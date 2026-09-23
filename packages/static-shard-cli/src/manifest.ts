import type {
  FieldConfig,
  FieldSchemaEntry,
  IndexChunkDirEntry,
  IndexDescriptor,
  Manifest,
  MissingZonemapInfo,
  PairZonemapEntry,
  ResolvedConfig,
  SchemaDescriptor,
  ShardDescriptor,
  ZonemapEntry,
} from "./types.js";

/** The sort field prunes via zonemap alone, so every numeric/date operator is free. */
const SORT_FIELD_OPERATORS = ["equals", "in", "gt", "gte", "lt", "lte"] as const;
/** Secondary string fields: values are sorted in the index, so prefix = a contiguous range (ADR-0003 §7). */
const SECONDARY_STRING_OPERATORS = ["equals", "in", "startsWith"] as const;
/**
 * Secondary number/date fields. `equals`/`in` are resolved exactly via the inverted index; the range
 * operators are pruned by the per-shard `[min,max]` pairs the zonemap already carries (ADR-0003 §6),
 * keeping only shards whose span overlaps the query interval. Those pairs are stored untruncated for
 * number/date — only string pairs are truncated — so range pruning is exact at shard granularity.
 *
 * Ranges are NOT offered on secondary STRING fields, deliberately: string comparison is lexicographic,
 * so `gte: "2"` on a numeric-looking column drops every double-digit value. Only the sort field gets
 * string ranges, where the ordering is the physical one the user chose (and `startsWith` covers the
 * prefix case a sorted string column can actually answer).
 */
const SECONDARY_RANGE_KIND_OPERATORS = ["equals", "in", "gt", "gte", "lt", "lte"] as const;
const SECONDARY_BOOLEAN_OPERATORS = ["equals"] as const;
/** `not` needs no index structure of its own — it's a filter-only rider valid alongside any pruning op (T7/ADR-0004). */
const RIDER_OPERATOR = "not";

function operatorsForField(field: FieldConfig, isSortField: boolean, indexed: boolean): readonly string[] {
  if (isSortField) {
    // A string sort field gets `startsWith` free on top of the range set: its values are sorted, so
    // a prefix is a contiguous span of the split-points already in the manifest — no index chunk to
    // fetch. This is the main reason to sort by a name-like field at all.
    const ops = [...SORT_FIELD_OPERATORS, ...(field.kind === "string" ? (["startsWith"] as const) : [])];
    return [...ops, RIDER_OPERATOR];
  }
  if (!indexed) return [];
  if (field.kind === "string") {
    const ops: string[] = [...SECONDARY_STRING_OPERATORS];
    if (field.endsWith) ops.push("endsWith");
    if (field.contains) ops.push("contains");
    ops.push(RIDER_OPERATOR);
    return ops;
  }
  if (field.kind === "boolean") return [...SECONDARY_BOOLEAN_OPERATORS, RIDER_OPERATOR];
  return [...SECONDARY_RANGE_KIND_OPERATORS, RIDER_OPERATOR];
}

/** N+1 monotonic boundaries: splitPoints[i] = min value of shard i; the final entry is the last shard's max. */
export function computeSplitPoints(groups: Record<string, unknown>[][], sortField: string): unknown[] {
  if (groups.length === 0) return [];
  const points = groups.map((group) => group[0]![sortField]);
  const lastGroup = groups[groups.length - 1]!;
  points.push(lastGroup[lastGroup.length - 1]![sortField]);
  return points;
}

/**
 * Locates the contiguous null/absent block at the high end of the globally sorted records
 * (ADR-0002 §9) and counts the two kinds separately. `undefined` when every record has a real
 * sort-field value.
 */
export function computeMissingBlock(groups: Record<string, unknown>[][], sortField: string): MissingZonemapInfo | undefined {
  let nullCount = 0;
  let absentCount = 0;
  let shardFrom: number | undefined;

  groups.forEach((group, shardIndex) => {
    for (const record of group) {
      const value = record[sortField];
      if (value === null) {
        nullCount++;
        if (shardFrom === undefined) shardFrom = shardIndex;
      } else if (value === undefined) {
        absentCount++;
        if (shardFrom === undefined) shardFrom = shardIndex;
      }
    }
  });

  return shardFrom === undefined ? undefined : { shardFrom, nullCount, absentCount };
}

function buildSchemaDescriptor(config: ResolvedConfig): SchemaDescriptor {
  const fields: Record<string, FieldSchemaEntry> = {};
  for (const [name, field] of Object.entries(config.fields)) {
    const isSortField = name === config.sortField;
    const indexed = isSortField || field.indexed === true;
    fields[name] = {
      kind: field.kind,
      isDate: field.kind === "date",
      indexed,
      operators: operatorsForField(field, isSortField, indexed),
      ...(field.absent === true ? { absent: true as const } : {}),
      ...(field.multi === true ? { multi: true as const } : {}),
      ...(name === config.pk ? { pk: true as const } : {}),
      ...(field.values !== undefined ? { values: field.values } : {}),
      ...(field.valuesType !== undefined ? { valuesType: field.valuesType } : {}),
      ...(field.tsType !== undefined ? { tsType: field.tsType } : {}),
      ...(field.tsImport !== undefined ? { tsImport: field.tsImport } : {}),
    };
  }
  return {
    collection: config.collection,
    sortField: config.sortField,
    ...(config.pk !== undefined ? { pk: config.pk } : {}),
    fields,
  };
}

export function buildManifest(opts: {
  config: ResolvedConfig;
  shardFiles: ShardDescriptor[];
  splitPoints: unknown[];
  /** The sort field's contiguous null/absent block, if any (ADR-0002 §9). */
  missing?: MissingZonemapInfo;
  /** Per non-sort indexed field, its per-shard [min,max] zonemap entry (ADR-0003). */
  secondaryZonemaps?: Record<string, PairZonemapEntry>;
  /** Per non-sort indexed field, its index chunk directory (ADR-0003). */
  indexChunkDirs?: Record<string, IndexChunkDirEntry[]>;
  /** Per field opted into `endsWith`, its reversed-value index chunk directory (ADR-0003 §7/§9). */
  reversedChunkDirs?: Record<string, IndexChunkDirEntry[]>;
  /** Per field opted into `contains`, its trigram index chunk directory (ADR-0003 §7/§9). */
  trigramChunkDirs?: Record<string, IndexChunkDirEntry[]>;
  /** Per multi-valued field, the shards holding a present `[]` (ADR-0010 §5). */
  emptyShards?: Record<string, number[]>;
  formatVersion: number;
  generatorVersion: string;
}): Manifest {
  const {
    config,
    shardFiles,
    splitPoints,
    missing,
    secondaryZonemaps = {},
    indexChunkDirs = {},
    reversedChunkDirs = {},
    trigramChunkDirs = {},
    emptyShards = {},
    formatVersion,
    generatorVersion,
  } = opts;
  const recordCount = shardFiles.reduce((sum, s) => sum + s.count, 0);
  const schema = buildSchemaDescriptor(config);

  const zonemap: Record<string, ZonemapEntry> = {
    [config.sortField]: { splitPoints, ...(missing ? { missing } : {}) },
  };
  for (const [field, entry] of Object.entries(secondaryZonemaps)) zonemap[field] = entry;

  const indexes: Record<string, IndexDescriptor> = {};
  const indexDescriptorFor = (field: string): IndexDescriptor =>
    indexes[field] ?? { operators: schema.fields[field]!.operators, chunks: [] };
  for (const [field, chunks] of Object.entries(indexChunkDirs)) {
    indexes[field] = { operators: schema.fields[field]!.operators, chunks };
  }
  for (const [field, chunks] of Object.entries(reversedChunkDirs)) {
    indexes[field] = { ...indexDescriptorFor(field), reversed: { chunks } };
  }
  for (const [field, chunks] of Object.entries(trigramChunkDirs)) {
    indexes[field] = { ...indexDescriptorFor(field), trigram: { chunks } };
  }
  for (const [field, ordinals] of Object.entries(emptyShards)) {
    indexes[field] = { ...indexDescriptorFor(field), emptyShards: ordinals };
  }

  return {
    formatVersion,
    generatorVersion,
    dataset: {
      collection: config.collection,
      recordCount,
      shardCount: shardFiles.length,
      sortField: config.sortField,
      ...(config.compression !== "none" ? { compression: config.compression } : {}),
    },
    schema,
    shards: shardFiles.map(({ hash, bytes, count }) => ({ hash, bytes, count })),
    zonemap,
    indexes,
  };
}

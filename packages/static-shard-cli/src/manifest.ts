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
 * Secondary number/date fields: their zonemap overlaps (can't pinpoint a value), so `equals`/`in` need the
 * inverted index; `gt`/`lt` would need the (already-present) zonemap pairs but that's out of T3's scope.
 */
const SECONDARY_RANGE_KIND_OPERATORS = ["equals", "in"] as const;
const SECONDARY_BOOLEAN_OPERATORS = ["equals"] as const;
/** `not` needs no index structure of its own — it's a filter-only rider valid alongside any pruning op (T7/ADR-0004). */
const RIDER_OPERATOR = "not";

function operatorsForField(field: FieldConfig, isSortField: boolean, indexed: boolean): readonly string[] {
  if (isSortField) return [...SORT_FIELD_OPERATORS, RIDER_OPERATOR];
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

  return {
    formatVersion,
    generatorVersion,
    dataset: {
      collection: config.collection,
      recordCount,
      shardCount: shardFiles.length,
      sortField: config.sortField,
      ...(config.gzip ? { gzip: true as const } : {}),
    },
    schema,
    shards: shardFiles.map(({ hash, bytes, count }) => ({ hash, bytes, count })),
    zonemap,
    indexes,
  };
}

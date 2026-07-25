import { truncateStringUpper, valuesOf } from "./secondary-index.js";
import type { FieldConfig, FieldKind } from "./types.js";

/** ADR-0003 §11: `M_gzip ≈ 0.35 · M` — the same JSON+front-coding/delta-encoding anchor used for shard sizing. */
export const GZIP_RATIO = 0.35;
/** ADR-0003 §3: root-manifest gzip budget the build warns past. */
export const MANIFEST_BUDGET_BYTES = 1_000_000;
/** Bytes contributed by one delta-encoded posting entry (ADR-0003 §5/§11: "postings_f·2B"). */
const POSTING_BYTES = 2;

/** ADR-0002 §5 recommended-shard-size clamp: `clamp(max(2MB, p95_record_size), 512KB, 8MB)`. */
const RECOMMENDED_SHARD_FLOOR_BYTES = 2_097_152;
const RECOMMENDED_SHARD_MIN_BYTES = 524_288;
const RECOMMENDED_SHARD_MAX_BYTES = 8_388_608;

const HASH_JSON_BYTES = jsonByteLength("a".repeat(16)); // 16-hex-char content-hash + quotes (ADR-0003 §9 shards[].hash)
const SHARD_INT_JSON_BYTES = 6; // representative digit-count for shards[].bytes / shards[].count
const SCHEMA_BASE_BYTES = 200; // formatVersion/generatorVersion/dataset block scaffolding
const SCHEMA_FIELD_OVERHEAD_BYTES = 90; // one schema.fields[name] descriptor (kind/isDate/indexed/operators[])
const DIR_ENTRY_OVERHEAD_BYTES = 24; // `{"from":…,"to":…,"file":"…"}` scaffolding sans the from/to/path bytes themselves

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = clamp(Math.ceil(p * sortedAscending.length) - 1, 0, sortedAscending.length - 1);
  return sortedAscending[idx]!;
}

function chunkCountFor(bytes: number, chunkBytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / chunkBytes) : 0;
}

function canonicalKey(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Per-field stats a `DatasetProfile` carries for every non-sort field that's opted `indexed: true` (ADR-0003 §11's per-field cost inputs). */
export interface FieldProfile {
  kind: FieldKind;
  /** Distinct non-null values observed (multi-valued fields: distinct elements across all arrays). */
  cardinality: number;
  /** Representative JSON-encoded byte length of one distinct value — the formula's `avgTermBytes_frontcoded` proxy (an upper bound: real front-coding shares prefixes across a sorted chunk). */
  avgValueBytes: number;
  /** Representative zonemap-pair value byte length — truncated for strings (ADR-0003 §2), same as `avgValueBytes` otherwise. */
  truncValueBytes: number;
  /** Occurrence count per distinct value, across every profiled record — the formula's raw `occurrences(value)` input. */
  occurrencesByValue: number[];
  /** Σ over every occurrence of `max(length - 2, 0)` — the `contains_f` numerator's weighted-length term. */
  trigramWeightedLength: number;
  /** Distinct 3-char substrings observed across all occurrences — the `contains_f` formula's `trigramCount`. */
  distinctTrigramCount: number;
  /** Total UTF-8 bytes of raw (non-null) string values — the "size of the column" `contains` is warned against exceeding (ADR-0003 §7). */
  totalValueBytes: number;
}

export interface DatasetProfile {
  recordCount: number;
  /** Total raw JSON-serialized bytes across all profiled records — Axis 1's `datasetBytes` input. */
  datasetBytes: number;
  /** 95th-percentile per-record JSON-serialized byte size — feeds `recommendShardBytes`. */
  p95RecordBytes: number;
  /** Largest single record's JSON-serialized byte size — feeds the oversized-record warning (ADR-0002 §5). */
  maxRecordBytes: number;
  sortField: string;
  /** Representative JSON-encoded byte length of a sort-field value (mean over observed values). */
  sortValueBytes: number;
  /** Distinct sort-field values observed — feeds the low-cardinality-sort-field warning. */
  sortFieldCardinality: number;
  /** One entry per non-sort field opted `indexed: true` — matches the cost surface `build` actually pays for. */
  fields: Record<string, FieldProfile>;
}

/**
 * Profiles an in-memory record set (a sample or the full dataset — the caller decides) into the
 * stats `estimateCosts` needs. Pure: no I/O. Mirrors `secondary-index.ts`'s value/occurrence
 * collection so profiled numbers stay close to what a real build would compute for the same data.
 */
export function profileDataset(
  records: Record<string, unknown>[],
  config: { sortField: string; fields: Record<string, FieldConfig> },
  /**
   * True population totals when `records` is only a sample (the wizard's default): `recordCount` and
   * `datasetBytes` are taken from these so shard-count and size estimates reflect the whole dataset,
   * while per-field cardinality/value stats stay sample-derived (a sampled estimate, ADR-0006 §3).
   * Omit when `records` IS the full dataset (`--full-scan`, `inspect`) — sample then equals population.
   */
  population?: { recordCount: number; datasetBytes: number },
): DatasetProfile {
  const recordBytes = records.map((r) => jsonByteLength(r)).sort((a, b) => a - b);
  const sampleBytes = recordBytes.reduce((sum, b) => sum + b, 0);
  const datasetBytes = population?.datasetBytes ?? sampleBytes;
  const p95RecordBytes = percentile(recordBytes, 0.95);
  const maxRecordBytes = recordBytes.length > 0 ? recordBytes[recordBytes.length - 1]! : 0;

  const sortValues = records.map((r) => r[config.sortField]).filter((v) => v !== null && v !== undefined);
  const sortValueBytes =
    sortValues.length > 0
      ? sortValues.reduce((sum: number, v) => sum + jsonByteLength(v), 0) / sortValues.length
      : 0;
  const sortFieldCardinality = new Set(sortValues.map((v) => canonicalKey(v))).size;

  const fields: Record<string, FieldProfile> = {};
  for (const [name, cfg] of Object.entries(config.fields)) {
    if (name === config.sortField || cfg.indexed !== true) continue;
    fields[name] = profileField(records, name, cfg);
  }

  return {
    recordCount: population?.recordCount ?? records.length,
    datasetBytes,
    p95RecordBytes,
    maxRecordBytes,
    sortField: config.sortField,
    sortValueBytes,
    sortFieldCardinality,
    fields,
  };
}

function profileField(records: Record<string, unknown>[], name: string, cfg: FieldConfig): FieldProfile {
  const multi = cfg.multi === true;
  const occurrences = new Map<string, { value: unknown; count: number }>();
  let trigramWeightedLength = 0;
  let totalValueBytes = 0;
  const trigrams = new Set<string>();

  for (const record of records) {
    for (const value of valuesOf(record, name, multi)) {
      if (value === null || value === undefined) continue;
      const key = canonicalKey(value);
      const entry = occurrences.get(key);
      if (entry) entry.count++;
      else occurrences.set(key, { value, count: 1 });

      if (typeof value === "string") {
        totalValueBytes += Buffer.byteLength(value, "utf8");
        trigramWeightedLength += Math.max(value.length - 2, 0);
        for (let i = 0; i <= value.length - 3; i++) trigrams.add(value.slice(i, i + 3));
      }
    }
  }

  const distinct = [...occurrences.values()];
  const cardinality = distinct.length;
  const avgValueBytes =
    cardinality > 0 ? distinct.reduce((sum, e) => sum + jsonByteLength(e.value), 0) / cardinality : 0;
  const truncValueBytes =
    cfg.kind === "string" && cardinality > 0
      ? distinct.reduce((sum, e) => sum + jsonByteLength(truncateStringUpper(e.value as string)), 0) / cardinality
      : avgValueBytes;

  return {
    kind: cfg.kind,
    cardinality,
    avgValueBytes,
    truncValueBytes,
    occurrencesByValue: distinct.map((e) => e.count),
    trigramWeightedLength,
    distinctTrigramCount: trigrams.size,
    totalValueBytes,
  };
}

/** Axis 1 (ADR-0003 §11): `shardCount = ceil(datasetBytes_compressed / T)`. */
export function estimateShardCount(datasetBytes: number, shardBytes: number): number {
  return datasetBytes > 0 ? Math.max(1, Math.ceil(datasetBytes / shardBytes)) : 0;
}

/** ADR-0002 §5: `T_default = clamp(max(2MB, p95_record_size), 512KB, 8MB)` — the wizard's (T12) shard-size recommendation, lifted here as reusable core. */
export function recommendShardBytes(p95RecordBytes: number): number {
  return clamp(Math.max(RECOMMENDED_SHARD_FLOOR_BYTES, p95RecordBytes), RECOMMENDED_SHARD_MIN_BYTES, RECOMMENDED_SHARD_MAX_BYTES);
}

/** Per-operator index-size estimate for one field (ADR-0003 §11's `baseIndex_f`/`endsWith_f`/`contains_f`/`chunkCount_f`). */
export interface IndexSizeEstimate {
  baseBytes: number;
  baseChunks: number;
  /** Present iff the field opts into `endsWith` — a same-shape reversed-value index, roughly `+baseBytes` of build output. */
  reversedBytes?: number;
  reversedChunks?: number;
  /** Present iff the field opts into `contains` — the trigram index. */
  trigramBytes?: number;
  trigramChunks?: number;
  /** True when the trigram index is estimated to exceed the field's raw column size (ADR-0003 §7's loud build warning). */
  containsExceedsColumn?: boolean;
}

export function estimateIndexSize(
  field: FieldProfile,
  shardCount: number,
  opts: { indexChunkBytes: number; endsWith?: boolean; contains?: boolean },
): IndexSizeEstimate {
  const postings = field.occurrencesByValue.reduce((sum, occ) => sum + Math.min(occ, shardCount), 0);
  const baseBytes = Math.round(field.cardinality * field.avgValueBytes + postings * POSTING_BYTES);
  const result: IndexSizeEstimate = { baseBytes, baseChunks: chunkCountFor(baseBytes, opts.indexChunkBytes) };

  if (opts.endsWith) {
    result.reversedBytes = baseBytes;
    result.reversedChunks = chunkCountFor(baseBytes, opts.indexChunkBytes);
  }

  if (opts.contains) {
    const trigramBytes = Math.round(
      Math.min(field.trigramWeightedLength, field.distinctTrigramCount * shardCount) * POSTING_BYTES,
    );
    result.trigramBytes = trigramBytes;
    result.trigramChunks = chunkCountFor(trigramBytes, opts.indexChunkBytes);
    result.containsExceedsColumn = trigramBytes > field.totalValueBytes;
  }

  return result;
}

/** Axis 2 (ADR-0003 §11): the root manifest's serialized size and whether it crosses the ~1MB gzip budget. */
export interface ManifestSizeEstimate {
  bytes: number;
  gzipBytes: number;
  overBudget: boolean;
}

export function estimateManifestBytes(
  profile: DatasetProfile,
  shardCount: number,
  indexes: Record<string, IndexSizeEstimate>,
): ManifestSizeEstimate {
  const fieldCount = 1 + Object.keys(profile.fields).length; // + the sort field itself
  let bytes =
    SCHEMA_BASE_BYTES +
    fieldCount * SCHEMA_FIELD_OVERHEAD_BYTES +
    shardCount * (HASH_JSON_BYTES + 2 * SHARD_INT_JSON_BYTES) + // shards[] identity
    (shardCount + 1) * profile.sortValueBytes; // sort-field split-points

  for (const [name, field] of Object.entries(profile.fields)) {
    bytes += shardCount * 2 * field.truncValueBytes; // secondary zonemap pairs — the dominant term

    const idx = indexes[name];
    if (!idx) continue;
    const dirEntryBytes = DIR_ENTRY_OVERHEAD_BYTES + name.length + field.truncValueBytes * 2;
    bytes += idx.baseChunks * dirEntryBytes;
    if (idx.reversedChunks) bytes += idx.reversedChunks * dirEntryBytes;
    if (idx.trigramChunks) bytes += idx.trigramChunks * (DIR_ENTRY_OVERHEAD_BYTES + name.length + 8); // trigram keys are fixed 3-char, tiny from/to
  }

  const gzipBytes = Math.round(bytes * GZIP_RATIO);
  return { bytes: Math.round(bytes), gzipBytes, overBudget: gzipBytes > MANIFEST_BUDGET_BYTES };
}

/** Axis 3 (ADR-0003 §11): representative per-query download cost, shown for one equality and one range query. */
export interface QueryCostEstimate {
  bytes: number;
  requests: number;
}

/**
 * A representative equality query on an indexed secondary field: one index-chunk fetch, plus the
 * shards its value's occurrences scatter across. Takes the field's raw `cardinality` rather than
 * a full `FieldProfile` so real (exact) cardinality — e.g. read off a built index's dictionary —
 * feeds the same formula `inspect --dir` uses for its "exact re-report".
 */
export function estimateEqualityQueryCost(
  cardinality: number,
  recordCount: number,
  shardCount: number,
  shardBytes: number,
  indexChunkBytes: number,
): QueryCostEstimate {
  if (shardCount === 0 || cardinality === 0) return { bytes: indexChunkBytes, requests: 1 };
  const avgOccurrences = recordCount / cardinality;
  const recordsPerShard = Math.max(1, recordCount / shardCount);
  const candidateShards = Math.min(shardCount, Math.max(1, Math.ceil(avgOccurrences / recordsPerShard)));
  return { bytes: indexChunkBytes + candidateShards * shardBytes, requests: 1 + candidateShards };
}

/** A representative range query on the sort field: zonemap-only (no index-chunk fetch), assumed to select ~10% of the shard span. */
export function estimateRangeQueryCost(shardCount: number, shardBytes: number, selectivity = 0.1): QueryCostEstimate {
  if (shardCount === 0) return { bytes: 0, requests: 0 };
  const candidateShards = Math.max(1, Math.ceil(shardCount * selectivity));
  return { bytes: candidateShards * shardBytes, requests: candidateShards };
}

/**
 * The full ADR-0003 §11 cost model for a profiled (sampled or full) dataset + resolved knobs —
 * the fast, sample-driven estimate the wizard (T12) will use for live per-keystroke readouts.
 * `inspect` doesn't call this directly: given the full input already in memory, it gets EXACT
 * numbers by materializing the real shards/indexes (`build.ts`'s `materialize`) instead of
 * estimating them — but it reuses this module's `IndexSizeEstimate`/`QueryCostEstimate` shapes
 * and its per-query cost formulas (`estimateEqualityQueryCost`/`estimateRangeQueryCost`), so a
 * formula change lands in one place for both the sampled estimate and the exact re-report.
 */
export interface CostEstimate {
  shardCount: number;
  recordsPerShard: number;
  manifest: ManifestSizeEstimate;
  /** One entry per profiled (non-sort, indexed) field. */
  indexes: Record<string, IndexSizeEstimate>;
  perQuery: {
    /** Absent when no field is indexed — there is no representative equality query to show. */
    equality?: QueryCostEstimate;
    range: QueryCostEstimate;
  };
}

export function estimateCosts(
  profile: DatasetProfile,
  fields: Record<string, FieldConfig>,
  opts: { shardBytes: number; indexChunkBytes: number },
): CostEstimate {
  const shardCount = estimateShardCount(profile.datasetBytes, opts.shardBytes);
  const recordsPerShard = shardCount > 0 ? profile.recordCount / shardCount : 0;

  const indexes: Record<string, IndexSizeEstimate> = {};
  for (const [name, field] of Object.entries(profile.fields)) {
    const cfg = fields[name];
    indexes[name] = estimateIndexSize(field, shardCount, {
      indexChunkBytes: opts.indexChunkBytes,
      endsWith: cfg?.endsWith,
      contains: cfg?.contains,
    });
  }

  const manifest = estimateManifestBytes(profile, shardCount, indexes);

  const firstField = Object.values(profile.fields)[0];
  const perQuery: CostEstimate["perQuery"] = { range: estimateRangeQueryCost(shardCount, opts.shardBytes) };
  if (firstField !== undefined) {
    perQuery.equality = estimateEqualityQueryCost(
      firstField.cardinality,
      profile.recordCount,
      shardCount,
      opts.shardBytes,
      opts.indexChunkBytes,
    );
  }

  return { shardCount, recordsPerShard, manifest, indexes, perQuery };
}

import { BlockDbError } from "./errors.js";
import { compressionSuffix, decompressionFormat, type Compression } from "./types.js";
import { fetchCompressedText, fetchJson, parseCorruptible } from "./fetch-file.js";
import { FORMAT_VERSION } from "./version.js";

export interface BlockDescriptor {
  hash: string;
  bytes: number;
  count: number;
}

export interface FieldSchemaEntry {
  kind: string;
  isDate: boolean;
  indexed: boolean;
  operators: readonly string[];
  /** The key may be missing from a record (absent ≠ null). */
  absent?: true;
  /** The value may be `null` (null ≠ absent). */
  nullable?: true;
  /** Scalar leaf under an object-array — value is an array, matched existentially via `some` (T7). */
  multi?: true;
  /** Present (`true`) only for the user PK field (T8). */
  pk?: true;
}

export interface SchemaDescriptor {
  collection: string;
  sortField: string;
  /** Names the user PK field, if declared (T8). */
  pk?: string;
  fields: Record<string, FieldSchemaEntry>;
}

/** Records with a null/absent sort-field value cluster in a contiguous tail at the high end (ADR-0002 §9). */
export interface MissingZonemapInfo {
  /** Ordinal of the earliest block containing any missing (null or absent) sort-field value. */
  blockFrom: number;
  /** Records with an explicit `null` sort-field value. */
  nullCount: number;
  /** Records whose sort-field key is absent entirely (not just null). */
  absentCount: number;
}

/** Sort field: N+1 monotonic split-points, binary-searchable (ADR-0003 §2). */
export interface SplitPointZonemapEntry {
  splitPoints: unknown[];
  /** Present iff at least one record had a null/absent sort-field value (ADR-0002 §9). */
  missing?: MissingZonemapInfo;
}

/** Secondary field: per-block [min,max] pairs, ordinal-aligned with `blocks[]` (ADR-0003 §2/§9). */
export interface PairZonemapEntry {
  pairs: [unknown, unknown][];
  truncated?: boolean;
}

/** A secondary field's zonemap moved out of root into a per-field sidecar file (ADR-0003 §3) — spilled when the root manifest would exceed the gzip budget. */
export interface SidecarZonemapEntry {
  sidecar: string;
}

export type ZonemapEntry = SplitPointZonemapEntry | PairZonemapEntry | SidecarZonemapEntry;

/** One index chunk's value-range coverage — routing metadata only (ADR-0003 §9). */
export interface IndexChunkDirEntry {
  from: unknown;
  to: unknown;
  file: string;
}

export interface IndexDescriptor {
  operators: readonly string[];
  chunks: IndexChunkDirEntry[];
  /** Reversed-value index chunk directory — present iff `endsWith` opted in (ADR-0003 §7/§9). */
  reversed?: { chunks: IndexChunkDirEntry[] };
  /** Trigram index chunk directory — present iff `contains` opted in (ADR-0003 §7/§9). */
  trigram?: { chunks: IndexChunkDirEntry[] };
  /**
   * Multi-valued fields only: ordinals of the blocks holding at least one present `[]` — what
   * `isEmpty` and `every` prune on (ADR-0010 §4/§5). Missing (a pre-ADR-0010 build) means unknown.
   */
  emptyBlocks?: number[];
}

export interface Manifest {
  formatVersion: number;
  generatorVersion: string;
  dataset: {
    collection: string;
    recordCount: number;
    blockCount: number;
    sortField: string;
    /** Present (`true`) only when block payloads are gzipped at build time (ADR-0002 §8) — omitted otherwise. */
    /**
     * How every served file was pre-compressed, when the build did so (ADR-0002 §8). Absent means
     * plain files. `gzip?: true` is the pre-`compression` spelling, still read so an older deploy keeps
     * working against a newer client.
     */
    compression?: Compression;
    /** @deprecated Superseded by `compression: "gzip"`. */
    gzip?: true;
  };
  schema: SchemaDescriptor;
  blocks: BlockDescriptor[];
  zonemap: Record<string, ZonemapEntry>;
  indexes: Record<string, IndexDescriptor>;
}

/**
 * Fetches the root manifest. `gzipped` says the deploy pre-compressed it (ADR-0002 §8) — unlike index
 * chunks and zonemap sidecars, whose `.gz` paths come FROM the manifest and so describe themselves,
 * this is the bootstrap fetch: nothing has been read yet that could tell the client the encoding. The
 * generated client carries the answer instead, stamped by the same `build` that wrote the file, so the
 * two cannot drift.
 */
export async function fetchManifest(
  basePath: string,
  fetchImpl: typeof fetch,
  compression: Compression = "none",
): Promise<Manifest> {
  const url = `${basePath}/manifest.json${compressionSuffix(compression)}`;
  const format = decompressionFormat(compression);
  let parsed: Manifest;
  if (format === undefined) {
    parsed = (await fetchJson(url, "manifest", fetchImpl)) as Manifest;
  } else {
    const text = await fetchCompressedText(url, "manifest", format, fetchImpl);
    parsed = parseCorruptible(url, () => JSON.parse(text) as Manifest);
  }
  // JSON-valid but not a manifest — the body "won't parse" into one (ADR-0007 §5).
  if (typeof parsed.formatVersion !== "number") {
    throw new BlockDbError({
      code: "CORRUPT_DATA",
      url,
      message: `blockdb: the manifest at "${url}" parsed as JSON but has no numeric formatVersion — the deploy is corrupt. Re-run \`blockdb build\` and redeploy.`,
    });
  }
  // ADR-0005: same major → always compatible (SemVer); major mismatch → fail loud.
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new BlockDbError({
      code: "FORMAT_VERSION",
      url,
      message:
        `blockdb: the dataset at "${url}" was built with blockdb major ${String(parsed.formatVersion)} ` +
        `but this runtime is major ${FORMAT_VERSION} — align versions and re-run \`blockdb build\`.`,
    });
  }
  return parsed;
}

/**
 * How this deploy compressed the files the manifest points at. Reads the modern `compression` field
 * and falls back to the original `gzip: true`, so a tree built before the field existed still works.
 */
export function datasetCompression(manifest: Manifest): Compression {
  return manifest.dataset.compression ?? (manifest.dataset.gzip === true ? "gzip" : "none");
}

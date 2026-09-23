import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { resolveConfig } from "./config.js";
import { generateClientTs, generateSchemaTs } from "./codegen.js";
import { applyDerivedFields } from "./derive.js";
import { assertNoSchemaDrift } from "./drift.js";
import { contentHash } from "./hash.js";
import { readInputRecords } from "./input.js";
import { buildManifest, computeMissingTail, computeSplitPoints } from "./manifest.js";
import {
  buildInvertedIndex,
  buildReversedIndex,
  buildTrigramIndex,
  computeColumnBytes,
  computeSecondaryZonemap,
  emptyListBlocks,
  meanPostingsLength,
} from "./secondary-index.js";
import { cutIntoBlocks, materializeBlocks, blockRelPath } from "./block.js";
import type { BlockFile } from "./block.js";
import { externalSort, type SortKind } from "./sort.js";
import type { OnProgress } from "./progress.js";
import type { BuiltIndexChunk } from "./secondary-index.js";
import { compressionSuffix, type Compression } from "./types.js";
import type { IndexChunkDirEntry, Manifest, PairZonemapEntry, ResolvedConfig, BlockDbConfig } from "./types.js";
import { getFormatVersion, getGeneratorVersion } from "./version.js";
import {
  brotliHostSupportWarning,
  lowCardinalitySortFieldWarning,
  oversizedRecordWarning,
  skewedBlocksWarning,
  sortFieldCardinalityOf,
  unselectiveTextIndexWarning,
} from "./warnings.js";
import { spillOversizedZonemaps } from "./zonemap-budget.js";

/**
 * Brotli quality for build-time compression. Not the default 11: measured on 40 MB of real JSON, q11
 * took 31s for 14.4x while q5 took 247ms for 11.8x — the same wall-clock as gzip, which manages 7.65x.
 * q11 would add minutes to every build for a further ~15%, on files a CDN caches anyway.
 */
const BROTLI_QUALITY = 5;

/** Applies the deploy's build-time compression to one file's bytes. */
function compressServedFile(content: string, compression: Compression): string | Buffer {
  if (compression === "gzip") return gzipSync(content);
  if (compression === "brotli") {
    return brotliCompressSync(Buffer.from(content, "utf8"), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
  }
  return content;
}

/** Records buffered per sorted run before `externalSort` spills to disk (ADR-0002 §9) — tunable per-call for tests, not part of the persisted config (an execution concern, not a design decision). */
const DEFAULT_SORT_RUN_RECORDS = 200_000;

export interface MaterializeOptions {
  generatorVersion?: string;
  formatVersion?: number;
  /** Records buffered per sorted run before the global sort spills to disk. Default 200,000. */
  sortRunRecords?: number;
  /** Scratch directory the external sort may use when spilling. Default `os.tmpdir()`. */
  tmpDir?: string;
  /** Phase-level progress for long builds. Purely observational — never changes what's produced. */
  onProgress?: OnProgress;
}

export interface MaterializeResult {
  manifest: Manifest;
  blockFiles: BlockFile[];
  /** Every non-block content-hashed file the manifest points at: index chunk directories and, past the manifest budget, spilled zonemap sidecars (ADR-0003 §3). */
  indexFiles: { relPath: string; content: string }[];
  /** Loud, non-fatal build-time warnings (e.g. a `contains` trigram index bigger than its column, ADR-0003 §7). */
  warnings: string[];
}

/**
 * The walking skeleton, minus disk I/O: read config's baked schema → global sort by the sort
 * field → cut into byte-target blocks → compute the manifest (zonemaps + lazy indexes). Pure
 * given `records` already in memory — never touches `output`/`clientOut` — with one exception:
 * the sort step may spill memory-bounded runs to OS-tmpdir scratch files (T13's external sort),
 * cleaned up before returning, so the result is still deterministic and side-effect-free from the
 * caller's perspective. `build` writes this result to disk; `inspect --config` (T11) reads it
 * directly for an exact re-report without ever touching `output`.
 */
export function materialize(
  resolved: ResolvedConfig,
  records: Record<string, unknown>[],
  opts: MaterializeOptions = {},
): MaterializeResult {
  const generatorVersion = opts.generatorVersion ?? getGeneratorVersion();
  const formatVersion = opts.formatVersion ?? getFormatVersion();
  const sortKind = resolved.fields[resolved.sortField]!.kind as SortKind;
  const progress = opts.onProgress;

  // Before anything reads a field: a derived column has to exist by the time drift checks it, the
  // sort reads it, and the indexers see it (ADR-0009). Doing it here means `build` and
  // `inspect --config` derive identically, since both enter through `materialize`.
  progress?.({ phase: "deriving fields", done: records.length, total: records.length, unit: "count" });
  applyDerivedFields(records, resolved.fields);

  progress?.({ phase: "checking schema", done: records.length, total: records.length, unit: "count" });
  assertNoSchemaDrift(records, resolved.fields);

  // The sort has no reportable midpoint (it's one call that may spill runs to disk), so it's an
  // open-ended phase carrying the record count rather than a fake percentage.
  progress?.({ phase: `sorting by ${resolved.sortField}`, done: records.length, unit: "count" });
  const sorted = externalSort(records, {
    sortField: resolved.sortField,
    kind: sortKind,
    pk: resolved.pk,
    runRecords: opts.sortRunRecords ?? DEFAULT_SORT_RUN_RECORDS,
    tmpDir: opts.tmpDir ?? os.tmpdir(),
  });

  progress?.({ phase: "splitting into data files" });
  const groups = cutIntoBlocks(sorted, resolved.sortField, resolved.blockBytes);
  const blockFiles = materializeBlocks(groups);
  const splitPoints = computeSplitPoints(groups, resolved.sortField);
  const missing = computeMissingTail(groups, resolved.sortField);

  const indexedSecondaryFields = Object.entries(resolved.fields).filter(
    ([name, field]) => name !== resolved.sortField && field.indexed === true,
  );

  const secondaryZonemaps: Record<string, PairZonemapEntry> = {};
  const indexChunkDirs: Record<string, IndexChunkDirEntry[]> = {};
  const reversedChunkDirs: Record<string, IndexChunkDirEntry[]> = {};
  const trigramChunkDirs: Record<string, IndexChunkDirEntry[]> = {};
  const emptyBlocks: Record<string, number[]> = {};
  const indexFiles: { relPath: string; content: string }[] = [];
  const warnings: string[] = [];

  // Under `gzip`, every manifest-referenced JSON file is written compressed and its path carries the
  // `.gz` suffix. The path IS the signal the client routes on (`fetchReferencedJson`), so there is no
  // flag to keep in sync and a tree mixing compressed and plain files still reads correctly.
  // `indexFiles[].content` stays LOGICAL (uncompressed) — `build` compresses at write time, and
  // `inspect --config` reports off the same logical bytes a real build would hash.
  const servedSuffix = compressionSuffix(resolved.compression);

  const addIndexChunks = (field: string, subdir: string | null, builtChunks: BuiltIndexChunk[]): IndexChunkDirEntry[] =>
    builtChunks.map(({ from, to, content }) => {
      // Hash over the uncompressed content, exactly as blocks do: toggling gzip between rebuilds must
      // not perturb filenames or the manifest structures keyed on them (ADR-0002 §8).
      const hash = contentHash(content);
      const base = subdir ? `index/${field}/${subdir}/${hash}` : `index/${field}/${hash}`;
      const relPath = `${base}.json${servedSuffix}`;
      indexFiles.push({ relPath, content });
      return { from, to, file: relPath };
    });

  let fieldsIndexed = 0;
  for (const [name, field] of indexedSecondaryFields) {
    // Per-field rather than a single "indexing" phase: index building dominates a big build, and
    // which field it's chewing on is the useful detail (a `contains` trigram field is the slow one).
    progress?.({
      phase: `indexing ${name}`,
      done: fieldsIndexed,
      total: indexedSecondaryFields.length,
      unit: "count",
    });
    fieldsIndexed++;
    const multi = field.multi === true;
    secondaryZonemaps[name] = computeSecondaryZonemap(groups, name, field.kind, multi);
    if (multi) emptyBlocks[name] = emptyListBlocks(groups, name);
    indexChunkDirs[name] = addIndexChunks(
      name,
      null,
      buildInvertedIndex(groups, name, field.kind, resolved.indexChunkBytes, multi),
    );

    if (field.endsWith) {
      const reversedChunks = buildReversedIndex(groups, name, resolved.indexChunkBytes, multi);
      reversedChunkDirs[name] = addIndexChunks(name, "reversed", reversedChunks);

      const unselective = unselectiveTextIndexWarning(
        name,
        "endsWith",
        meanPostingsLength(reversedChunks),
        groups.length,
      );
      if (unselective) warnings.push(unselective);
    }

    if (field.contains) {
      const trigramChunks = buildTrigramIndex(groups, name, resolved.indexChunkBytes, multi);
      trigramChunkDirs[name] = addIndexChunks(name, "trigram", trigramChunks);

      const unselective = unselectiveTextIndexWarning(
        name,
        "contains",
        meanPostingsLength(trigramChunks),
        groups.length,
      );
      if (unselective) warnings.push(unselective);

      const trigramBytes = trigramChunks.reduce((sum, c) => sum + Buffer.byteLength(c.content, "utf8"), 0);
      const columnBytes = computeColumnBytes(groups, name, multi);
      if (trigramBytes > columnBytes) {
        warnings.push(
          `blockdb: contains(${name}): trigram index (${trigramBytes} bytes) is bigger than the data — ` +
            `the raw "${name}" column is only ${columnBytes} bytes. This is the single biggest build-output cost; ` +
            `consider disabling contains for this field.`,
        );
      }
    }
  }

  progress?.({
    phase: "building manifest",
    done: indexedSecondaryFields.length,
    total: indexedSecondaryFields.length,
    unit: "count",
  });
  const rawManifest = buildManifest({
    config: resolved,
    blockFiles,
    splitPoints,
    missing,
    secondaryZonemaps,
    indexChunkDirs,
    reversedChunkDirs,
    trigramChunkDirs,
    emptyBlocks,
    formatVersion,
    generatorVersion,
  });

  // Root-manifest budget (ADR-0003 §3): spill the largest secondary zonemaps to per-field
  // sidecars, largest first, until the gzipped root is back under budget.
  const { manifest, sidecarFiles, warning: budgetWarning } = spillOversizedZonemaps(rawManifest, servedSuffix);
  indexFiles.push(...sidecarFiles);
  if (budgetWarning) warnings.push(budgetWarning);

  const maxRecordBytes = records.reduce((max, r) => Math.max(max, Buffer.byteLength(JSON.stringify(r), "utf8")), 0);
  const oversizedWarning = oversizedRecordWarning(maxRecordBytes, resolved.blockBytes);
  if (oversizedWarning) warnings.push(oversizedWarning);

  const skewWarning = skewedBlocksWarning(blockFiles);
  if (skewWarning) warnings.push(skewWarning);

  const cardinalityWarning = lowCardinalitySortFieldWarning(
    records.length,
    sortFieldCardinalityOf(records, resolved.sortField),
  );
  if (cardinalityWarning) warnings.push(cardinalityWarning);

  const brotliWarning = brotliHostSupportWarning(resolved.compression);
  if (brotliWarning) warnings.push(brotliWarning);

  return { manifest, blockFiles, indexFiles, warnings };
}

export interface BuildOptions {
  /** Directory config-relative paths (input/output/clientOut) are resolved against. */
  baseDir: string;
  generatorVersion?: string;
  formatVersion?: number;
  /** Records buffered per sorted run before the global sort spills to disk. Default 200,000. */
  sortRunRecords?: number;
  /** Scratch directory the external sort may use when spilling. Default `os.tmpdir()`. */
  tmpDir?: string;
  /** Phase-level progress for long builds. Purely observational — never changes what's produced. */
  onProgress?: OnProgress;
}

export interface BuildResult {
  manifest: Manifest;
  outputDir: string;
  clientOutDir: string;
  /** Loud, non-fatal build-time warnings (e.g. a `contains` trigram index bigger than its column, ADR-0003 §7). */
  warnings: string[];
}

/**
 * Reads config's input, materializes the served tree in memory (`materialize`), then writes it
 * out: the manifest + content-hash-named blocks/index chunks, and the generated client
 * (schema.ts + client.ts) in one pass.
 */
export function build(config: BlockDbConfig, opts: BuildOptions): BuildResult {
  const resolved = resolveConfig(config, opts.baseDir);
  const generatorVersion = opts.generatorVersion ?? getGeneratorVersion();
  const formatVersion = opts.formatVersion ?? getFormatVersion();

  const progress = opts.onProgress;

  const records = readInputRecords(resolved.inputPath, {
    format: resolved.inputFormat,
    delimiter: resolved.inputDelimiter,
    recordsPath: resolved.inputRecordsPath,
    fields: resolved.fields,
    ...(progress ? { onProgress: progress } : {}),
  });

  const { manifest, blockFiles, indexFiles, warnings } = materialize(resolved, records, {
    generatorVersion,
    formatVersion,
    sortRunRecords: opts.sortRunRecords,
    tmpDir: opts.tmpDir,
    ...(progress ? { onProgress: progress } : {}),
  });

  rmSync(resolved.output, { recursive: true, force: true });
  mkdirSync(resolved.output, { recursive: true });
  let blocksWritten = 0;
  for (const file of blockFiles) {
    const filePath = path.join(resolved.output, blockRelPath(file.hash, blockFiles.length, resolved.compression));
    mkdirSync(path.dirname(filePath), { recursive: true });
    // Compression is a transport concern applied only at write time — the content-hash (computed
    // in `block.ts`) stays over the LOGICAL uncompressed NDJSON, so toggling gzip between rebuilds
    // never perturbs block hashes or the manifest/index structures keyed on them.
    writeFileSync(filePath, compressServedFile(file.content, resolved.compression));
    progress?.({ phase: "writing data files", done: ++blocksWritten, total: blockFiles.length, unit: "count" });
  }
  let indexFilesWritten = 0;
  for (const { relPath, content } of indexFiles) {
    const filePath = path.join(resolved.output, relPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    // The relPath the manifest already points at decides this — see `servedSuffix` in `materialize`.
    writeFileSync(filePath, compressServedFile(content, resolved.compression));
    progress?.({ phase: "writing index files", done: ++indexFilesWritten, total: indexFiles.length, unit: "count" });
  }
  // Minified, not pretty-printed: every client downloads this file before it can run a query, and
  // the ADR-0003 §3 budget is measured on gzip(minified) — so indentation would be bytes the budget
  // never accounted for (~2.2x the file on a real dataset). `curl | jq` reads minified JSON fine.
  //
  // Under `gzip` it also ships pre-compressed. The name changes rather than the encoding alone, so a
  // stale plain `manifest.json` left in an output directory can never be silently served as if it
  // were current — and the generated client below is stamped with which one to fetch.
  const manifestJson = JSON.stringify(manifest);
  writeFileSync(
    path.join(resolved.output, `manifest.json${compressionSuffix(resolved.compression)}`),
    compressServedFile(manifestJson, resolved.compression),
  );

  progress?.({ phase: "generating client", done: 1, total: 1, unit: "count" });
  mkdirSync(resolved.clientOut, { recursive: true });
  writeFileSync(path.join(resolved.clientOut, "schema.ts"), generateSchemaTs(manifest, generatorVersion));
  writeFileSync(
    path.join(resolved.clientOut, "client.ts"),
    generateClientTs(manifest, {
      basePath: resolved.basePath,
      generatorVersion,
      ...(resolved.compression !== "none" ? { manifestCompression: resolved.compression } : {}),
    }),
  );

  return { manifest, outputDir: resolved.output, clientOutDir: resolved.clientOut, warnings };
}

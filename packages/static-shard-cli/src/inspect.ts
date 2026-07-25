import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { materialize } from "./build.js";
import { loadConfigFile, resolveConfig } from "./config.js";
import {
  MANIFEST_BUDGET_BYTES,
  estimateEqualityQueryCost,
  estimateRangeQueryCost,
  type IndexSizeEstimate,
  type QueryCostEstimate,
} from "./estimator.js";
import { readInputRecords } from "./input.js";
import { valuesOf } from "./secondary-index.js";
import { shardRelPath } from "./shard.js";
import type { IndexChunkDirEntry, Manifest } from "./types.js";
import { lowCardinalitySortFieldWarning, oversizedRecordWarning, skewedShardsWarning, sortFieldCardinalityOf } from "./warnings.js";

export interface InspectOptions {
  /** Absolute path to a `static-shard.config.json` — materializes the served tree in memory from the (unbuilt) input and reports it exactly, without ever writing `output`. */
  configPath?: string;
  /** Absolute path to a built `output` directory — reports the real artifacts already on disk, no rebuild. */
  dir?: string;
}

export interface ShardSizeDistribution {
  count: number;
  totalBytes: number;
  minBytes: number;
  maxBytes: number;
  meanBytes: number;
}

export interface InspectReport {
  /** `"config"`: materialized in memory from the (unbuilt) input. `"dir"`: read from real build output on disk. Both report exact, not estimated, numbers (ADR-0003's "exact re-report", as distinct from the wizard's sampled live estimate). */
  mode: "config" | "dir";
  collection: string;
  recordCount: number;
  shardCount: number;
  shards: ShardSizeDistribution;
  manifestBytes: number;
  manifestGzipBytes: number;
  manifestOverBudget: boolean;
  /** One entry per indexed non-sort field. */
  indexes: Record<string, IndexSizeEstimate>;
  perQuery: {
    equality?: QueryCostEstimate;
    range: QueryCostEstimate;
  };
  warnings: string[];
}

function shardSizeDistribution(shardBytes: number[]): ShardSizeDistribution {
  if (shardBytes.length === 0) return { count: 0, totalBytes: 0, minBytes: 0, maxBytes: 0, meanBytes: 0 };
  const totalBytes = shardBytes.reduce((sum, b) => sum + b, 0);
  return {
    count: shardBytes.length,
    totalBytes,
    minBytes: Math.min(...shardBytes),
    maxBytes: Math.max(...shardBytes),
    meanBytes: totalBytes / shardBytes.length,
  };
}

/** Sums one index's chunk files' real bytes and dictionary-entry count (= exact cardinality) via `readChunk`. */
function readChunkStats(chunks: IndexChunkDirEntry[], readChunk: (relPath: string) => string): { bytes: number; entryCount: number } {
  let bytes = 0;
  let entryCount = 0;
  for (const chunk of chunks) {
    const content = readChunk(chunk.file);
    bytes += Buffer.byteLength(content, "utf8");
    entryCount += (JSON.parse(content) as { entries: unknown[] }).entries.length;
  }
  return { bytes, entryCount };
}

interface StructuralReport {
  shards: ShardSizeDistribution;
  manifestBytes: number;
  manifestGzipBytes: number;
  manifestOverBudget: boolean;
  indexes: Record<string, IndexSizeEstimate>;
  perQuery: InspectReport["perQuery"];
  warnings: string[];
}

/**
 * The report structure both modes share: given a manifest, its exact serialized JSON (as `build`
 * would write it), a way to fetch an index chunk's content (disk in `--dir`, in-memory in
 * `--config`), and a way to measure one field's raw column bytes — produces exact shard/manifest/
 * index sizes and reuses the estimator's representative per-query-cost formulas fed with real
 * cardinality, so a formula change only has one place to land.
 */
function buildStructuralReport(opts: {
  manifest: Manifest;
  manifestJson: string;
  readChunk: (relPath: string) => string;
  columnBytesFor: (field: string, multi: boolean) => number;
}): StructuralReport {
  const { manifest, manifestJson, readChunk, columnBytesFor } = opts;

  const manifestBytes = Buffer.byteLength(manifestJson, "utf8");
  const manifestGzipBytes = gzipSync(manifestJson).length;
  const manifestOverBudget = manifestGzipBytes > MANIFEST_BUDGET_BYTES;

  const shards = shardSizeDistribution(manifest.shards.map((s) => s.bytes));

  const indexes: Record<string, IndexSizeEstimate> = {};
  const cardinalityByField: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [name, descriptor] of Object.entries(manifest.indexes)) {
    const base = readChunkStats(descriptor.chunks, readChunk);
    cardinalityByField[name] = base.entryCount;
    const report: IndexSizeEstimate = { baseBytes: base.bytes, baseChunks: descriptor.chunks.length };

    if (descriptor.reversed) {
      const reversed = readChunkStats(descriptor.reversed.chunks, readChunk);
      report.reversedBytes = reversed.bytes;
      report.reversedChunks = descriptor.reversed.chunks.length;
    }
    if (descriptor.trigram) {
      const trigram = readChunkStats(descriptor.trigram.chunks, readChunk);
      report.trigramBytes = trigram.bytes;
      report.trigramChunks = descriptor.trigram.chunks.length;

      const multi = manifest.schema.fields[name]?.multi === true;
      const columnBytes = columnBytesFor(name, multi);
      report.containsExceedsColumn = trigram.bytes > columnBytes;
      if (report.containsExceedsColumn) {
        warnings.push(
          `static-shard: contains(${name}): the trigram index (${trigram.bytes} bytes) is bigger than the raw "${name}" column (${columnBytes} bytes) — the single biggest build-output cost; consider disabling contains for this field.`,
        );
      }
    }

    indexes[name] = report;
  }

  if (manifestOverBudget) {
    warnings.push(
      `static-shard: root manifest is ${manifestGzipBytes} gzipped bytes, over the ~${MANIFEST_BUDGET_BYTES} budget even after spilling every secondary zonemap to a sidecar (ADR-0003 §3) — consider fewer indexed fields.`,
    );
  }
  const skewWarning = skewedShardsWarning(manifest.shards);
  if (skewWarning) warnings.push(skewWarning);

  const equalityField = Object.entries(cardinalityByField)[0];
  const perQuery: InspectReport["perQuery"] = {
    range: estimateRangeQueryCost(manifest.shards.length, shards.meanBytes || manifest.shards[0]?.bytes || 0),
  };
  if (equalityField) {
    const [name, cardinality] = equalityField;
    const idx = indexes[name]!;
    const avgChunkBytes = idx.baseChunks > 0 ? idx.baseBytes / idx.baseChunks : idx.baseBytes;
    perQuery.equality = estimateEqualityQueryCost(
      cardinality,
      manifest.dataset.recordCount,
      manifest.shards.length,
      shards.meanBytes,
      avgChunkBytes,
    );
  }

  return { shards, manifestBytes, manifestGzipBytes, manifestOverBudget, indexes, perQuery, warnings };
}

function inspectConfig(configPath: string): InspectReport {
  const config = loadConfigFile(configPath);
  const resolved = resolveConfig(config, path.dirname(configPath));

  const records = readInputRecords(resolved.inputPath, {
    format: resolved.inputFormat,
    delimiter: resolved.inputDelimiter,
    recordsPath: resolved.inputRecordsPath,
    fields: resolved.fields,
  });

  const { manifest, indexFiles } = materialize(resolved, records);
  const manifestJson = JSON.stringify(manifest); // same serialization `build` writes to disk (build.ts)

  const chunkContent = new Map(indexFiles.map((f) => [f.relPath, f.content]));
  const readChunk = (relPath: string): string => {
    const content = chunkContent.get(relPath);
    if (content === undefined) throw new Error(`static-shard: inspect — missing in-memory index chunk "${relPath}"`);
    return content;
  };
  const columnBytesFor = (field: string, multi: boolean): number => {
    let bytes = 0;
    for (const record of records) {
      for (const value of valuesOf(record, field, multi)) {
        if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
      }
    }
    return bytes;
  };

  const structural = buildStructuralReport({ manifest, manifestJson, readChunk, columnBytesFor });

  const warnings = [...structural.warnings];
  const cardinalityWarning = lowCardinalitySortFieldWarning(
    manifest.dataset.recordCount,
    sortFieldCardinalityOf(records, resolved.sortField),
  );
  if (cardinalityWarning) warnings.push(cardinalityWarning);

  const maxRecordBytes = records.reduce((max, r) => Math.max(max, Buffer.byteLength(JSON.stringify(r), "utf8")), 0);
  const oversizedWarning = oversizedRecordWarning(maxRecordBytes, resolved.shardBytes);
  if (oversizedWarning) warnings.push(oversizedWarning);

  return {
    mode: "config",
    collection: manifest.dataset.collection,
    recordCount: manifest.dataset.recordCount,
    shardCount: manifest.dataset.shardCount,
    ...structural,
    warnings,
  };
}

function inspectDir(dir: string): InspectReport {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`static-shard: inspect --dir "${dir}" has no manifest.json — has it been built yet?`);
  }
  const manifestJson = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestJson) as Manifest;

  const readChunk = (relPath: string): string => readFileSync(path.join(dir, relPath), "utf8");
  const columnBytesFor = (field: string, multi: boolean): number => {
    let bytes = 0;
    for (const shard of manifest.shards) {
      const shardPath = path.join(dir, shardRelPath(shard.hash, manifest.shards.length, manifest.dataset.gzip === true));
      const content = manifest.dataset.gzip === true
        ? gunzipSync(readFileSync(shardPath)).toString("utf8")
        : readFileSync(shardPath, "utf8");
      for (const line of content.split("\n")) {
        if (line.length === 0) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        for (const value of valuesOf(record, field, multi)) {
          if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
        }
      }
    }
    return bytes;
  };

  const structural = buildStructuralReport({ manifest, manifestJson, readChunk, columnBytesFor });

  // No low-cardinality-sort-field warning here: the manifest doesn't carry the sort field's true
  // distinct-value count, and split-points can't substitute — each shard's min split-point is
  // necessarily unique by construction (equal-key runs stay in one shard), so counting distinct
  // split-points always just equals shardCount, undercounting whenever several values pack into
  // one shard. `inspect --config` has the raw records and can compute this exactly instead.
  const warnings = [...structural.warnings];
  const singleRecordOutlier = manifest.shards.find(
    (s) => s.count === 1 && structural.shards.meanBytes > 0 && s.bytes > structural.shards.meanBytes * 1.5,
  );
  if (singleRecordOutlier) {
    warnings.push(
      `static-shard: shard "${singleRecordOutlier.hash}" holds a single record at ${singleRecordOutlier.bytes} bytes, well over the mean — likely the oversized-record case (ADR-0002 §5).`,
    );
  }

  return {
    mode: "dir",
    collection: manifest.dataset.collection,
    recordCount: manifest.dataset.recordCount,
    shardCount: manifest.dataset.shardCount,
    ...structural,
    warnings,
  };
}

/**
 * Read-only cost/health report over a config (materialized in memory from the unbuilt input) or a
 * built `output` directory (the real artifacts) — never rebuilds/writes (ADR-0005 §4).
 */
export function inspect(opts: InspectOptions): InspectReport {
  if (opts.configPath !== undefined && opts.dir !== undefined) {
    throw new Error('static-shard: inspect accepts exactly one of "--config" or "--dir", not both');
  }
  if (opts.configPath !== undefined) return inspectConfig(opts.configPath);
  if (opts.dir !== undefined) return inspectDir(opts.dir);
  throw new Error('static-shard: inspect needs "--config <path>" or "--dir <path>"');
}

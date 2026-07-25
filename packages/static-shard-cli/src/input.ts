import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FieldConfig, FieldKind, InputFormat } from "./types.js";

export interface InputReadOptions {
  format: InputFormat;
  /** Column delimiter for csv/tsv; ignored for ndjson/json. */
  delimiter: string;
  /** JSON only: dot-path to the nested array/map of records (record selector). */
  recordsPath?: string;
  fields: Record<string, FieldConfig>;
  /**
   * ndjson only: stop after reading this many records. Lets `init`/the wizard parse just the
   * leading sample instead of the whole dataset. Ignored by json/csv/tsv (whole-document formats).
   */
  limit?: number;
}

const GLOB_MAGIC = /[*?]/;

function hasGlobMagic(segment: string): boolean {
  return GLOB_MAGIC.test(segment);
}

function segmentToRegExp(segment: string): RegExp {
  let pattern = "^";
  for (const ch of segment) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(pattern + "$");
}

function walkGlob(dir: string, segments: string[], results: string[], visitedRealDirs: Set<string>): void {
  if (segments.length === 0) return;
  const [segment, ...rest] = segments as [string, ...string[]];

  if (segment === "**") {
    walkGlob(dir, rest, results, visitedRealDirs);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      // Guard `**`'s unbounded recursion against symlink cycles (a fixed-segment pattern can't loop).
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (visitedRealDirs.has(real)) continue;
      visitedRealDirs.add(real);
      walkGlob(full, segments, results, visitedRealDirs);
    }
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const regex = segmentToRegExp(segment);
  for (const entry of entries) {
    if (!regex.test(entry)) continue;
    const full = path.join(dir, entry);
    if (rest.length === 0) {
      if (statSync(full).isFile()) results.push(full);
    } else if (statSync(full).isDirectory()) {
      walkGlob(full, rest, results, visitedRealDirs);
    }
  }
}

/** Expands a single path or glob pattern (`*`/`?`/`**`) to a sorted list of matching absolute file paths (T9). */
export function expandInputFiles(absPathOrPattern: string): string[] {
  const segments = absPathOrPattern.split(path.sep);
  const firstGlobIdx = segments.findIndex(hasGlobMagic);
  if (firstGlobIdx === -1) return [absPathOrPattern];

  const startDir = segments.slice(0, firstGlobIdx).join(path.sep) || path.sep;
  const patternSegments = segments.slice(firstGlobIdx);
  const results: string[] = [];
  walkGlob(startDir, patternSegments, results, new Set());
  return results.sort();
}

const NDJSON_READ_CHUNK_BYTES = 1 << 20; // 1 MiB

/**
 * Streams an NDJSON file a fixed-size chunk at a time, invoking `onLine` for each non-empty,
 * trimmed line — so a source larger than V8's ~512 MB max string length never has to exist as one
 * string (the old `readFileSync(…, "utf8")` threw on such inputs). A streaming `TextDecoder` absorbs
 * multi-byte UTF-8 sequences split across a chunk boundary. `onLine` returns `false` to stop early
 * (e.g. once a sample limit is reached), so callers touch only the head of a huge file.
 */
function forEachNdjsonLine(filePath: string, onLine: (line: string) => boolean): void {
  const fd = openSync(filePath, "r");
  try {
    const decoder = new TextDecoder("utf-8");
    const chunk = Buffer.allocUnsafe(NDJSON_READ_CHUNK_BYTES);
    let pending = "";

    const handle = (raw: string): boolean => {
      const trimmed = raw.trim();
      return trimmed.length === 0 ? true : onLine(trimmed);
    };

    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        pending += decoder.decode(); // flush any trailing partial multi-byte sequence
        break;
      }
      pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newlineIdx);
        pending = pending.slice(newlineIdx + 1);
        if (!handle(line)) return;
      }
    }

    if (pending.length > 0) handle(pending);
  } finally {
    closeSync(fd);
  }
}

function readNdjsonRecords(filePath: string, limit?: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  forEachNdjsonLine(filePath, (line) => {
    records.push(JSON.parse(line) as Record<string, unknown>);
    return limit === undefined || records.length < limit;
  });
  return records;
}

function navigateRecordsPath(doc: unknown, recordsPath: string): unknown {
  let node: unknown = doc;
  for (const key of recordsPath.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(
        `static-shard: input.records path "${recordsPath}" — "${key}" cannot be navigated into (not an object)`,
      );
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function selectRecordsFromNode(node: unknown, recordsPath: string | undefined): Record<string, unknown>[] {
  if (Array.isArray(node)) return node as Record<string, unknown>[];
  if (node !== null && typeof node === "object") {
    return Object.values(node as Record<string, unknown>) as Record<string, unknown>[];
  }
  throw new Error(
    `static-shard: input.records${recordsPath ? ` path "${recordsPath}"` : ""} did not land on an array or object of records`,
  );
}

function readJsonRecords(filePath: string, recordsPath: string | undefined): Record<string, unknown>[] {
  const doc: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const node = recordsPath === undefined ? doc : navigateRecordsPath(doc, recordsPath);
  return selectRecordsFromNode(node, recordsPath);
}

/** RFC4180-ish: quoted fields may contain the delimiter, newlines, and `""`-escaped quotes. */
function parseDelimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Empty cell ⇒ absent (the key is omitted, not coerced to `""`/`NaN`) — CSV/TSV has no null literal.
 * A cell that can't be coerced to its declared kind fails loud rather than silently admitting a
 * wrong-typed value (a `NaN` or stray string) into the record.
 */
function coerceCsvValue(raw: string, fieldName: string, kind: FieldKind | undefined): unknown {
  if (raw === "") return undefined;
  if (kind === "number") {
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new Error(
        `static-shard: input field "${fieldName}" is declared kind "number" but CSV/TSV cell "${raw}" isn't a valid number`,
      );
    }
    return value;
  }
  if (kind === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(
      `static-shard: input field "${fieldName}" is declared kind "boolean" but CSV/TSV cell "${raw}" is neither "true" nor "false"`,
    );
  }
  return raw;
}

function readDelimitedRecords(
  filePath: string,
  delimiter: string,
  fields: Record<string, FieldConfig>,
): Record<string, unknown>[] {
  const rows = parseDelimitedRows(readFileSync(filePath, "utf8"), delimiter);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).map((cells) => {
    const record: Record<string, unknown> = {};
    header.forEach((name, idx) => {
      const value = coerceCsvValue(cells[idx] ?? "", name, fields[name]?.kind);
      if (value !== undefined) record[name] = value;
    });
    return record;
  });
}

/**
 * Reads and merges records from a single path or glob pattern, per the configured
 * input format and record selector (T9). Same-format files matched by a glob are
 * concatenated in filename order as one dataset.
 */
export function readInputRecords(inputPathOrGlob: string, opts: InputReadOptions): Record<string, unknown>[] {
  const files = expandInputFiles(inputPathOrGlob);
  if (files.length === 0) {
    throw new Error(`static-shard: no input files matched "${inputPathOrGlob}"`);
  }

  const records: Record<string, unknown>[] = [];
  for (const file of files) {
    if (opts.limit !== undefined && records.length >= opts.limit) break;
    switch (opts.format) {
      case "ndjson": {
        const remaining = opts.limit === undefined ? undefined : opts.limit - records.length;
        records.push(...readNdjsonRecords(file, remaining));
        break;
      }
      case "json":
        records.push(...readJsonRecords(file, opts.recordsPath));
        break;
      case "csv":
      case "tsv":
        records.push(...readDelimitedRecords(file, opts.delimiter, opts.fields));
        break;
      default:
        throw new Error(
          `static-shard: unknown input format "${String(opts.format)}" — expected one of "ndjson", "json", "csv", "tsv"`,
        );
    }
  }
  return records;
}

/** True dataset totals — record count and raw JSON payload bytes — over the whole input. */
export interface PopulationStats {
  recordCount: number;
  datasetBytes: number;
}

/**
 * Counts the FULL dataset's record count and payload bytes without holding it in memory or parsing
 * it: NDJSON is streamed line by line (constant memory, no JSON.parse), so `init`'s wizard can show
 * the true dataset size and scale its size/shard estimates even while inferring the schema from just
 * a sample. Whole-document formats (json/csv/tsv) have no streaming win, so they're read normally.
 */
export function countInputRecords(inputPathOrGlob: string, opts: InputReadOptions): PopulationStats {
  const files = expandInputFiles(inputPathOrGlob);
  if (files.length === 0) {
    throw new Error(`static-shard: no input files matched "${inputPathOrGlob}"`);
  }

  if (opts.format === "ndjson") {
    let recordCount = 0;
    let datasetBytes = 0;
    for (const file of files) {
      forEachNdjsonLine(file, (line) => {
        recordCount++;
        datasetBytes += Buffer.byteLength(line, "utf8");
        return true;
      });
    }
    return { recordCount, datasetBytes };
  }

  const records = readInputRecords(inputPathOrGlob, { ...opts, limit: undefined });
  return {
    recordCount: records.length,
    datasetBytes: records.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r), "utf8"), 0),
  };
}

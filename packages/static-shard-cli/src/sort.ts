import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SortKind = "number" | "date" | "string";

/**
 * Compares two sort-field values. Missing values (null/undefined) sort after
 * every real value (ADR-0002: missing sort values cluster at the high end).
 * Within the missing block, null sorts before undefined (absent) so the two
 * stay separately contiguous rather than interleaved (ADR-0002 §9).
 */
export function compareSortValues(a: unknown, b: unknown, kind: SortKind): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) {
    if (a === b) return 0;
    return a === null ? -1 : 1;
  }
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (kind === "number") {
    return (a as number) - (b as number);
  }
  // string and date share one branch: dates are ISO strings, so lexicographic order IS chronological
  // order for them — which is why a string sort field needs no comparison logic of its own.
  const av = a as string;
  const bv = b as string;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Generic ascending compare for a tiebreak field of any scalar kind; missing sorts last. */
function compareTiebreak(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const av = a as number | string;
  const bv = b as number | string;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * Total order over records for the global sort (ADR-0002 §6 "secondary tiebreak sort within equal
 * keys"): primary by the sort field, then the declared PK (if any), then a canonical full-record
 * comparison. This makes the result independent of input row order — re-exporting the same
 * logical dataset in a different physical order still produces byte-identical shards (ADR-0003 §8).
 */
export function compareRecordsForSort(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  sortField: string,
  kind: SortKind,
  pk?: string,
): number {
  const primary = compareSortValues(a[sortField], b[sortField], kind);
  if (primary !== 0) return primary;
  if (pk !== undefined) {
    const pkCompare = compareTiebreak(a[pk], b[pk]);
    if (pkCompare !== 0) return pkCompare;
  }
  const aKey = JSON.stringify(a);
  const bKey = JSON.stringify(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export interface ExternalSortOptions {
  sortField: string;
  kind: SortKind;
  pk?: string;
  /** Records buffered per sorted run before spilling to disk; a source at or under this size sorts purely in memory. */
  runRecords: number;
  /** Scratch directory external sort creates a run-file subdirectory under; removed before returning. */
  tmpDir: string;
}

function writeRun(dir: string, index: number, run: Record<string, unknown>[]): string {
  const filePath = path.join(dir, `run-${index}.ndjson`);
  writeFileSync(filePath, run.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return filePath;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads one run file a fixed-size chunk at a time and yields it line by line — so merging N runs
 * holds only ~N × `READ_CHUNK_BYTES` in memory at once, not each run's full content. A `TextDecoder`
 * in streaming mode absorbs multi-byte UTF-8 sequences split across a chunk boundary.
 */
class RunReader {
  private readonly fd: number;
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private eof = false;

  constructor(filePath: string) {
    this.fd = openSync(filePath, "r");
  }

  private fill(): void {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    const bytesRead = readSync(this.fd, chunk, 0, READ_CHUNK_BYTES, null);
    if (bytesRead === 0) {
      this.eof = true;
      this.buffer += this.decoder.decode(); // flush any trailing partial sequence
      closeSync(this.fd);
      return;
    }
    this.buffer += this.decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
  }

  /** The next parsed record, or `undefined` once the run is exhausted (closing its file descriptor). */
  next(): Record<string, unknown> | undefined {
    for (;;) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;
        return JSON.parse(line) as Record<string, unknown>;
      }
      if (this.eof) {
        const line = this.buffer.trim();
        this.buffer = "";
        return line.length === 0 ? undefined : (JSON.parse(line) as Record<string, unknown>);
      }
      this.fill();
    }
  }
}

/**
 * Sorts `source` by `compareRecordsForSort`. A source at or under `runRecords` sorts purely in
 * memory (the common case, and every case in today's build — `readInputRecords` still loads the
 * full input up front). Above that threshold, `externalSort` spills memory-bounded sorted runs to
 * NDJSON temp files under `tmpDir`, then k-way-merges those runs back into the final ordering by
 * reading each run through a small fixed-size buffer (`RunReader`) rather than loading any run's
 * full content at once — so read+sort+merge peaks at O(run count × a small chunk size), not the
 * dataset size (ADR-0002 §9). Shard-cutting/indexing downstream still consume the merged result
 * as one in-memory array — a deliberate T13 scope boundary, not attempted here.
 */
export function externalSort(
  source: Record<string, unknown>[],
  opts: ExternalSortOptions,
): Record<string, unknown>[] {
  const compare = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
    compareRecordsForSort(a, b, opts.sortField, opts.kind, opts.pk);

  if (source.length <= opts.runRecords) {
    return [...source].sort(compare);
  }

  const scratchDir = mkdtempSync(path.join(opts.tmpDir, "static-shard-sort-"));
  try {
    const runFiles: string[] = [];
    for (let start = 0; start < source.length; start += opts.runRecords) {
      const run = source.slice(start, start + opts.runRecords).sort(compare);
      runFiles.push(writeRun(scratchDir, runFiles.length, run));
    }

    const readers: RunReader[] = runFiles.map((filePath) => new RunReader(filePath));
    const heads: (Record<string, unknown> | undefined)[] = readers.map((reader) => reader.next());

    const merged: Record<string, unknown>[] = [];
    for (;;) {
      let bestIdx = -1;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        if (head === undefined) continue;
        if (bestIdx === -1 || compare(head, heads[bestIdx]!) < 0) bestIdx = i;
      }
      if (bestIdx === -1) break;
      merged.push(heads[bestIdx]!);
      heads[bestIdx] = readers[bestIdx]!.next();
    }
    return merged;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

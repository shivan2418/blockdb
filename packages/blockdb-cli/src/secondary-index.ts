import type { FieldKind, PairZonemapEntry } from "./types.js";

const DEFAULT_TRUNCATE_LEN = 12;

/** Parquet-style lower truncation: a proper prefix always compares ≤ the true value. */
export function truncateStringLower(value: string, maxLen = DEFAULT_TRUNCATE_LEN): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

/** Codepoint-safe reversal — used to build the reversed-value index for `endsWith` (ADR-0003 §7). */
export function reverseString(value: string): string {
  return [...value].reverse().join("");
}

/** Increments the last code point of `prefix` so the result strictly exceeds every string sharing it. */
function incrementString(prefix: string): string {
  const chars = [...prefix];
  for (let i = chars.length - 1; i >= 0; i--) {
    const code = chars[i]!.codePointAt(0)!;
    if (code < 0x10ffff) {
      chars[i] = String.fromCodePoint(code + 1);
      return chars.slice(0, i + 1).join("");
    }
  }
  return prefix + "￿";
}

/** Parquet-style "next string after" upper truncation — a strict upper bound a few bytes long. */
export function truncateStringUpper(value: string, maxLen = DEFAULT_TRUNCATE_LEN): string {
  return value.length <= maxLen ? value : incrementString(value.slice(0, maxLen));
}

/**
 * The values one record contributes for `field`: a multi-valued field's record
 * holds an array (each element indexed individually, existentially matched via
 * `some` — T7); a single-valued field holds one scalar. Null/undefined entries
 * are skipped either way — same "no index entry for absent data" rule as before.
 */
/** The values one record contributes for `field` — a shared primitive: a multi-valued field's
 * record holds an array (each element indexed individually via `some`, T7); a single-valued
 * field holds one scalar. Also used by `estimator.ts` to profile the same fields the same way. */
export function valuesOf(record: Record<string, unknown>, field: string, multi: boolean): unknown[] {
  if (!multi) return [record[field]];
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

function canonicalKey(value: unknown, kind: FieldKind): string {
  if (kind === "number") return String(value as number);
  if (kind === "boolean") return String(value as boolean);
  return value as string; // string | date — dates are already ISO strings
}

function compareByKind(a: unknown, b: unknown, kind: FieldKind): number {
  if (kind === "number") return (a as number) - (b as number);
  if (kind === "boolean") return a === b ? 0 : a ? 1 : -1;
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

/** Per-block [min,max] over `field`, ordinal-aligned with `groups` (ADR-0002 §7 / ADR-0003 §2, §9). */
export function computeSecondaryZonemap(
  groups: Record<string, unknown>[][],
  field: string,
  kind: FieldKind,
  multi = false,
): PairZonemapEntry {
  const pairs: [unknown, unknown][] = groups.map((group) => {
    let min: unknown;
    let max: unknown;
    for (const record of group) {
      for (const value of valuesOf(record, field, multi)) {
        if (value === null || value === undefined) continue;
        if (min === undefined || compareByKind(value, min, kind) < 0) min = value;
        if (max === undefined || compareByKind(value, max, kind) > 0) max = value;
      }
    }
    // A block can hold zero non-null values for an absentable field (T7) — no bound to compute or truncate.
    if (min === undefined) return [undefined, undefined];
    if (kind === "string") {
      return [truncateStringLower(min as string), truncateStringUpper(max as string)];
    }
    return [min, max];
  });

  return kind === "string" ? { pairs, truncated: true } : { pairs };
}

export interface IndexChunkEntry {
  /** Chars shared with the PREVIOUS entry's canonical key; 0 for a chunk's first entry (front-coding, ADR-0003 §4). */
  prefixLen: number;
  suffix: string;
  /** Delta-encoded ascending block ordinals — cumulative-sum from 0 reconstructs them (ADR-0003 §5). */
  postings: number[];
}

export interface IndexChunkFile {
  entries: IndexChunkEntry[];
}

export interface BuiltIndexChunk {
  from: unknown;
  to: unknown;
  content: string;
}

interface DictEntry {
  value: unknown;
  key: string;
  blockIndices: number[];
}

function collectDistinctValues(
  groups: Record<string, unknown>[][],
  field: string,
  kind: FieldKind,
  multi = false,
): DictEntry[] {
  const byKey = new Map<string, DictEntry>();
  groups.forEach((group, blockIndex) => {
    for (const record of group) {
      for (const value of valuesOf(record, field, multi)) {
        if (value === null || value === undefined) continue;
        const key = canonicalKey(value, kind);
        let entry = byKey.get(key);
        if (!entry) {
          entry = { value, key, blockIndices: [] };
          byKey.set(key, entry);
        }
        if (entry.blockIndices[entry.blockIndices.length - 1] !== blockIndex) entry.blockIndices.push(blockIndex);
      }
    }
  });
  return [...byKey.values()].sort((a, b) => compareByKind(a.value, b.value, kind));
}

function encodeEntry(entry: DictEntry, prevKey: string): IndexChunkEntry {
  const maxShared = Math.min(prevKey.length, entry.key.length);
  let prefixLen = 0;
  while (prefixLen < maxShared && prevKey[prefixLen] === entry.key[prefixLen]) prefixLen++;

  const postings: number[] = [];
  let prev = 0;
  for (const blockIndex of entry.blockIndices) {
    postings.push(blockIndex - prev);
    prev = blockIndex;
  }

  return { prefixLen, suffix: entry.key.slice(prefixLen), postings };
}

/** Cuts a sorted distinct-value dictionary into front-coded, delta-encoded, ~chunkBytes-sized chunks. */
function buildChunksFromDictionary(distinct: DictEntry[], chunkBytes: number): BuiltIndexChunk[] {
  if (distinct.length === 0) return [];

  const chunks: BuiltIndexChunk[] = [];
  let currentEntries: IndexChunkEntry[] = [];
  let currentBytes = 0;
  let chunkFirstValue: unknown;

  const flush = (lastValue: unknown): void => {
    if (currentEntries.length === 0) return;
    chunks.push({
      from: chunkFirstValue,
      to: lastValue,
      content: JSON.stringify({ entries: currentEntries } satisfies IndexChunkFile),
    });
    currentEntries = [];
    currentBytes = 0;
  };

  for (let i = 0; i < distinct.length; i++) {
    const dictEntry = distinct[i]!;
    const isChunkStart = currentEntries.length === 0;
    const prevKey = isChunkStart ? "" : distinct[i - 1]!.key;
    const encoded = encodeEntry(dictEntry, prevKey);
    const entryBytes = JSON.stringify(encoded).length + 1;

    if (!isChunkStart && currentBytes + entryBytes > chunkBytes) {
      flush(distinct[i - 1]!.value);
      const restart = encodeEntry(dictEntry, "");
      currentEntries.push(restart);
      currentBytes = JSON.stringify(restart).length + 1;
      chunkFirstValue = dictEntry.value;
    } else {
      if (isChunkStart) chunkFirstValue = dictEntry.value;
      currentEntries.push(encoded);
      currentBytes += entryBytes;
    }
  }
  flush(distinct[distinct.length - 1]!.value);

  return chunks;
}

/**
 * Builds the chunked inverted index for one non-sort indexed field (ADR-0003):
 * distinct values sorted, front-coded within each chunk (so a chunk decodes
 * standalone), delta-encoded postings (value → block ordinals), cut into
 * ~chunkBytes-sized groups.
 */
export function buildInvertedIndex(
  groups: Record<string, unknown>[][],
  field: string,
  kind: FieldKind,
  chunkBytes: number,
  multi = false,
): BuiltIndexChunk[] {
  return buildChunksFromDictionary(collectDistinctValues(groups, field, kind, multi), chunkBytes);
}

/**
 * Builds the reversed-value index that unlocks `endsWith` (ADR-0003 §7): the
 * SAME chunked-dictionary structure as the base index, keyed on each string
 * value reversed — so `endsWith("son")` becomes a `startsWith` prefix-range
 * query on this index once the runtime reverses the query value too.
 */
export function buildReversedIndex(
  groups: Record<string, unknown>[][],
  field: string,
  chunkBytes: number,
  multi = false,
): BuiltIndexChunk[] {
  const reversedGroups = groups.map((group) =>
    group.flatMap((record) =>
      valuesOf(record, field, multi)
        .filter((value): value is string => value !== null && value !== undefined)
        .map((value) => ({ [field]: reverseString(value) })),
    ),
  );
  return buildInvertedIndex(reversedGroups, field, "string", chunkBytes);
}

/** Every sliding 3-char window of `value` — the dictionary keys of a trigram index. */
function trigramsOf(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i <= value.length - 3; i++) grams.push(value.slice(i, i + 3));
  return grams;
}

function collectDistinctTrigrams(groups: Record<string, unknown>[][], field: string, multi = false): DictEntry[] {
  const byKey = new Map<string, DictEntry>();
  groups.forEach((group, blockIndex) => {
    for (const record of group) {
      for (const value of valuesOf(record, field, multi)) {
        if (value === null || value === undefined) continue;
        for (const gram of trigramsOf(value as string)) {
          let entry = byKey.get(gram);
          if (!entry) {
            entry = { value: gram, key: gram, blockIndices: [] };
            byKey.set(gram, entry);
          }
          if (entry.blockIndices[entry.blockIndices.length - 1] !== blockIndex) entry.blockIndices.push(blockIndex);
        }
      }
    }
  });
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Builds the trigram index that unlocks `contains` (ADR-0003 §7): every
 * distinct 3-char substring across the field's values, front-coded/delta-
 * encoded exactly like the base index, but keyed on trigrams rather than
 * whole values — a value shorter than 3 chars contributes none.
 */
export function buildTrigramIndex(
  groups: Record<string, unknown>[][],
  field: string,
  chunkBytes: number,
  multi = false,
): BuiltIndexChunk[] {
  return buildChunksFromDictionary(collectDistinctTrigrams(groups, field, multi), chunkBytes);
}

/**
 * Mean postings-list length across a built structure's dictionary entries — i.e. how many blocks
 * the average lookup on it resolves to. Compared against `blockCount` this is the one number that
 * says whether an index actually *prunes*: an entry pointing at most blocks buys nothing, since the
 * query still has to fetch most of the dataset. `undefined` for an empty structure.
 */
export function meanPostingsLength(chunks: BuiltIndexChunk[]): number | undefined {
  let entries = 0;
  let postings = 0;
  for (const chunk of chunks) {
    const parsed = JSON.parse(chunk.content) as IndexChunkFile;
    for (const entry of parsed.entries) {
      entries++;
      postings += entry.postings.length;
    }
  }
  return entries === 0 ? undefined : postings / entries;
}

/**
 * Ordinals of the blocks holding at least one record whose `field` is a present `[]` — what `isEmpty`
 * and `every` prune on (ADR-0010 §4). A missing key or `null` is not an empty list (§3), so neither
 * counts.
 */
export function emptyListBlocks(groups: Record<string, unknown>[][], field: string): number[] {
  const ordinals: number[] = [];
  groups.forEach((group, ordinal) => {
    if (group.some((record) => Array.isArray(record[field]) && (record[field] as unknown[]).length === 0)) {
      ordinals.push(ordinal);
    }
  });
  return ordinals;
}

/** Total UTF-8 bytes of the field's raw (non-null) string values — the "size of the column" ADR-0003 §7 warns against exceeding. */
export function computeColumnBytes(groups: Record<string, unknown>[][], field: string, multi = false): number {
  let bytes = 0;
  for (const group of groups) {
    for (const record of group) {
      for (const value of valuesOf(record, field, multi)) {
        if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
      }
    }
  }
  return bytes;
}

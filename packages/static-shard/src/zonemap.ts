// Zonemap pruning over the sort field's split-points (ADR-0002/0003): the
// split-points ARE the search structure — binary search finds the shards that
// could possibly satisfy a where-filter on the sort field, so only those need
// to be fetched.

export type SortValue = number | string;

export interface SortFieldFilter {
  equals?: SortValue;
  in?: SortValue[];
  gt?: SortValue;
  gte?: SortValue;
  lt?: SortValue;
  lte?: SortValue;
  /** String sort fields only: a prefix is a contiguous range once values are sorted (ADR-0003 §7). */
  startsWith?: string;
}

/** Higher than any realistic code point in a stored value, so `[p, p + this]` brackets every string starting with `p`. */
const PREFIX_UPPER_SENTINEL = "\u{10FFFF}";

function pointShardIndex(splitPoints: readonly SortValue[], value: SortValue, shardCount: number): number {
  let lo = 0;
  let hi = shardCount - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (splitPoints[mid]! <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function upperBoundShardIndex(
  splitPoints: readonly SortValue[],
  value: SortValue,
  shardCount: number,
  strict: boolean,
): number {
  let lo = 0;
  let hi = shardCount - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const boundOk = strict ? splitPoints[mid]! < value : splitPoints[mid]! <= value;
    if (boundOk) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function isWithinGlobalRange(splitPoints: readonly SortValue[], value: SortValue): boolean {
  return value >= splitPoints[0]! && value <= splitPoints[splitPoints.length - 1]!;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** Shard ordinals (into `manifest.shards`) that could satisfy `filter` on the sort field. */
export function candidateShardIndices(
  splitPoints: readonly SortValue[],
  filter: SortFieldFilter | undefined,
): number[] {
  const shardCount = splitPoints.length - 1;
  if (shardCount <= 0) return [];

  if (!filter || Object.keys(filter).length === 0) return range(0, shardCount - 1);

  if (filter.in !== undefined) {
    const indices = new Set<number>();
    for (const value of filter.in) {
      if (isWithinGlobalRange(splitPoints, value)) indices.add(pointShardIndex(splitPoints, value, shardCount));
    }
    return [...indices].sort((a, b) => a - b);
  }

  if (filter.equals !== undefined) {
    if (!isWithinGlobalRange(splitPoints, filter.equals)) return [];
    return [pointShardIndex(splitPoints, filter.equals, shardCount)];
  }

  // `startsWith(p)` IS the closed range [p, p+sentinel] on a sorted string field — free pruning off
  // the split-points already in the manifest, no index chunk to fetch. Composes with an explicit
  // range by intersecting: both bounds narrow the same span.
  const lower = filter.startsWith !== undefined ? filter.startsWith : (filter.gte ?? filter.gt);
  const upper =
    filter.startsWith !== undefined ? filter.startsWith + PREFIX_UPPER_SENTINEL : (filter.lte ?? filter.lt);
  const strictUpper = filter.startsWith === undefined && filter.lt !== undefined;

  const startIdx = lower !== undefined ? pointShardIndex(splitPoints, lower, shardCount) : 0;
  const endIdx =
    upper !== undefined ? upperBoundShardIndex(splitPoints, upper, shardCount, strictUpper) : shardCount - 1;

  if (endIdx < startIdx) return [];
  return range(startIdx, endIdx);
}

/** A secondary field's equals/in constraint — the only shapes a per-shard [min,max] pair can weakly prune (ADR-0003 §6 step 1). */
export interface PairRangeFilter {
  equals?: unknown;
  in?: unknown[];
}

function withinPair(pair: readonly [unknown, unknown], value: unknown): boolean {
  const [min, max] = pair;
  // A shard with zero non-null values for this field has no bound to compare against (ADR-0002 §5/T7).
  if (min === undefined || max === undefined) return false;
  return (min as never) <= (value as never) && (value as never) <= (max as never);
}

/**
 * Shard ordinals whose per-shard `[min,max]` pair could contain any of `filter`'s values — the
 * secondary-field counterpart of `candidateShardIndices` (ADR-0003 §6 step 1: "apply all free
 * zonemap pruning first"). String bounds are truncated but never past the true value (ADR-0003
 * §2), so this can only ever OVER-approximate — it never excludes a real match. `undefined` means
 * the filter shape (e.g. `startsWith`) isn't one a min/max pair can prune; the caller should treat
 * that as "no zonemap signal" rather than as an empty set.
 */
export function pairCandidateShardIndices(
  pairs: readonly (readonly [unknown, unknown])[],
  filter: PairRangeFilter,
): Set<number> | undefined {
  if (filter.equals === undefined && filter.in === undefined) return undefined;

  const indices = new Set<number>();
  const values = filter.in ?? [filter.equals];
  pairs.forEach((pair, i) => {
    if (values.some((value) => withinPair(pair, value))) indices.add(i);
  });
  return indices;
}

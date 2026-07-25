import { describe, expect, test } from "vitest";
import { candidateShardIndices, pairCandidateShardIndices } from "../src/zonemap.js";

// 3 shards: shard0 [1900,1950), shard1 [1950,2000), shard2 [2000,2020] (inclusive both ends, last shard).
const splitPoints = [1900, 1950, 2000, 2020];

describe("candidateShardIndices", () => {
  test("no filter (or empty filter) selects every shard", () => {
    expect(candidateShardIndices(splitPoints, undefined)).toEqual([0, 1, 2]);
    expect(candidateShardIndices(splitPoints, {})).toEqual([0, 1, 2]);
  });

  test("equals selects exactly the one containing shard", () => {
    expect(candidateShardIndices(splitPoints, { equals: 1925 })).toEqual([0]);
    expect(candidateShardIndices(splitPoints, { equals: 1950 })).toEqual([1]); // boundary → next shard
    expect(candidateShardIndices(splitPoints, { equals: 2020 })).toEqual([2]); // last shard is closed both ends
  });

  test("equals outside the global range selects nothing", () => {
    expect(candidateShardIndices(splitPoints, { equals: 1800 })).toEqual([]);
    expect(candidateShardIndices(splitPoints, { equals: 2025 })).toEqual([]);
  });

  test("in selects the union of each value's shard, deduplicated and sorted", () => {
    expect(candidateShardIndices(splitPoints, { in: [1925, 2010] })).toEqual([0, 2]);
    expect(candidateShardIndices(splitPoints, { in: [1925, 1930] })).toEqual([0]);
  });

  test("range (gte/lte) selects the contiguous covering shard span", () => {
    expect(candidateShardIndices(splitPoints, { gte: 1950, lte: 2000 })).toEqual([1, 2]);
  });

  test("an open-ended lower range selects from the start", () => {
    expect(candidateShardIndices(splitPoints, { lt: 1950 })).toEqual([0]);
  });

  test("an open-ended upper range selects through the end", () => {
    expect(candidateShardIndices(splitPoints, { gt: 1950 })).toEqual([1, 2]);
  });

  test("an empty manifest (no shards) selects nothing", () => {
    expect(candidateShardIndices([], { equals: 2000 })).toEqual([]);
  });

  describe("string split-points (a string sort field range-partitions lexicographically)", () => {
    // 3 shards: ["Alice","Frank"), ["Frank","Nina"), ["Nina","Zoe"]
    const names = ["Alice", "Frank", "Nina", "Zoe"];

    test("equals selects exactly the one containing shard, with boundaries falling forward", () => {
      expect(candidateShardIndices(names, { equals: "Charlie" })).toEqual([0]);
      expect(candidateShardIndices(names, { equals: "Frank" })).toEqual([1]);
      expect(candidateShardIndices(names, { equals: "Zoe" })).toEqual([2]);
    });

    test("values outside the global range select nothing", () => {
      expect(candidateShardIndices(names, { equals: "Aaron" })).toEqual([]);
      expect(candidateShardIndices(names, { equals: "Zzz" })).toEqual([]);
    });

    test("a prefix-style range selects the contiguous covering span", () => {
      // The startsWith-becomes-a-range trick the sort field gets for free: ["N", "N￿"].
      // Shard 1 spans ["Frank","Nina") and so may hold "Nadia" — including it is the zonemap
      // over-approximating, which is always allowed; excluding a real match never is.
      expect(candidateShardIndices(names, { gte: "N", lte: "N￿" })).toEqual([1, 2]);
      expect(candidateShardIndices(names, { gte: "Frank", lte: "Paul" })).toEqual([1, 2]);
      // A prefix at or past a boundary narrows to that shard alone ("Nina" <= "Nina").
      expect(candidateShardIndices(names, { gte: "Nina", lte: "Nina￿" })).toEqual([2]);
    });

    test("in selects the union of each value's shard, deduplicated and sorted", () => {
      expect(candidateShardIndices(names, { in: ["Bob", "Tom"] })).toEqual([0, 2]);
    });

    test("startsWith prunes for free on a string sort field — sorted values make a prefix a contiguous range", () => {
      // The reason a string sort field is worth having: no inverted index, no chunk fetch, just the
      // split-points already in the manifest.
      expect(candidateShardIndices(names, { startsWith: "Nina" })).toEqual([2]);
      expect(candidateShardIndices(names, { startsWith: "B" })).toEqual([0]);
      // Over-approximates across a boundary rather than missing: shard 1 spans ["Frank","Nina") and
      // could hold "Nadia".
      expect(candidateShardIndices(names, { startsWith: "N" })).toEqual([1, 2]);
      // A prefix below every stored value prunes to nothing at all.
      expect(candidateShardIndices(names, { startsWith: "Aa" })).toEqual([]);
      // But a prefix that merely happens to be unused still selects the shard whose range brackets
      // it — split-points bound each shard, they don't enumerate its contents, so "Qqx" could sit in
      // shard 2's ["Nina","Zoe"] span. Over-approximating is always allowed.
      expect(candidateShardIndices(names, { startsWith: "Qq" })).toEqual([2]);
      // An empty prefix constrains nothing.
      expect(candidateShardIndices(names, { startsWith: "" })).toEqual([0, 1, 2]);
    });
  });
});

describe("pairCandidateShardIndices", () => {
  // shard0 [Alpha,Golf], shard1 [Hotel,Papa], shard2 [Quebec,Zulu]
  const pairs: [string, string][] = [
    ["Alpha", "Golf"],
    ["Hotel", "Papa"],
    ["Quebec", "Zulu"],
  ];

  test("equals selects every shard whose pair could contain the value", () => {
    expect(pairCandidateShardIndices(pairs, { equals: "Kilo" })).toEqual(new Set([1]));
  });

  test("equals outside every pair's range selects nothing", () => {
    expect(pairCandidateShardIndices(pairs, { equals: "0" })).toEqual(new Set());
  });

  test("in selects the union across values", () => {
    expect(pairCandidateShardIndices(pairs, { in: ["Bravo", "Romeo"] })).toEqual(new Set([0, 2]));
  });

  test("a filter shape with neither equals nor in returns undefined (no zonemap signal)", () => {
    expect(pairCandidateShardIndices(pairs, {})).toBeUndefined();
  });

  test("skips a shard with no bound (zero non-null values for the field)", () => {
    const withGap: [unknown, unknown][] = [
      ["Alpha", "Golf"],
      [undefined, undefined],
      ["Quebec", "Zulu"],
    ];
    expect(pairCandidateShardIndices(withGap, { equals: "Charlie" })).toEqual(new Set([0]));
  });

  // Range pruning keeps a shard iff its [min,max] OVERLAPS the query interval. For number/date the
  // pairs are exact (only string pairs are truncated), so this prunes precisely at shard granularity.
  describe("range operators (ADR-0003 §6, secondary number/date fields)", () => {
    // shard0 [0,8], shard1 [3,12], shard2 [20,40] — deliberately overlapping, as real data is.
    const numeric: [number, number][] = [
      [0, 8],
      [3, 12],
      [20, 40],
    ];

    test("gte keeps every shard that could still hold a value at or above the bound", () => {
      expect(pairCandidateShardIndices(numeric, { gte: 10 })).toEqual(new Set([1, 2]));
    });

    test("lte keeps every shard reaching at or below the bound", () => {
      expect(pairCandidateShardIndices(numeric, { lte: 2 })).toEqual(new Set([0]));
    });

    test("gt/lt exclude a shard that only touches the bound exactly", () => {
      // shard0's max is 8, so `gt: 8` cannot be satisfied there, while `gte: 8` can.
      expect(pairCandidateShardIndices(numeric, { gte: 8 })).toEqual(new Set([0, 1, 2]));
      expect(pairCandidateShardIndices(numeric, { gt: 8 })).toEqual(new Set([1, 2]));
      expect(pairCandidateShardIndices(numeric, { lt: 3 })).toEqual(new Set([0]));
    });

    test("a two-sided range intersects both bounds rather than unioning them", () => {
      expect(pairCandidateShardIndices(numeric, { gte: 9, lte: 15 })).toEqual(new Set([1]));
    });

    test("a range no shard overlaps selects nothing", () => {
      expect(pairCandidateShardIndices(numeric, { gte: 13, lte: 19 })).toEqual(new Set());
    });

    test("a point and a range on one field are ANDed, pruning more than either alone", () => {
      // `in` alone would admit all three (5 is in shard0 and shard1, 25 in shard2); the range cuts it to one.
      expect(pairCandidateShardIndices(numeric, { in: [5, 25] })).toEqual(new Set([0, 1, 2]));
      expect(pairCandidateShardIndices(numeric, { in: [5, 25], gte: 20 })).toEqual(new Set([2]));
    });

    test("pruning reasons per-constraint, so an unsatisfiable combination may still admit a shard", () => {
      // Nothing is both ==5 and >=10, but shard1 [3,12] could hold a 5 AND could hold something >=10.
      // A pair cannot see that no single value does both. Over-approximating is the contract
      // (ADR-0003 §2) — matchesWhere rejects the records post-fetch.
      expect(pairCandidateShardIndices(numeric, { equals: 5, gte: 10 })).toEqual(new Set([1]));
    });

    test("ISO date strings compare correctly, since date pairs are stored untruncated", () => {
      const dates: [string, string][] = [
        ["2019-01-01", "2019-06-30"],
        ["2020-01-01", "2020-12-31"],
      ];
      expect(pairCandidateShardIndices(dates, { gte: "2020-06-01" })).toEqual(new Set([1]));
    });

    test("a shard with no bound is skipped by a range too", () => {
      const withGap: [unknown, unknown][] = [[0, 8], [undefined, undefined], [20, 40]];
      expect(pairCandidateShardIndices(withGap, { gte: 1 })).toEqual(new Set([0, 2]));
    });
  });
});

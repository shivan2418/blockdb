import { describe, expect, test } from "vitest";
import { computeMissingBlock, computeSplitPoints, buildManifest } from "../src/manifest.js";
import type { ResolvedConfig, ShardDescriptor } from "../src/types.js";

const config: ResolvedConfig = {
  collection: "movies",
  inputPath: "data/movies.ndjson",
  output: "public/shard-data",
  clientOut: "src/shard-db",
  basePath: "/shard-data",
  shardBytes: 2_097_152,
  indexChunkBytes: 45_000,
  sortField: "year",
  fields: {
    year: { kind: "number" },
    title: { kind: "string" },
  },
};

describe("computeSplitPoints", () => {
  test("returns N+1 monotonic boundaries for N shards", () => {
    const groups = [
      [{ year: 2000 }, { year: 2001 }],
      [{ year: 2002 }, { year: 2002 }],
      [{ year: 2005 }],
    ];
    const points = computeSplitPoints(groups, "year");
    // 3 shards → 4 boundaries: each shard's min, plus the last shard's max.
    expect(points).toEqual([2000, 2002, 2005, 2005]);
  });

  test("returns an empty array for no shards", () => {
    expect(computeSplitPoints([], "year")).toEqual([]);
  });
});

describe("computeMissingBlock", () => {
  test("returns undefined when every record has a real sort-field value", () => {
    const groups = [[{ year: 2000 }], [{ year: 2001 }]];
    expect(computeMissingBlock(groups, "year")).toBeUndefined();
  });

  test("reports the earliest shard containing a missing value and counts null vs absent separately (T13)", () => {
    const groups = [
      [{ year: 2000 }, { year: 2001 }],
      [{ year: 2002 }, { year: null }],
      [{ year: null }, {}],
    ];
    expect(computeMissingBlock(groups, "year")).toEqual({ shardFrom: 1, nullCount: 2, absentCount: 1 });
  });
});

describe("buildManifest", () => {
  const shardFiles: ShardDescriptor[] = [
    { hash: "aaaa000000000000", bytes: 100, count: 2 },
    { hash: "bbbb000000000000", bytes: 120, count: 3 },
  ];
  const splitPoints = [2000, 2005];

  test("matches the spec's manifest shape for the sort-field-only case", () => {
    const manifest = buildManifest({
      config,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.formatVersion).toBe(0);
    expect(manifest.generatorVersion).toBe("0.0.0");
    expect(manifest.dataset).toEqual({
      collection: "movies",
      recordCount: 5,
      shardCount: 2,
      sortField: "year",
    });
    expect(manifest.shards).toEqual(shardFiles);
    expect(manifest.zonemap).toEqual({ year: { splitPoints: [2000, 2005] } });
    expect(manifest.schema.sortField).toBe("year");
    expect(manifest.schema.fields.year).toEqual({
      kind: "number",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"],
    });
    expect(manifest.schema.fields.title).toEqual({
      kind: "string",
      isDate: false,
      indexed: false,
      operators: [],
    });
  });

  test("per-shard counts sum to recordCount", () => {
    const manifest = buildManifest({
      config,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    const sum = manifest.shards.reduce((acc, s) => acc + s.count, 0);
    expect(sum).toBe(manifest.dataset.recordCount);
  });

  test("marks a date sort field with isDate: true", () => {
    const dateConfig: ResolvedConfig = {
      ...config,
      sortField: "releaseDate",
      fields: { releaseDate: { kind: "date" } },
    };
    const manifest = buildManifest({
      config: dateConfig,
      shardFiles: [],
      splitPoints: [],
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.releaseDate).toEqual({
      kind: "date",
      isDate: true,
      indexed: true,
      operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"],
    });
  });

  test("a non-sort field with no `indexed` opt-in is not indexed and has no operators", () => {
    const manifest = buildManifest({
      config,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.title).toEqual({ kind: "string", isDate: false, indexed: false, operators: [] });
    expect(manifest.indexes).toEqual({});
  });

  test("an opted-in secondary string field gets equals/in/startsWith and merges its zonemap + index directory", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      secondaryZonemaps: { title: { pairs: [["Alpha", "Zeta"]], truncated: true } },
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.schema.fields.title).toEqual({
      kind: "string",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "startsWith", "not"],
    });
    expect(manifest.zonemap.title).toEqual({ pairs: [["Alpha", "Zeta"]], truncated: true });
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "not"],
      chunks: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }],
    });
    // the sort field's own zonemap entry is untouched
    expect(manifest.zonemap.year).toEqual({ splitPoints: [2000, 2005] });
  });

  test("an opted-in secondary number field gets only equals/in (no gt/lt — that's zonemap territory, out of T3 scope)", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, rating: { kind: "number", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.rating).toEqual({
      kind: "number",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "not"],
    });
  });

  test("T6: endsWith opt-in appends the operator and merges the reversed chunk directory", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, endsWith: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      reversedChunkDirs: { title: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "not"]);
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "endsWith", "not"],
      chunks: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }],
      reversed: { chunks: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
    });
  });

  test("T6: contains opt-in appends the operator and merges the trigram chunk directory", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, contains: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      trigramChunkDirs: { title: [{ from: "aaa", to: "zzz", file: "index/title/trigram/ghi789.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "contains", "not"]);
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "contains", "not"],
      chunks: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }],
      trigram: { chunks: [{ from: "aaa", to: "zzz", file: "index/title/trigram/ghi789.json" }] },
    });
  });

  test("T6: reversed/trigram chunk dirs merge safely even without a matching indexChunkDirs entry for that field", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, endsWith: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      // Deliberately omit indexChunkDirs.title — buildManifest must not crash on `indexes[field]!`.
      reversedChunkDirs: { title: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "endsWith", "not"],
      chunks: [],
      reversed: { chunks: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
    });
  });

  test("an opted-in secondary boolean field gets only equals", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, isClassic: { kind: "boolean", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.isClassic).toEqual({
      kind: "boolean",
      isDate: false,
      indexed: true,
      operators: ["equals", "not"],
    });
  });

  test("T7: a multi-valued field carries multi: true; a non-multi field omits the key entirely", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, genres: { kind: "string", indexed: true, multi: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.genres).toEqual({
      kind: "string",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "startsWith", "not"],
      multi: true,
    });
    expect(manifest.schema.fields.title!.multi).toBeUndefined();
  });

  test("T7: an absent-opted-in field carries absent: true; a non-opted-in field omits the key entirely", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, absent: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.title).toEqual({
      kind: "string",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "startsWith", "not"],
      absent: true,
    });
    expect(manifest.schema.fields.year!.absent).toBeUndefined();
  });

  test("T8: a declared pk on the sort field carries schema.pk + the field's pk: true, no indexed requirement", () => {
    const pkConfig: ResolvedConfig = { ...config, pk: "year" };
    const manifest = buildManifest({
      config: pkConfig,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.pk).toBe("year");
    expect(manifest.schema.fields.year!.pk).toBe(true);
    expect(manifest.schema.fields.title!.pk).toBeUndefined();
  });

  test("T8: a declared pk on an indexed non-sort field carries schema.pk + the field's pk: true", () => {
    const pkConfig: ResolvedConfig = {
      ...config,
      pk: "title",
      fields: { ...config.fields, title: { kind: "string", indexed: true } },
    };
    const manifest = buildManifest({
      config: pkConfig,
      shardFiles,
      splitPoints,
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.pk).toBe("title");
    expect(manifest.schema.fields.title!.pk).toBe(true);
    expect(manifest.schema.fields.year!.pk).toBeUndefined();
  });

  test("T8: no pk configured omits schema.pk entirely", () => {
    const manifest = buildManifest({
      config,
      shardFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.pk).toBeUndefined();
  });

  test("carries dataset.compression when the build compressed, and omits it entirely when it didn't", () => {
    for (const compression of ["gzip", "brotli"] as const) {
      const built = buildManifest({
        config: { ...config, compression },
        shardFiles,
        splitPoints,
        formatVersion: 0,
        generatorVersion: "0.0.0",
      });
      expect(built.dataset.compression).toBe(compression);
      // the pre-`compression` boolean is not emitted alongside it — one field, one source of truth
      expect(built.dataset.gzip).toBeUndefined();
    }

    const plain = buildManifest({ config, shardFiles, splitPoints, formatVersion: 0, generatorVersion: "0.0.0" });
    expect(plain.dataset.compression).toBeUndefined();
    expect(plain.dataset.gzip).toBeUndefined();
  });
});

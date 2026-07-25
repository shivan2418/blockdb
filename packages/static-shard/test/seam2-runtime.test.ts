import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build } from "static-shard-cli";
import type { StaticShardConfig } from "static-shard-cli";
import { createClient } from "../src/client.js";
import { ShardError } from "../src/errors.js";
import type { SchemaMeta } from "../src/types.js";

// Same fixture shape as static-shard-cli's seam #1 test — the point of seam #2
// is to serve a tree that seam #1 itself produced, keeping the two honest
// against each other.
const MOVIES = [
  { year: 1999, title: "The Matrix", rating: 8.7 },
  { year: 2000, title: "Gladiator", rating: 8.5 },
  { year: 2000, title: "Snatch", rating: 8.3 },
  { year: 2000, title: "Memento", rating: 8.4 },
  { year: 2003, title: "The Matrix Reloaded", rating: 7.2 },
  { year: 2008, title: "The Dark Knight", rating: 9.0 },
  { year: 2010, title: "Inception", rating: 8.8 },
  { year: 2010, title: "Toy Story 3", rating: 8.3 },
  { year: 2014, title: "Interstellar", rating: 8.6 },
  { year: 2019, title: "Parasite", rating: 8.6 },
];

const config: StaticShardConfig = {
  collection: "movies",
  input: { path: "movies.ndjson" },
  shardBytes: 60, // tiny — forces multiple shards so pruning is meaningfully exercised
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string" },
      rating: { kind: "number" },
    },
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "static-shard-seam2-"));
  writeFileSync(path.join(tmpDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** basePath = the real output dir's absolute fs path, so `${basePath}/x` IS a real file to read. */
function diskFetch(requests: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const filePath = String(input);
    requests.push(filePath);
    try {
      const content = await readFile(filePath, "utf8");
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(content),
        text: async () => content,
      } as Response;
    } catch {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    }
  }) as typeof fetch;
}

async function loadGeneratedSchema(clientOutDir: string): Promise<SchemaMeta> {
  const mod = (await import(pathToFileURL(path.join(clientOutDir, "schema.ts")).href)) as {
    schema: SchemaMeta;
  };
  return mod.schema;
}

describe("seam #2 — connect({ basePath, fetch }) → results, over a seam #1-built fixture tree", () => {
  test("findMany returns correct records for equals/in/range on the sort field", async () => {
    const { outputDir, clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const equalsResult = await client.movies.findMany({ where: { year: { equals: 2000 } } });
    expect(equalsResult.records.map((r) => r.title).sort()).toEqual(["Gladiator", "Memento", "Snatch"].sort());

    const inResult = await client.movies.findMany({ where: { year: { in: [1999, 2019] } } });
    expect(inResult.records.map((r) => r.year).sort()).toEqual([1999, 2019]);

    const rangeResult = await client.movies.findMany({ where: { year: { gte: 2008, lt: 2014 } } });
    expect(rangeResult.records.map((r) => r.title).sort()).toEqual(["Inception", "The Dark Knight", "Toy Story 3"].sort());
  });

  test("only shards surviving zonemap pruning are fetched", async () => {
    const { outputDir, clientOutDir, manifest } = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    expect(manifest.shards.length).toBeGreaterThan(2); // tiny shardBytes should force multiple shards

    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    await client.movies.findMany({ where: { year: { equals: 1999 } } });
    const shardRequests = requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`));
    // A point query for the earliest year should touch only the one shard that can contain it.
    expect(shardRequests).toHaveLength(1);
  });

  test("orderBy / limit / offset and exact hasMore over the built fixture", async () => {
    const { clientOutDir, outputDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    const desc = await client.movies.findMany({ orderBy: { year: "desc" }, limit: 3 });
    expect(desc.records.map((r) => r.year)).toEqual([2019, 2014, 2010]);
    expect(desc.hasMore).toBe(true);

    const all = await client.movies.findMany();
    expect(all.records).toHaveLength(MOVIES.length);
    expect(all.hasMore).toBe(false);

    const lastPage = await client.movies.findMany({ limit: 5, offset: MOVIES.length - 2 });
    expect(lastPage.records).toHaveLength(2);
    expect(lastPage.hasMore).toBe(false);
  });
});

/** T3/T4 shared fixture: same movies, with title + rating secondary-indexed. */
const indexedConfig: StaticShardConfig = {
  ...config,
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string", indexed: true },
      rating: { kind: "number", indexed: true },
    },
  },
};

describe("seam #2 — secondary inverted index & multi-field AND (T3), over a seam #1-built fixture tree", () => {

  test("equals/in/startsWith on the secondary field return correct records, fetching only surviving shards + constrained chunks", async () => {
    const { outputDir, clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const equalsResult = await client.movies.findMany({ where: { title: { equals: "Inception" } } });
    expect(equalsResult.records.map((r) => r.title)).toEqual(["Inception"]);

    const inResult = await client.movies.findMany({ where: { title: { in: ["The Matrix", "Parasite"] } } });
    expect(inResult.records.map((r) => r.title).sort()).toEqual(["Parasite", "The Matrix"]);

    const startsWithResult = await client.movies.findMany({ where: { title: { startsWith: "The" } } });
    expect(startsWithResult.records.map((r) => r.title).sort()).toEqual(
      ["The Matrix", "The Matrix Reloaded", "The Dark Knight"].sort(),
    );
  });

  test("only chunks covering the queried value and only the matching shard are fetched for an equals query", async () => {
    const { outputDir, clientOutDir, manifest } = build(indexedConfig, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    expect(manifest.indexes.title!.chunks.length).toBeGreaterThan(0);

    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    await client.movies.findMany({ where: { title: { equals: "Parasite" } } });
    const indexRequests = requests.filter((r) => r.includes(`${path.sep}index${path.sep}`));
    const shardRequests = requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`));
    expect(shardRequests).toHaveLength(1); // "Parasite" lives in exactly one shard
    // Never more chunks than the directory actually holds — proves we're not sweeping every chunk.
    expect(indexRequests.length).toBeGreaterThan(0);
    expect(indexRequests.length).toBeLessThanOrEqual(manifest.indexes.title!.chunks.length);
  });

  test("implicit AND across the sort field and the secondary index returns the exact intersection", async () => {
    const { outputDir, clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    // year:2000 → {Gladiator, Snatch, Memento}; title startsWith "S" → {Snatch, ...}. AND ⇒ exactly Snatch.
    const result = await client.movies.findMany({ where: { year: { equals: 2000 }, title: { startsWith: "S" } } });
    expect(result.records.map((r) => r.title)).toEqual(["Snatch"]);
  });

  test("implicit AND across TWO non-sort indexed fields intersects both fields' own index-derived shard sets", async () => {
    const { outputDir, clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    // title startsWith "The" → {The Matrix (8.7), The Matrix Reloaded (7.2), The Dark Knight (9.0)};
    // rating equals 9.0 → {The Dark Knight} alone. Neither constraint touches the sort field (year) at all.
    const result = await client.movies.findMany({ where: { title: { startsWith: "The" }, rating: { equals: 9.0 } } });
    expect(result.records.map((r) => r.title)).toEqual(["The Dark Knight"]);
  });

  test("a multi-field AND with no possible intersection returns an empty result and fetches no shards", async () => {
    const { outputDir, clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    // "Parasite" (year 2019) can never satisfy year:1999 — disjoint constraints.
    const result = await client.movies.findMany({ where: { year: { equals: 1999 }, title: { equals: "Parasite" } } });
    expect(result.records).toEqual([]);
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toEqual([]);
  });
});

describe("seam #2 — count() approximate upper bound & pagination totals (T4), over a seam #1-built fixture tree", () => {
  test("count(where) is an upper bound ≥ the true match count, flagged exact: false, fetching no data shards", async () => {
    const { outputDir, clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const wheres = [
      { year: { gte: 2000 } },
      { title: { startsWith: "The" } },
      { year: { gte: 2000 }, title: { startsWith: "The" } },
      { rating: { equals: 8.6 } },
    ] as const;
    for (const where of wheres) {
      const before = requests.length;
      const result = await client.movies.count(where);
      // Zero data-shard fetches per count call, whatever else it fetched.
      expect(requests.slice(before).filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toEqual([]);
      // The truth, independently observed through the findMany seam.
      const truth = (await client.movies.findMany({ where })).records.length;
      expect(result.count).toBeGreaterThanOrEqual(truth);
      expect(result.exact).toBe(false);
    }
  });

  test("the two exact cases: empty where → recordCount, pruned-to-zero → 0", async () => {
    const { outputDir, clientOutDir, manifest } = build(indexedConfig, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    // Empty where → the free, exact recordCount — and literally nothing but the manifest is fetched.
    await expect(client.movies.count()).resolves.toEqual({ count: MOVIES.length, exact: true });
    expect(manifest.dataset.recordCount).toBe(MOVIES.length);
    expect(requests).toEqual([path.join(outputDir, "manifest.json")]);

    // Disjoint AND (year:1999 ∩ title:"Parasite") prunes to zero shards → an exact, trustworthy "none".
    await expect(client.movies.count({ year: { equals: 1999 }, title: { equals: "Parasite" } })).resolves.toEqual({
      count: 0,
      exact: true,
    });
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toEqual([]);
  });

  test("a constrained secondary field costs only its index chunk(s) — manifest + chunks, never a shard body", async () => {
    const { outputDir, clientOutDir, manifest } = build(indexedConfig, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const result = await client.movies.count({ rating: { equals: 9.0 } });
    expect(result.exact).toBe(false);
    expect(result.count).toBeGreaterThanOrEqual(1); // The Dark Knight's shard — maybe loose, never below the truth.

    const indexRequests = requests.filter((r) => r.includes(`${path.sep}index${path.sep}`));
    expect(indexRequests.length).toBeGreaterThan(0); // the constrained field's chunk(s) ARE the allowed cost
    expect(indexRequests.length).toBeLessThanOrEqual(manifest.indexes.rating!.chunks.length);
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toEqual([]);
  });
});

/** T6 fixture: same movies, title opted into endsWith (reversed) + contains (trigram). */
const t6Config: StaticShardConfig = {
  ...config,
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string", indexed: true, endsWith: true, contains: true },
      rating: { kind: "number" },
    },
  },
};

describe("seam #2 — endsWith (reversed index) & contains (trigram index), over a seam #1-built fixture tree (T6)", () => {
  test("endsWith returns exactly the records whose value truly ends with the suffix, fetching only the reversed chunk(s) + surviving shards", async () => {
    const { outputDir, clientOutDir, manifest } = build(t6Config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    expect(manifest.indexes.title!.reversed!.chunks.length).toBeGreaterThan(0);

    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const result = await client.movies.findMany({ where: { title: { endsWith: "Reloaded" } } });
    expect(result.records.map((r) => r.title)).toEqual(["The Matrix Reloaded"]);

    const reversedRequests = requests.filter((r) => r.includes(`${path.sep}reversed${path.sep}`));
    expect(reversedRequests.length).toBeGreaterThan(0);
    expect(reversedRequests.length).toBeLessThanOrEqual(manifest.indexes.title!.reversed!.chunks.length);
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toHaveLength(1);
  });

  test("contains returns exactly the records whose value truly contains the substring, valid as a SOLE constraint", async () => {
    const { outputDir, clientOutDir, manifest } = build(t6Config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    expect(manifest.indexes.title!.trigram!.chunks.length).toBeGreaterThan(0);

    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const result = await client.movies.findMany({ where: { title: { contains: "Matrix" } } });
    expect(result.records.map((r) => r.title).sort()).toEqual(["The Matrix", "The Matrix Reloaded"].sort());

    const trigramRequests = requests.filter((r) => r.includes(`${path.sep}trigram${path.sep}`));
    expect(trigramRequests.length).toBeGreaterThan(0);
    // Never touches every shard — the trigram AND-intersection must have pruned something.
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`)).length).toBeLessThan(manifest.shards.length);
  });

  test("implicit AND: contains combined with a sort-field range intersects both prunes", async () => {
    const { outputDir, clientOutDir } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    // title contains "Matrix" -> {The Matrix (1999), The Matrix Reloaded (2003)}; year < 2000 narrows to 1999 alone.
    const result = await client.movies.findMany({ where: { title: { contains: "Matrix" }, year: { lt: 2000 } } });
    expect(result.records.map((r) => r.title)).toEqual(["The Matrix"]);
  });

  test("a contains substring shorter than 3 chars can't route via the trigram index but still matches correctly (falls back to a full scan)", async () => {
    const { outputDir, clientOutDir } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    const result = await client.movies.findMany({ where: { title: { contains: "By" } } });
    expect(result.records).toEqual([]);
  });

  test("a query with no true match returns no records and fetches no shards for a fully-disjoint AND", async () => {
    const { outputDir, clientOutDir } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    // "Parasite" never ends with "Reloaded" AND year:1999 is disjoint from where "Reloaded"-suffixed titles live.
    const result = await client.movies.findMany({ where: { title: { endsWith: "Reloaded" }, year: { equals: 1999 } } });
    expect(result.records).toEqual([]);
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toEqual([]);
  });
});

/** T8 fixture: pk declared on the sort field itself — the free zonemap path. */
const sortPkConfig: StaticShardConfig = {
  ...config,
  schema: { sortField: "year", pk: "year", fields: { year: { kind: "number" }, title: { kind: "string" }, rating: { kind: "number" } } },
};

/** T8 fixture: pk declared on an indexed non-sort field — one chunk + one shard. */
const secondaryPkConfig: StaticShardConfig = {
  ...config,
  schema: {
    sortField: "year",
    pk: "title",
    fields: { year: { kind: "number" }, title: { kind: "string", indexed: true }, rating: { kind: "number" } },
  },
};

describe("seam #2 — get(id) / PK lookup (T8), over a seam #1-built fixture tree", () => {
  test("a PK-less collection exposes no get member at runtime", async () => {
    const { outputDir, clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });
    expect((client.movies as unknown as Record<string, unknown>).get).toBeUndefined();
  });

  test("pk on the sort field: a hit returns the record, fetching at most one shard and no index chunks", async () => {
    const { outputDir, clientOutDir } = build(sortPkConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const hit = await (client.movies as unknown as { get(id: number): Promise<Record<string, unknown> | null> }).get(2008);
    expect(hit).toEqual(MOVIES.find((m) => m.year === 2008));
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`)).length).toBeLessThanOrEqual(1);
    expect(requests.filter((r) => r.includes(`${path.sep}index${path.sep}`))).toEqual([]);
  });

  test("pk on the sort field: a miss returns null", async () => {
    const { outputDir, clientOutDir } = build(sortPkConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    const miss = await (client.movies as unknown as { get(id: number): Promise<Record<string, unknown> | null> }).get(1975);
    expect(miss).toBeNull();
  });

  test("pk on a non-sort indexed field: a hit returns the record, fetching at most one chunk and one shard", async () => {
    const { outputDir, clientOutDir } = build(secondaryPkConfig, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const hit = await (client.movies as unknown as { get(id: string): Promise<Record<string, unknown> | null> }).get("Parasite");
    expect(hit).toEqual(MOVIES.find((m) => m.title === "Parasite"));

    const indexRequests = requests.filter((r) => r.includes(`${path.sep}index${path.sep}`));
    const shardRequests = requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`));
    // The acceptance criterion is ≤1 chunk specifically (not merely "≤ however
    // many chunks exist") — an equals lookup can overlap at most one chunk
    // directory entry, since entries are non-overlapping value ranges.
    expect(indexRequests.length).toBeGreaterThan(0);
    expect(indexRequests.length).toBeLessThanOrEqual(1);
    expect(shardRequests).toHaveLength(1);
  });

  test("pk on a non-sort indexed field: a miss returns null, fetching no shard", async () => {
    const { outputDir, clientOutDir } = build(secondaryPkConfig, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const miss = await (client.movies as unknown as { get(id: string): Promise<Record<string, unknown> | null> }).get(
      "No Such Movie",
    );
    expect(miss).toBeNull();
    expect(requests.filter((r) => r.includes(`${path.sep}shards${path.sep}`))).toEqual([]);
  });
});

describe("seam #2 — runtime failure contract & maxResults guardrail (T5), over a seam #1-built fixture tree", () => {
  /** Rejects with a ShardError; asserts the exact code + payload, then returns it for message checks. */
  async function expectFailure(
    promise: Promise<unknown>,
    expected: { code: string; url?: string; status?: number; remediation: RegExp },
  ): Promise<void> {
    const error = await promise.then(
      () => {
        throw new Error(`expected ${expected.code}, but the query resolved`);
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ShardError);
    const shardError = error as ShardError;
    expect(shardError.code).toBe(expected.code);
    if (expected.url !== undefined) expect(shardError.url).toBe(expected.url);
    if (expected.status !== undefined) expect(shardError.status).toBe(expected.status);
    // Every message carries remediation (ADR-0007 §8), and the query object is never attached (PII).
    expect(shardError.message).toMatch(expected.remediation);
    expect((shardError as unknown as Record<string, unknown>).query).toBeUndefined();
    expect((shardError as unknown as Record<string, unknown>).where).toBeUndefined();
  }

  test("manifest.json missing (wrong basePath) → CONFIG with url, 404 status and a basePath remediation", async () => {
    const { clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const missingDir = path.join(tmpDir, "no-such-dataset");
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: missingDir,
      fetch: diskFetch([]),
    });
    await expectFailure(client.movies.findMany(), {
      code: "CONFIG",
      url: path.join(missingDir, "manifest.json"),
      status: 404,
      remediation: /basePath/,
    });
  });

  test("manifest major ≠ runtime major → FORMAT_VERSION at manifest load, before any query work", async () => {
    const { outputDir, clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 99 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });
    await expectFailure(client.movies.findMany({ where: { year: { equals: 2000 } } }), {
      code: "FORMAT_VERSION",
      url: path.join(outputDir, "manifest.json"),
      remediation: /static-shard build/,
    });
    // Nothing but the manifest was fetched — the mismatch halts everything downstream.
    expect(requests).toEqual([path.join(outputDir, "manifest.json")]);
  });

  test("a manifest-referenced shard missing from the deploy → DEPLOY_INTEGRITY naming the file, never a partial array", async () => {
    const { outputDir, clientOutDir, manifest } = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    // Sabotage the deploy: delete one shard the manifest promises.
    const victim = manifest.shards[manifest.shards.length - 1]!;
    unlinkSync(path.join(outputDir, "shards", `${victim.hash}.ndjson`));

    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });
    await expectFailure(client.movies.findMany(), {
      code: "DEPLOY_INTEGRITY",
      url: path.join(outputDir, "shards", `${victim.hash}.ndjson`),
      status: 404,
      remediation: /redeploy/,
    });
  });

  test("a manifest-referenced index chunk missing → DEPLOY_INTEGRITY on the chunk url", async () => {
    const { outputDir, clientOutDir, manifest } = build(indexedConfig, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const victim = manifest.indexes.title!.chunks[0]!;
    unlinkSync(path.join(outputDir, victim.file));

    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });
    await expectFailure(client.movies.findMany({ where: { title: { equals: "Inception" } } }), {
      code: "DEPLOY_INTEGRITY",
      url: path.join(outputDir, victim.file),
      status: 404,
      remediation: /redeploy/,
    });
  });

  test("a 500 on any file → NETWORK with .status (the maybe-transient bucket), not a 404 code", async () => {
    const { outputDir, clientOutDir, manifest } = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const inner = diskFetch([]);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`${path.sep}shards${path.sep}`)) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "" } as Response;
      }
      return inner(input, init);
    }) as typeof fetch;
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: fetchImpl,
    });
    // year:1999 is the earliest record — it lives in the first shard.
    await expectFailure(client.movies.findMany({ where: { year: { equals: 1999 } } }), {
      code: "NETWORK",
      url: path.join(outputDir, "shards", `${manifest.shards[0]!.hash}.ndjson`),
      status: 500,
      remediation: /transient|retry/i,
    });
  });

  test("a network-level rejection → NETWORK with NO .status and the original error chained as .cause", async () => {
    const { outputDir, clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const inner = diskFetch([]);
    const cause = new TypeError("socket hangup");
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`${path.sep}shards${path.sep}`)) throw cause;
      return inner(input, init);
    }) as typeof fetch;
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: fetchImpl,
    });
    const error = await client.movies.findMany({ where: { year: { equals: 1999 } } }).then(
      () => {
        throw new Error("expected NETWORK, but the query resolved");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ShardError);
    expect((error as ShardError).code).toBe("NETWORK");
    expect("status" in (error as ShardError)).toBe(false);
    expect((error as ShardError).cause).toBe(cause);
    expect((error as ShardError).message).toMatch(/socket hangup/);
  });

  test("a 2xx shard body that won't parse → CORRUPT_DATA with the parse error chained", async () => {
    const { outputDir, clientOutDir, manifest } = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    // Sabotage: corrupt one shard's contents on disk (the file exists, the bytes are garbage).
    const victim = manifest.shards[manifest.shards.length - 1]!;
    writeFileSync(path.join(outputDir, "shards", `${victim.hash}.ndjson`), "<html>definitely not ndjson</html>\n");

    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });
    const error = await client.movies.findMany().then(
      () => {
        throw new Error("expected CORRUPT_DATA, but the query resolved");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ShardError);
    expect((error as ShardError).code).toBe("CORRUPT_DATA");
    expect((error as ShardError).url).toBe(path.join(outputDir, "shards", `${victim.hash}.ndjson`));
    expect((error as ShardError).cause).toBeInstanceOf(SyntaxError);
    expect((error as ShardError).message).toMatch(/redeploy/);
  });

  test("the first failure aborts the outstanding fetches through the injected fetch's signal", async () => {
    const { outputDir, clientOutDir, manifest } = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });
    const schema = await loadGeneratedSchema(clientOutDir);
    const inner = diskFetch([]);
    const abortUrl = path.join(outputDir, "shards", `${manifest.shards[0]!.hash}.ndjson`);
    const shardSignals: (AbortSignal | undefined)[] = [];
    // One shard 404s immediately; every OTHER shard hangs until its signal
    // fires — the only way the query settles is if the first failure's abort
    // reaches them (proving cancellation, not settle-all).
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes(`${path.sep}shards${path.sep}`)) return inner(input, init);
      shardSignals.push(init?.signal);
      if (url === abortUrl) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
      }
      return new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () =>
          resolve({ ok: true, status: 200, json: async () => [], text: async () => "" } as Response),
        );
      });
    }) as typeof fetch;

    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: fetchImpl,
    });
    await expectFailure(client.movies.findMany(), { code: "DEPLOY_INTEGRITY", status: 404, remediation: /redeploy/ });
    expect(shardSignals.length).toBeGreaterThan(1); // a real fan-out was in flight
    for (const signal of shardSignals) expect(signal?.aborted).toBe(true);
  });

  test("maxResults over the seam: unbounded query exceeding the ceiling throws LIMIT_EXCEEDED rather than truncating", async () => {
    const { outputDir, clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
      maxResults: 3,
    });
    // MOVIES holds 10 records > 3 — an unbounded findMany must fail loud…
    await expectFailure(client.movies.findMany(), { code: "LIMIT_EXCEEDED", remediation: /maxResults/ });
    // …and an explicit limit above the ceiling fails before fetching anything…
    requests.length = 0;
    await expectFailure(client.movies.findMany({ limit: 4 }), { code: "LIMIT_EXCEEDED", remediation: /maxResults/ });
    expect(requests).toEqual([]); // pure client-side validation — not even the manifest was fetched
    // …while paging within the ceiling works fine.
    const page = await client.movies.findMany({ limit: 3 });
    expect(page.records).toHaveLength(3);
    expect(page.hasMore).toBe(true);
  });
});

/** T7 fixture: multi-valued `genres` and an absentable `tagline` (missing for Gladiator, explicit null for Snatch). */
const t7Config: StaticShardConfig = {
  ...config,
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string", indexed: true },
      tagline: { kind: "string", indexed: true, absent: true },
      genres: { kind: "string", indexed: true, multi: true },
    },
  },
};

const T7_MOVIES = [
  { year: 1999, title: "The Matrix", genres: ["Sci-Fi", "Action"], tagline: "Welcome to the Real World" },
  { year: 2000, title: "Gladiator", genres: ["Action", "Drama"] },
  { year: 2000, title: "Snatch", genres: ["Crime", "Comedy"], tagline: null },
  { year: 2008, title: "The Dark Knight", genres: ["Action", "Crime"], tagline: "Why So Serious?" },
  { year: 2010, title: "Inception", genres: ["Sci-Fi", "Thriller"], tagline: "Your mind is the scene of the crime" },
];

function writeT7Fixture(): void {
  writeFileSync(path.join(tmpDir, "movies.ndjson"), T7_MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

describe("seam #2 — absentable ops, multi-valued some & not rider (T7), over a seam #1-built fixture tree", () => {
  test("some existentially matches multi-valued elements, pruning via the shared inverted index", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    const result = await client.movies.findMany({ where: { genres: { some: "Sci-Fi" } } });
    expect(result.records.map((r) => r.title).sort()).toEqual(["Inception", "The Matrix"].sort());
    expect(requests.some((r) => r.includes(`${path.sep}index${path.sep}genres${path.sep}`))).toBe(true);
  });

  test("some with a nested operator matches existentially (object form, not the equals shorthand)", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    const result = await client.movies.findMany({ where: { genres: { some: { startsWith: "Sci" } } } });
    expect(result.records.map((r) => r.title).sort()).toEqual(["Inception", "The Matrix"].sort());
  });

  test("a genre no movie has returns no records", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    const result = await client.movies.findMany({ where: { genres: { some: "Horror" } } });
    expect(result.records).toEqual([]);
  });

  test("isNull/isAbsent/exists correctly distinguish a missing key from an explicit null from a real value", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    // Snatch alone carries an explicit `tagline: null`.
    const nullResult = await client.movies.findMany({ where: { tagline: { isNull: true } } });
    expect(nullResult.records.map((r) => r.title)).toEqual(["Snatch"]);

    // Gladiator alone omits `tagline` entirely.
    const absentResult = await client.movies.findMany({ where: { tagline: { isAbsent: true } } });
    expect(absentResult.records.map((r) => r.title)).toEqual(["Gladiator"]);

    // Every other movie carries a real tagline.
    const existsResult = await client.movies.findMany({ where: { tagline: { exists: true } } });
    expect(existsResult.records.map((r) => r.title).sort()).toEqual(
      ["The Matrix", "The Dark Knight", "Inception"].sort(),
    );
  });

  test("not composes with a pruning companion on the same field to return the correct records", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    // Titles starting with "T": "The Matrix" and "The Dark Knight" — `not` excludes the former.
    const result = await client.movies.findMany({ where: { title: { startsWith: "T", not: "The Matrix" } } });
    expect(result.records.map((r) => r.title)).toEqual(["The Dark Knight"]);
  });

  test("not composes across fields: a pruning constraint on field A licenses not on field B (ADR-0004)", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch([]),
    });

    // year:2000 -> {Gladiator, Snatch}; title `not` "Gladiator" (a DIFFERENT field, no pruning op of its own)
    // is licensed by the year constraint, per ADR-0004: "a pruning op on field A licenses a `not` on field B".
    const result = await client.movies.findMany({ where: { year: { equals: 2000 }, title: { not: "Gladiator" } } });
    expect(result.records.map((r) => r.title)).toEqual(["Snatch"]);
  });

  test("assertWhereHasPruning rejects a dynamically-built not-only where at the client boundary, before any fetch", async () => {
    writeT7Fixture();
    const { outputDir, clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof T7_MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetch(requests),
    });

    // Bypasses the compile-time RiderGuard the way an untyped/dynamically-built where would.
    const notOnlyWhere = { title: { not: "Gladiator" } };
    await expect(client.movies.findMany({ where: notOnlyWhere as never })).rejects.toThrow(
      /cannot be the only constraint/,
    );
    expect(requests).toEqual([]);
  });
});

/** Like `diskFetch`, but reads raw bytes and exposes a real `.body` stream — needed so `DecompressionStream` can pipe gzipped shard payloads (T13, ADR-0002 §8). Handles plain (non-gzip) files too, so it doubles as a drop-in for the manifest/index-chunk JSON fetches in the same query. */
function diskFetchBinary(requests: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const filePath = String(input);
    requests.push(filePath);
    try {
      const buf = await readFile(filePath);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(buf));
            controller.close();
          },
        }),
        json: async () => JSON.parse(buf.toString("utf8")),
        text: async () => buf.toString("utf8"),
      } as unknown as Response;
    } catch {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    }
  }) as typeof fetch;
}

describe("seam #2 — gzip shard payloads (T13, ADR-0002 §8)", () => {
  test("findMany transparently decompresses gzip shard payloads end-to-end over a real build", async () => {
    const gzipConfig: StaticShardConfig = { ...config, gzip: true };
    const { outputDir, clientOutDir } = build(gzipConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schema = await loadGeneratedSchema(clientOutDir);
    const requests: string[] = [];
    const client = createClient<typeof schema, { movies: (typeof MOVIES)[number] }>(schema, {
      basePath: outputDir,
      fetch: diskFetchBinary(requests),
      // A gzipped build moves the manifest to manifest.json.gz, and it is the bootstrap fetch — so a
      // hand-written createClient caller has to say so. The generated connect() is stamped with it.
      manifestGzip: true,
    });

    const result = await client.movies.findMany({ where: { year: { equals: 2000 } } });
    expect(result.records.map((r) => r.title).sort()).toEqual(["Gladiator", "Memento", "Snatch"].sort());
    expect(requests.some((u) => u.endsWith(".ndjson.gz"))).toBe(true);
    // every file this deploy serves is compressed, bootstrap included
    expect(requests[0]).toMatch(/manifest\.json\.gz$/);
    expect(requests.every((u) => u.endsWith(".gz"))).toBe(true);
  });

  test("the generated client for a gzipped build carries the flag, so connect() needs no argument", async () => {
    const { clientOutDir } = build(
      { ...config, gzip: true, output: "out-gzc", clientOut: "client-gzc" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    const clientTs = await readFile(path.join(clientOutDir, "client.ts"), "utf8");
    expect(clientTs).toMatch(/manifestCompression: MANIFEST_COMPRESSION/);
    expect(clientTs).toMatch(/MANIFEST_COMPRESSION = "gzip"/);
  });
});

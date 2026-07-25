import { describe, expect, test } from "vitest";
import { inferSchema } from "../src/infer.js";

describe("inferSchema — field kind detection", () => {
  test("infers number/string/boolean from consistent sample values", () => {
    const records = [
      { year: 1999, title: "The Matrix", active: true },
      { year: 2000, title: "Gladiator", active: false },
      { year: 2000, title: "Snatch", active: true },
    ];
    const result = inferSchema(records);
    expect(result.fields.year!.kind).toBe("number");
    expect(result.fields.title!.kind).toBe("string");
    expect(result.fields.active!.kind).toBe("boolean");
  });

  test("infers date for ISO-8601-shaped strings", () => {
    const records = [{ releasedAt: "1999-03-31" }, { releasedAt: "2000-05-05T00:00:00Z" }];
    expect(inferSchema(records).fields.releasedAt!.kind).toBe("date");
  });

  test("a field that is null in every record falls back to kind string", () => {
    const records = [{ year: 1999, notes: null }, { year: 2000, notes: null }];
    expect(inferSchema(records).fields.notes!.kind).toBe("string");
  });

  test("null values are ignored for kind detection alongside real values", () => {
    const records = [{ rating: 8.5 }, { rating: null }, { rating: 7.2 }];
    expect(inferSchema(records).fields.rating!.kind).toBe("number");
  });

  test("carries a field with inconsistent, non-coercible scalar types as payload-only json", () => {
    const records = [
      { id: 1, code: 5 },
      { id: 2, code: "five" },
    ];
    expect(inferSchema(records).fields.code!.kind).toBe("json");
  });

  test("carries a nested-object field as payload-only json", () => {
    const records = [
      { id: 1, prices: { usd: "1.50", eur: "1.20" } },
      { id: 2, prices: { usd: "2.00" } },
    ];
    const field = inferSchema(records).fields.prices!;
    expect(field.kind).toBe("json");
    expect(field.multi).toBe(false);
  });
});

describe("inferSchema — cardinality / absent / multi", () => {
  test("computes distinct-value cardinality per field", () => {
    const records = [
      { year: 1999, genre: "action" },
      { year: 2000, genre: "drama" },
      { year: 2001, genre: "action" },
    ];
    expect(inferSchema(records).fields.genre!.cardinality).toBe(2);
  });

  test("flags a field absent when its key is missing from at least one record but present in another", () => {
    const records = [{ year: 1999, tagline: "hello" }, { year: 2000 }];
    expect(inferSchema(records).fields.tagline!.absent).toBe(true);
    expect(inferSchema(records).fields.year!.absent).toBe(false);
  });

  test("a null value counts as present, not absent", () => {
    const records = [
      { year: 1999, tagline: "hello" },
      { year: 2000, tagline: null },
    ];
    expect(inferSchema(records).fields.tagline!.absent).toBe(false);
  });

  test("detects a multi-valued field from consistent string-array values", () => {
    const records = [
      { year: 1999, genres: ["Action", "Drama"] },
      { year: 2000, genres: ["Comedy"] },
    ];
    const field = inferSchema(records).fields.genres!;
    expect(field.multi).toBe(true);
    expect(field.kind).toBe("string");
  });

  test("multi-field cardinality counts distinct elements across all arrays, not distinct array combos", () => {
    const records = [
      { year: 1999, genres: ["Action", "Drama"] },
      { year: 2000, genres: ["Action"] },
    ];
    expect(inferSchema(records).fields.genres!.cardinality).toBe(2);
  });

  test("carries a field that mixes array and scalar shapes as payload-only json", () => {
    const records = [
      { year: 1999, tags: ["a", "b"] },
      { year: 2000, tags: "c" },
    ];
    const field = inferSchema(records).fields.tags!;
    expect(field.kind).toBe("json");
    expect(field.multi).toBe(false);
  });

  test("carries a non-string array (number[] / object[]) as payload-only json, not a multi field", () => {
    const records = [
      { year: 1999, multiverseIds: [668564], parts: [{ id: "a" }] },
      { year: 2000, multiverseIds: [12, 34], parts: [{ id: "b" }] },
    ];
    const fields = inferSchema(records).fields;
    expect(fields.multiverseIds!.kind).toBe("json");
    expect(fields.multiverseIds!.multi).toBe(false);
    expect(fields.parts!.kind).toBe("json");
  });
});

describe("inferSchema — sort field recommendation", () => {
  test("recommends the number/date field with the highest cardinality", () => {
    const records = [
      { year: 1999, rank: 1, title: "a" },
      { year: 2000, rank: 1, title: "b" },
      { year: 2001, rank: 1, title: "c" },
    ];
    // year has cardinality 3, rank has cardinality 1 — year wins.
    expect(inferSchema(records).sortField).toBe("year");
  });

  test("prefers a date field over a lower-cardinality number field", () => {
    const records = [
      { releasedAt: "1999-01-01", views: 5 },
      { releasedAt: "2000-01-01", views: 5 },
      { releasedAt: "2001-01-01", views: 5 },
    ];
    expect(inferSchema(records).sortField).toBe("releasedAt");
  });

  test("never recommends a multi-valued or absentable field as the sort field", () => {
    const records = [
      { score: 1, genres: ["a"], year: 1999 },
      { score: 2, genres: ["b"], year: 2000 },
    ];
    expect(["score", "year"]).toContain(inferSchema(records).sortField);
  });

  test("throws a clear, actionable error when no number/date field exists in the sample", () => {
    const records = [{ title: "a" }, { title: "b" }];
    expect(() => inferSchema(records)).toThrow(/sort field|--sort-field/i);
  });

  test("tiebreaks toward a candidate that is itself unique and id-like named, not just similar cardinality", () => {
    // Both "id" and "rank" have cardinality 3 (tied); "id" additionally looks PK-shaped.
    const records = [
      { id: 1, rank: 10 },
      { id: 2, rank: 20 },
      { id: 3, rank: 30 },
    ];
    expect(inferSchema(records).sortField).toBe("id");
  });
});

describe("inferSchema — pk recommendation", () => {
  test("recommends an id-named field that is unique across the sample", () => {
    const records = [
      { id: "p1", year: 1999 },
      { id: "p2", year: 2000 },
      { id: "p3", year: 2001 },
    ];
    expect(inferSchema(records).pk).toBe("id");
  });

  test("may recommend the sort field itself as pk when it is also unique and id-like named (ADR-0002 §4 free path)", () => {
    const records = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = inferSchema(records);
    expect(result.sortField).toBe("id");
    expect(result.pk).toBe("id");
  });

  test("does not recommend a pk when no field both looks id-like and is unique", () => {
    const records = [
      { year: 1999, title: "a" },
      { year: 2000, title: "a" },
    ];
    expect(inferSchema(records).pk).toBeUndefined();
  });

  test("does not recommend a uniquely-valued field as pk unless it looks id-like by name", () => {
    const records = [
      { year: 1999, title: "The Matrix" },
      { year: 2000, title: "Gladiator" },
    ];
    // title is unique across the sample but isn't id-shaped by name — no guess.
    expect(inferSchema(records).pk).toBeUndefined();
  });
});

describe("inferSchema — default indexed-set recommendation", () => {
  test("recommends a small set of categorical (low-cardinality, non-constant) fields, excluding the sort field", () => {
    const records = [
      { year: 1999, category: "action", price: 10, title: "a" },
      { year: 2000, category: "action", price: 20, title: "b" },
      { year: 2001, category: "drama", price: 30, title: "c" },
      { year: 2002, category: "drama", price: 40, title: "d" },
    ];
    const result = inferSchema(records);
    expect(result.indexedFields).toContain("category");
    expect(result.indexedFields).not.toContain("year");
  });

  test("excludes a constant field (cardinality 1) from the default indexed set", () => {
    const records = [
      { year: 1999, kind: "movie" },
      { year: 2000, kind: "movie" },
    ];
    expect(inferSchema(records).indexedFields).not.toContain("kind");
  });

  test("excludes a fully-unique-looking field from the default indexed set", () => {
    const records = [
      { year: 1999, uuid: "a1" },
      { year: 2000, uuid: "b2" },
      { year: 2001, uuid: "c3" },
    ];
    expect(inferSchema(records).indexedFields).not.toContain("uuid");
  });

  test("caps the default indexed set at a small number of categorical fields", () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      year: 1990 + i,
      a: `a${i % 2}`,
      b: `b${i % 2}`,
      c: `c${i % 2}`,
      d: `d${i % 2}`,
      e: `e${i % 2}`,
    }));
    expect(inferSchema(records).indexedFields.length).toBeLessThanOrEqual(3);
  });

  test("always includes a detected multi-valued field in the indexed set (required to declare it correctly)", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ year: 1990 + i, genres: [`g${i}`, `h${i}`] }));
    expect(inferSchema(records).indexedFields).toContain("genres");
  });
});

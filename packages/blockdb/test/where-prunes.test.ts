import { describe, expect, test } from "vitest";
import { createClient } from "../src/client.js";
import { BlockDbError } from "../src/errors.js";
import { assertWhereHasPruning, wherePrunes } from "../src/types.js";
import type { SchemaMeta } from "../src/types.js";

// The rider rule as a check, for a `where` built from UI input: fall back instead of catching.

const fields = {
  year: { kind: "number", operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
  name: { kind: "string", operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"], pruning: ["equals", "in", "startsWith", "contains"] },
  note: { kind: "string", operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"], pruning: [] },
  tags: { kind: "string", multi: true, operators: ["equals", "in", "startsWith", "contains"], pruning: ["equals", "in", "startsWith", "contains"] },
} as const;
const collection = { fields };
const withSortField = { sortField: "year", fields };

describe("wherePrunes", () => {
  test("a filter the sort field or an index answers prunes; riders alone don't", () => {
    expect(wherePrunes({ year: { gte: 2000 } }, collection)).toBe(true);
    expect(wherePrunes({ name: { equals: "Bolt" } }, collection)).toBe(true);
    expect(wherePrunes({ note: { equals: "x" } }, collection)).toBe(false);
    expect(wherePrunes({ name: { not: "Bolt" } }, collection)).toBe(false);
    expect(wherePrunes({ note: { equals: "x" }, year: { lt: 1990 } }, collection)).toBe(true);
  });

  test("contains prunes only with 3 or more characters", () => {
    expect(wherePrunes({ name: { contains: "bol" } }, collection)).toBe(true);
    expect(wherePrunes({ name: { contains: "bo" } }, collection)).toBe(false);
    expect(wherePrunes({ name: { contains: "" } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { some: { contains: "ab" } } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { some: { contains: "abc" } } }, collection)).toBe(true);
  });

  test("an empty or missing where is allowed, so it counts as pruning", () => {
    expect(wherePrunes(undefined, collection)).toBe(true);
    expect(wherePrunes({}, collection)).toBe(true);
    expect(wherePrunes({ name: undefined }, collection)).toBe(true);
  });

  test("takes a collection's getSchema() as it is", () => {
    const schema = { cards: collection } satisfies SchemaMeta;
    const db = createClient<typeof schema, { cards: Record<string, unknown> }>(schema, { basePath: "/data", fetch: fetch });
    expect(wherePrunes({ name: { contains: "a" } }, db.cards.getSchema())).toBe(false);
  });

  test("assertWhereHasPruning agrees, and names the 3-character rule when a short contains is why", () => {
    expect(() => assertWhereHasPruning({ name: { contains: "bol" } }, withSortField)).not.toThrow();
    let error: unknown;
    try {
      assertWhereHasPruning({ name: { contains: "bo" } }, withSortField);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BlockDbError);
    expect((error as BlockDbError).code).toBe("NEEDS_PRUNING");
    expect((error as BlockDbError).message).toMatch(/`contains` needs at least 3 characters/);
    expect((error as BlockDbError).message).toMatch(/wherePrunes\(\)/);

    try {
      assertWhereHasPruning({ note: { equals: "x" } }, withSortField);
    } catch (e) {
      expect((e as BlockDbError).message).not.toMatch(/3 characters/);
    }
  });
});

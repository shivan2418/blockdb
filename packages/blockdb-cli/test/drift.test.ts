import { describe, expect, test } from "vitest";
import { assertNoSchemaDrift } from "../src/drift.js";
import type { FieldConfig } from "../src/types.js";

// Every key may be missing here, so each kind-drift test can use a record holding just the field it's about.
const fields: Record<string, FieldConfig> = {
  year: { kind: "number", absent: true },
  title: { kind: "string", absent: true },
  active: { kind: "boolean", absent: true },
  genres: { kind: "string", indexed: true, multi: true, absent: true },
};

const strict: Record<string, FieldConfig> = {
  year: { kind: "number" },
  title: { kind: "string" },
  genres: { kind: "string", indexed: true, multi: true },
  payload: { kind: "json" },
};

describe("assertNoSchemaDrift", () => {
  test("passes when every present value matches its declared kind", () => {
    const records = [{ year: 1999, title: "The Matrix", active: true, genres: ["Action"] }];
    expect(() => assertNoSchemaDrift(records, fields)).not.toThrow();
  });

  test("a missing key fails unless the field is absent, since the generated type says it's always there", () => {
    expect(() => assertNoSchemaDrift([{ year: 1999, genres: [] }], strict)).toThrow(/record 0 has no "title" key/);
    expect(() => assertNoSchemaDrift([{ year: 1999, genres: [] }], strict)).toThrow(/"absent": true/);
    expect(() => assertNoSchemaDrift([{ year: 1999 }], fields)).not.toThrow();
  });

  test("a null fails unless the field is nullable, since the generated type says it's never null", () => {
    const records = [{ year: 1999, title: null, genres: [] }];
    expect(() => assertNoSchemaDrift(records, strict)).toThrow(/record 0 has "title": null/);
    expect(() => assertNoSchemaDrift(records, strict)).toThrow(/"nullable": true/);
    expect(() => assertNoSchemaDrift(records, { ...strict, title: { kind: "string", nullable: true } })).not.toThrow();
  });

  test("a null list is a missing value too, allowed only on a nullable list field", () => {
    const records = [{ year: 1999, title: "T", genres: null }];
    expect(() => assertNoSchemaDrift(records, strict)).toThrow(/"genres": null/);
    const nullableGenres = { ...strict, genres: { kind: "string" as const, indexed: true, multi: true, nullable: true } };
    expect(() => assertNoSchemaDrift(records, nullableGenres)).not.toThrow();
  });

  test("payload-only json fields may be missing or null: they're opaque and always typed optional", () => {
    expect(() => assertNoSchemaDrift([{ year: 1999, title: "T", genres: [] }], strict)).not.toThrow();
    expect(() => assertNoSchemaDrift([{ year: 1999, title: "T", genres: [], payload: null }], strict)).not.toThrow();
  });

  test("throws loud when a declared number field's actual value is a string", () => {
    const records = [{ year: "1999" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"year".*number/i);
  });

  test("throws loud when a declared boolean field's actual value is a string", () => {
    const records = [{ active: "true" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"active".*boolean/i);
  });

  test("throws loud when a declared multi field's value is no longer a string array", () => {
    const records = [{ genres: "Action" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"genres".*multi/i);
  });

  test("throws loud when a declared multi field's array contains a non-string element", () => {
    const records = [{ genres: ["Action", 5] }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"genres".*multi/i);
  });

  test("identifies the offending record index in the error message", () => {
    const records = [{ year: 1999 }, { year: 2000 }, { year: "2001" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/2/);
  });

  test("an array on a single-valued field says how to declare it, instead of just 'object'", () => {
    // The common way in: un-indexing a multi-valued field drops `multi` with it, since `multi`
    // requires `indexed`. "has a object value" alone doesn't tell you the way out.
    const records = [{ title: ["G"] }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/array/);
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"multi": true.*"indexed": true/);
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"kind": "json"/);
  });

  test("names the CLI's real binary when suggesting a fix", () => {
    expect(() => assertNoSchemaDrift([{ year: "1999" }], fields)).toThrow(/"blockdb init --reinfer"/);
    expect(() => assertNoSchemaDrift([{ genres: "Action" }], fields)).toThrow(/"blockdb init --reinfer"/);
  });
});

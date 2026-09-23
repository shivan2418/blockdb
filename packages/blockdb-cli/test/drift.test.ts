import { describe, expect, test } from "vitest";
import { assertNoSchemaDrift } from "../src/drift.js";
import type { FieldConfig } from "../src/types.js";

const fields: Record<string, FieldConfig> = {
  year: { kind: "number" },
  title: { kind: "string" },
  active: { kind: "boolean" },
  genres: { kind: "string", indexed: true, multi: true },
};

describe("assertNoSchemaDrift", () => {
  test("passes when every present value matches its declared kind", () => {
    const records = [{ year: 1999, title: "The Matrix", active: true, genres: ["Action"] }];
    expect(() => assertNoSchemaDrift(records, fields)).not.toThrow();
  });

  test("ignores a missing key entirely (presence is T7's concern, not drift's)", () => {
    const records = [{ year: 1999 }];
    expect(() => assertNoSchemaDrift(records, fields)).not.toThrow();
  });

  test("ignores an explicit null (null is a valid value distinct from absent)", () => {
    const records = [{ year: 1999, title: null }];
    expect(() => assertNoSchemaDrift(records, fields)).not.toThrow();
  });

  test("throws loud when a declared number field's actual value is a string", () => {
    const records = [{ year: "1999" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/year.*number|drift/i);
  });

  test("throws loud when a declared boolean field's actual value is a string", () => {
    const records = [{ active: "true" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/active.*boolean|drift/i);
  });

  test("throws loud when a declared multi field's value is no longer a string array", () => {
    const records = [{ genres: "Action" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/genres.*multi|drift/i);
  });

  test("throws loud when a declared multi field's array contains a non-string element", () => {
    const records = [{ genres: ["Action", 5] }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/genres.*multi|drift/i);
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

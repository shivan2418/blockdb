import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import type { StaticShardConfig } from "../src/types.js";

const base: StaticShardConfig = {
  collection: "movies",
  input: { path: "data/movies.ndjson" },
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string" },
    },
  },
};

describe("resolveConfig", () => {
  test("fills in defaults for output, clientOut, basePath, shardBytes", () => {
    const resolved = resolveConfig(base, "/repo");
    expect(resolved.output).toBe("/repo/public/shard-data");
    expect(resolved.clientOut).toBe("/repo/src/shard-db");
    expect(resolved.basePath).toBe("/shard-data");
    expect(resolved.shardBytes).toBeGreaterThan(0);
    expect(resolved.inputPath).toBe("/repo/data/movies.ndjson");
    expect(resolved.inputFormat).toBe("ndjson");
    expect(resolved.gzip).toBe(false);
  });

  test("honors an explicit gzip: true override (T13, ADR-0002 §8)", () => {
    const resolved = resolveConfig({ ...base, gzip: true }, "/repo");
    expect(resolved.gzip).toBe(true);
  });

  test("honors explicit output/clientOut/basePath/shardBytes overrides", () => {
    const resolved = resolveConfig(
      { ...base, output: "dist/data", clientOut: "dist/client", basePath: "https://cdn.example.com/data", shardBytes: 1024 },
      "/repo",
    );
    expect(resolved.output).toBe("/repo/dist/data");
    expect(resolved.clientOut).toBe("/repo/dist/client");
    expect(resolved.basePath).toBe("https://cdn.example.com/data");
    expect(resolved.shardBytes).toBe(1024);
  });

  test("rejects a sortField not declared in schema.fields", () => {
    const bad: StaticShardConfig = { ...base, schema: { sortField: "missing", fields: base.schema.fields } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/sortField/);
  });

  test("rejects a sortField whose kind is not number or date", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "title", fields: base.schema.fields },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/number.*date|date.*number/i);
  });

  test("rejects an unsupported input format", () => {
    const bad: StaticShardConfig = { ...base, input: { path: "x.xml", format: "xml" as never } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/unsupported input format/);
  });
});

describe("resolveConfig — input formats (T9)", () => {
  test("json/csv/tsv are accepted, defaulting delimiter per format", () => {
    expect(resolveConfig({ ...base, input: { path: "x.json", format: "json" } }, "/repo").inputFormat).toBe("json");

    const csv = resolveConfig({ ...base, input: { path: "x.csv", format: "csv" } }, "/repo");
    expect(csv.inputFormat).toBe("csv");
    expect(csv.inputDelimiter).toBe(",");

    const tsv = resolveConfig({ ...base, input: { path: "x.tsv", format: "tsv" } }, "/repo");
    expect(tsv.inputFormat).toBe("tsv");
    expect(tsv.inputDelimiter).toBe("\t");
  });

  test("honors an explicit delimiter override for csv/tsv", () => {
    const resolved = resolveConfig({ ...base, input: { path: "x.csv", format: "csv", delimiter: ";" } }, "/repo");
    expect(resolved.inputDelimiter).toBe(";");
  });

  test("rejects a delimiter override on ndjson/json input", () => {
    const bad: StaticShardConfig = { ...base, input: { path: "x.ndjson", delimiter: ";" } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/delimiter.*json|json.*delimiter/i);
  });

  test("carries a records selector path through for json input", () => {
    const resolved = resolveConfig({ ...base, input: { path: "x.json", format: "json", records: "data.records" } }, "/repo");
    expect(resolved.inputRecordsPath).toBe("data.records");
  });

  test("omits inputRecordsPath entirely when not configured", () => {
    const resolved = resolveConfig(base, "/repo");
    expect(resolved.inputRecordsPath).toBeUndefined();
  });

  test("rejects a records selector on a non-json format", () => {
    const bad: StaticShardConfig = { ...base, input: { path: "x.ndjson", records: "data.records" } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/records.*json|json.*records/i);
  });
});

describe("resolveConfig — endsWith/contains opt-ins (T6)", () => {
  const indexedString: StaticShardConfig = {
    ...base,
    schema: {
      sortField: "year",
      fields: { ...base.schema.fields, title: { kind: "string", indexed: true } },
    },
  };

  test("accepts endsWith/contains on an indexed string field", () => {
    const resolved = resolveConfig(
      { ...indexedString, schema: { ...indexedString.schema, fields: { ...indexedString.schema.fields, title: { kind: "string", indexed: true, endsWith: true, contains: true } } } },
      "/repo",
    );
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, endsWith: true, contains: true });
  });

  test("rejects endsWith on a non-indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", endsWith: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects contains on a non-indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", contains: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects endsWith on a non-string indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: {
        sortField: "year",
        fields: { ...base.schema.fields, rating: { kind: "number", indexed: true, endsWith: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/rating.*string|string.*rating/i);
  });

  test("rejects contains on a non-string indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: {
        sortField: "year",
        fields: { ...base.schema.fields, rating: { kind: "number", indexed: true, contains: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/rating.*string|string.*rating/i);
  });

  test("rejects endsWith/contains on the sort field itself (always number/date, never string)", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, year: { kind: "number", endsWith: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/year.*string|string.*year/i);
  });
});

describe("resolveConfig — multi/absent opt-ins (T7)", () => {
  test("accepts multi on an indexed string field", () => {
    const resolved = resolveConfig(
      { ...base, schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", indexed: true, multi: true } } } },
      "/repo",
    );
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, multi: true });
  });

  test("accepts absent on an indexed field of any kind", () => {
    const resolved = resolveConfig(
      { ...base, schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", indexed: true, absent: true } } } },
      "/repo",
    );
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, absent: true });
  });

  test("rejects multi on a non-indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", multi: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects multi on a non-string indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, rating: { kind: "number", indexed: true, multi: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/rating.*string|string.*rating/i);
  });

  test("rejects multi on the sort field itself", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, year: { kind: "number", multi: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/year.*sort field/i);
  });

  test("rejects absent on a non-indexed field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", absent: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects absent on the sort field itself", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, year: { kind: "number", absent: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/year.*sort field/i);
  });

  test("rejects a field opting into both multi and absent (element-presence semantics are unsupported)", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: {
        sortField: "year",
        fields: { ...base.schema.fields, title: { kind: "string", indexed: true, multi: true, absent: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*multi.*absent|absent.*multi/i);
  });
});

describe("resolveConfig — pk opt-in (T8)", () => {
  test("accepts pk on the sort field itself (the free zonemap path)", () => {
    const resolved = resolveConfig({ ...base, schema: { sortField: "year", pk: "year", fields: base.schema.fields } }, "/repo");
    expect(resolved.pk).toBe("year");
  });

  test("accepts pk on a non-sort field that is indexed", () => {
    const resolved = resolveConfig(
      { ...base, schema: { sortField: "year", pk: "title", fields: { ...base.schema.fields, title: { kind: "string", indexed: true } } } },
      "/repo",
    );
    expect(resolved.pk).toBe("title");
  });

  test("omits pk entirely when not configured", () => {
    const resolved = resolveConfig(base, "/repo");
    expect(resolved.pk).toBeUndefined();
  });

  test("rejects a pk not declared in schema.fields", () => {
    const bad: StaticShardConfig = { ...base, schema: { sortField: "year", pk: "missing", fields: base.schema.fields } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/pk.*missing|missing.*pk/i);
  });

  test("rejects pk on a non-sort field that is NOT indexed (no index to look it up by)", () => {
    const bad: StaticShardConfig = { ...base, schema: { sortField: "year", pk: "title", fields: base.schema.fields } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects pk on a multi-valued field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: {
        sortField: "year",
        pk: "title",
        fields: { ...base.schema.fields, title: { kind: "string", indexed: true, multi: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*multi|multi.*title/i);
  });

  test("rejects pk on an absentable field", () => {
    const bad: StaticShardConfig = {
      ...base,
      schema: {
        sortField: "year",
        pk: "title",
        fields: { ...base.schema.fields, title: { kind: "string", indexed: true, absent: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*present|present.*title/i);
  });
});

describe("resolveConfig — enum-like value unions", () => {
  const withField = (title: Record<string, unknown>): StaticShardConfig => ({
    ...base,
    schema: { sortField: "year", fields: { ...base.schema.fields, title: title as never } },
  });

  test("accepts a values array on an indexed string field", () => {
    const resolved = resolveConfig(withField({ kind: "string", indexed: true, values: ["a", "b"] }), "/repo");
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, values: ["a", "b"] });
  });

  test("rejects values on a non-string field — only strings can be an enum", () => {
    expect(() => resolveConfig(withField({ kind: "number", indexed: true, values: ["a"] }), "/repo")).toThrow(
      /"values".*kind "number"|kind "number".*"values"/,
    );
  });

  test("rejects values on a non-indexed field — a union only narrows queryable fields", () => {
    expect(() => resolveConfig(withField({ kind: "string", values: ["a"] }), "/repo")).toThrow(/not indexed/);
  });

  test("rejects an empty values array rather than emitting an uninhabitable union", () => {
    expect(() => resolveConfig(withField({ kind: "string", indexed: true, values: [] }), "/repo")).toThrow(/empty/);
  });

  test("rejects duplicate values", () => {
    expect(() => resolveConfig(withField({ kind: "string", indexed: true, values: ["a", "b", "a"] }), "/repo")).toThrow(
      /duplicate/,
    );
  });
});

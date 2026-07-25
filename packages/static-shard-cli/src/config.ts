import { readFileSync } from "node:fs";
import path from "node:path";
import type { InputFormat, ResolvedConfig, StaticShardConfig } from "./types.js";

const DEFAULT_OUTPUT = "public/shard-data";
const DEFAULT_CLIENT_OUT = "src/shard-db";
const DEFAULT_SHARD_BYTES = 2_097_152; // 2 MiB
/** ~45 KB gzipped anchor (ADR-0003 §5) — exported so the wizard's live estimates (T12) use the same default `build` would. */
export const DEFAULT_INDEX_CHUNK_BYTES = 45_000;
const INPUT_FORMATS = ["ndjson", "json", "csv", "tsv"] as const;
/**
 * Field kinds a sort field may have (ADR-0002 §2). Exported so `infer`'s candidate predicate and
 * the wizard's candidate list share this exact set rather than keeping second copies that could
 * drift from what `build` accepts.
 */
export const SORTABLE_KINDS = ["number", "date", "string"] as const;
export type SortableKind = (typeof SORTABLE_KINDS)[number];
const DEFAULT_DELIMITERS: Partial<Record<InputFormat, string>> = { csv: ",", tsv: "\t" };

function defaultBasePath(output: string): string {
  const normalized = output.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("public/") ? `/${normalized.slice("public/".length)}` : `/${normalized}`;
}

export function resolveConfig(config: StaticShardConfig, baseDir: string): ResolvedConfig {
  const format = config.input.format ?? "ndjson";
  if (!INPUT_FORMATS.includes(format)) {
    throw new Error(
      `static-shard: unsupported input format "${format}" — supported formats: ${INPUT_FORMATS.join(", ")}`,
    );
  }
  if (config.input.records !== undefined && format !== "json") {
    throw new Error(`static-shard: config.input.records is only valid for format "json", got "${format}"`);
  }
  if (config.input.delimiter !== undefined && format !== "csv" && format !== "tsv") {
    throw new Error(`static-shard: config.input.delimiter is only valid for format "csv"/"tsv", got "${format}"`);
  }
  const delimiter = config.input.delimiter ?? DEFAULT_DELIMITERS[format] ?? ",";

  const sortField = config.schema.sortField;
  const sortFieldConfig = config.schema.fields[sortField];
  if (!sortFieldConfig) {
    throw new Error(`static-shard: config.schema.sortField "${sortField}" is not declared in config.schema.fields`);
  }
  // number | date | string. Strings range-partition lexicographically exactly as dates already do
  // (dates ARE compared as ISO strings), and the sort field is the one field whose locality decides
  // what a query costs — restricting it to number/date would have forced a timestamp on datasets
  // whose real access pattern is a name. `boolean` and `json` stay out: a two-value sort field is a
  // degenerate partition, and a payload field has no order (ADR-0001).
  if (!SORTABLE_KINDS.includes(sortFieldConfig.kind as SortableKind)) {
    throw new Error(
      `static-shard: sortField "${sortField}" must be one of ${SORTABLE_KINDS.join(" / ")}, got "${sortFieldConfig.kind}"`,
    );
  }

  // `endsWith`/`contains` build structures only for non-sort fields (build.ts indexes the secondary
  // set), so declaring them on the sort field used to be silently dropped — the config asked for an
  // operator the generated client would never expose. Say so instead.
  for (const op of ["endsWith", "contains"] as const) {
    if (sortFieldConfig[op]) {
      throw new Error(
        `static-shard: sortField "${sortField}" cannot also declare ${op}: true — the sort field prunes via ` +
          `split-points, not an inverted index, so no ${op} structure is built for it. ` +
          `Sorted string fields get equals/in/startsWith and the range operators for free; for ${op} on ` +
          `"${sortField}", sort by a different field and index this one instead.`,
      );
    }
  }

  for (const [name, field] of Object.entries(config.schema.fields)) {
    const isSortField = name === sortField;

    if (field.kind === "json" && (field.indexed === true || field.endsWith || field.contains || field.multi || isSortField)) {
      throw new Error(
        `static-shard: field "${name}" is kind "json" (payload-only) — it cannot be indexed, sorted on, or given endsWith/contains/multi. Give it a scalar kind to make it queryable.`,
      );
    }

    if (field.values !== undefined) {
      if (field.kind !== "string") {
        throw new Error(
          `static-shard: field "${name}" declares "values" but is kind "${field.kind}" — a value union requires kind: "string"`,
        );
      }
      // No sort-field exemption needed: `values` requires kind "string", and a sort field must be
      // number/date, so a valued field is always a secondary field that has to be indexed.
      if (field.indexed !== true) {
        throw new Error(
          `static-shard: field "${name}" declares "values" but is not indexed — a value union only narrows queryable fields, so set indexed: true or remove "values"`,
        );
      }
      if (field.values.length === 0) {
        throw new Error(
          `static-shard: field "${name}" declares an empty "values" array — remove it to leave the field typed as plain string`,
        );
      }
      const duplicates = field.values.filter((v, i) => field.values!.indexOf(v) !== i);
      if (duplicates.length > 0) {
        throw new Error(
          `static-shard: field "${name}" declares duplicate "values" entries (${[...new Set(duplicates)].join(", ")}) — each value must appear once`,
        );
      }
    }

    if (field.endsWith || field.contains) {
      const opt = field.endsWith ? "endsWith" : "contains";
      if (field.kind !== "string") {
        throw new Error(
          `static-shard: field "${name}" opts into "${opt}" but is kind "${field.kind}" — endsWith/contains require kind: "string"`,
        );
      }
      if (field.indexed !== true) {
        throw new Error(
          `static-shard: field "${name}" opts into "${opt}" but is not indexed — set indexed: true first (ADR-0003 §7)`,
        );
      }
    }

    if (field.multi) {
      if (isSortField) {
        throw new Error(
          `static-shard: field "${name}" opts into "multi" but is the sort field — a multi-valued field cannot be the sort field`,
        );
      }
      if (field.kind !== "string") {
        throw new Error(
          `static-shard: field "${name}" opts into "multi" but is kind "${field.kind}" — multi requires kind: "string" (T7)`,
        );
      }
      if (field.indexed !== true) {
        throw new Error(`static-shard: field "${name}" opts into "multi" but is not indexed — set indexed: true first (T7)`);
      }
      if (field.absent) {
        throw new Error(
          `static-shard: field "${name}" opts into both "multi" and "absent" — presence semantics over a multi-valued field's elements are not supported (T7)`,
        );
      }
    }

    if (field.absent) {
      if (isSortField) {
        throw new Error(
          `static-shard: field "${name}" opts into "absent" but is the sort field — presence semantics are not supported on the sort field`,
        );
      }
      if (field.indexed !== true) {
        throw new Error(`static-shard: field "${name}" opts into "absent" but is not indexed — set indexed: true first (T7)`);
      }
    }
  }

  const pk = config.schema.pk;
  if (pk !== undefined) {
    const pkFieldConfig = config.schema.fields[pk];
    if (!pkFieldConfig) {
      throw new Error(`static-shard: config.schema.pk "${pk}" is not declared in config.schema.fields`);
    }
    if (pkFieldConfig.multi) {
      throw new Error(`static-shard: config.schema.pk "${pk}" opts into "multi" — a multi-valued field cannot be a primary key`);
    }
    if (pkFieldConfig.absent) {
      throw new Error(`static-shard: config.schema.pk "${pk}" opts into "absent" — a primary key must always be present`);
    }
    if (pk !== sortField && pkFieldConfig.indexed !== true) {
      throw new Error(
        `static-shard: config.schema.pk "${pk}" is not the sort field and is not indexed — set indexed: true so get(id) has an index to look it up by (ADR-0003 §10)`,
      );
    }
  }

  const output = config.output ?? DEFAULT_OUTPUT;

  return {
    collection: config.collection,
    inputPath: path.resolve(baseDir, config.input.path),
    inputFormat: format,
    inputDelimiter: delimiter,
    ...(config.input.records !== undefined ? { inputRecordsPath: config.input.records } : {}),
    output: path.resolve(baseDir, output),
    clientOut: path.resolve(baseDir, config.clientOut ?? DEFAULT_CLIENT_OUT),
    basePath: config.basePath ?? defaultBasePath(output),
    shardBytes: config.shardBytes ?? DEFAULT_SHARD_BYTES,
    gzip: config.gzip ?? false,
    indexChunkBytes: config.indexChunkBytes ?? DEFAULT_INDEX_CHUNK_BYTES,
    sortField,
    ...(pk !== undefined ? { pk } : {}),
    fields: config.schema.fields,
  };
}

export function loadConfigFile(configPath: string): StaticShardConfig {
  return JSON.parse(readFileSync(configPath, "utf8")) as StaticShardConfig;
}

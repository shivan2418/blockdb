import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfigFile, resolveConfig } from "./config.js";
import { inferSchema } from "./infer.js";
import { readInputRecords } from "./input.js";
import type { OnProgress } from "./progress.js";
import type { FieldConfig, InputFormat, StaticShardConfig } from "./types.js";
import { getFormatVersion } from "./version.js";

/** Exported so callers that sample records the same way `init` does (the wizard, T12) never drift from this default. */
export const DEFAULT_SAMPLE_SIZE = 1000;

/**
 * How many leading records inference should look at, or `undefined` for every record.
 *
 * Reading everything is the DEFAULT: inference decides the baked schema, and a schema wrong about
 * the data is the expensive kind of wrong — a value union missing a late value, a field that never
 * appeared in the first 1000 rows, a cardinality that misprices an index or picks the wrong sort
 * field. `build` already reads the whole input, so a full scan asks for no memory a build doesn't.
 * Sampling stays available for a fast look at a large file, but it is now opt-in.
 */
export function sampleLimit(opts: { fullScan?: boolean; sampleSize?: number }): number | undefined {
  return opts.fullScan ? undefined : opts.sampleSize;
}

/** Shared by `init` and the wizard's live estimates (T12): applies `sampleLimit` to already-read records. */
export function sampleRecords(
  records: Record<string, unknown>[],
  opts: { fullScan?: boolean; sampleSize?: number },
): Record<string, unknown>[] {
  const limit = sampleLimit(opts);
  return limit === undefined ? records : records.slice(0, limit);
}

/** Convention for editor JSON-schema resolution: `config.schema.json` ships inside the installed devDependency. */
const CONFIG_SCHEMA_REF = "node_modules/static-shard-cli/config.schema.json";

export interface InitOptions {
  /** Directory input/config-relative paths resolve against. */
  cwd: string;
  /** Absolute path to read/write `static-shard.config.json`. */
  configPath: string;
  /** Non-interactive confirmation — must be true, or this throws. The interactive wizard (T12,
   * `wizard-tui.ts`) sits above `init()` in `bin.ts` and always passes `true` here itself, once its
   * review step confirms; `init()` has no separate interactive path of its own. */
  yes: boolean;
  /** Re-run inference even if a config already exists, refreshing the baked schema block. */
  reinfer?: boolean;
  /** Force a full scan. Redundant with the default, kept so `--full-scan` stays meaningful and explicit. */
  fullScan?: boolean;
  /** Opt into inferring from only the leading `sampleSize` records instead of the whole input. */
  sampleSize?: number;
  collection?: string;
  /** Positional input path/glob — required the first time `init` runs for a given config. */
  inputPath?: string;
  format?: InputFormat;
  delimiter?: string;
  records?: string;
  sortField?: string;
  pk?: string;
  /** Explicit opt-in indexed-field set, overriding the inferred/existing recommendation. */
  indexedFields?: string[];
  /** Fields to opt into the reversed-value index (ADR-0003 §7) — forces them indexed too. */
  endsWithFields?: string[];
  /** Fields to opt into the trigram index (ADR-0003 §7) — forces them indexed too. */
  containsFields?: string[];
  output?: string;
  clientOut?: string;
  basePath?: string;
  shardBytes?: number;
  indexChunkBytes?: number;
  /**
   * Progress for the read phase. Reading the whole input is the default, so on a large file this is
   * the difference between a progress bar and a long silence.
   */
  onProgress?: OnProgress;
}

type FieldFlagOverrides = Pick<InitOptions, "indexedFields" | "endsWithFields" | "containsFields">;

/**
 * Layers `--indexed`/`--ends-with`/`--contains` on top of a fields record — used identically
 * whether `fields` just came from inference or is being reused from an existing config, so the
 * flag-equivalence contract (ADR-0005 §3) is honored the same way either way. `--indexed`, when
 * passed, is the *complete* indexed set (flags > file precedence) rather than merged with
 * whatever was already indexed. Multi-valued fields and a non-sort-field pk are always forced
 * indexed regardless — omitting them isn't a real choice, it produces a structurally broken config.
 */
function applyFieldFlagOverrides(
  fields: Record<string, FieldConfig>,
  sortField: string,
  pk: string | undefined,
  overrides: FieldFlagOverrides,
): Record<string, FieldConfig> {
  const flagGroups: [string, string[] | undefined][] = [
    ["indexed", overrides.indexedFields],
    ["ends-with", overrides.endsWithFields],
    ["contains", overrides.containsFields],
  ];
  for (const [flagName, names] of flagGroups) {
    for (const name of names ?? []) {
      if (!fields[name]) {
        throw new Error(
          `static-shard: --${flagName} "${name}" is not declared in the baked schema — pass --reinfer to rediscover fields`,
        );
      }
    }
  }

  const indexedWanted = overrides.indexedFields ? new Set(overrides.indexedFields) : undefined;
  const endsWithWanted = new Set(overrides.endsWithFields ?? []);
  const containsWanted = new Set(overrides.containsFields ?? []);
  if (!indexedWanted && endsWithWanted.size === 0 && containsWanted.size === 0) return fields;

  const next: Record<string, FieldConfig> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (name === sortField) {
      next[name] = f;
      continue;
    }
    const cfg: FieldConfig = { ...f };
    const mustIndex = cfg.multi === true || name === pk;

    if (indexedWanted) {
      if (indexedWanted.has(name) || mustIndex) cfg.indexed = true;
      else {
        delete cfg.indexed;
        // A value union only narrows a queryable field, so it goes when the index does.
        delete cfg.values;
      }
    }
    if (endsWithWanted.has(name)) {
      cfg.indexed = true;
      cfg.endsWith = true;
    }
    if (containsWanted.has(name)) {
      cfg.indexed = true;
      cfg.contains = true;
    }
    if (mustIndex) cfg.indexed = true;
    next[name] = cfg;
  }
  return next;
}

export interface InitResult {
  configPath: string;
  config: StaticShardConfig;
  /** True when this run actually (re)inferred the schema, false when it reused an existing baked one. */
  reinferred: boolean;
  /** Non-fatal repairs made while resolving — e.g. query flags dropped from a payload-only `json` field. */
  warnings: string[];
}

/** Flags that only mean something on a queryable field; `config.ts` rejects all of them on a `json` field. */
const QUERY_FLAGS = ["indexed", "endsWith", "contains", "multi", "absent"] as const;

/**
 * Strips query flags that landed on a payload-only `json` field, reporting each one.
 *
 * Asking to index a nested/mixed field is an easy mistake (a `--indexed` list, a hand-edited config,
 * or a field that only became `json` on `--reinfer` after the data changed shape), and failing the
 * whole run over it would throw away every other choice the user made. Dropping just the offending
 * flags always lands a usable config; the field itself is still stored and returned, just not
 * filterable. `sortField`/`pk` are deliberately NOT repaired this way — they name a required role,
 * so quietly dropping them would leave the config structurally incomplete, and `resolveConfig`
 * rightly rejects a `json` field in either slot.
 */
function dropQueryFlagsFromJsonFields(fields: Record<string, FieldConfig>): {
  fields: Record<string, FieldConfig>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const next: Record<string, FieldConfig> = {};

  for (const [name, field] of Object.entries(fields)) {
    const dropped = field.kind === "json" ? QUERY_FLAGS.filter((flag) => field[flag] === true) : [];
    if (dropped.length === 0) {
      next[name] = field;
      continue;
    }
    const cfg: FieldConfig = { ...field };
    for (const flag of dropped) delete cfg[flag];
    next[name] = cfg;
    warnings.push(
      `static-shard: field "${name}" holds nested or mixed-type values, so it is payload-only (kind "json") — ` +
        `dropped ${dropped.join(", ")}. It is still stored and returned by findMany, but cannot be filtered on. ` +
        `To query it, flatten it into a scalar field upstream and re-run init --reinfer.`,
    );
  }

  return { fields: next, warnings };
}

/**
 * Computes the config `init` would write, without writing it — the pure(-ish; it still reads the
 * input file and any existing config) core `init()` builds on. Exported so the wizard's review step
 * (T12) can render an exact, byte-faithful "what will be written" preview by calling the *same*
 * resolution logic the actual persist step uses, instead of hand-reconstructing its own JSON shape
 * that could silently drift from it.
 */
export function resolveInitConfig(opts: InitOptions): InitResult {
  if (!opts.yes) {
    throw new Error(
      'static-shard: "init" requires --yes to run non-interactively — pass --yes plus flags, or re-run in a real terminal for the interactive wizard',
    );
  }

  const existing = existsSync(opts.configPath) ? loadConfigFile(opts.configPath) : undefined;

  const inputPath = opts.inputPath ?? existing?.input.path;
  if (!inputPath) {
    throw new Error("static-shard: init needs an input path/glob — pass it as the positional argument");
  }
  const format: InputFormat = opts.format ?? existing?.input.format ?? "ndjson";
  const delimiter = opts.delimiter ?? existing?.input.delimiter;
  const recordsPath = opts.records ?? existing?.input.records;
  const collection = opts.collection ?? existing?.collection ?? path.basename(inputPath).replace(/\.[^.]+$/, "");

  const reinferred = existing === undefined || opts.reinfer === true;

  let fields: Record<string, FieldConfig>;
  let sortField: string;
  let pk: string | undefined;

  if (reinferred) {
    const readDelimiter = delimiter ?? (format === "tsv" ? "\t" : ",");
    const allRecords = readInputRecords(path.resolve(opts.cwd, inputPath), {
      format,
      delimiter: readDelimiter,
      recordsPath,
      fields: {},
      // Reads everything unless the caller opted into a sample (see `sampleLimit`).
      limit: sampleLimit(opts),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    if (allRecords.length === 0) {
      throw new Error(`static-shard: init found no records in "${inputPath}" to infer a schema from`);
    }
    const sample = sampleRecords(allRecords, opts);
    // Open-ended: inference walks every sampled record per field with no reportable midpoint, and
    // under --full-scan the sample IS the whole dataset, which is the slow half of a full scan.
    opts.onProgress?.({ phase: "inferring schema", done: sample.length, unit: "count" });
    const inferred = inferSchema(sample);

    sortField = opts.sortField ?? inferred.sortField;
    pk = opts.pk ?? inferred.pk;

    const defaultIndexed = new Set(inferred.indexedFields);
    if (pk !== undefined) defaultIndexed.add(pk);

    fields = {};
    for (const [name, f] of Object.entries(inferred.fields)) {
      const cfg: FieldConfig = { kind: f.kind };
      const isIndexed = f.kind !== "json" && name !== sortField && (defaultIndexed.has(name) || f.multi);
      if (isIndexed) cfg.indexed = true;
      // Only a queryable field's values are worth baking — that's what the union narrows.
      if (isIndexed && f.values) cfg.values = f.values;
      if (f.multi) cfg.multi = true;
      // A multi field can't also be `absent`: T7 has no presence semantics over a string[]'s
      // elements, and config validation rejects the combination (config.ts).
      if (f.absent && isIndexed && !f.multi) cfg.absent = true;
      // `tsType`/`tsImport` are the one part of a field config inference can never produce — the user
      // hand-writes them. `--reinfer` re-reads the DATA's shape, so carry them over rather than
      // silently discarding work. Dropped if the field stopped being a payload field, since a scalar
      // kind can't carry a tsType (config.ts rejects it).
      const priorField = existing?.schema.fields[name];
      if (f.kind === "json" && priorField?.tsType !== undefined) {
        cfg.tsType = priorField.tsType;
        if (priorField.tsImport !== undefined) cfg.tsImport = priorField.tsImport;
      }
      fields[name] = cfg;
    }
  } else {
    fields = existing!.schema.fields;
    sortField = opts.sortField ?? existing!.schema.sortField;
    pk = opts.pk ?? existing!.schema.pk;
  }

  fields = applyFieldFlagOverrides(fields, sortField, pk, opts);
  const repaired = dropQueryFlagsFromJsonFields(fields);
  fields = repaired.fields;

  const output = opts.output ?? existing?.output;
  const clientOut = opts.clientOut ?? existing?.clientOut;
  const basePath = opts.basePath ?? existing?.basePath;
  const shardBytes = opts.shardBytes ?? existing?.shardBytes;
  const indexChunkBytes = opts.indexChunkBytes ?? existing?.indexChunkBytes;

  const config: StaticShardConfig = {
    $schema: CONFIG_SCHEMA_REF,
    formatVersion: getFormatVersion(),
    collection,
    input: {
      path: inputPath,
      ...(format !== "ndjson" ? { format } : {}),
      ...(delimiter !== undefined ? { delimiter } : {}),
      ...(recordsPath !== undefined ? { records: recordsPath } : {}),
    },
    ...(output !== undefined ? { output } : {}),
    ...(clientOut !== undefined ? { clientOut } : {}),
    ...(basePath !== undefined ? { basePath } : {}),
    ...(shardBytes !== undefined ? { shardBytes } : {}),
    ...(indexChunkBytes !== undefined ? { indexChunkBytes } : {}),
    schema: { sortField, ...(pk !== undefined ? { pk } : {}), fields },
  };

  // Fail loud on any invalid combination before writing anything — reuses build's own invariants.
  resolveConfig(config, path.dirname(opts.configPath));

  return { configPath: opts.configPath, config, reinferred, warnings: repaired.warnings };
}

/**
 * The non-interactive core of `init` (ADR-0005 §4 / ADR-0006 §1): infer → recommend → persist
 * `static-shard.config.json`. `init --yes` + flags is fully scriptable; the interactive wizard
 * (T12, `wizard-tui.ts`) is a UX layer that calls this exact function with `yes: true` once its
 * review step confirms — there is no separate wizard-side config writer to drift from this one.
 * Precedence is flags > existing file > inferred defaults (ADR-0005 §3).
 */
export function init(opts: InitOptions): InitResult {
  const result = resolveInitConfig(opts);
  mkdirSync(path.dirname(opts.configPath), { recursive: true });
  writeFileSync(opts.configPath, JSON.stringify(result.config, null, 2) + "\n");
  return result;
}

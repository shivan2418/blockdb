import { SORTABLE_KINDS, type SortableKind } from "./config.js";
import type { OnProgress } from "./progress.js";
import type { FieldKind } from "./types.js";

/** ISO-8601 date/date-time, e.g. "1999-03-31" or "2000-05-05T00:00:00Z" (ADR-0001: date = string + isDate). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Field names that look like an identifier, for the pk-recommendation naming heuristic. */
const ID_LIKE_NAME_RE = /(^_?id$)|([._-]?id$)/i;

/** ADR-0006 §5: `init` recommends a *small* default indexed set, not opt-out-of-everything. */
const DEFAULT_MAX_INDEXED = 3;

/**
 * A string field with at most this many distinct values is treated as enum-like, and its values are
 * baked into the config so codegen can emit a value union (MTG colours, a rarity, a status).
 * Deliberately conservative: it should catch closed sets and miss fields that merely *happen* to be
 * small right now — a set code (dozens, grows every release) or an artist name must stay wide, since
 * a union narrows `equals`/`in`/`some` and a stale one rejects a legitimate query.
 */
export const MAX_ENUM_VALUES = 16;

export interface InferredField {
  kind: FieldKind;
  /** Distinct non-null values observed (for multi fields: distinct elements across all arrays). */
  cardinality: number;
  /** The key was missing from at least one sampled record but present in another (absent ≠ null). */
  absent: boolean;
  /** Every observed value was a string[] — a scalar leaf under an object-array (ADR-0001). */
  multi: boolean;
  /**
   * Sorted distinct values, present only for enum-like string fields (≤ `MAX_ENUM_VALUES` distinct).
   * Drives codegen's value union; omitted for every other field so they stay typed as plain `string`.
   */
  values?: string[];
}

export interface InferenceResult {
  recordCount: number;
  fields: Record<string, InferredField>;
  sortField: string;
  pk?: string;
  /** Recommended default opt-in indexed set (excludes the sort field). */
  indexedFields: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function inferKind(fieldName: string, values: unknown[]): FieldKind {
  const nonNull = values.filter((v) => v !== null);
  if (nonNull.length === 0) return "string";

  const allBoolean = nonNull.every((v) => typeof v === "boolean");
  if (allBoolean) return "boolean";
  const allNumber = nonNull.every((v) => typeof v === "number");
  if (allNumber) return "number";
  const allString = nonNull.every((v) => typeof v === "string");
  if (allString) {
    const allDates = (nonNull as string[]).every((v) => ISO_DATE_RE.test(v));
    return allDates ? "date" : "string";
  }

  // Nested objects and mixed-scalar-type fields aren't a queryable scalar kind — carry them as
  // payload-only "json" (ADR-0001) rather than failing the whole init.
  return "json";
}

function distinctCount(values: unknown[]): number {
  const seen = new Set<string>();
  for (const v of values) seen.add(JSON.stringify(v));
  return seen.size;
}

/** A payload-only field: kept in the record and returned by `findMany`, never indexed or queryable (ADR-0001). */
function payloadField(presentValues: unknown[], recordCount: number): InferredField {
  return {
    kind: "json",
    cardinality: distinctCount(presentValues.filter((v) => v !== null)),
    absent: presentValues.length < recordCount,
    multi: false,
  };
}

/**
 * The sorted distinct values of an enum-like string field, or `undefined` when the field isn't one.
 * `date` is excluded deliberately: a closed set of dates is a coincidence of the sample, not a
 * domain enum, and freezing it would reject any later date.
 */
function enumValuesOf(kind: FieldKind, values: string[]): string[] | undefined {
  if (kind !== "string") return undefined;
  const distinct = [...new Set(values)];
  if (distinct.length === 0 || distinct.length > MAX_ENUM_VALUES) return undefined;
  return distinct.sort();
}

function inferField(fieldName: string, presentValues: unknown[], recordCount: number): InferredField {
  const arrays = presentValues.filter((v) => Array.isArray(v));
  const scalars = presentValues.filter((v) => !Array.isArray(v));

  // A field that mixes arrays and scalars can't be a single queryable kind — carry it as payload.
  if (arrays.length > 0 && scalars.length > 0) {
    return payloadField(presentValues, recordCount);
  }

  if (arrays.length > 0) {
    // Only string[] is a queryable multi-valued field (T7); number[]/object[]/mixed become payload.
    if (!arrays.every(isStringArray)) {
      return payloadField(presentValues, recordCount);
    }
    const elements = (arrays as string[][]).flat();
    const elementValues = enumValuesOf("string", elements);
    return {
      kind: "string",
      cardinality: distinctCount(elements),
      absent: presentValues.length < recordCount,
      multi: true,
      ...(elementValues ? { values: elementValues } : {}),
    };
  }

  const kind = inferKind(fieldName, scalars);
  const nonNull = scalars.filter((v) => v !== null);
  const values = enumValuesOf(kind, nonNull.filter((v): v is string => typeof v === "string"));
  return {
    kind,
    cardinality: distinctCount(nonNull),
    absent: presentValues.length < recordCount,
    multi: false,
    ...(values ? { values } : {}),
  };
}

/** A field is PK-shaped when its own sampled values look like an identifier: unique + id-like name. */
function looksLikePk(name: string, f: InferredField, recordCount: number): boolean {
  return !f.multi && !f.absent && f.cardinality === recordCount && ID_LIKE_NAME_RE.test(name);
}

/** A field can be a sort-field candidate iff it's an always-present, single-valued sortable kind
 * (ADR-0002 §2) — exported so the wizard's sort-field step (T12) shares this exact predicate
 * instead of a second copy that could silently drift from what `init --yes` would recommend. */
export function isSortFieldCandidate(f: Pick<InferredField, "kind" | "multi" | "absent">): boolean {
  return SORTABLE_KINDS.includes(f.kind as SortableKind) && !f.multi && !f.absent;
}

/**
 * Ranks a candidate's *kind* ahead of its cardinality. Strings are legal sort fields (locality on
 * the field users search is the point — ADR-0002 §2), but ranking purely by cardinality would hand
 * the default to whichever column is most unique, which on real data is an id/UUID/URL — the worst
 * possible locality. So number/date keep the default and a string only wins when nothing else can.
 */
function sortKindRank(kind: FieldKind): number {
  return kind === "string" ? 1 : 0;
}

function recommendSortField(fields: Record<string, InferredField>, recordCount: number): string {
  const candidates = Object.entries(fields).filter(([, f]) => isSortFieldCandidate(f));
  if (candidates.length === 0) {
    throw new Error(
      "static-shard: init could not infer a sort field — no always-present, single-valued " +
        `${SORTABLE_KINDS.join("/")} field was found in the sample; declare one explicitly with --sort-field`,
    );
  }

  candidates.sort(([nameA, a], [nameB, b]) => {
    const kindRank = sortKindRank(a.kind) - sortKindRank(b.kind);
    if (kindRank !== 0) return kindRank;
    if (b.cardinality !== a.cardinality) return b.cardinality - a.cardinality;
    // ADR-0002 §2: tiebreak toward the PK — judged directly off each candidate's own
    // uniqueness + id-like name, not by deferring to recommendPk (which runs after the
    // sort field is chosen, and pk may legitimately equal the sort field — ADR-0002 §4).
    const aPkLike = looksLikePk(nameA, a, recordCount);
    const bPkLike = looksLikePk(nameB, b, recordCount);
    if (aPkLike !== bPkLike) return aPkLike ? -1 : 1;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });

  return candidates[0]![0];
}

function recommendPk(fields: Record<string, InferredField>, recordCount: number): string | undefined {
  // A pk may legitimately be the sort field itself — the "free" get(id) path (ADR-0002 §4).
  const idLike = Object.entries(fields)
    .filter(([name, f]) => (f.kind === "number" || f.kind === "string") && looksLikePk(name, f, recordCount))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return idLike[0]?.[0];
}

function recommendIndexedFields(fields: Record<string, InferredField>, recordCount: number, sortField: string): string[] {
  const entries = Object.entries(fields).filter(([name]) => name !== sortField);

  // Multi-valued fields can only be declared correctly when indexed (T7 constraint) — always include them.
  const forced = entries.filter(([, f]) => f.multi).map(([name]) => name);

  const categorical = entries
    .filter(([, f]) => f.kind !== "json" && !f.multi && f.cardinality > 1 && f.cardinality < recordCount)
    .sort(([nameA, a], [nameB, b]) => (a.cardinality !== b.cardinality ? a.cardinality - b.cardinality : nameA < nameB ? -1 : 1))
    .slice(0, DEFAULT_MAX_INDEXED)
    .map(([name]) => name);

  return [...forced, ...categorical];
}

/**
 * Infers a candidate schema from a sample (or full scan) of parsed records — the only inference
 * site (ADR-0005 §4). Pure: no I/O, no defaults from config — `init` layers flags/existing-file
 * precedence on top of this recommendation.
 */
export function inferSchema(
  records: Record<string, unknown>[],
  opts: { onProgress?: OnProgress } = {},
): InferenceResult {
  const recordCount = records.length;
  const fieldNames = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) fieldNames.add(key);
  }

  // Per field, not one event for the whole pass: this is O(records x fields) and, once inference reads
  // the entire input by default, it is the longest silence in `init` — 6.6s of a 10s run on a 532 MB
  // file, all of it after the read bar has already finished. Per-field events make it visibly advance.
  const fields: Record<string, InferredField> = {};
  let inferred = 0;
  for (const name of fieldNames) {
    const presentValues = records.filter((r) => Object.prototype.hasOwnProperty.call(r, name)).map((r) => r[name]);
    fields[name] = inferField(name, presentValues, recordCount);
    opts.onProgress?.({ phase: `inferring schema (${name})`, done: ++inferred, total: fieldNames.size, unit: "count" });
  }

  const sortField = recommendSortField(fields, recordCount);
  const pk = recommendPk(fields, recordCount);
  const indexedFields = recommendIndexedFields(fields, recordCount, sortField);

  return { recordCount, fields, sortField, pk, indexedFields };
}

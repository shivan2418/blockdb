import type { FieldConfig, FieldKind } from "./types.js";

function expectedTypeof(kind: FieldKind): "string" | "number" | "boolean" {
  return kind === "number" ? "number" : kind === "boolean" ? "boolean" : "string";
}

/** A missing key or `null` the config doesn't allow: where it first appears, and how often. */
interface MissingValueDrift {
  firstRecord: number;
  count: number;
}

const REINFER_HINT =
  `Run "blockdb init --reinfer" to refresh these facts from the data (it keeps your sort field, ` +
  `indexed fields and other choices), or edit blockdb.config.json by hand.`;

/**
 * `build` replays the baked schema and never re-infers (ADR-0005 §4) — if the data's shape has
 * since changed, that must fail loud rather than silently block/index a mistyped value, or ship a
 * generated type that lies. Checks the kind of every present value, and that a missing key or a
 * `null` only appears where the config says it can (`absent`, `nullable`): those flags are what
 * make the generated record type optional or `| null`.
 *
 * Reports every drifting field in one error, grouped by fix, so a data refresh that touched many
 * fields costs one rebuild to diagnose rather than one per field.
 */
export function assertNoSchemaDrift(records: Record<string, unknown>[], fields: Record<string, FieldConfig>): void {
  const missingKeys = new Map<string, MissingValueDrift>();
  const nulls = new Map<string, MissingValueDrift>();
  const kindProblems: string[] = [];

  const note = (map: Map<string, MissingValueDrift>, name: string, record: number) => {
    const seen = map.get(name);
    if (seen) seen.count++;
    else map.set(name, { firstRecord: record, count: 1 });
  };

  for (const [name, field] of Object.entries(fields)) {
    // Payload-only fields are opaque — any JSON value is valid, and they're always typed optional.
    if (field.kind === "json") continue;

    let kindReported = false;
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (!Object.prototype.hasOwnProperty.call(record, name)) {
        if (!field.absent) note(missingKeys, name, i);
        continue;
      }
      const value = record[name];
      if (value === null) {
        if (!field.nullable) note(nulls, name, i);
        continue;
      }
      if (value === undefined || kindReported) continue;

      const problem = kindProblem(name, field, value, i);
      if (problem) {
        kindProblems.push(problem);
        kindReported = true;
      }
    }
  }

  if (missingKeys.size === 0 && nulls.size === 0 && kindProblems.length === 0) return;

  const sections: string[] = [];
  if (missingKeys.size > 0) {
    sections.push(
      `Some records lack a key the config says is always present. Add "absent": true to:\n` +
        describeMissing(missingKeys, "has no key"),
    );
  }
  if (nulls.size > 0) {
    sections.push(
      `Some records hold null where the config says a field is never null. Add "nullable": true to:\n` +
        describeMissing(nulls, "is null"),
    );
  }
  if (kindProblems.length > 0) {
    sections.push(`Some values no longer match the field's declared kind:\n` + kindProblems.map((p) => `  - ${p}`).join("\n"));
  }
  throw new Error(`blockdb: schema drift — the data no longer matches blockdb.config.json.\n\n${sections.join("\n\n")}\n\n${REINFER_HINT}`);
}

function describeMissing(map: Map<string, MissingValueDrift>, what: string): string {
  return [...map]
    .map(([name, { firstRecord, count }]) => `  - "${name}" (${what} in ${count} record${count === 1 ? "" : "s"}, first record ${firstRecord})`)
    .join("\n");
}

/** Why a present, non-null value doesn't fit its field's declared kind, or undefined if it does. */
function kindProblem(name: string, field: FieldConfig, value: unknown, record: number): string | undefined {
  if (field.multi) {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return undefined;
    return `"${name}" is declared "multi" (string[]), but record ${record} has ${JSON.stringify(value)}.`;
  }
  if (Array.isArray(value)) {
    return (
      `"${name}" is declared a single ${field.kind}, but record ${record} has an array (${JSON.stringify(value)}). ` +
      `A multi-valued field is either "multi": true (which needs "indexed": true) or, if you don't query it, "kind": "json".`
    );
  }
  if (typeof value === expectedTypeof(field.kind)) return undefined;
  return `"${name}" is declared kind "${field.kind}", but record ${record} has a ${typeof value} value (${JSON.stringify(value)}).`;
}

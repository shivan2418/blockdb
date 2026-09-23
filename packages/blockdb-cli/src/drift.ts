import type { FieldConfig, FieldKind } from "./types.js";

function expectedTypeof(kind: FieldKind): "string" | "number" | "boolean" {
  return kind === "number" ? "number" : kind === "boolean" ? "boolean" : "string";
}

/**
 * `build` replays the baked schema and never re-infers (ADR-0005 §4) — if the data's shape has
 * since changed, that must fail loud rather than silently block/index a mistyped value, or ship a
 * generated type that lies. Checks the kind of every present value, and that a missing key or a
 * `null` only appears where the config says it can (`absent`, `nullable`): those flags are what
 * make the generated record type optional or `| null`.
 */
export function assertNoSchemaDrift(records: Record<string, unknown>[], fields: Record<string, FieldConfig>): void {
  for (const [name, field] of Object.entries(fields)) {
    // Payload-only fields are opaque — any JSON value is valid, and they're always typed optional.
    if (field.kind === "json") continue;

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const value = record[name];
      if (!Object.prototype.hasOwnProperty.call(record, name)) {
        if (field.absent) continue;
        throw new Error(
          `blockdb: schema drift — record ${i} has no "${name}" key, but blockdb.config.json doesn't mark ` +
            `"${name}" as "absent", so its generated type says it is always present. Add "absent": true ` +
            `to the field, or run "blockdb init --reinfer" to refresh the baked schema.`,
        );
      }
      if (value === null) {
        if (field.nullable) continue;
        throw new Error(
          `blockdb: schema drift — record ${i} has "${name}": null, but blockdb.config.json doesn't mark ` +
            `"${name}" as "nullable", so its generated type says it is never null. Add "nullable": true ` +
            `to the field, or run "blockdb init --reinfer" to refresh the baked schema.`,
        );
      }
      if (value === undefined) continue;

      if (field.multi) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          throw new Error(
            `blockdb: schema drift — field "${name}" is declared "multi" (string[]) in blockdb.config.json ` +
              `but record ${i} has ${JSON.stringify(value)}. Run "blockdb init --reinfer" to refresh the baked schema.`,
          );
        }
        continue;
      }

      if (Array.isArray(value)) {
        throw new Error(
          `blockdb: schema drift — field "${name}" is declared a single ${field.kind} in blockdb.config.json ` +
            `but record ${i} has an array (${JSON.stringify(value)}). A multi-valued field is either ` +
            `"multi": true (which needs "indexed": true) or, if you don't query it, "kind": "json".`,
        );
      }

      const expected = expectedTypeof(field.kind);
      if (typeof value !== expected) {
        throw new Error(
          `blockdb: schema drift — field "${name}" is declared kind "${field.kind}" in blockdb.config.json ` +
            `but record ${i} has a ${typeof value} value (${JSON.stringify(value)}). ` +
            `Run "blockdb init --reinfer" to refresh the baked schema.`,
        );
      }
    }
  }
}

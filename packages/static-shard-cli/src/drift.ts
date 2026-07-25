import type { FieldConfig, FieldKind } from "./types.js";

function expectedTypeof(kind: FieldKind): "string" | "number" | "boolean" {
  return kind === "number" ? "number" : kind === "boolean" ? "boolean" : "string";
}

/**
 * `build` replays the baked schema and never re-infers (ADR-0005 §4) — if the data's shape has
 * since changed, that must fail loud rather than silently shard/index a mistyped value. Checks
 * only the *kind* of values that are present; a missing key is T7's `absent` opt-in's concern,
 * not drift's, and `null` is a valid value distinct from absent (ADR-0001).
 */
export function assertNoSchemaDrift(records: Record<string, unknown>[], fields: Record<string, FieldConfig>): void {
  for (const [name, field] of Object.entries(fields)) {
    // Payload-only fields are opaque — any JSON value is valid, so there's no kind to drift from.
    if (field.kind === "json") continue;

    for (let i = 0; i < records.length; i++) {
      const value = records[i]![name];
      if (value === undefined || value === null) continue;

      if (field.multi) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          throw new Error(
            `static-shard: schema drift — field "${name}" is declared "multi" (string[]) in static-shard.config.json ` +
              `but record ${i} has ${JSON.stringify(value)}. Run "static-shard-cli init --reinfer" to refresh the baked schema.`,
          );
        }
        continue;
      }

      const expected = expectedTypeof(field.kind);
      if (typeof value !== expected) {
        throw new Error(
          `static-shard: schema drift — field "${name}" is declared kind "${field.kind}" in static-shard.config.json ` +
            `but record ${i} has a ${typeof value} value (${JSON.stringify(value)}). ` +
            `Run "static-shard-cli init --reinfer" to refresh the baked schema.`,
        );
      }
    }
  }
}

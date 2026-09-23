# ADR-0012 — `nullable` and `absent` describe the data

## Status

Accepted. Refines the T7 `absent` opt-in (ADR-0001, ADR-0003 §7).

## Context

`absent: true` was an opt-in on indexed, single-valued, non-sort fields that unlocked `isNull`, `isAbsent` and `exists`. It did two jobs at once, and missed a case in each:

- **Types lied about null.** Inference tracked whether a key could be missing, never whether a value could be `null`. A field that was always present but sometimes `null` was typed `score: number` and had no `isNull`. A field that was both got `rating?: number`, without `| null`.
- **Types lied about presence off the index.** `absent` required `indexed: true`, so a non-indexed field missing from some records was typed as always present.

Found while verifying the query guide against a real build (2026-09-22).

## Decision

1. **Two flags, both facts about the data.** `absent: true` means the key can be missing; `nullable: true` means the value can be `null`. `init` infers both, for every field. They're valid on any field, including non-indexed fields, the sort field and list fields. A primary key can be neither.
2. **The flags shape the record type.** `absent` makes the field optional, `nullable` adds `| null`. `json` payload fields stay optional as before, and `unknown` needs no `| null`.
3. **Operators follow the data precisely.** On an indexed, single-valued, non-sort field, `nullable` unlocks `isNull`, `absent` unlocks `isAbsent`, and either unlocks `exists`. They're listed in the field's `operators` like any other, so the runtime types no longer special-case a flag. The sort field and list fields get none: their missing values have their own rules (ADR-0002 §9, ADR-0010). *(Amended 2026-09-23, ADR-0013: offered on any single-valued, non-sort field, indexed or not, and always riders: they no longer count as the pruning constraint a `where` needs.)*
4. **`build` enforces the flags.** Drift checking fails when a record holds `null` in a field that isn't `nullable`, or lacks a key that isn't `absent`, naming the flag to add. Otherwise an older config would keep generating a type that lies. `json` fields stay exempt.
5. **Inference treats a null list as missing, not as a scalar.** A list field with some `null` lists stays a list field, flagged `nullable`, instead of degrading to `json`.

## Consequences

- Configs written before this can fail `build` with a drift error. `init --reinfer` or adding the named flag fixes it. The manifest format is unchanged apart from the new `nullable` key and the extra operator names.
- `isAbsent` is no longer offered on a field whose key is never missing, and `isNull` no longer on one that is never null.
- The operators need no index: they filter records that other operators selected, so enabling them costs nothing at build time.

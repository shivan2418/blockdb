# ADR-0009 — Derived fields: build-time columns computed from a closed set of normalizers

## Status

Accepted.

## Context

A column is frequently stored in a representation you cannot query the way you want to. The motivating case is Scryfall's `power`: it is a string across all 109,202 values, because 1,723 of them (1.6%) are domain sentinels — `*`, `1+*`, `2+*`, `*+1`, `?`, `7-*`, `*²`, `∞`. The other 98.4% are ordinary integers that users very much want to compare with `>=`.

Neither existing route works:

- **Declare it `kind: "number"`.** `assertNoSchemaDrift` compares `typeof value` against the declared kind, and *every* power value is a string — `"2"` as much as `"1+*"`. The build fails on all 109,202 records, not just the odd ones.
- **Allow lexicographic ranges on string fields.** Measured: `gte: "5"` returns 7,405 where the truth is 7,762, missing 357 — every double-digit power, i.e. precisely the cards someone filtering by power is looking for. ADR-0003 §7 therefore withholds ranges from secondary string fields on purpose.

The general shape: **the representation you want to query is a pure function of the representation you store.** Case-insensitive search is the same shape (`name` → lowercase), as is accent-folding, as is whitespace repair on hand-maintained CSV.

## Decision

### 1. A derived field is a real column, computed at build time

```json
"power_num": {
  "kind": "number",
  "indexed": true,
  "absent": true,
  "derive": { "from": "power", "using": "numeric" }
}
```

`materialize` computes it onto every record before sharding. From that point it is **an ordinary column** — sortable, indexable, zonemapped, typed, drift-checked — indistinguishable from one that was in the input file. The source field is untouched and keeps its own semantics: `power` still answers `equals: "*"`, which 1,594 records need.

### 2. Rejected alternative — `normalize`, an indexed projection of the same field

The tempting design is one field whose *index* is built over a transform of its values, so `power` itself gains numeric ranges and no second name appears. Rejected on two counts:

- **It breaks `equals`.** If the index and the query type both become numeric, `power: { equals: "*" }` is unexpressible. That is a real query over 1,594 records, not a hypothetical.
- **It splits `kind` in two.** `kind` currently drives both the record interface (`tsTypeForKind`) and the where type (`FilterFor`). A projection needs a separate `queryKind` threaded through `FieldConfig` → `FieldSchemaEntry` → manifest → codegen → `FilterFor`, plus the same normalizer executing in the runtime's post-fetch filter (the payload still holds the raw value), plus split-point handling when the projected field is the sort field.

Derived fields need **zero runtime change and zero type-system change**. The cost is that the queryable name differs from the display name — which is exactly what Scryfall's own API exposes, returning the printed string and doing the numeric work behind it.

### 3. Normalizers are a closed, domain-free set

`numeric`, `lowercase`, `trim`, `fold`.

**Closed**, because the name is data in the config and the manifest. A user-supplied function would have to be serialized and executed somewhere — a code-execution surface in a JSON config, and a dependency in a runtime whose whole premise is zero dependencies.

**Domain-free**, because a normalizer that knew Magic's `*` means 0, or that a CSV's `N/A` means missing, would silently reinterpret data it does not understand. Scryfall's own rule (every `*` term evaluates to 0, so `1+*` is 1 and `∞` is a true infinity — verified against their live API) is a *domain* rule and stays the caller's job: preprocess the input, or add the column upstream.

### 4. Unmappable values are absent, never guessed

A normalizer returns `null` for input it cannot map, and the derived key is then **omitted from the record**. Not `0`, which would make Tarmogoyf a 0-power creature and pollute every range query over the column; not `null`, because absence is what the data actually means and it unlocks `isAbsent`/`exists` for finding those very rows.

The empty string is a specific trap worth naming: `Number("")` is `0`, so `numeric` treats blank input as absent rather than letting every empty cell become a real zero.

### 5. Constraints

- `derive.from` must name a field declared in `schema.fields`.
- **No chaining.** Deriving from a derived field is rejected: it would make config order load-bearing for a single pass and admit cycles, buying nothing a second field derived from the original does not.
- The normalizer's `outputKind` must equal the field's declared `kind`.
- The build **refuses to overwrite** a key the input data already carries, rather than silently disagreeing with its own input.
- A multi-valued source derives elementwise; no derivable elements means the field is absent, matching the scalar rule.
- `init --reinfer` carries `derive` declarations over verbatim. Inference reads the *data's* shape and a derived field has no key in the data, so re-inferring would otherwise delete the field and every index on it.

## Consequences

- **Unblocks range queries on text-stored numerics** without weakening ADR-0003 §7's refusal to give string fields lexicographic ranges. `power_num` earns `gt/gte/lt/lte` honestly, because it really is a number.
- **Runtime untouched.** No manifest format change beyond ordinary field entries, no new operator, no `formatVersion` bump.
- **Payload grows** by the derived values. One number per record on 116k records is a few hundred KB raw and far less compressed.
- **Two names for one concept.** `power` for display and exact-match, `power_num` for comparison. Accepted deliberately (§2), and mitigated by the source field remaining fully queryable.
- **A partial answer to case-insensitive search.** `name_fold` with `fold` gives accent- and case-insensitive matching today, at the cost of an extra indexed column and a query that names the folded field. The single-field version remains the deferred `caseInsensitive` folded-index item.
- **Not yet suggested by `init`.** A string field where >90% of values parse as numbers is exactly the signal `infer.ts`'s existing `ValueShape` machinery could raise, so the feature is currently discoverable only by reading the docs. Follow-up.

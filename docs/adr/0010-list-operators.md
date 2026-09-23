# ADR-0010 — List operators on multi-valued fields: `hasEvery`, `every`, `isEmpty`

## Status

Accepted. Refines ADR-0001 (operator surface) and ADR-0003 §7/§9 (index descriptor).

## Context

ADR-0001 gave multi-valued fields exactly one operator, `some` ("at least one element matches"). With implicit AND and one filter per field, that leaves ordinary list questions unanswerable:

- **contains all of** `[W, U]` — Scryfall's "including these colours", or "has every one of these tags".
- **every element is one of** `[W, U]`, an empty list included — Scryfall's "at most these colours".
- **the list is empty** — "colorless", "untagged".
- **exactly** `[W, U]` — the first two at once.

Nothing in the design record rejected these. `some` was simply the only list operator ever discussed (ADR-0001, T1, T7). The gap surfaced in the shard-test demo, whose advanced search showed colourless and three of four colour comparisons disabled.

## Decision

### 1. Three operators beside `some`

Names follow `some`'s existing shape rather than switching to Prisma's `has`/`hasSome`, which would break `some`.

| Operator | Matches a present list… | `[]` |
|---|---|---|
| `some: F` (existing) | with at least one element satisfying `F` | never |
| `hasEvery: V[]` | containing every listed value | only when the list given is `[]` |
| `every: F` | whose elements all satisfy `F` | always (vacuous truth) |
| `isEmpty: true` | that is `[]` | always |

`every` takes the same element filter as `some`, including the shorthand (`every: "W"` ≡ `every: { equals: "W" }`). `isEmpty` is typed `true` only, like `isAbsent`: the complement "non-empty" is `some` over anything, and a `false` form would be a filter that can't prune.

### 2. Several keys on one field AND together

A field's operator object already ANDs its keys (`matchesFieldFilter` loops over every key), so no new combining rule is needed. **Exactly `[W, U]`** is:

```ts
colors: { hasEvery: ["W", "U"], every: { in: ["W", "U"] } }
```

### 3. Absent and null are not empty

Every list operator requires a **present, non-null list**, as `some` already does. A record with no `colors` key fails `isEmpty: true`, `every` and `hasEvery` alike. "Missing" and "empty" are different facts about the data; conflating them would make `isEmpty` silently answer a presence question. A caller who wants both combines queries, or declares the field `absent` on a non-multi source. (T7 already forbids `absent` on a multi field, so there is no presence surface to overlap with.)

### 4. Pruning

All three prune, so none is a filter-only rider:

- **`hasEvery: [a, b]`** — intersect the postings of `a` and `b`: a matching record holds both, so its shard is in both sets. The `some`/`in` path unions; this one intersects. `hasEvery: []` constrains nothing.
- **`isEmpty: true`** — a new per-field list of the shards holding at least one `[]`, written by the build as `indexes.<field>.emptyShards`.
- **`every: F`** — candidates of `some: F` **∪** `emptyShards`. A record passing `every: F` either has at least one element, which satisfies `F` and so appears in `some: F`'s postings, or has none, and so sits in an `emptyShards` shard. Nothing that matches can fall outside the union. When `F` has no index-routable key (only `not`), `every` constrains nothing.

`every` is the weakest of the three: "at most W, U" admits every mono-W, mono-U, W/U and colourless card, so its union is often most shards. That is the query's nature, not a missing index, and it is still a real bound rather than a scan.

### 5. `emptyShards` in the manifest, not a chunk

`emptyShards` is an array of shard ordinals, present on every multi-valued field's index descriptor, empty when no record holds `[]`. It lives inline in the root manifest rather than in a lazily-fetched chunk:

- It is bounded by shard count per multi field — the same growth class as a secondary zonemap's pairs, which ADR-0003 also keeps inline under the manifest budget.
- It carries no values, so front-coding and value-range chunking buy nothing.
- Multi-valued fields are few per dataset.

A manifest built before this ADR has no `emptyShards`. The runtime then treats `isEmpty` and `every` as unable to prune through that field (never as "no empty lists"), so old deploys answer correctly, just without the pruning. No `formatVersion` bump.

## Consequences

- Scryfall-style colour search is expressible in full: including (`hasEvery`), at most (`every`), exactly (both), colourless (`isEmpty`).
- **Manifest grows** by one shard-ordinal array per multi-valued field, at most `shardCount` entries each.
- **The rider check stays shallow.** `assertWhereHasPruning` and `RiderGuard` look at a field's top-level keys, so `every: { not: "W" }` alone passes them while pruning nothing, exactly as `some: { not: "W" }` already does. Closing that gap is separate from this ADR.
- `count()` needs nothing new: it sums shard counts over whatever candidates pruning leaves.

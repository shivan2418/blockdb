# ADR-0013 — Riders: every field is queryable, indexes decide what prunes

## Status

Accepted (2026-09-23, #30). Supersedes "queryable ⟺ indexed" (ADR-0001, ADR-0003 §7, ADR-0004) and generalizes the `not` filter-only rule.

## Context

A field had to be indexed to be filterable at all. On US addresses sorted by `street`, filtering by house `number` meant indexing it, but common numbers sit in almost every block. The index pruned nothing and still cost a few hundred MB of build output, and it dominated build memory once the build streamed (#28).

The runtime never needed the index to filter. It tests every fetched record against the whole `where`, and an unindexed field already filtered correctly from untyped JavaScript. Only the generated types kept it out.

The rule against full scans also had a hole. Only `not` counted as a filter that can't prune, so `where: { tagline: { isNull: true } }` passed both the type guard and the runtime check and read every block.

## Decision

1. **Two kinds of filter.** A **pruning constraint** narrows which blocks a query reads: a filter on the sort field, or one an index structure answers. A **rider** only tests the records already fetched: `not`, `isNull`/`isAbsent`/`exists`, any filter on an unindexed field, and any operator the field has no structure for (for example `contains` without the trigram opt-in, or with fewer than three characters).
2. **Every `findMany` `where` needs at least one pruning constraint.** Otherwise it's rejected: at compile time by `RiderGuard`, and at runtime with `BlockDbError` code `NEEDS_PRUNING`, whose message names the fields that could prune. `count` is exempt, since it reads only the manifest. A rider-only `where` just widens its bound.
3. **Every non-json scalar field is queryable, with every operator its type allows**: `equals`, `in`, `not`, the missing-value operators its flags allow, ranges on number and date, and `startsWith`/`endsWith`/`contains` on strings. String ranges stay reserved for the sort field (ADR-0003 §7), and list fields stay indexed-only (ADR-0010). `orderBy` accepts every queryable scalar field, since sorting happens in memory either way.
4. **The manifest says which operators prune.** Each schema field keeps `operators` (everything a `where` may write) and gains `pruning` (the subset that narrows blocks). The runtime guard and the generated types read `pruning`. They don't copy knowledge of which index structures exist.
5. **Deploys built before this are refused, not guessed at.** `formatVersion` is the package major (ADR-0005) and stays 0. Instead the runtime rejects a manifest whose fields lack `pruning`, with the existing `FORMAT_VERSION` code and a "rebuild" message.
6. **The build warns about indexes that barely prune.** When the average value of a plain index appears in more than 35% of blocks (with eight or more blocks), the build suggests dropping `indexed`, since the field stays filterable as a rider.

## Considered options

- **Allowing a rider-only query as an explicit full scan** (`allowFullScan: true`) was left for later. Adding it wouldn't break anything, whereas allowing it silently would make downloading a 660 MB dataset a one-liner.
- **Deriving "prunes" in the runtime from the index descriptor** was rejected. The generated types can't see the descriptor, so the knowledge would have to be copied into them.

## Consequences

- Breaking in 0.3.0: a `where` made only of missing-value operators, or only of `contains` shorter than three characters, now needs a pruning companion. Old deploys need a rebuild.
- Indexing becomes purely a cost-for-speed choice. The wizard's first step now asks "Which filters need to be fast?"
- `contains` is free as a rider on any string field and costs a trigram index only when it should prune.
- *(Amended 2026-09-23.)* The runtime exports `wherePrunes(where, schema)`, the same rule as `NEEDS_PRUNING` without the throw, so an app building a `where` from UI input can fall back instead of re-implementing the rule. The manifest's `pruning` list can't express the 3-character minimum for `contains`, so the docs and the `NEEDS_PRUNING` message state it.
- *(Amended 2026-09-23, self-review.)* Whether a filter prunes also depends on its value, not just its operator: an empty `startsWith`/`endsWith`, an empty `hasEvery` and `isEmpty: false` match every block and ride, the same as a `contains` under 3 characters. A filter or operator set to `undefined` is dropped before the check and the query. The types stay key-based, so these are runtime-only (`wherePrunes`, `NEEDS_PRUNING`).
- `init` no longer recommends an index the build would warn about (#31). A field left unindexed that way stays filterable as a rider; index it anyway when an app filters on it alone, since an index is a pruning constraint even when it prunes badly.

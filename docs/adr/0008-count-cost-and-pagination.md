# ADR-0008 — `count()` cost & pagination primitives: approximate upper bound + exact next-page

**Status:** Accepted
**Date:** 2026-07-22
**Ticket:** [T9 — Exact count() cost & index-format decision (#12)](https://github.com/shivan2418/static-shard/issues/12)

## Context

The map's *Not yet specified* carried one open cost question: exact `count()`. ADR-0003 postings are `value → shard-id set` (which shards hold a value, not how many rows match), so an *exact* `count()` generally needs fetching candidate shards — only sort-field ranges are cheap. Three options were framed: store per-shard match counts in postings (larger index) · return an approximate/bounded count · accept `count ≈ findMany` cost.

Grilling fixed the **job** first: `count()` exists for **pagination totals**. Analytics-grade exact aggregation stays **out of scope** (the SQL/DuckDB lane the map already ruled out). That reframing makes an approximate count acceptable and, crucially, exposed a second gap — with an approximate `count()` and a bare-array `findMany`, *nothing in the surface answers "is there a next page?" exactly*. This ADR resolves both.

## Decision

### 1. Index format — unchanged

Postings stay `value → shard-ids` (ADR-0003 §5). The "store per-shard match counts in postings" option is **not taken**. No index-format change is needed now, nor when the deferred exact mode (§4) later ships — exact counting reuses the `findMany` fetch machinery, not a new posting shape. This closes the ticket's index-format question: **leave ADR-0003's format alone.**

### 2. `count()` — approximate upper bound, zero data-shard fetch

The default (and only 1.0) behaviour:

- **Value** = `Σ manifest.shards[i].count` over the shards surviving zonemap + postings pruning. The manifest already carries per-shard record `count` (ADR-0003 §9) and the zonemap; a secondary-field constraint additionally fetches that field's index chunk(s) to read the surviving shard-id list.
- **Cost** = zonemap (free — already in the root manifest) + one index chunk (~40–50 KB) per constrained secondary field. **Zero data-shard fetches, ever.**
- It is an **upper bound**: "shard *i* contains the value" ≠ "how many of shard *i*'s rows match," so unmatched rows in surviving shards inflate the total.

### 3. Return shape — `{ count, exact }`

`count()` returns **`{ count: number; exact: boolean }`** (refines ADR-0001's `count → number`).

- `exact: true` only in the free-and-tight cases: **no `where`** (→ `count = recordCount`) and **pruned-to-zero** (→ `count = 0`).
- Therefore **`count === 0` with `exact: true` is a trustworthy "none"** — a reliable existence check — even though positive counts are estimates (`exact: false`).
- The `not` filter-only rider and the `contains`/`endsWith` operators cannot refine an un-fetched count, so they only **widen** the upper bound and force `exact: false`. Never wrong, just loose.

### 4. Exact mode — deferred, but reserved in the surface

A real exact/statistical mode is **deferred to v2**, but its input slot is **reserved now** so switching it on is non-breaking:

- Signature reserves `count(where?, opts?: { exact?: false })`. In 1.0 the type **only permits `false`** — passing `exact: true` is a **compile-time error**. This is T8's fail-loud posture applied to the type system: the API never accepts a request 1.0 cannot fulfil. (This is a *conscious* exception to the map's usual "defer = omit from surface" rule, taken specifically to make the future `count` signature change non-breaking.)
- **v2 design (recorded, not built):** widen the option to `{ precision }` = a target CI width/confidence **or** `"exact"`, implemented as **one shard-sampling loop** with two stopping rules:
  - Sample candidate shards, fetch them, and use a **combined ratio estimator over shards-as-clusters** with a finite-population correction: `p̂ = Σ matches_j / Σ count_j`, `T̂ = p̂·M`, CI from between-shard residual variance. **Shards are the sampling unit, not rows** — the data is range-partitioned by the sort field, so matches cluster; a naïve iid-Bernoulli CI would be confidently wrong (too narrow).
  - Stop at a tight-enough CI (**estimate**, `exact: false`, returns `ci`) or when all candidates are fetched (variance → 0, **`exact: true`**). Exact and estimate are the *same* algorithm at different stopping points.
  - The return widens non-breakingly to `{ count, exact, ci?: [lo, hi] }`.
- **Recorded semantics:** the exact/estimate mode is **not** gated by `maxResults` — that cap bounds materialized `findMany` arrays; a count materializes none, and its fetch cost is an inherent, documented tradeoff.
- **Known blind spot:** rare-event queries (a needle across many shards) — sampling can miss the needle, and the plain upper bound is equally useless; only full-fetch exact finds it. Statistical count is noted as a v2 differentiator (unclaimed in this space).

### 5. `findMany` — exact next-page signal via `limit + 1`

An approximate `count()` cannot answer "are there more than N?" exactly. That job moves to `findMany`, which returns **`{ records: T[]; hasMore: boolean }`** (refines ADR-0001's "findMany → full records array"):

- `findMany` over-fetches by one internally: it walks candidate shards in sort order accumulating post-filtered matches until it has `limit + 1`; `hasMore` is `true` iff the extra match exists, and only the first `limit` records are returned. **Exact and cheap** (~0–1 extra shard beyond the page), independent of `count()`.
- With no `limit`, `findMany` returns all matches up to `maxResults` (throws `LIMIT_EXCEEDED` beyond — ADR-0007) and `hasMore: false`. `offset` composes (`offset + limit + 1`).
- Clean split of the two pagination questions: **`hasMore` answers "next page?" exactly and cheaply; `count()` answers "how many pages?" approximately.**

### 5a. `findMany` — exact `total` whenever the query already saw every match (amendment)

The split above is right about `count()` but too pessimistic about `findMany`, which frequently ends up holding the entire match set and then discards its size. Where that happens the exact total is free, so `findMany` returns **`{ records: T[]; hasMore: boolean; total?: number }`**.

`total` is present iff every candidate shard was read — pruning is conservative, so "all candidates read" means "all matches seen":

- **any `orderBy` on a non-sort field** — the ordering cannot be decided without materializing all matches, so this path always knew the total;
- **no `limit`** — every match is returned anyway;
- **a shard walk that ran out of candidates** before it accumulated `offset + limit + 1`.

It is absent exactly when the walk stopped early, which is precisely when the tail was never fetched. No fetch is ever added to produce it: `total` appears when it is already known and is omitted rather than estimated.

`total` is **not** `offset + records.length` — on a page past the end that formula yields the offset. It is a property of the match set, not of the window taken from it, which is why the engine has to report it rather than the caller deriving it.

Consumers should prefer `total` over `count()` whenever it is present. `count()`'s zero-fetch bound can be an order of magnitude high (measured: 35,739 against a true 396 for a `contains` filter on a 116k-record dataset), and displaying it as "about N" next to an exactly-known page range is a worse answer than the one already in hand.

## Consequences

- **Refines ADR-0001 (T2):** `count(args) → { count, exact }` (input `opts?: { exact?: false }` reserved); `findMany(args) → { records, hasMore, total? }` (§5a).
- **Refines ADR-0003 (T4):** documents the zero-fetch upper-bound algorithm and confirms **no index-format change**; records the v2 shard-sampling CI estimator as the intended exact-mode design (still no posting-shape change).
- **Feeds T5 (codegen):** emit the `{ count, exact }` and `{ records, hasMore }` return types and the compile-time-locked `exact?: false` option; no runtime statistics ship in 1.0 (runtime stays zero-dep).
- Consistent with T8: no silent lies — the type system refuses `exact: true`, positive counts are honestly flagged `exact: false`, and `count === 0`/`hasMore` are the two reliable signals.

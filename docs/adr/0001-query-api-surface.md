# ADR-0001 — Query API surface: object/where-clause

**Status:** Accepted
**Date:** 2026-07-20
**Ticket:** [T2 — Query API surface (#3)](https://github.com/shivan2418/static-shard/issues/3)
**Prototype:** branch `prototype/query-api` (deleted 2026-09-22; last commit `bfb2bdf`) — four candidate shapes, all type-checked under `tsc`.

## Context

`static-shard` generates a **typed client** per dataset; the query API is that client's centerpiece and the headline DX differentiator. We had to fix its shape before codegen (T5) can be designed. The prototype built four candidates over a mock generated client and checked each with `tsc` (including `@ts-expect-error` lines proving the type constraints reject invalid queries):

- **A — object/where-clause** (Prisma-style): `where: { year: { gte: 2000 } }`
- **B — builder/chain** (Kysely-style): `.where("year", "gte", 2000).many()`
- **C — both** (A canonical + B for dynamic composition)
- **D — field-proxy / expression builder** (Drizzle-style): `where: f => and(f.year.gte(2000))`

The decision criterion the user prioritised: **crisp intellisense on both the field and the operator.**

## Decision

**Adopt Style A — the object/where-clause — as the single canonical query surface.** No builder, no field-proxy.

Rationale:

- **Intellisense on both is fully met.** Field and operator are both object keys in known positions: `where: {` completes to indexed fields; `year: {` completes to exactly that field's operators. Equivalent to D, and D was rejected as looking "too strange" — the callback + `and()/or()` composition reads as foreign and creates adoption friction.
- **B is the worst** for the stated goal: the operator is a positional overload argument whose completion is unreliable until all args are present.
- **`where` is a plain, serializable object** — the query planner reads it directly to decide which shards / index chunks to fetch; it can be logged, cached by value, and constructed in non-TS contexts. D's `where` is a callback that must be executed against a recording proxy.
- **C rejected** — shipping two surfaces doubles codegen output and docs and forces a "which do I use?" choice on every user, unjustified once A covers the dynamic case adequately (build the plain object conditionally).

### Operators (per type; queryable ⟺ indexed — only indexed fields appear in `where`)

*(Amended 2026-09-23, ADR-0013: every non-json scalar field is queryable; an index decides only which filters prune. A filter that can't prune is a rider, and a `findMany` `where` needs at least one pruning constraint.)*

- **string:** `equals`, `not`, `in`, `contains`, `startsWith`, `endsWith`
- **number:** `equals`, `not`, `in`, `gt`, `gte`, `lt`, `lte`
- **date** (string + `isDate`, compared as ISO): `equals`, `not`, `in`, `gt`, `gte`, `lt`, `lte`
- **boolean:** `equals`, `not`
- **multi-valued** (`string[]`, from object-arrays): `some` — existential match taking the element's operator set. Shorthand `genres: { some: "Sci-Fi" }` ≡ `{ some: { equals: "Sci-Fi" } }`. *(Refined by ADR-0010: `hasEvery`, `every` and `isEmpty` join `some`.)*

### Query features

- `findMany(args)` → **`{ records, hasMore }`** — full records (whole nested payload; no projection — see out of scope) plus an exact next-page flag via `limit + 1` over-fetch *(shape set by ADR-0008 — see T9)*
- `count(args)` → **`{ count, exact }`** — approximate upper bound (zero data-shard fetch); `exact` true only for empty-`where` / pruned-to-zero. Input reserves a compile-time-locked `opts?: { exact?: false }` for a deferred exact mode *(ADR-0008 — see T9)*
- `get(id)` → single record **or `null`; codegen-emitted only when a user PK exists** (per ADR/T1)
- `getSchema()` → the runtime schema descriptor
- `orderBy` — object form over indexed fields, `"asc" | "desc"`, multi-key allowed
- `limit`, `offset` — offset/limit pagination (no cursors in v1.0)

### Boolean logic

**v1.0 is implicit-AND only** across `where` keys. OR / nested boolean logic is **deferred, not foreclosed**: object-where can gain Prisma-style reserved `OR` / `AND` / `NOT` array keys later while staying a plain serializable object — a **non-breaking** addition. Not in the 1.0 surface.

## Consequences

- **T5 (codegen)** emits, per dataset: the record interface, the index descriptor, per-type operator filter types (`FilterFor<…>` mapped over indexed fields), `where`/`orderBy` types, and the `findMany`/`count`/`get`/`getSchema` collection interface. `get` is PK-gated.
- The type machinery is the R2 "operator-constraint typing" applied at the `where` boundary. The prototype's `generated-client.ts` is a faithful shape reference for T5.
- Query execution consumes a plain `where` object → clean input to the T4 index/T3 shard planner.
- No OR means some queries require multiple round-trip queries client-side in v1.0; acceptable, and revisitable non-breakingly.

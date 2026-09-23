# ADR-0004 — Codegen & typed-client shape: thin runtime + generated facade

**Status:** Accepted
**Date:** 2026-07-21
**Ticket:** [T5 — Codegen & typed-client shape (#8)](https://github.com/shivan2418/static-shard/issues/8)
**Prototype:** [`prototypes/codegen-client/`](https://github.com/shivan2418/static-shard/tree/master/prototypes/codegen-client) — the full type machinery + a worked movie/screenings dataset, `tsc` exit 0 (every invalid query proven rejected by `@ts-expect-error`) and a runnable runtime-guard demo.

## Context

`static-shard` generates a **typed client** per dataset. T2 (ADR-0001) fixed the *query surface* (object/where-clause); T5 fixes **how that client is delivered, how the types are bound to the query API, and the runtime footprint** — the last decision the whole build hangs on. Reference points weighed in the discussion: tRPC (a generic runtime parameterized by generated types) vs hey-api / `openapi-generator` (codegen emits a concrete surface). Industry has moved *away* from the old "single generated file, everything inlined" model.

The prototype built the machinery for real over a mock dataset and type-checked it: the headline result is `tsc` exit 0, which — because tsc errors on an *unused* `@ts-expect-error` — proves every invalid query in `consumer.ts` was actually rejected at compile time.

## Decision

**Ship a "blend": a thin dataset-agnostic runtime npm package + a thin generated facade over generated types.** Not a single inlined file.

- **Spine = tRPC-style.** One npm package `static-shard` (`runtime.ts`) that every consumer installs — a **generic runtime** parameterized by a generated `as const` schema. *All* the typing lives here as mapped types (`WhereOf` / `FilterFor` / `Collection`).
- **Skin = hey-api / Prisma-style.** Codegen emits a **thin concrete facade** (`generated/client.ts`, ~20 lines) so `db.movies` is a real, named, go-to-definition member with clean hover types — not raw generic index access. The facade only narrows the generic client's type; it holds no query logic.

### The two generated artifacts (per dataset)

1. **`generated/schema.ts`** — a full record interface per collection (drives result types, entire nested payload) **plus one `as const` schema** describing, per collection: the user PK (if any) and, per field, `kind` / `operators` / `multi` / `pk` / `absent`. Tiny. Emitted from the R2 `SchemaDescriptor` IR.
2. **`generated/client.ts`** — the thin facade: a `Db` interface listing concrete collections and a `connect()` that casts the generic client.

### Types → query-API binding

The generated `as const` schema drives the runtime's mapped types. Operator availability is **data**, not implied by `kind`: each field carries an `operators` tuple (ADR-0003 §7 — "operator available ⟺ its structure was built"), and `FilterFor<F>` exposes exactly that subset with per-type value types. This realizes, at the type level:

- **queryable ⟺ indexed** (non-indexed fields are payload-readable, not filterable); *(Amended 2026-09-23, ADR-0013: every non-json scalar field is filterable; `RiderGuard` now reads each field's `pruning` list, so `not`, the missing-value operators and any filter on an unindexed field are riders. The runtime check throws `NEEDS_PRUNING`. `orderBy` accepts every queryable field.)*
- per-type operators + wrong-value-type rejection;
- `contains` / `endsWith` present **only** where opted in (trigram / reversed index built);
- multi-valued fields forcing existential `some`;
- the `isNull` / `isAbsent` / `exists` surface only on absentable fields (ADR-0002);
- `get(id)` emitted **only** when a user PK exists (T1);
- `orderBy` restricted to indexed fields.

### The exact-type technique (and a refinement to ADR-0001)

The **filter-only rider rule** is cross-field (a pruning op on field A licenses a `not` on field B), so it needs the query *literal's* type. A naive generic `where?: W` disables TypeScript's excess-property check (silently admitting unknown fields / disabled operators) — verified empirically. The fix: capture the literal as `W`, then re-implement every check by hand — `ValidateWhere<W,C>` maps any illegal field / disabled operator / wrong value type to `never`, and `RiderGuard<W>` injects a required branded property (whose *name* is the fix message) when `not` appears with no pruning constraint. Cost: a noisier error first-line; compile cost bounded by query size, not dataset size.

**Refinement of ADR-0001:** only **`not`** is a filter-only rider. ADR-0001's operator list grouped `contains` / `endsWith` as riders too, but per ADR-0003 §7 those build a trigram / reversed-value index and **do** prune, so they are valid as a *sole* constraint. ADR-0003 §7 is authoritative; only `not` is rejected alone.

### Public factory & runtime footprint

- `connect({ basePath, maxResults? })` (wrapping `createClient(schema, opts)`). Manifest at `${basePath}/manifest.json`; lazy index chunks + content-hashed NDJSON shards resolved relative to `basePath`.
- **Runtime footprint: zero third-party deps, no WASM** — pure TS + `fetch` (+ optional `DecompressionStream`). `fetch` is injectable for non-browser / testing.
- **`maxResults`** — a client-level result ceiling (default `10_000`), a guardrail distinct from per-query `limit`, with **fail-loud** semantics (per T1): an explicit `limit` above it throws; an unbounded query that *would* match more than it throws rather than silently truncating.
- **Defense-in-depth:** `assertWhereHasPruning` re-checks the rider rule at runtime for untyped JS callers and dynamically-built `where` objects the compiler never sees.

## Consequences

- **T6 (#9, package & CLI contract)** is now unblocked: the npm package is `static-shard` (the runtime), consumers get generated `schema.ts` + `client.ts`, and `connect({ basePath })` is the entry point — T6 fixes how the package/CLI publishes and wires this.
- **T7 (#10, TUI wizard)** persists the per-field `operators` set that this codegen reads — enabling a toggle in the wizard directly unlocks that operator in the generated types.
- Codegen consumes the R2 `SchemaDescriptor` IR and emits two small files; no per-dataset logic is generated, keeping generated output tiny and the logic centrally maintained/versioned in the runtime.
- **Chunk-fetch error / partial-failure semantics** (map fog) are now sharply specifiable against this runtime shape — the next decision on the runtime.

## Open items

Surfaced while resolving T5 but not resolved by this decision:

- ~~**Autocomplete crispness (verify in-editor).**~~ **Resolved (T14, publish gate).** Verified by driving classic TypeScript's `ts.createLanguageService` (this repo's own `typescript` resolves to TS7/tsgo, which doesn't expose that API, so the check ran against TS 5.6 in a scratch harness) against the real generated `examples/movies` client: `where: {` completed to exactly the indexed fields (`director`, `genres`, `rating`, `title`, `year` — `id`/`overview` correctly excluded); `where: { title: {` completed to exactly `title`'s configured operator set (`contains`, `equals`, `in`, `not`, `startsWith`); `where: { genres: {` (a multi-valued field) completed to exactly `some`; `orderBy: {` completed to the same indexed-field set. Completions are precise, not the generic fallback a degraded mapped type would produce — the exact-type encoding does not need revisiting.
- **`count()` exact-total cost.** ADR-0003 postings are `value → shard-id set` (which shards contain a value, not how many rows), so an *exact* `count()` generally requires fetching the candidate shards — only sort-field ranges are cheap (split-points + per-shard record counts). Whether to store per-shard match counts in postings (cheap exact counts, larger index), return an approximate/upper-bound count, or accept `count ≈ findMany` cost is an **ADR-0003 (T4) index-format** question this ticket surfaced; tracked in the map's *Not yet specified*.

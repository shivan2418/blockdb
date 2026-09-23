# ADR-0002 — Sharding strategy: range-partition by a single sort field

**Status:** Accepted
**Date:** 2026-07-21
**Ticket:** [T3 — Sharding strategy (#6)](https://github.com/shivan2418/static-shard/issues/6)
**Depends on:** [T1 — Data model (#2)](https://github.com/shivan2418/static-shard/issues/2), [T2 — Query API (#3)](https://github.com/shivan2418/static-shard/issues/3), [R1 — Index-scaling research](https://github.com/shivan2418/static-shard/blob/master/docs/research/index-scaling.md)

## Context

`build` must split a 100 MB–1 GB+ dataset into many small whole files (shards) that a client fetches selectively. The sharding strategy decides *how records map to shards* and *what boundary metadata is recorded* so the client can prune. R1's central finding drives everything: **sorted-load ordering is the single biggest lever, and you can only physically sort by one field.** Whichever field wins the sort gets free range-pruning; every other field scatters and leans on an index.

## Decision

### 1. Partitioning method
**Range-partition by a single sort field.** Globally sort the dataset, cut the sorted stream into shards; adjacent shards hold non-overlapping value ranges → free range-pruning on that one field via zonemap binary search. Hash-partitioning and partition-by-value are degenerate points on the same "one sort dimension" line, not separate primary strategies (hash destroys range pruning; by-value is the low-cardinality special case of range).

### 2. Sort-field selection
Exactly **one** sort field, drawn from the opt-in indexed set. It is a **user choice** surfaced in the wizard alongside two other knobs — the indexed-field set and the chunk size — each with a **live consequence estimate**. An auto-heuristic (prefer `number`/`date` types + high cardinality; tiebreak toward the PK) supplies only the *default selection and candidate ordering*, never a hidden decision. Sorting a field implicitly makes it queryable (consistent with "queryable ⟺ indexed").

### 3. Pruning metadata — zonemaps up front, rich index lazy
Every indexed field gets a per-shard `[min,max]` **zonemap** — the cheap, always-downloaded "range directory." The sort field's zonemap is **non-overlapping** (clean pruning); other fields' zonemaps **overlap** (weak pruning). To honour T2's secondary-field operators without bloating the always-downloaded manifest, the rich inverted index is **two-tier and lazy** (fetched only when a query touches that field; format → T4). Per-field cost therefore splits into **always-paid** (tiny zonemap) + **pay-on-use** (lazy index).

### 4. `get(id)`
Ordinary equality-on-PK through the lazy index path — **free iff PK is the sort field**, one lazy-index fetch + one shard fetch otherwise. No privileged placement machinery. "Stable placement" reduces to a **deterministic build** (identical input → identical sort → identical shards → identical content-hashes).

### 5. Shard size
Fixed **target byte size (compressed)**, default:

```
T_default = clamp( max( 2 MB , p95_record_size ) , 512 KB , 8 MB )
```

The `max(2MB, p95)` floor-to-a-record rule handles fat-document data (a 1.5 MB-object dataset targets ~1.5 MB/shard, ~1 record each). Guardrails: an oversized single record gets its own flagged shard; the tail shard may fall under target. The wizard shows a live readout (shard count, records/shard, per-query bytes + request count, manifest size).

### 6. Skew
Surfaced, never silently mishandled:
- A single sort value spanning many shards → correct but costly → **build-time warning**.
- Low-cardinality sort field → **discouraged, not forbidden** (preserves the legitimate partition-by-value case).
- **Secondary tiebreak sort** within equal keys for determinism.
- **Equal-key runs stay contiguous even if the shard exceeds the byte target** — preserves the non-overlapping zonemap, which is worth more than uniform size.

### 7. Boundary metadata — the T3/T4 line
`build` emits, per shard, a **stats record**: ordinal (sort position), sort-field `[min,max]`, every indexed field's `[min,max]`, record count, compressed byte size, content-hash — all computed on **coerced** values (zonemap comparison must match query-time comparison). **T4 owns the on-disk packing**: split-points vs per-shard pairs, min/max string truncation, coarse→fine splitting, and the entire lazy-index format.

### 8. File naming & layout
- **Content-hash filenames** — immutable (`Cache-Control: immutable`), dedups byte-identical shards across rebuilds; the manifest carries `ordinal → hash` order.
- **Hash-prefix subdirectories** past ~1,000 shards (`shards/a3/a3f9c2…`).
- **NDJSON payload** — streaming parse, concatenable (trivial glob→merge→shard), local corruption. Same format as the preferred input (one less concept).
- **Uncompressed by default** — host `Content-Encoding` handles transport compression transparently (zero client code). **Optional build-time compression** decompressed via the native `DecompressionStream` API (gzip; no library, no WASM). Exact compression *transport* (brotli, double-compression avoidance) defers to the Deploy-guidance doc.

### 9. Missing sort values
Records with null/absent sort field cluster in a **contiguous block at the high end**, zonemap-flagged (null vs absent distinguished), prunable as a unit. The `is null`/`is absent` **operator surface** defers to T5.

## Consequences

- **T4 (#7)** inherits: the lazy two-tier index format; zonemap packing (split-points vs pairs, min/max truncation, coarse→fine); postings/bloom for high-cardinality fields; the per-shard stats-record schema; and the **cost-estimation formulas** behind the wizard's three consequence axes.
- **T5 (#8)** inherits: the `is null`/`is absent`/exists operator surface; `get(id)` typed as equality-on-PK.
- **T6 (#9)** inherits: non-wizard CLI flags for the sort field / chunk size / compression toggle.
- **T7 (new)** — TUI config wizard — inherits: presentation of the three knobs + live consequence estimates, the sort-field recommendation UX, and skew/oversized-record warnings.
- The always-downloaded manifest stays "range-directory cheap"; rich pruning is pay-on-use — the core R1 invariant (the index must be selectively downloaded, like the data) is preserved.
- `build` requires an **external (on-disk) sort** to order 1 GB+ without holding it in memory — an execution concern for the post-map build session, not a map decision. *(Amended 2026-09-23, #28: the whole build now streams, not just the sort. Records are derived, drift-checked and fed to sorted runs as they're read; runs spill at 200,000 records or ~64 MB, whichever comes first; a heap merge feeds a block cutter; each closed block is written out and folded into small accumulators (split-points, zonemap pairs, value → block postings) before it's dropped. Peak memory is one run, one block and the index dictionaries, which grow with distinct values rather than records. Output is byte-identical to the in-memory build. Because a block's path depends on the final block count (§8), blocks are written flat to a staging directory and moved into hash-prefix subdirectories at the end; the staging tree replaces `output` only once it's complete.)*

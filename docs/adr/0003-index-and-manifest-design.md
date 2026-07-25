# ADR-0003 — Index & manifest design: zonemap + one lazy chunked inverted index

**Status:** Accepted
**Date:** 2026-07-21
**Ticket:** [T4 — Index & manifest design (#7)](https://github.com/shivan2418/static-shard/issues/7)
**Depends on:** [T1 — Data model (#2)](https://github.com/shivan2418/static-shard/issues/2), [T2 — Query API (#3)](https://github.com/shivan2418/static-shard/issues/3), [T3 — Sharding strategy (#6)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0002-sharding-strategy.md), [R1 — Index-scaling research](https://github.com/shivan2418/static-shard/blob/master/docs/research/index-scaling.md)
**Refines:** [ADR-0001 — Query API surface](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0001-query-api-surface.md) (see §7)

## Context

ADR-0002 committed to zonemaps up front and a "lazy two-tier rich index" for secondary fields, and explicitly delegated to T4: the on-disk index format, zonemap packing (split-points vs pairs, min/max truncation, coarse→fine), postings/bloom for high-cardinality fields, the per-shard stats-record schema, and the wizard's cost-estimation formulas. R1's invariant governs every choice: **the manifest is downloaded in full by 100% of clients, so any structure that grows with the data must be selectively downloaded like the data — otherwise it relocates the "download 400 MB before you can query" problem it exists to avoid.**

## Decision

### 1. Two pruning tools (bloom deferred)

The client prunes with exactly two structures:

- **Zonemap** — per-shard `[min,max]`, always downloaded. Does *all* pruning for the sort field (non-overlapping ⇒ exact) and weak pruning for secondary ranges (overlapping).
- **One lazy chunked inverted index** — for secondary fields: distinct values sorted, cut into value-range-keyed chunks, front-coded dictionary + delta-encoded postings (value → shard-id set). A small **chunk directory** (ranges only) lives in the root manifest; postings chunks are fetched on demand.

Per-shard **bloom filters are deferred to v2** (optional). The chunked index already bounds *query-time* download to one chunk even for near-unique fields; bloom's only edge is smaller *total* build output, paid for with fuzziness (false-positive shard fetches) and no ordered/prefix operators — a bad trade at v1.0.

The inverted index is built for **every indexed field except the sort field** (the sort field's zonemap is exact). Secondary number/date fields still get an index for `equals`/`in` (their zonemaps overlap and can't pinpoint a value); their `gt/lt` ranges use the zonemap. The indexed set stays **user opt-in** (T1); the wizard auto-recommends candidates but the config is the declared source of truth.

### 2. Zonemap packing

- **Sort field → split-points.** `N+1` boundaries for `N` shards (`[1900, 1912, …, 2026]`), binary-searchable — half the size of pairs and *is* the search structure.
- **Secondary fields → per-shard `[min,max]` pairs.** They overlap; no shared boundary to exploit.
- **String min/max truncation** (Parquet trick): store a short next-string-after bound (e.g. `"Zx"` for `"Zwigoff, Terry"`) with a truncation marker, so the range still contains the true value at a few bytes. Bound ~8–12 chars.
- **Column-major layout.** Each field's values across all shards form one ordinal-aligned array (`zonemap.<field>`), which compresses better and matches access (client searches one field at a time). Shard *identity* (`hash`/`bytes`/`count`) stays row-major in `shards[]`; both key off ordinal `i`.

### 3. Root-manifest budget & coarse→fine spill

Root manifest target **~1 MB gzipped** (a wizard cost axis; build warns past it).

- **Always in root** (never spills): schema + `formatVersion`, shard identity (`ordinal → hash`, bytes, count), sort-field split-points, all index chunk directories (ranges only). Small; needed to route *any* query.
- **Secondary zonemaps** are in root by default but **spill to per-field sidecars** (`zonemap/<field>-<hash>.json`) when the root would exceed budget — the `O(shards × fields)` Parquet-footer failure mode. A secondary range query then fetches that one sidecar before pruning (pay-on-use).
- Root manifest is **always loaded up-front**; everything else (zonemap sidecars, index chunks, shards) is lazy.

### 4. Serialization format

**JSON everywhere for v1.0** — root manifest, zonemap sidecars, index chunks. Compression comes from *encoding* + gzip, not a binary container:

- postings = **delta-encoded integer arrays** (`[7, 35, 61]` ⇒ shards 7, 42, 103);
- strings = **front-coded** `[shared-prefix-len, suffix]`;
- gzip / build-time compression via the native `DecompressionStream` (ADR-0002) closes most of the gap to CBOR.

Rationale: `curl | jq`-inspectable output and zero decoder dependency (no WASM) matter more at v1.0 than the last ~20–30 % of size. **CBOR/MessagePack deferred to v2.**

### 5. Index chunk sizing & postings encoding

- **Chunk size target ~40–50 KB gzipped** (Pagefind anchor): a typical equality query fetches one chunk; a `startsWith`/`in` span fetches a small handful. Request amplification stays a documented known tradeoff.
- **Postings = sorted shard-ids, delta-encoded, JSON integer array.** **Roaring bitmaps deferred to v2** (they pair with the binary-format switch — both land together if profiling shows JSON+delta-arrays is the bottleneck).

### 6. Multi-field AND execution

ADR-0001 made v1.0 implicit-AND. The planner combines `where` keys on one economic fact: **index chunks (~40 KB) are far cheaper than data shards (~MBs)** — so spend cheap chunk fetches to avoid expensive shard fetches.

1. Apply all **free zonemap pruning** first (sort-field ranges exact, secondary ranges weak) → initial candidate shard set.
2. **Fetch the index chunk for every equality/`in`/`startsWith`-constrained secondary field** and **intersect** their shard sets with the zonemap set.
3. **Post-filter the residue in memory** — anything the index/zonemap couldn't fully resolve — always possible because records carry their full payload (T1).
4. **Selectivity tiebreak:** use per-field **cardinality** (carried in the manifest) as a cheap proxy — higher-cardinality equality prunes harder.

### 7. Operator coverage — configurable, with cost (refines ADR-0001)

Each operator is available **iff its supporting structure was built** — generalizing T1's "queryable ⟺ indexed." The typed client (T5) exposes only the operators enabled per field.

| Operator | Structure | Cost | Default |
|---|---|---|---|
| `equals`, `in` | base index / zonemap | free | on |
| `startsWith` | base index (values sorted ⇒ prefix = contiguous range) | free | on |
| number/date `gt/gte/lt/lte` | zonemap | free | on |
| **`endsWith`** | **reversed-value index** (`endsWith("son")` = `startsWith("nos")` on reversed strings) | ≈ **+1× the field's base index** | **opt-in, off** |
| **`contains`** | **trigram index** | **often larger than the column itself** (common trigrams approach the record count in postings) — **loud build warning** | **opt-in, off** |
| **`not` / negation** | none possible | negation matches nearly every shard — **inherently unprunable** | **filter-only rider** |

- **Range operators are number/date only on secondary fields.** A secondary field's ranges are pruned by its per-shard `[min,max]` pairs, keeping shards whose span overlaps the query interval — exact at shard granularity, because number/date pairs are stored untruncated (§2 truncates string pairs only). Secondary **string** fields are deliberately denied ranges: string comparison is lexicographic, so `gte: "2"` on a numeric-looking column silently drops every double-digit value (measured on Scryfall's `power`, which is a string because 1.6% of values are `*`, `1+*`, `∞` — a lexicographic `gte: "5"` misses 357 of 7,762 true matches, all of them the largest). Only the **sort field** gets string ranges, where the ordering is the physical one the user chose; `startsWith` covers the prefix case a sorted string column can genuinely answer.
- `endsWith` / `contains` are **per-field opt-in** in the config; the wizard shows the real byte + chunk cost at build time. Enabling one builds its structure and unlocks that operator in the generated types.
- `not` / negation is a **filter-only rider**: valid only alongside a pruning constraint, applied by in-memory post-filter, **rejected as a sole constraint** (it would force a full scan, which T1 forbids). No structure buys it out.

**Refinement to ADR-0001:** ADR-0001 listed `contains`, `endsWith`, and `not` in the flat string/number operator sets. This ADR reclassifies them: `contains`/`endsWith` become **conditional** (present only when opted in) and `not` becomes a **filter-only rider**. The `where` surface and all other operators are unchanged.

### 8. Versioning & rebuild model

- **Full rebuild only for v1.0.** Input → deterministic sort → shards + index, all content-hashed. Incremental/append and in-place mutation deferred (map out-of-scope "writes = rebuild & redeploy"; ADR-0002 deterministic build; T1 rebuild-replays).
- **Cache-friendly despite full rebuild:** content-hashed filenames mean a rebuild changes only the hashes of shards/chunks whose contents changed; unchanged ones stay in the visitor's immutable cache.
- **One mutable pointer, immutable everything-else:** the root manifest lives at a **stable path** (`manifest.json` / configured), fetched with revalidation; every file it points at is content-hashed + `Cache-Control: immutable`.
- **`formatVersion`** (integer) in the manifest; the generated client is pinned to its build version and **errors loudly on mismatch** rather than silently misreading a changed layout.

### 9. Manifest schema

```jsonc
{
  "formatVersion": 1,
  "dataset": { "recordCount": 1000000, "shardCount": 500, "sortField": "year" },
  "schema": { /* SchemaDescriptor IR (R2/T1): per field → type, isDate, cardinality, absent-vs-null, multiValued */ },

  "shards": [                        // ordinal = array index; row-major identity
    { "hash": "a3f9c2…", "bytes": 2048576, "count": 2013 }
  ],

  "zonemap": {                       // column-major, ordinal-aligned
    "year":     { "splitPoints": [1900, 1912, 1915, "…", 2026] },     // sort field
    "director": { "pairs": [["Cha", "Wil"]], "truncated": true },     // secondary
    "rating":   { "pairs": [[1.0, 9.8]] }
    // spilled form: "director": { "sidecar": "zonemap/director-<hash>.json" }
  },

  "indexes": {                       // one per non-sort indexed field; directories only
    "director": {
      "operators": ["equals", "in", "startsWith"],                    // enabled set → drives T5 types
      "chunks": [ { "from": "A", "to": "F", "file": "index/director/1a2b…json" } ]
      // "reversed": { "chunks": [...] }   present iff endsWith enabled
      // "trigram":  { "chunks": [...] }   present iff contains enabled
    }
  }
}
```

The per-shard **stats record** ADR-0002 named is realized as `shards[i]` (identity) plus column `i` of each `zonemap.<field>` (min/max), all on **coerced** values so zonemap comparison matches query-time comparison.

### 10. `get(id)` / PK lookup

Unchanged from ADR-0002: equality-on-PK through the index path — **free iff the PK is the sort field** (zonemap binary search), otherwise one index-chunk fetch + one shard fetch. No privileged placement machinery.

### 11. Wizard cost-estimation formulas

Build-time estimates from the sample; the build reports exact numbers and re-warns on budget overruns.

```
# Axis 1 — Shards (knob: chunk size T)
T          = clamp(max(2MB, p95_record_compressed), 512KB, 8MB)      # ADR-0002
shardCount = ceil(datasetBytes_compressed / T)
recordsPerShard ≈ recordCount / shardCount

# Axis 2 — Root-manifest size (knobs: indexed set, sort field)
M ≈ schemaConst
  + shardCount · (hashBytes + 2·intBytes)                 # shards[] identity
  + (shardCount+1) · sortValueBytes                        # sort split-points
  + Σ_secondaryFields shardCount · 2 · truncValueBytes     # zonemap pairs ← dominant term
  + Σ_indexedFields   chunkCount_f · dirEntryBytes         # index directories
M_gzip ≈ 0.35 · M      → if M_gzip > 1MB: spill secondary zonemaps to sidecars

# Axis 3 — Per-query cost (request amplification), shown for a representative equality & range query
bytes    ≈ Σ(index chunks touched)·~45KB + (candidate shards)·T       # manifest amortized ~0 (cached)
requests ≈ (index chunks touched) + (candidate shards) [+ zonemap sidecars]

# Per-operator index cost (T7 operator toggles)
postings_f  = Σ_value min(occurrences(value), shardCount)
baseIndex_f ≈ cardinality_f · avgTermBytes_frontcoded + postings_f·2B  # equals/in/startsWith — free
endsWith_f  ≈ + baseIndex_f                                            # reversed index
contains_f  ≈ + min(Σ_value (len-2)·occ, trigramCount·shardCount)·2B   # trigram — usually huge
chunkCount_f = ceil(indexSize_f / 45KB)
```

## Consequences

- **T5 (#8)** inherits: read the per-field `operators` config from the manifest/config and emit only enabled operators' filter types; encode the **filter-only rider** rule (`not`/`contains`/`endsWith` require a companion pruning constraint; `contains`/`endsWith` present only when opted in); `get(id)` typed as equality-on-PK.
- **T6 (#9)** inherits: non-wizard CLI flags for the per-field operator opt-ins (`endsWith`/`contains`), manifest path, format-version behaviour.
- **T7 (#10)** inherits: per-field **operator toggles** with the live cost readout (base/reversed/trigram index sizes), plus the three-axis estimates (shards / manifest size / per-query cost) surfaced on the existing knobs.
- The always-downloaded root manifest stays "routing-essential only"; rich pruning is pay-on-use — R1's core invariant is preserved.
- Bloom filters, CBOR/binary encoding, roaring postings, incremental rebuild, and `contains`-via-trigram-by-default are all **v2 candidates**, deliberately out of the v1.0 index format but non-breaking to add behind `formatVersion`.
- **`count()` needs no format change** (ADR-0008 / T9): the approximate `count()` upper bound = `Σ shards[i].count` over shards surviving zonemap + postings pruning — postings stay `value → shard-ids`, the "store per-shard match counts in postings" option is **not** taken. The deferred v2 exact/statistical mode reuses the `findMany` shard-fetch path (a shard-sampling ratio estimator with a CI, shards as sampling units), so it too leaves the posting shape unchanged.

# ADR-0007 — Runtime failure contract: chunk-fetch errors & partial-failure semantics

**Status:** Accepted
**Date:** 2026-07-21
**Ticket:** [T8 — Chunk-fetch error & partial-failure semantics (#11)](https://github.com/shivan2418/static-shard/issues/11)
**Depends on:** [ADR-0003 — Index & manifest (#7)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0003-index-and-manifest-design.md), [ADR-0004 — Codegen & typed client (#8)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0004-codegen-and-typed-client.md), [ADR-0005 — Package & CLI contract (#9)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0005-package-and-cli-contract.md)
**Refines:** ADR-0004 (folds `maxResults` throwing into a unified error surface), ADR-0005 (`formatVersion`-mismatch throw becomes a `ShardError` code)

## Context

The runtime (ADR-0004) is a zero-dep, no-WASM client: `connect({ basePath, maxResults? })`, an injectable `fetch`, a whole `manifest.json` plus lazily-fetched content-hashed index chunks and NDJSON shards (ADR-0003). A single `findMany` fans out to many parallel fetches. T8 fixes the **failure contract** those fetches obey — a runtime-level decision that was correctly held in the map's fog until ADR-0004 fixed the runtime shape.

Three fail-loud precedents already bound this decision: T1's no-silent-truncation ethos, ADR-0004's `maxResults` **throwing** rather than truncating, and ADR-0005's `connect()` **failing loud** on a `formatVersion` major mismatch. T8's job was to make the fetch-failure contract coherent with all three, not to invent a new posture.

This was a `/grilling` ticket. The decision tree below was walked one branch at a time.

## Decision

### 1. Philosophy — hard-fail, always

Any single failed fetch **aborts the whole query and throws**. A `findMany` returns a complete, correct result set or it throws — it never returns a silently-incomplete array. A partial result set is indistinguishable to the caller from a smaller-but-correct one, which is exactly the silent-truncation failure mode the project has repeatedly rejected. *Partial-with-signal* (returning gathered records plus an `incomplete` flag) was rejected: it splits the return type and invites callers to ignore the signal. A caller who genuinely wants best-effort degradation catches the hard error and degrades themselves.

### 2. No built-in retry, backoff, or timeout

The runtime does **zero** retrying. A failed fetch fails the query immediately (§1). *(Amended 2026-09-23, #32: one exception, which retries a stale manifest rather than a transient failure. `manifest.json` is the one stable-named file, and a host that caches everything (GitHub Pages sends `max-age=600` and allows no headers) can serve the previous deploy's copy, which names files the new deploy removed. So the manifest is fetched with `cache: "no-cache"`, and a `DEPLOY_INTEGRITY` 404 refetches it once with `cache: "reload"`. If the fresh manifest no longer names the missing file, it replaces the cached one and the query reruns once. If it still names it, the original error is thrown. Concurrent queries failing on the same stale manifest share one refetch; a failed refetch throws its own error (`NETWORK`, `CONFIG`, `FORMAT_VERSION`). The rerun is never retried, so this can't loop, and §1 still holds: the query returns a complete result from one manifest or throws.)* Retry, backoff, timeouts, auth headers, and circuit-breaking all belong to the **injected `fetch`** (ADR-0004) or the CDN in front of the static files. Rationale: keeps the zero-dep runtime tiny; retry policy is genuinely host- and app-specific; and the injected-`fetch` seam is the documented extension point for it. The deploy-guidance doc ships a "wrap `fetch` to add retry" snippet.

### 3. What counts as a fetch failure

The injected `fetch` follows the WHATWG contract: it **rejects** on network-level failure (DNS, dropped connection, CORS block, timeout) but **resolves** on any HTTP status, including 404 and 500. The runtime therefore treats a fetch as failed when the promise **rejects** *or* resolves with **`!response.ok`** (status outside 200–299). Trusting `fetch` to have thrown was rejected — it would `JSON.parse` a 404 error page and crash confusingly downstream instead of raising a clear error.

### 4. Error surface — one `ShardError` with a discriminated `code`

A single exported class `ShardError extends Error` carries a `readonly code` drawn from a string-literal union. Callers do `catch (e) { if (e instanceof ShardError && e.code === '…') … }` — one import, one `instanceof`, an exhaustive `switch` on `.code` with type narrowing. Chosen over a subclass hierarchy: same narrowing, far less exported surface, and no `instanceof`-across-bundlers fragility. Adding a code later is non-breaking.

### 5. The `code` taxonomy

Every failure maps to exactly one code — as fine-grained as the caller's *reaction* differs, no finer:

| `code` | Trigger | Retryable? |
|---|---|---|
| `CONFIG` | `manifest.json` itself 404s / unreachable — wrong `basePath` | no |
| `FORMAT_VERSION` | manifest major ≠ runtime major (ADR-0005) | no |
| `DEPLOY_INTEGRITY` | a manifest-*referenced* content-hashed shard/chunk/sidecar 404s / is missing *(Amended 2026-09-23, #32: and a refetched manifest still names it; see §2. Self-review: a 2xx `text/html` answer, a single-page-app fallback, counts as missing, and on the manifest itself as `CONFIG`)* | no |
| `NETWORK` | `fetch` rejected, **or** resolved non-ok non-404 (500/403/429/…); optional `.status` | maybe |
| `CORRUPT_DATA` | fetch resolved 2xx but the body won't parse / decompress (bad JSON·NDJSON·encoding) | no |
| `LIMIT_EXCEEDED` | the `maxResults` ceiling (ADR-0004) | no |
| `ABORTED` | *(Added 2026-09-23, #33.)* the caller's `signal` option fired; the query's pending fetches were cancelled | no — not a failure |

Judgment calls:
- **`HTTP` and `NETWORK` merged.** An earlier draft split resolved-non-ok (`HTTP`) from fetch-rejection (`NETWORK`). Merged into one `NETWORK` code carrying an optional `.status` (present when it came from a resolved response, absent on rejection). The retryability signal the split was meant to give is already delivered by keeping the deterministic codes (`CONFIG`/`FORMAT_VERSION`/`DEPLOY_INTEGRITY`/`CORRUPT_DATA`) distinct — `NETWORK` is the one "maybe transient" bucket.
- **`LIMIT_EXCEEDED` folded in.** ADR-0004's `maxResults` already throws; making it a `ShardError` code unifies the surface so a caller catches one type. It is deterministic and never retryable, sitting next to `FORMAT_VERSION`/`CORRUPT_DATA`.
- **`FORMAT_VERSION`** is ADR-0005's existing `connect()` mismatch check, now expressed as a code on the shared class.

### 6. The 404 routing rule

Because `NETWORK` absorbs generic HTTP errors, a **404 must not land in the retryable bucket** — it is never transient. 404 routes by **which file** was being fetched (always known at the call site):

- 404 / unreachable on **`manifest.json`** → **`CONFIG`** (wrong `basePath`).
- 404 on any **manifest-referenced content-hashed file** (shard, index chunk, zonemap sidecar) → **`DEPLOY_INTEGRITY`** (the manifest promised a file that isn't there — incomplete/corrupt deploy; re-run `build` & redeploy).
- Any **other** non-ok status on any file → **`NETWORK`** with `.status`.

This keeps `NETWORK` populated only by genuinely-maybe-transient failures, so a `fetch`-layer retry wrapper can key off the code sanely.

### 7. Concurrency — fail-fast + abort

On the first failure of any fan-out fetch, the runtime rejects the query and **cancels the outstanding parallel fetches** via a shared `AbortController` (standard, zero-dep) whose `signal` is passed to the injected `fetch`. First-failure-wins. *Settle-all-then-throw* was rejected: it wastes bandwidth finishing a doomed query. The cost is giving up an aggregate "here are all N missing shards" report — deemed an acceptable trade for 1.0. A custom `fetch` that ignores `signal` loses only the cancellation savings; correctness is unaffected. *(Amended 2026-09-23, #33: `findMany`, `count` and `get` take an optional caller `signal`. It fires the same per-query controller, so the query's pending fetches cancel, and the call rejects with `ABORTED`. The shared manifest fetch is never aborted by one query's signal, since other queries may be waiting on it: the cancelled query only stops waiting. A cancelled query skips the §2 stale-manifest retry, and it rejects promptly even when a custom `fetch` ignores `signal`.)*

### 8. Error payload

`ShardError` carries:

- `code` — the discriminant (§5).
- `message` — human-readable with remediation, matching ADR-0005's `FORMAT_VERSION` precedent (e.g. *"shard `abc123.ndjson` referenced by the manifest returned 404 — re-run `static-shard build` and redeploy"*).
- `cause` — the underlying thrown error via native ES2022 `Error.cause` (zero-dep), so the original `fetch` `TypeError` / parse error chains into stack traces.
- `url` — the file being fetched when it failed (absent for `LIMIT_EXCEEDED`). The single most useful debugging datum.
- `status?` — HTTP status; present on `NETWORK`-from-response and the two 404 codes.

The triggering **query object is deliberately not auto-attached** in 1.0: a `where` can hold user/PII-ish filter values that would then land in logs and error-reporting unexpectedly. `url` + `cause` suffice to debug. Query-in-error can be added as an opt-in later, non-breaking.

### 9. `fetch`-injection interactions (summary)

The injected `fetch` (ADR-0004) is the single seam for resilience and environment:
- It owns retry/backoff/timeout (§2) and receives the abort `signal` (§7).
- Its rejection ⇒ `NETWORK` (no `.status`); its resolved non-ok ⇒ `NETWORK`/`CONFIG`/`DEPLOY_INTEGRITY` per §3/§6.
- Tests and non-browser hosts supply their own `fetch`; the failure contract above is defined purely in terms of the WHATWG `fetch` behavior, so it holds identically for any conforming implementation.

## Consequences

- The runtime stays zero-dep and no-WASM; `AbortController` and `Error.cause` are the only platform features leaned on (both baseline in every target runtime).
- One catchable type (`ShardError`) with an exhaustive `code` switch — a small, documentable, type-narrowable surface consistent with the DX-forward posture of ADR-0004.
- Resilience is uniformly the injected `fetch`'s / CDN's job; the deploy-guidance doc (map fog) now owns the retry-wrapper snippet and the `DEPLOY_INTEGRITY` "corrupt deploy" story.
- **Refines ADR-0004 & ADR-0005:** `maxResults` and `formatVersion` throws are now `ShardError` codes rather than ad-hoc/independent throws — a surface unification, not a behavior change.

## Deferred to v2 (non-breaking)

- **Aggregate failure reporting** (settle-all to list every missing shard in one error) — §7 chose first-failure-wins.
- **Query context in the error payload** — §8; opt-in, additive.
- **Built-in retry/backoff** — §2; would be additive config on `connect()` if ever wanted.

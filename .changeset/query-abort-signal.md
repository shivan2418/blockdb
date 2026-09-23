---
"blockdb": minor
---

`findMany`, `count` and `get` take an optional `signal` (`findMany({ signal })`, `count(where, { signal })`, `get(id, { signal })`). When it fires, the query's pending block, index and sidecar fetches are cancelled and the call rejects with the new `BlockDbError` code `ABORTED`. Aborting one query never cancels the manifest fetch other queries share, and a cancelled query skips the stale-manifest retry. Meant for search-as-you-type, where each keystroke supersedes the previous query.

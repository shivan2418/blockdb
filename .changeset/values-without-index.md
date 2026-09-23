---
"blockdb-cli": minor
---

A field's `values` union no longer requires `indexed: true`: every field is queryable since ADR-0013, and the union narrows an unindexed field's filters too. Following the build's "this index barely prunes, consider removing indexed" advice no longer breaks the next build, and the advice names any `endsWith`/`contains` that go with the index. `init --reinfer` and `--indexed` keep an existing union when a field is un-indexed.

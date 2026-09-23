---
"blockdb": minor
---

`findMany({ where, scan: "block-order", limit })` accepts a rider-only `where`. It walks the data files in sort order and stops as soon as the page is full, for browse-style searches that are rider-only on purpose (a one-letter name search, a `not` filter alone). It needs a `limit` (a compile error without one) and no `orderBy` but the sort field (`NEEDS_PRUNING` otherwise). A rider few records match can still read most of the dataset, which is why this is opt-in. It replaces full-range tricks like `{ name: { gte: "" } }`. `NEEDS_PRUNING` messages now mention it.

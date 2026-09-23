---
"blockdb": patch
---

The rider check now looks at values as well as operators. An empty `startsWith`/`endsWith`, an empty `hasEvery` and `isEmpty: false` match every block, so a `where` that relies on them alone now throws `NEEDS_PRUNING` (and `wherePrunes` returns `false`) instead of quietly downloading the whole dataset. A filter or operator set to `undefined` is left out, and no longer crashes `findMany`/`count` with a `TypeError`.

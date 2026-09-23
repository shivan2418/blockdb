---
"blockdb-cli": minor
"blockdb": minor
---

**Breaking:** every field is now queryable, and an index only decides which filters *prune* (ADR-0013, #30). A filter that can't narrow which files are read is a **rider**: `not`, `isNull`/`isAbsent`/`exists`, any filter on an unindexed field, and `contains`/`endsWith` without their index opt-in. Riders work alongside at least one filter that prunes. A `findMany` `where` made only of riders is a compile error and throws `BlockDbError` code `NEEDS_PRUNING` at runtime, instead of quietly reading the whole dataset (previously possible with `isNull`/`isAbsent`/`exists`). `orderBy` accepts any queryable field. The manifest gains a per-field `pruning` list, so deploys built with an older blockdb must be rebuilt (the runtime reports `FORMAT_VERSION`). `blockdb build` now warns when a plain index barely prunes, and the wizard's first step asks "Which filters need to be fast?".

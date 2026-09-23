---
"blockdb": minor
"blockdb-cli": minor
---

Generated types now say when a field can be `null` (ADR-0012). `init` infers a new `nullable` flag beside `absent`, on every field. `nullable` types the field `T | null` and unlocks `isNull`, `absent` makes it optional and unlocks `isAbsent`, and either unlocks `exists`. Both flags now work on non-indexed fields too.

`build` now fails when a record holds `null`, or lacks a key, where the config doesn't allow it, so an older config can report schema drift. Add the flag the error names, or run `blockdb init --reinfer`.

---
"blockdb": patch
"blockdb-cli": patch
---

Fix: a generated schema with a `json` field marked `absent` or `nullable` failed to type-check against the runtime (`Type '"json"' is not assignable to type 'FieldKind'`). Since 0.3.0 such fields reach the schema for their missing-value operators, but the runtime's `FieldKind` didn't include `json`. It now does. A `json` field takes only `isNull`/`isAbsent`/`exists`, and it can't be used in `orderBy`.

---
"blockdb": minor
---

New export `wherePrunes(where, schema): boolean`: the rule behind `NEEDS_PRUNING`, without the throw. An app that builds a `where` from UI input can check it against `db.x.getSchema()` and fall back (for example, add a sort-field range) instead of catching the error or re-implementing the rule. The `NEEDS_PRUNING` message now names the one rule the types can't see when it's the cause: `contains` prunes only with 3 or more characters. The query guide documents both.

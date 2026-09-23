---
"blockdb-cli": patch
---

`init --reinfer` now refreshes only what it learned from the data (kinds, `absent`/`nullable`, list fields, value sets, added or removed fields) and keeps your choices: the sort field, primary key, indexed fields, `endsWith`/`contains`, compression and block sizes. Previously it reset the sort field and indexed set to inferred defaults and dropped `compression`. Re-running plain `init` on an existing config also keeps `compression` now. Schema-drift errors from `build` list every drifting field at once, grouped by the fix.

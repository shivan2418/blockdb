---
"blockdb-cli": minor
---

`--ends-with` and `--contains` are now the complete set when passed, like `--indexed`, so a text opt-in can be turned off from the CLI and the wizard (unticking `contains` in the wizard used to keep it on a re-run). Un-indexing a field with `--indexed` also drops its `endsWith`/`contains` instead of failing with "opts into contains but is not indexed".

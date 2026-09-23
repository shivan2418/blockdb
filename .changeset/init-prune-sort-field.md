---
"blockdb-cli": patch
---

`init`'s check for indexes that wouldn't prune is now judged against the sort field the config will actually use (`--sort-field`, or the one an existing config keeps on `--reinfer`), not the inferred one, and against the whole input's size when `--sample`/`--sample-size` reads only part of it. The "left X unindexed" note no longer appears for a field the existing config already had, or when `--indexed` gives the complete set.

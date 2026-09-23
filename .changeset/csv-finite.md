---
"blockdb-cli": patch
---

A CSV/TSV number cell of `Infinity`, `-Infinity` or `1e999` now fails the read ("isn't a finite number") instead of being written to the block as `null`, where the manifest depended on whether the sort had spilled to disk. Schema drift also rejects a non-finite number.

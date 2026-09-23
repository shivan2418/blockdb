---
"blockdb-cli": minor
"blockdb": minor
---

`blockdb build` streams end to end, so its memory no longer grows with the input (#28). Records are read, derived and drift-checked one at a time; the external sort now spills runs by size as well as count and merges them through a heap; each block is written as soon as it closes. Output is byte-identical to before. On real data, peak memory fell from 2.5 GB to 0.75 GB (532 MB input) and from 1.6 GB to 0.54 GB (257 MB input), and builds got faster. A build that fails part-way now leaves the previous output untouched. `inspect --config` streams the same way.

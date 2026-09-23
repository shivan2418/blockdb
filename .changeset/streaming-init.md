---
"blockdb-cli": minor
"blockdb": minor
---

`blockdb init` streams its inference, so reading the whole input no longer means holding it in memory (#29). Each field keeps counts and a bounded distinct counter instead of its values: exact up to a million distinct values, estimated (±~1%) past that. On real data, peak memory fell from 1.47 GB to 0.19 GB (257 MB input) and from 1.33 GB to 0.37 GB (532 MB input), with identical configs. The wizard's live estimates now use a uniform sample of the whole input rather than its first 2,000 records, so a glob read in filename order no longer skews them.

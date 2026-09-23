---
"blockdb-cli": patch
---

The wizard's default indexes and its live "barely prunes" marks now come from the same sample, block size and whole-input size as `init`'s recommendation, so it no longer pre-ticks a field and then flags it. With `--sample-size` the wizard judges pruning against the whole input.

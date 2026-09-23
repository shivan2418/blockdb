---
"blockdb-cli": minor
---

`init` no longer recommends an index that wouldn't prune (#31). It estimates from a 5,000-record sample how many data files each candidate's average value would sit in under the recommended sort field. Above the build's 35% "barely prunes" line, it gives the slot to the next candidate and prints a note saying the field stays filterable as a rider. The wizard's "Fast filters" step marks such fields "barely prunes" and warns if you tick one.

---
"blockdb": patch
---

A first manifest fetch that fails (a 503 on page load, a dropped connection) is no longer cached: the next query fetches the manifest again instead of failing until the page reloads.

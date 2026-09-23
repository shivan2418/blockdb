---
"blockdb": patch
---

A host with a single-page-app fallback (200 and `index.html` for a missing file) now gets the same stale-manifest recovery as a 404: an HTML response for a data file is `DEPLOY_INTEGRITY`, and for `manifest.json` it is `CONFIG`, instead of `CORRUPT_DATA`.

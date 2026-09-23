---
"blockdb-cli": patch
---

`blockdb build` warns on every `compression: "brotli"` build: it needs a host that serves `.br` files with `Content-Encoding: br`. On raw-bytes hosts such as GitHub Pages, Chrome can't decode them yet; use `gzip` there.

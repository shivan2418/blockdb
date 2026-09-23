# blockdb-cli

## 0.2.0

### Minor Changes

- 35a9d3c: Generated types now say when a field can be `null` (ADR-0012). `init` infers a new `nullable` flag beside `absent`, on every field. `nullable` types the field `T | null` and unlocks `isNull`, `absent` makes it optional and unlocks `isAbsent`, and either unlocks `exists`. Both flags now work on non-indexed fields too.

  `build` now fails when a record holds `null`, or lacks a key, where the config doesn't allow it, so an older config can report schema drift. Add the flag the error names, or run `blockdb init --reinfer`.

### Patch Changes

- 1eb99c7: `blockdb build` warns on every `compression: "brotli"` build: it needs a host that serves `.br` files with `Content-Encoding: br`. On raw-bytes hosts such as GitHub Pages, Chrome can't decode them yet; use `gzip` there.

## 0.1.0

### Minor Changes

- First release. Query large datasets from any static host: the CLI partitions a dataset into blocks with zonemaps and a lazy inverted index, and the zero-dependency runtime fetches only the blocks a query needs.

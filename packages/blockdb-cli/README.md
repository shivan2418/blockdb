# blockdb-cli

Build tool for [blockdb](https://www.npmjs.com/package/blockdb): infer → partition → index → codegen, plus the config wizard. A Node-only devDependency — install it alongside the runtime `blockdb` package, never in production.

## Quickstart

```bash
pnpm add blockdb && pnpm add -D blockdb-cli
npx blockdb init data/books.ndjson   # interactive wizard, or fully flag-driven with --yes
npx blockdb build                    # → public/blockdb/ (deploy this) + src/blockdb/ (commit this)
```

`init` is the only place inference happens, and it reads **every record by default** — it writes a single committed `blockdb.config.json`. `build` is headless (no TTY, safe in CI): it replays the config's baked schema — never re-infers — and fails loudly if your data has drifted from it.

### Commands

- **`init`** — interactive wizard or `--yes` + flags (fully non-interactive, scriptable). Detects the input format, infers a schema, recommends a sort field and default indexed set, and persists `blockdb.config.json`.
- **`build`** — reads the committed config, blocks + indexes the data, writes the served tree (default `public/blockdb/`) and regenerates the typed client (default `src/blockdb/`). Flags: `--config`, `--out`, `--no-clean`.
- **`inspect`** — read-only report over a config or built directory: block/index sizes, cost estimates, and warnings, without rebuilding. Flags: `--config`/`--dir`, `--json`.

Every wizard choice is also a CLI flag (nothing wizard-only), so `init --yes` with the right flags reproduces exactly what the wizard would have written — config generation is fully scriptable for CI.

### Inference reads everything by default

`init` decides the baked schema, and a schema that is wrong about your data is the expensive kind of wrong: a value union missing a value that first appears at row 40,000, a field absent from the first 1000 rows, a cardinality that misprices an index or picks the wrong sort field. So `init` reads the whole input. `build` already does, so this asks for no memory a build doesn't.

Pass `--sample` (or `--sample-size <n>`) for a fast look at a large file. It is a real speed/accuracy trade and it is opt-in, not the default.

### Choosing the sort field

The single biggest lever on query cost. Records are range-partitioned by this one field, so it decides **which records get stored next to each other**: a filter on the sort field reads a handful of data files, while a filter on anything else may read most of them. Pick the field your most common filter or ordering actually uses.

`number`, `date` and `string` fields are all eligible. A sorted **string** field additionally gets `startsWith` for free — a prefix is a contiguous range of the split-points already in the manifest, so it needs no index chunk fetch at all. On a 25k-record dataset (29 files), `startsWith("Light")` reads 26 of 29 files when sorted by a timestamp, and 1 of 29 when sorted by `name`.

The wizard measures this rather than guessing. It asks what you filter on **first**, then — for each candidate sort field — orders your actual records by it, cuts them into block-sized bins, and counts how many bins each of your filter values lands in. Each candidate shows what share of your data files a query would read, and it warns when even your best-clustered filter would still read over half of it. Nothing keys off field names.

`init --yes`, with no filter selection to measure against, falls back to the highest-cardinality `number`/`date` field. That spreads blocks evenly but is blind to what you query, so a bulk-maintenance timestamp can win — check it, or use the wizard.

### Text-search opt-ins have real cost

`equals`, `in` and `startsWith` are free on any indexed string field. `endsWith` (reversed index) and `contains` (trigram index) are per-field opt-ins that each build an extra structure, and `build` warns in two distinct ways:

- **"bigger than the data"** — the structure exceeds the raw column it indexes. A size complaint.
- **"barely prunes"** — the average lookup resolves to most of your data files, so a query using it still reads most of the dataset. Typical of identifier, URL, and near-constant fields, whose substrings spread evenly across every file. Substring-searching a UUID column costs a full extra index and buys nothing.

An index can be small and useless, or large and worth it, so the two warnings are independent. Text matching is also **case-sensitive**; for case- and accent-insensitive search, see [derived fields](#derived-fields).

### Derived fields

A derived field is a column `build` computes from another field before partitioning (ADR-0009). After that it behaves like any other column: indexable, sortable, typed. The normalizers are a closed set: `fold` (lowercase, diacritics stripped), `lowercase`, `trim` and `numeric`. A value a normalizer can't map, like `numeric` on `"*"`, leaves the derived key absent rather than guessing.

```json
"title_fold": { "kind": "string", "indexed": true, "contains": true, "derive": { "from": "title", "using": "fold" } },
"year_num":   { "kind": "number", "indexed": true, "absent": true, "derive": { "from": "year", "using": "numeric" } }
```

`title_fold` gives case- and accent-insensitive search; normalize the query with the runtime's `normalize("fold", input)` so it matches ([runtime README](https://www.npmjs.com/package/blockdb#case-insensitive-search-fold-at-build-time)). `year_num` gives numeric ranges over a column stored as text (`"1999"`, `"n/a"`), and is absent where the text isn't a number. `derive.from` must be a declared, non-derived field, and the declared `kind` must match the normalizer's output.

### Typing json payloads

Fields of `kind: "json"` are payload-only: stored and returned in full, but not queryable (only indexed fields are). Codegen types them as `unknown`, which is honest but means the part of the record holding your nested data is the one part that isn't typed. Declare a `tsType` to fix that:

```jsonc
{
  "cover": {
    "kind": "json",
    "tsType": "CoverImage",
    "tsImport": "import type { CoverImage } from \"../types/books.js\";"
  },
  "prices": { "kind": "json", "tsType": "Record<string, string | null>" }
}
```

```ts
book.cover?.url;  // string | undefined — checked, not `unknown`
book.cover?.ulr;  // compile error
```

- `tsType` is any type expression (`CoverImage`, `Author[]`, a `Record<…>`), emitted verbatim.
- `tsImport` is a complete import statement, emitted above the interface. Identical statements across fields are emitted once, so several payload fields can share one module. **The path is relative to `clientOut`** (default `src/blockdb/`), not to the config.
- Payload fields stay **optional** even with a declared type. blockdb never tracks presence for `json` fields, so it can't promise the key exists.
- `init --reinfer` preserves both — they're the one part of a field config inference can't produce.

This is an **unchecked assertion**. blockdb relays the payload verbatim and never validates it against the type you declared; keeping the declaration true of your data is your job, exactly as with a database driver's row type. Validation stays out of scope.

See the [project README](https://github.com/shivan2418/blockdb#readme) for the full pitch and design, and [`examples/`](https://github.com/shivan2418/blockdb/tree/master/examples) for two complete example apps built with this CLI. For querying, see the [query guide](https://github.com/shivan2418/blockdb/blob/master/docs/query-guide.md).

## License

MIT

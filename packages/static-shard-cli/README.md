# static-shard-cli

Build tool for [static-shard](https://www.npmjs.com/package/static-shard): infer → shard → index → codegen, plus the config wizard. A Node-only devDependency — install it alongside the runtime `static-shard` package, never in production.

## Quickstart

```bash
pnpm add static-shard && pnpm add -D static-shard-cli
npx static-shard-cli init      # interactive wizard, or fully flag-driven with --yes
npx static-shard build         # → public/shard-data/  (deploy this)  +  src/shard-db/  (commit this)
```

`init` is the only place inference happens (sampled by default, `--full-scan` for exact cardinalities); it writes a single committed `static-shard.config.json`. `build` is headless (no TTY, safe in CI): it replays the config's baked schema — never re-infers — and fails loudly if your data has drifted from it.

### Commands

- **`init`** — interactive wizard or `--yes` + flags (fully non-interactive, scriptable). Detects the input format, infers a schema, recommends a sort field and default indexed set, and persists `static-shard.config.json`.
- **`build`** — reads the committed config, shards + indexes the data, writes the served tree (default `public/shard-data/`) and regenerates the typed client (default `src/shard-db/`). Flags: `--config`, `--out`, `--no-clean`.
- **`inspect`** — read-only report over a config or built directory: shard/index sizes, cost estimates, and warnings, without rebuilding. Flags: `--config`/`--dir`, `--json`.

Every wizard choice is also a CLI flag (nothing wizard-only), so `init --yes` with the right flags reproduces exactly what the wizard would have written — config generation is fully scriptable for CI.

### Choosing the sort field

The single biggest lever on query cost. Records are range-partitioned by this one field, so it decides **which records get stored next to each other**: a filter on the sort field reads a handful of data files, while a filter on anything else may read most of them. Pick the field your most common filter or ordering actually uses.

`number`, `date` and `string` fields are all eligible. A sorted **string** field additionally gets `startsWith` for free — a prefix is a contiguous range of the split-points already in the manifest, so it needs no index chunk fetch at all. On a 25k-card dataset (29 files), `startsWith("Light")` reads 26 of 29 files when sorted by a timestamp, and 1 of 29 when sorted by `name`.

`init` defaults to the highest-cardinality `number`/`date` field, which spreads shards evenly but is blind to what you query. A bulk-maintenance timestamp (`updated_at`, `synced_at`) is close to worst-case: it correlates with nothing users search, so every result set scatters across every file. If that's what got recommended, override it.

### Text-search opt-ins have real cost

`equals`, `in` and `startsWith` are free on any indexed string field. `endsWith` (reversed index) and `contains` (trigram index) are per-field opt-ins that each build an extra structure, and `build` warns in two distinct ways:

- **"bigger than the data"** — the structure exceeds the raw column it indexes. A size complaint.
- **"barely prunes"** — the average lookup resolves to most of your data files, so a query using it still reads most of the dataset. Typical of identifier, URL, and near-constant fields, whose substrings spread evenly across every file. Substring-searching a UUID column costs a full extra index and buys nothing.

An index can be small and useless, or large and worth it, so the two warnings are independent. Text matching is also **case-sensitive** with no folded index — see the [runtime README](https://www.npmjs.com/package/static-shard#text-matching-is-case-sensitive).

See the [project README](https://github.com/shivan2418/static-shard#readme) for the full pitch and design, and [`examples/`](https://github.com/shivan2418/static-shard/tree/master/examples) for two complete example apps built with this CLI.

## License

MIT

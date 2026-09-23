# ADR-0011 — Naming: `blockdb`, and Block as the domain term

## Status

Accepted. Supersedes the name `static-shard` and every use of "shard" in ADR-0001 through ADR-0010, whose text is left as written.

## Context

The project was named `static-shard` on a whim, and "shard" spread through the code, config and manifest. But what `build` does is not sharding. Sharding splits data across servers that each answer for their own share. Here, static files sit on a CDN and the *client* decides which to fetch. `build` range-partitions a dataset into size-bounded blocks, each carrying a per-block `[min, max]` zonemap, which is the vocabulary of the closest precedents: PostgreSQL's BRIN (Block Range INdex), Netezza and Redshift zone maps over blocks, Parquet row groups.

`CONTEXT.md` had already chosen **Block** for the data files and marked "Shard" as a term to avoid, because it suggests hash routing and distributed servers. The code never followed.

Nothing had been published to npm, so renaming cost nothing outside this repo and its one demo consumer.

## Decision

1. **Block is the domain term.** A Block is a data file; a Chunk is a piece of the lazy index. "Shard" is retired everywhere: code, config, manifest, docs.
2. **The package name agrees with that vocabulary**, says "static host / no backend" and "querying", is descriptive rather than coined, and includes "db". "db" oversells slightly (no writes, SQL or joins), which the tagline corrects.
3. **The name is `blockdb`.** `static-db` came first as the plainest wording, but `staticdb`, an abandoned 2022 package with a similar pitch, sits one hyphen away on npm.
4. **Derived names:**
   - packages `blockdb` (runtime) and `blockdb-cli` (dev dependency), binary `blockdb`
   - `ShardError` → `BlockDbError`, named for the library because its codes cover config, network and limits, not blocks
   - `blockdb.config.json`, output `public/blockdb/`, generated client `src/blockdb/`
   - `shardBytes` → `blockBytes`; manifest `shards` → `blocks`, `shardCount` → `blockCount`, `emptyShards` → `emptyBlocks`; data folder `shards/` → `blocks/`
   - the sort field's null/absent run, previously the "missing block", becomes the **missing tail**, so "block" keeps one meaning
5. **`formatVersion` stays 0.** Nothing deployed depends on the old layout.
6. **Tagline:** "Query large datasets from any static host: no backend, no WASM." It clears the blockchain association without naming it.
7. **The GitHub repo moves** to `shivan2418/blockdb`; GitHub redirects the old URL.
8. **npm names are not reserved ahead of v1.0.**

## Consequences

- Earlier ADRs still say "shard". Read it as "block".
- The rename is breaking for every consumer, which is currently only the shard-test demo, renamed to `blockdb-scryfall`.

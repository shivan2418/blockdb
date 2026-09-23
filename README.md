# blockdb

Query large datasets from any static host: no backend, no WASM, no HTTP Range requests.

`blockdb` splits a large dataset into many small files at build time, builds indexes over them, and generates a **typed client** that fetches only the files a query needs. Because it fetches whole small files (not byte ranges of one big file), it works on any dumb static host and every block is a plain, compressible, cacheable CDN object.

## Quickstart

```bash
pnpm add blockdb && pnpm add -D blockdb-cli
npx blockdb-cli init      # a guided wizard reads a sample of your data, recommends
                                #   what to index, and writes blockdb.config.json
npx blockdb build         # → public/blockdb/  (deploy this)  +  src/blockdb/  (commit this)
```

```ts
import { connect } from "./blockdb/client";

const db = connect();
const { records } = await db.movies.findMany({
  where: { year: { gte: 2000 }, rating: { gt: 8 } },
  orderBy: { rating: "desc" },
  limit: 20,
});
```

Two complete, working example apps — a movie catalog and a product lookup, each building → deploying → querying in a real browser — live in [`examples/`](https://github.com/shivan2418/blockdb/tree/master/examples).

## Why blockdb?

The problem — *query a big dataset in the browser, with no database server and no backend, served from plain static hosting* — is well-trodden. Almost every existing tool solves it the **opposite way** from blockdb: keep **one big file** and read byte-slices of it with **HTTP Range requests** inside a **WebAssembly engine**.

blockdb splits your data into **many small whole files** at build time, indexes them, and generates a **typed client** that fetches only the files a query needs. That trade buys three things the one-big-file approach can't easily get:

- **Runs on any static host.** It fetches whole files by URL — no HTTP Range support required. GitHub Pages, S3, an old nginx, a corporate proxy: if it can serve a file, it works.
- **Compression actually works.** Range requests and on-the-fly gzip/brotli fight each other (byte offsets shift once compressed), so the one-file camp often has to serve data *uncompressed*. Whole-file blocks compress end-to-end — a big deal for JSON, which shrinks 5–10×.
- **A typed client, no engine.** The generated client is small JS with zero runtime dependencies and no multi-MB WASM to download and compile before the first query. Your fields and per-field operators are typed from the data.

**The honest cost:** many small files means **more HTTP requests** than a single range-read file, and it's **read-only** (you rebuild and redeploy to update). If those are dealbreakers, pick one of the alternatives below.

### Use blockdb when

- You have a **large, mostly-static, structured dataset** (roughly tens of MB up to ~1 GB) that you want to **query by field** (equality, ranges, `in`, simple string matches).
- The data is **read-only** from the browser's side — rebuild-to-update is fine.
- You have **no backend** — just static hosting or a CDN.
- You want **type-safe queries** in TypeScript, generated from your data.
- You want to keep the client **lightweight** (no WASM engine, no heavy dependencies).

### Reach for something else when

**If you have — or can run — a server and an API, that is almost always the right choice.** A real backend with a database handles anything that mutates, needs authentication or private/per-user data, must always be fresh, or runs heavy relational/analytical queries. blockdb exists for when you *can't* or *won't* run one; don't adopt it to dodge building an API you actually need.

For the no-backend / static-hosting case specifically, here's the landscape and when each fits better:

| Tool | How it works | Reach for it instead when |
|------|--------------|---------------------------|
| **A backend + DB + API** (Postgres/Mongo + REST/GraphQL) | A server runs queries against a database | The data mutates, needs auth or private data, must be always-fresh, or needs joins / aggregations / full SQL. |
| **Just load the whole file** | `fetch()` the entire JSON and filter in memory | The dataset is small (a few MB or less) — below that, partitioning is pure overhead. |
| **sql.js-httpvfs** (phiresky) | SQLite → WASM, reads pages of one file via HTTP Range | You need full read-only **SQL** (joins, aggregates), your host supports Range, and WASM + a largely-uncompressed DB file is acceptable. |
| **DuckDB-WASM + Parquet** | WASM SQL engine, range-reads Parquet row groups, prunes via column stats | You run heavy **analytical / aggregation** queries over columnar data and can afford a multi-MB WASM engine. |
| **hyparquet** | Pure-JS (no WASM) Parquet reader, range-fetches column chunks | You want to read **existing Parquet** files in the browser without WASM. |
| **PMTiles** | Single-file archive with an internal directory → any record in ≤2 range reads | Your data is **map tiles** or a key→blob archive served from one file. |
| **Pagefind / lunr / FlexSearch** | Build-time index shipped (or partitioned) to the browser | The query is **full-text search** over documents, not structured field filtering. |

blockdb overlaps most with **sql.js-httpvfs** (same goal — a database on static hosting) and **Pagefind** (same architecture — a build-time-partitioned index fetched on demand). It differs by targeting **structured + numeric-range queries** with **no WASM**, **no HTTP Range**, and a **typed generated client**.

## License

MIT

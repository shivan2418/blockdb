# static-shard

Query large static datasets from any static host — no database, no backend, no WASM, no HTTP Range requests.

This is the **runtime** package: a zero-third-party-dependency, ESM-only browser client that fetches a manifest and the handful of small shard/index files a query actually needs, and returns fully-typed records. It has no `bin` and does no building — pair it with [`static-shard-cli`](https://www.npmjs.com/package/static-shard-cli) (a devDependency) to shard your data and generate the typed client this package powers.

See the [project README](https://github.com/shivan2418/static-shard#readme) for the full pitch, design, and alternatives comparison.

## Quickstart

```bash
pnpm add static-shard && pnpm add -D static-shard-cli
npx static-shard-cli init      # a guided wizard reads a sample of your data, recommends
                                #   what to index, and writes static-shard.config.json
npx static-shard build         # → public/shard-data/  (deploy this)  +  src/shard-db/  (commit this)
```

```ts
import { connect } from "./shard-db/client";

const db = connect();
const { records, hasMore } = await db.movies.findMany({
  where: { year: { gte: 2000 }, rating: { gt: 8 } },
  orderBy: { rating: "desc" },
  limit: 20,
});
```

`db.<collection>` is a real, named member with go-to-definition and intellisense on both the field and its available operators — the type system only offers operators the built data actually indexed. See [`examples/`](https://github.com/shivan2418/static-shard/tree/master/examples) in the repo for two complete, working example apps (movie catalog, product lookup) that build → deploy → query in a real browser.

## Case-insensitive search: fold at build time

`equals`, `in`, `startsWith`, `endsWith` and `contains` all compare **exactly**. The index stores the values it was built from, so on Title Case data `contains: "bolt"` finds nothing while `contains: "Bolt"` works. Folding only the query can't fix that, because the index keys are still `"Bol"`, not `"bol"`.

The fix is a **derived field** (ADR-0009): a column the build computes from another, here with the `fold` normalizer (lowercase, diacritics stripped). In `static-shard.config.json`:

```json
"name_fold": {
  "kind": "string",
  "indexed": true,
  "contains": true,
  "absent": true,
  "derive": { "from": "name", "using": "fold" }
}
```

Then fold the query the same way with the exported `normalize`, so it lines up with the index:

```ts
import { normalize } from "static-shard";

const q = normalize("fold", input) ?? "";
await db.cards.findMany({ where: { name_fold: { contains: q } } }); // "lim-dul" → Lim-Dûl, …
```

`name` itself is untouched, so you still display it, sort by it and match it exactly. The other normalizers are `lowercase` (case only), `trim` and `numeric`; `normalize` mirrors the build's copies exactly. A derived column costs one extra index; if you only ever search the folded column, drop `contains` from the source field to get that cost back.

Don't retry a failed query in different capitalization instead. It can't help mid-word matches, it doubles the cost of every miss, and a miss is the expensive path: a zero-result query still fetches every candidate shard.

## License

MIT

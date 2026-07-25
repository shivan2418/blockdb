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

## Text matching is case-sensitive

`equals`, `in`, `startsWith`, `endsWith` and `contains` all compare **exactly**, with no case folding or normalization anywhere — the index stores raw values and the query is matched against them as given. On Title Case data, `contains: "bolt"` finds nothing while `contains: "Bolt"` works:

```ts
await db.cards.findMany({ where: { name: { contains: "bolt" } } }); // → no records
await db.cards.findMany({ where: { name: { contains: "Bolt" } } }); // → Lightning Bolt, …
```

There is no case-insensitive option in 1.0. Folding only the query cannot work, because the index keys are the raw values (`"Bol"`, not `"bol"`) — a case-insensitive search needs the *index* built folded, which is a build-time decision. Until that ships, the practical options are:

- **Normalize before you build.** Add a lowercase companion field to your input (`name_lower`), index that, and search it with a lowercased query. This is exact, costs one extra index, and is what we'd recommend today.
- **Constrain the input.** If you control the data, store the search field already folded.

Retrying a failed query with different capitalization is tempting but weak: it can't help mid-word matches, it doubles the cost of every miss, and a miss is the expensive path — a zero-result query still fetches every candidate shard.

Note that `count()` is unaffected in one useful way: `count === 0` with `exact: true` is still a trustworthy "none", so it remains a reliable existence check regardless of casing.

## License

MIT

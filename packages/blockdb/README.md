# blockdb

Query large datasets from any static host: no backend, no WASM, no HTTP Range requests.

This is the **runtime** package: a zero-third-party-dependency, ESM-only browser client that fetches a manifest and the handful of small block/index files a query actually needs, and returns fully-typed records. It has no `bin` and does no building — pair it with [`blockdb-cli`](https://www.npmjs.com/package/blockdb-cli) (a devDependency) to partition your data and generate the typed client this package powers.

See the [project README](https://github.com/shivan2418/blockdb#readme) for the full pitch, design, and alternatives comparison.

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
const { records, hasMore } = await db.movies.findMany({
  where: { year: { gte: 2000 }, rating: { gt: 8 } },
  orderBy: { rating: "desc" },
  limit: 20,
});
```

`db.<collection>` is a real, named member with go-to-definition and intellisense on both the field and its available operators — the type system only offers operators the built data actually indexed. See [`examples/`](https://github.com/shivan2418/blockdb/tree/master/examples) in the repo for two complete, working example apps (movie catalog, product lookup) that build → deploy → query in a real browser.

## List fields

A multi-valued field (`"multi": true`) takes list operators instead of scalar ones:

```ts
await db.cards.findMany({ where: { colors: { some: "W" } } });                  // any element is W
await db.cards.findMany({ where: { colors: { hasEvery: ["W", "U"] } } });       // contains W and U
await db.cards.findMany({ where: { colors: { every: { in: ["W", "U"] } } } });  // only W/U; [] passes
await db.cards.findMany({ where: { colors: { isEmpty: true } } });              // []
// Keys on one field AND together, so exactly [W, U] is:
await db.cards.findMany({ where: { colors: { hasEvery: ["W", "U"], every: { in: ["W", "U"] } } } });
```

All of them need a present list: a record with no `colors` key, or `null`, matches none, including `isEmpty`. All of them prune through the index, but `every` is the weakest, since "only W or U" admits many blocks. See ADR-0010.

## Case-insensitive search: fold at build time

`equals`, `in`, `startsWith`, `endsWith` and `contains` all compare **exactly**. The index stores the values it was built from, so on Title Case data `contains: "bolt"` finds nothing while `contains: "Bolt"` works. Folding only the query can't fix that, because the index keys are still `"Bol"`, not `"bol"`.

The fix is a **derived field** (ADR-0009): a column the build computes from another, here with the `fold` normalizer (lowercase, diacritics stripped). In `blockdb.config.json`:

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
import { normalize } from "blockdb";

const q = normalize("fold", input) ?? "";
await db.cards.findMany({ where: { name_fold: { contains: q } } }); // "lim-dul" → Lim-Dûl, …
```

`name` itself is untouched, so you still display it, sort by it and match it exactly. The other normalizers are `lowercase` (case only), `trim` and `numeric`; `normalize` mirrors the build's copies exactly. A derived column costs one extra index; if you only ever search the folded column, drop `contains` from the source field to get that cost back.

Don't retry a failed query in different capitalization instead. It can't help mid-word matches, it doubles the cost of every miss, and a miss is the expensive path: a zero-result query still fetches every candidate block.

## License

MIT

# Querying blockdb

A complete guide to the query API: every operator, what each method returns, and what a query costs. For setup, see the [README](../README.md). For how the build decides what's queryable, see the [blockdb-cli README](../packages/blockdb-cli/README.md).

- [The example dataset](#the-example-dataset)
- [Connecting](#connecting)
- [The four methods](#the-four-methods)
- [Filtering rules](#filtering-rules)
- [Which operators a field gets](#which-operators-a-field-gets)
- [Strings](#strings)
- [Numbers and dates](#numbers-and-dates)
- [Booleans](#booleans)
- [Missing values: null and absent](#missing-values-null-and-absent)
- [`not`](#not)
- [List fields](#list-fields)
- [No OR: what to do instead](#no-or-what-to-do-instead)
- [Sorting](#sorting)
- [Pagination](#pagination)
- [Counting](#counting)
- [Looking up by id](#looking-up-by-id)
- [What a query costs](#what-a-query-costs)
- [Errors](#errors)
- [What the compiler catches](#what-the-compiler-catches)

## The example dataset

Every example below queries one collection, `books`, built from records like this:

```json
{ "id": "b-00042", "title": "River Clock", "author": "Erin Walsh", "published": "2005-01-18",
  "pages": 526, "inStock": true, "language": "fr", "tags": ["history", "poetry"],
  "rating": 4.2, "details": { "isbn": "978-1000000042" } }
```

`rating` is `null` in some records and missing entirely in others. The config's `schema` block:

```json
{
  "sortField": "title",
  "pk": "id",
  "fields": {
    "id":         { "kind": "string", "indexed": true },
    "title":      { "kind": "string" },
    "title_fold": { "kind": "string", "indexed": true, "contains": true, "derive": { "from": "title", "using": "fold" } },
    "author":     { "kind": "string", "indexed": true, "endsWith": true },
    "published":  { "kind": "date", "indexed": true },
    "pages":      { "kind": "number", "indexed": true },
    "rating":     { "kind": "number", "indexed": true, "absent": true, "nullable": true },
    "inStock":    { "kind": "boolean", "indexed": true },
    "language":   { "kind": "string", "indexed": true, "values": ["de", "en", "es", "fr"] },
    "tags":       { "kind": "string", "indexed": true, "multi": true,
                    "values": ["fantasy", "fiction", "history", "mystery", "poetry", "romance", "science", "travel"] },
    "details":    { "kind": "json" }
  }
}
```

`blockdb init` infers almost all of this from the data; you pick the sort field, the primary key and the indexed fields.

## Connecting

`blockdb build` generates `src/blockdb/client.ts`. Import `connect` from it:

```ts
import { connect } from "./blockdb/client";

const db = connect();
```

With no arguments it fetches from the `basePath` baked in at build time (default `/blockdb`). Every option can be overridden:

```ts
const db = connect({
  basePath: "/data/books", // where the built output is deployed
  fetch: myFetch,          // any fetch-compatible function: retries, auth headers, tests
  maxResults: 50_000,      // the result ceiling (default 10,000), see Pagination
});
```

`db.books` is a real, named property, so go-to-definition and autocomplete work on the collection, its fields and each field's operators.

## The four methods

| Method | Returns | Notes |
|---|---|---|
| `findMany({ where?, orderBy?, limit?, offset? })` | `{ records, hasMore, total? }` | Full records, including payload-only fields. |
| `count(where?)` | `{ count, exact }` | A zero-fetch upper bound. See [Counting](#counting). |
| `get(id)` | the record, or `null` | Only exists when the config names a `pk`. |
| `getSchema()` | the schema descriptor | Fields, kinds and enabled operators, for building UIs. |

All four are async.

## Filtering rules

A `where` maps field names to filters, and a filter maps operator names to values:

```ts
await db.books.findMany({
  where: { language: { equals: "fr" }, pages: { gte: 300, lte: 400 } },
});
```

- **Everything ANDs.** Every field in `where` must match, and every operator on one field must match. There is no OR. See [No OR](#no-or-what-to-do-instead).
- **Only indexed fields are queryable.** The sort field is always queryable. Other fields need `"indexed": true`. Fields of kind `json` are carried in records but never queryable.
- **Operators come from the config, not just the type.** A string field only gets `contains` if you opted in. The type system offers exactly what was built, so an operator you can't use is a compile error rather than a slow query.

## Which operators a field gets

| Field | Operators |
|---|---|
| Sort field, number or date | `equals` `in` `gt` `gte` `lt` `lte` `not` |
| Sort field, string | the same, plus `startsWith` |
| Indexed string | `equals` `in` `startsWith` `not`, plus `endsWith` / `contains` if opted in |
| Indexed number or date | `equals` `in` `gt` `gte` `lt` `lte` `not` |
| Indexed boolean | `equals` `not` |
| Indexed list (`"multi": true`) | `some` `every` `hasEvery` `isEmpty` |
| Indexed, not a list, with `"nullable": true` | also `isNull` `exists` |
| Indexed, not a list, with `"absent": true` | also `isAbsent` `exists` |

## Strings

`equals`, `in` and `startsWith` work on every indexed string field and are case-sensitive:

```ts
await db.books.findMany({ where: { author: { equals: "Erin Walsh" } } });
await db.books.findMany({ where: { author: { in: ["Erin Walsh", "Hana Sato"] } } });
await db.books.findMany({ where: { author: { startsWith: "Er" } } });
```

**The sort field also gets ranges.** String ranges compare lexicographically (by UTF-16 code unit), which is only meaningful on the sort field, where it matches the physical order of the data. A range on the sort field is also the cheapest query there is:

```ts
await db.books.findMany({ where: { title: { gte: "Glass", lt: "H" } } });
```

Other string fields never get ranges, because `gte: "2"` on a column of numeric-looking strings would silently drop `"10"`. Give that data `kind: "number"` instead, or derive a number column (below).

**`endsWith` and `contains` are opt-ins.** Each builds an extra index (`"endsWith": true` builds a reversed index; `"contains": true` builds a trigram index), so they cost build time and deploy size:

```ts
await db.books.findMany({ where: { author: { endsWith: "Walsh" } } });
await db.books.findMany({ where: { title_fold: { contains: "atlas" } } });
```

`blockdb build` warns when one of these indexes barely prunes, which is typical of identifiers and near-constant fields.

**Value unions.** When a string field has few distinct values, `init` records them in `values`. Codegen then narrows `equals`, `in`, `some` and `hasEvery` to that union, so `language: { equals: "xx" }` is a compile error and your editor autocompletes the valid values. `startsWith`, `endsWith` and `contains` stay plain `string`, because a fragment of a value isn't itself a value. The union is exported by name (`BooksLanguage` here), which is handy for building a picker. Delete `values` from the config to widen the field back to `string`.

### Case- and accent-insensitive search

Matching is exact, so `contains: "cafe"` won't find "Café". Fix it at build time: derive a folded copy of the field (`"derive": { "from": "title", "using": "fold" }`, see the config above), then fold the user's input the same way before querying:

```ts
import { normalize } from "blockdb";

const q = normalize("fold", userInput) ?? "";
await db.books.findMany({ where: { title_fold: { contains: q } } }); // "cafe" finds "Café Atlas"
```

`fold` lowercases and strips accents. The other normalizers are `lowercase`, `trim` and `numeric`, which parses numeric-looking strings into a number column so you get real number ranges. `normalize` in the runtime is the same function the build uses, so both sides always agree.

## Numbers and dates

Numbers and dates get equality, `in` and ranges on any indexed field. Combine `gt`/`gte` with `lt`/`lte` on one field for a between:

```ts
await db.books.findMany({ where: { pages: { gte: 300, lte: 400 } } });
await db.books.findMany({ where: { rating: { gt: 4.5 } } });
```

Dates are ISO 8601 strings (`"2005-01-18"` or a full timestamp) and compare as such:

```ts
await db.books.findMany({ where: { published: { gte: "2000-01-01", lt: "2010-01-01" } } });
```

## Booleans

```ts
await db.books.findMany({ where: { inStock: { equals: true } } });
```

## Missing values: null and absent

blockdb distinguishes a field that is `null` from one that is missing from the record ("absent"), and the config records which of the two each field can be. `init` detects both from the data:

- `"nullable": true`: some records hold `null`. The generated type is `T | null`, and the field gets `isNull` and `exists`.
- `"absent": true`: some records lack the key. The generated type is optional (`field?: T`), and the field gets `isAbsent` and `exists`.

`rating` is both, so its type is `rating?: number | null` and it gets all three operators:

```ts
await db.books.findMany({ where: { rating: { isNull: true } } });   // rating: null
await db.books.findMany({ where: { rating: { isAbsent: true } } }); // no rating key
await db.books.findMany({ where: { rating: { exists: true } } });   // has a real value
await db.books.findMany({ where: { rating: { exists: false } } });  // null or absent
```

A missing value never matches a comparison: `rating: { gt: 4.5 }`, `rating: { equals: 5 }` and `rating: { not: 5 }` all skip records whose rating is null or absent.

The flags keep the generated types honest, so `build` enforces them: if your data gains a `null` or loses a key where the config doesn't allow it, the build fails and says which flag to add (or run `blockdb init --reinfer`). The operators are only offered on indexed fields other than the sort field and list fields, but the flags shape the record type on every field.

## `not`

`not` excludes one value:

```ts
await db.books.findMany({
  where: { language: { equals: "fr" }, author: { not: "Erin Walsh" } },
});
```

`not` can't use an index (every file might hold a record that isn't Erin Walsh), so it only filters records that other operators already selected. A `where` whose only operator is `not` would read the whole dataset, so it's rejected: a compile error, plus a runtime error for untyped callers. `count` accepts it, because `count` never reads data.

## List fields

A field whose values are string arrays (`"multi": true`) takes list operators instead of scalar ones:

```ts
await db.books.findMany({ where: { tags: { some: "poetry" } } });                        // any tag is poetry
await db.books.findMany({ where: { tags: { some: { startsWith: "fi" } } } });            // any tag starts with fi
await db.books.findMany({ where: { tags: { hasEvery: ["poetry", "travel"] } } });        // has both
await db.books.findMany({ where: { tags: { every: { in: ["poetry", "travel"] } } } });   // no other tags
await db.books.findMany({ where: { tags: { isEmpty: true } } });                         // tags: []
```

- `some` takes an element filter using the field's own operators, or a bare value as shorthand for `{ equals: value }`.
- `every` passes an empty list, since an empty list has no element that fails. To require at least one element, add `some` with the same filter: `{ every: { in: ["poetry", "travel"] }, some: { in: ["poetry", "travel"] } }`.
- Operators on one field AND together, so an exact set is `hasEvery` plus `every`:

```ts
await db.books.findMany({
  where: { tags: { hasEvery: ["poetry", "travel"], every: { in: ["poetry", "travel"] } } },
}); // exactly poetry and travel
```

A record whose list is missing or `null` matches none of these, including `isEmpty`.

## No OR: what to do instead

`where` has no `OR`. For alternatives on one field, use `in` (or `some` on a list field). For alternatives across fields, run one query per branch and merge by primary key:

```ts
const [byAuthor, byTag] = await Promise.all([
  db.books.findMany({ where: { author: { equals: "Hana Sato" } } }),
  db.books.findMany({ where: { tags: { some: "poetry" } } }),
]);
const merged = new Map([...byAuthor.records, ...byTag.records].map((b) => [b.id, b]));
```

`OR` may be added later without breaking existing queries.

## Sorting

`orderBy` takes any queryable field, `"asc"` or `"desc"`. Several keys break ties in the order you write them:

```ts
await db.books.findMany({ orderBy: { title: "desc" }, limit: 10 });
await db.books.findMany({
  where: { author: { equals: "Hana Sato" } },
  orderBy: { published: "desc", pages: "asc" },
});
```

Without `orderBy`, results come in sort-field order.

**Sorting by the sort field is cheap; sorting by anything else reads every candidate.** Data is stored in sort-field order, so a page sorted by the sort field is read from the first few files and the walk stops. To sort by `rating`, blockdb must first read every record the `where` selects, so narrow the `where` before sorting large collections by another field.

Missing values sort first in ascending order and last in descending order.

## Pagination

`limit` and `offset` page through results. `hasMore` says whether another page exists:

```ts
const page = await db.books.findMany({
  where: { language: { equals: "de" } },
  limit: 20,
  offset: 40, // the third page
});
page.hasMore; // true if there's a fourth page
page.total;   // the exact match count, when blockdb had to see every match anyway
```

`total` is present only when answering the query already meant seeing every match: an `orderBy` on a field other than the sort field, no `limit`, or a page at or past the end. It's the true count, so prefer it over `count()` when it's there.

**The result ceiling.** A query never returns more than `maxResults` records (default 10,000). An explicit `limit` above it throws, and so does a query without `limit` that matches more records than that. Nothing is ever silently truncated. Paginate, or raise `maxResults` in `connect()` if you really need everything.

## Counting

`count` answers from the manifest alone, without fetching any data files, so it's instant but approximate:

```ts
const { count, exact } = await db.books.count({ language: { equals: "de" } });
```

- `count` is an **upper bound**: the number of records in every file that might match.
- `exact` is `true` only for an empty `where` (the total record count) and when nothing can match (`count: 0`), so `count === 0` is always a trustworthy "no results".
- For an exact number, use `total` from `findMany` when it's present, or run `findMany` without `limit` (capped by `maxResults`).

## Looking up by id

When the config names a `pk`, the collection has `get`:

```ts
const book = await db.books.get("b-00042"); // the record, or null
```

It's a compile error on a collection without a primary key.

## What a query costs

Every query first loads the manifest (once, then cached). The manifest records each file's value ranges, so the sort field and number/date ranges can rule out files without fetching anything else. Other operators may fetch small index chunks (about 45 KB each) to find which files contain a value. blockdb then fetches the remaining data files.

Files fetched per query (after the manifest) on a build of 4,000 books in 47 data files:

| Query | Files | Why |
|---|---|---|
| `title: { equals }` | 1 | The manifest's sort-field ranges point at the one file |
| `get` by id | 2 | One index chunk, then the file it names |
| `title: { startsWith }` or a title range | 3 | A contiguous run of files, no index needed |
| Any query with a small `limit` and no `orderBy` | about 5 | The walk stops once the page is full |
| `pages: { gte, lte }` on an indexed field | up to all | Only pruned where files' value ranges don't overlap |
| `tags: { every: … }`, `author: { endsWith }` | most | These admit many files |
| `orderBy` on a non-sort field | every candidate | Ordering needs all matches |

How to keep queries cheap:

- **Choose the sort field for your main access pattern.** Lookups, prefixes and ranges on it are the cheapest queries.
- **Always pass `limit`** unless you need every match.
- **Pair broad operators with a selective one.** `not`, `every` and the fragment operators get cheaper when another field narrows the candidates.
- **Inspect before deploying.** `blockdb inspect` reports sizes and warnings without rebuilding.

## Errors

The runtime throws one error class, `BlockDbError`, with a `code` to switch on:

```ts
import { BlockDbError } from "blockdb";

try {
  await db.books.findMany({ where: { language: { equals: "de" } } });
} catch (e) {
  if (e instanceof BlockDbError && e.code === "NETWORK") {
    // worth retrying
  }
}
```

| Code | Meaning | Retry? |
|---|---|---|
| `CONFIG` | No manifest at `basePath` (404 or unreachable). Check `basePath`. | No |
| `FORMAT_VERSION` | The deployed data was built by an incompatible major version. Rebuild. | No |
| `DEPLOY_INTEGRITY` | A file the manifest names is missing. Usually a partial deploy, or a client generated by a different build. | No |
| `NETWORK` | `fetch` failed or returned a non-404 error status. `e.status` holds the status if there was one. | Maybe |
| `CORRUPT_DATA` | A file didn't parse, or didn't decompress (for example, brotli on a host that can't serve it; see the [deploy guide](deploy-guide.md)). | No |
| `LIMIT_EXCEEDED` | The query would return more than `maxResults`. | No, paginate |

Errors carry `e.url` (the file being fetched) where relevant. They never include your `where`, so filter values don't end up in logs. There's no built-in retry: wrap `fetch` instead, as the [deploy guide](deploy-guide.md) shows.

## What the compiler catches

The generated types reject, at compile time:

- a field that isn't queryable: unknown, not indexed, or a `json` payload
- an operator the field doesn't have, such as `contains` without the opt-in, or a range on a secondary string field
- a value outside a field's value union
- `isNull` on a field that isn't `nullable`, `isAbsent` on one that isn't `absent`, and `exists` on one that's neither
- a `where` whose only operator is `not`
- `get` on a collection without a primary key
- `orderBy` on a field that isn't queryable

import { BlockDbError } from "./errors.js";

/**
 * How the deploy pre-compresses every file it serves (ADR-0002 §8). `"none"` is the default: most
 * hosts apply `Content-Encoding` themselves, which negotiates per client, whereas a pre-compressed
 * file cannot — a baked `.br` is unreadable to a client without brotli, with no fallback.
 *
 * Note the mismatch the file extension hides: the served suffix is `.br` (matching `Content-Encoding:
 * br`), but the DecompressionStream format string is `"brotli"`.
 */
export type Compression = "none" | "gzip" | "brotli";

/** The suffix a compressed file carries. Duplicated in both packages and pinned by an equivalence test — the runtime must derive block paths without reading anything the CLI wrote. */
export function compressionSuffix(compression: Compression): string {
  return compression === "gzip" ? ".gz" : compression === "brotli" ? ".br" : "";
}

/** The `DecompressionStream` format name for a compression, or `undefined` when nothing was applied. */
export function decompressionFormat(compression: Compression): "gzip" | "brotli" | undefined {
  return compression === "none" ? undefined : compression;
}

// The dataset-agnostic runtime's type machinery (ADR-0004). Ported from
// prototypes/codegen-client/runtime.ts: a generic runtime parameterized by a
// generated `as const` schema — all typing lives here as mapped types. The
// generated facade (schema.ts + client.ts, emitted by blockdb-cli) only
// narrows this generic surface to named, go-to-definition collections.

export type FieldKind = "string" | "number" | "date" | "boolean";

export interface FieldMeta {
  readonly kind: FieldKind;
  /** Every operator a `where` may write on this field (ADR-0013). */
  readonly operators: readonly string[];
  /**
   * The subset of `operators` that narrows which blocks a query reads; the others are riders. Always
   * emitted by codegen. A hand-written schema that omits it falls back to "every operator but `not`
   * and the missing-value operators prunes".
   */
  readonly pruning?: readonly string[];
  /** Multi-valued (string[]) → the list operators `some`/`every`/`hasEvery`/`isEmpty` (ADR-0010). */
  readonly multi?: boolean;
  /** This field is the user PK. */
  readonly pk?: boolean;
  /** The key may be missing from a record. Informational: `isAbsent`/`exists` arrive via `operators`. */
  readonly absent?: boolean;
  /** The value may be `null`. Informational: `isNull`/`exists` arrive via `operators`. */
  readonly nullable?: boolean;
  /**
   * The field's observed value set, baked in by codegen for low-cardinality string fields (an
   * "enum-like" field: MTG colours, a rarity, a status). Narrows the *equality-shaped* operators so
   * they autocomplete; absent → those operators accept any `string`.
   */
  readonly values?: readonly string[];
}

export interface CollectionMeta {
  /** Present ⟺ a user PK was declared → `get(id)` is emitted. */
  readonly pk?: string;
  readonly fields: { readonly [field: string]: FieldMeta };
}

export interface SchemaMeta {
  readonly [collection: string]: CollectionMeta;
}

// ---------------------------------------------------------------------------
// Per-kind operator → value-type tables. The FULL set; a field exposes only
// the subset its `operators` tuple names (config-driven, ADR-0003 §7).
// ---------------------------------------------------------------------------
/**
 * `V` is the field's value union when codegen baked one in (else `string`). Only the
 * equality-shaped operators narrow to it: `startsWith`/`contains`/`endsWith` match a *fragment* of
 * a value, and a fragment of an enum member is not itself an enum member — narrowing those would
 * reject `contains: "art"` against a value of `"artifact"`.
 */
type AllStringOps<V extends string = string> = {
  equals: V;
  not: V; // always a rider
  in: V[];
  startsWith: string;
  contains: string; // prunes with a trigram index, else a rider
  endsWith: string; // prunes with a reversed index, else a rider
  // Lexicographic ranges: only a string SORT field is ever granted these (ADR-0003 §7), so PickOps
  // keeps them off secondary string fields, whose operator lists never include them.
  gt: string;
  gte: string;
  lt: string;
  lte: string;
};
type AllNumberOps = {
  equals: number;
  not: number; // always a rider
  in: number[];
  gt: number;
  gte: number;
  lt: number;
  lte: number;
};
type AllDateOps = {
  // dates compare as ISO strings
  equals: string;
  not: string; // always a rider
  in: string[];
  gt: string;
  gte: string;
  lt: string;
  lte: string;
};
type AllBoolOps = {
  equals: boolean;
  not: boolean; // always a rider
};

type PickOps<All, Ops extends string> = {
  [K in Extract<keyof All, Ops>]?: All[K];
};

/** The missing-value operators, offered per field through its `operators` like any other. */
type MissingValueOps = {
  isNull: true;
  isAbsent: true;
  exists: boolean;
};

/**
 * A field's baked value union, or `string` when codegen didn't bake one (high-cardinality field, or
 * a schema typed loosely as `SchemaMeta` rather than an `as const` literal — which degrades to the
 * previous wide behavior rather than breaking).
 */
type ValuesOf<F extends FieldMeta> = F extends { values: readonly (infer V extends string)[] } ? V : string;

/** `{ some: value }` ≡ `{ some: { equals: value } }` (ADR-0001) — only offered where `equals` is itself enabled. */
type SomeShorthand<F extends FieldMeta> = "equals" extends F["operators"][number] ? ValuesOf<F> : never;

/** What `some` and `every` apply to each element: the field's own operators, or the equals shorthand. */
type ElementFilter<F extends FieldMeta> = PickOps<AllStringOps<ValuesOf<F>>, F["operators"][number]> | SomeShorthand<F>;

/** A multi-valued field's list operators (T7 `some`, ADR-0010 the rest). Keys on one field AND together. */
type ListOps<F extends FieldMeta> = {
  some?: ElementFilter<F>;
  every?: ElementFilter<F>;
  hasEvery?: ValuesOf<F>[];
  isEmpty?: true;
};

type FilterFor<F extends FieldMeta> = F extends { kind: "string"; multi: true }
  ? ListOps<F>
  : F extends { kind: "string" }
    ? PickOps<AllStringOps<ValuesOf<F>> & MissingValueOps, F["operators"][number]>
    : F extends { kind: "number" }
      ? PickOps<AllNumberOps & MissingValueOps, F["operators"][number]>
      : F extends { kind: "date" }
        ? PickOps<AllDateOps & MissingValueOps, F["operators"][number]>
        : F extends { kind: "boolean" }
          ? PickOps<AllBoolOps & MissingValueOps, F["operators"][number]>
          : never;

/** The where type: every queryable field, each with ONLY its valid operators. */
export type WhereOf<C extends CollectionMeta> = {
  [K in keyof C["fields"]]?: FilterFor<C["fields"][K]>;
};

/** orderBy over every queryable field — sorting happens in memory, so an index doesn't matter (ADR-0013). */
export type OrderByOf<C extends CollectionMeta> = {
  [K in keyof C["fields"]]?: "asc" | "desc";
};

// ---------------------------------------------------------------------------
// EXACT-TYPE validation. A generic `where?: W` alone would disable excess-
// property checking, silently admitting unknown fields / disabled operators.
// Capture the query literal as W and re-implement every check by hand.
// ---------------------------------------------------------------------------
type ValidateFilter<F, Allowed> = { [Op in keyof F]: Op extends keyof Allowed ? Allowed[Op] : never };
export type ValidateWhere<W, C extends CollectionMeta> = {
  [K in keyof W]: K extends keyof C["fields"]
    ? ValidateFilter<NonNullable<W[K]>, FilterFor<C["fields"][K]>>
    : never;
};

// ---------------------------------------------------------------------------
// The rider rule (ADR-0013): a filter either PRUNES (narrows which blocks are
// read — the sort field, or an operator an index answers) or RIDES (tests the
// records already fetched — `not`, the missing-value operators, and anything
// on an unindexed field). A where made only of riders would read every block,
// which ADR-0001 forbids, so it's rejected: at the type level via a branded
// required property whose NAME is the fix, and at runtime with NEEDS_PRUNING.
// ---------------------------------------------------------------------------
type RiderOp = "not" | "isNull" | "isAbsent" | "exists";
type PruningOp<F extends FieldMeta> = F extends { pruning: infer P extends readonly string[] }
  ? P[number]
  : Exclude<F["operators"][number], RiderOp>;
/** A list field's `some`/`every` prune through their element filter; `hasEvery` and `isEmpty` always do. */
type ElementPrunes<E, F extends FieldMeta> = E extends object
  ? Extract<keyof E, PruningOp<F>> extends never ? false : true
  : "equals" extends PruningOp<F> ? true : false;
type ListFilterPrunes<Filter, F extends FieldMeta> = Extract<keyof Filter, "hasEvery" | "isEmpty"> extends never
  ? true extends (Filter extends { some: infer E } ? ElementPrunes<E, F> : false) | (Filter extends { every: infer E } ? ElementPrunes<E, F> : false)
    ? true
    : false
  : true;
type FilterPrunes<Filter, F extends FieldMeta> = Filter extends object
  ? F extends { multi: true }
    ? ListFilterPrunes<Filter, F>
    : Extract<keyof Filter, PruningOp<F>> extends never ? false : true
  : false;
type AnyPrunes<W, C extends CollectionMeta> = true extends {
  [K in keyof W]: K extends keyof C["fields"] ? FilterPrunes<NonNullable<W[K]>, C["fields"][K]> : false;
}[keyof W]
  ? true
  : false;
export type RiderGuard<W, C extends CollectionMeta> = [keyof W] extends [never]
  ? {}
  : AnyPrunes<W, C> extends true
    ? {}
    : { "❌ every filter here is a rider — add one on the sort field or an indexed field, so the query doesn't read every block": never };

const RUNTIME_RIDER_OPS = new Set(["not", "isNull", "isAbsent", "exists"]);

/** The operators of `field` that prune — from the manifest, or the pre-ADR-0013 rule for a hand-written schema. */
function pruningOpsOf(field: { operators: readonly string[]; pruning?: readonly string[] }): readonly string[] {
  return field.pruning ?? field.operators.filter((op) => !RUNTIME_RIDER_OPS.has(op));
}

/** Whether one element filter of `some`/`every` can use the field's index. */
function elementPrunes(elementFilter: unknown, pruning: readonly string[]): boolean {
  if (typeof elementFilter !== "object" || elementFilter === null) return pruning.includes("equals");
  return Object.keys(elementFilter).some((op) => filterOpPrunes(op, (elementFilter as Record<string, unknown>)[op], pruning));
}

/**
 * Whether one operator actually reaches an index structure. `contains` routes on the trigrams of its
 * argument, so one shorter than three characters has none and can't prune even on a trigram field.
 */
function filterOpPrunes(op: string, value: unknown, pruning: readonly string[]): boolean {
  if (!pruning.includes(op)) return false;
  return !(op === "contains" && typeof value === "string" && value.length < 3);
}

/**
 * The rider rule at runtime (ADR-0013), for untyped JS callers and `where` objects built dynamically
 * (e.g. from UI input) that the compiler never sees. Throws `NEEDS_PRUNING` naming the fields that
 * could prune on this dataset.
 */
export function assertWhereHasPruning(
  where: Record<string, Record<string, unknown>> | undefined,
  schema: { sortField: string; fields: Record<string, { operators: readonly string[]; pruning?: readonly string[]; multi?: true | boolean }> },
): void {
  if (!where) return;
  const entries = Object.entries(where).filter(([, filter]) => filter !== undefined);
  if (entries.length === 0) return;

  const prunes = entries.some(([field, filter]) => {
    const meta = schema.fields[field];
    if (!meta) return false;
    const pruning = pruningOpsOf(meta);
    return Object.entries(filter ?? {}).some(([op, value]) => {
      if (meta.multi) {
        if (op === "hasEvery" || op === "isEmpty") return true;
        if (op === "some" || op === "every") return elementPrunes(value, pruning);
        return false;
      }
      return filterOpPrunes(op, value, pruning);
    });
  });
  if (prunes) return;

  const prunable = Object.entries(schema.fields)
    .filter(([name, meta]) => name !== schema.sortField && pruningOpsOf(meta).length > 0)
    .map(([name]) => name);
  throw new BlockDbError({
    code: "NEEDS_PRUNING",
    message:
      `blockdb: every filter in this where is a rider (it tests fetched records but can't narrow which blocks are read), ` +
      `so the query would read the whole dataset. Add a filter on the sort field "${schema.sortField}"` +
      (prunable.length > 0 ? ` or on an indexed field (${prunable.join(", ")})` : "") +
      `. See "Riders" in docs/query-guide.md.`,
  });
}

// ---------------------------------------------------------------------------
// `get(id)` (T8): emitted only when the collection declares a user PK.
// `PkField<C>` reads the collection-level `pk` name (never for a collection
// literal that omits the key — the point being it's a compile error, not a
// runtime undefined, for a PK-less collection to expose `get`).
// ---------------------------------------------------------------------------
type PkField<C extends CollectionMeta> = C extends { pk: infer P extends string } ? P : never;

type KindValueType<K extends FieldKind> = K extends "number" ? number : K extends "boolean" ? boolean : string;

type PkIdOf<C extends CollectionMeta> = PkField<C> extends keyof C["fields"]
  ? KindValueType<C["fields"][PkField<C>]["kind"]>
  : never;

type GetMember<C extends CollectionMeta, Rec> = PkField<C> extends never
  ? {}
  : { get(id: PkIdOf<C>, opts?: QueryOptions): Promise<Rec | null> };

// ---------------------------------------------------------------------------
// The collection surface: `findMany` (T2) + `count` (T4) + `getSchema` +
// `get(id)` (T8, conditional on a declared PK).
// ---------------------------------------------------------------------------
/**
 * Per-query options every collection method accepts. `signal` cancels the query: its pending block,
 * index and sidecar fetches are aborted and the call rejects with `BlockDbError` code `ABORTED`.
 * The manifest fetch, shared by every query on the client, is never cancelled: an aborted query only
 * stops waiting for it. For search-as-you-type, abort the previous keystroke's query before starting
 * the next.
 */
export interface QueryOptions {
  signal?: AbortSignal;
}

export interface FindManyArgs<C extends CollectionMeta, W extends WhereOf<C>> extends QueryOptions {
  where?: W & ValidateWhere<W, C> & RiderGuard<W, C>;
  orderBy?: OrderByOf<C>;
  limit?: number;
  offset?: number;
}

export interface FindManyResult<Rec> {
  records: Rec[];
  hasMore: boolean;
  /**
   * The EXACT number of records matching `where`, present only when answering the query already
   * required seeing all of them (refines ADR-0008 §5). Free when it appears — the engine had the
   * match set in hand and would otherwise have discarded its size.
   *
   * Present when every candidate block was read: any `orderBy` on a non-sort field (ordering can't be
   * decided without them), no `limit`, or a block walk that ran out of candidates before it filled the
   * page. Absent when the walk stopped early, which is exactly when the engine has NOT seen the tail.
   *
   * Prefer this over `count()` whenever it is present: `count()` is a zero-fetch upper bound that can
   * be an order of magnitude high, while this is the truth. It is not `offset + records.length` — on a
   * page past the end that formula returns the offset, not the total.
   */
  total?: number;
}

/**
 * Approximate upper bound for pagination totals (ADR-0008 §2/§3): `exact: true`
 * only for an empty where (→ recordCount) and pruned-to-zero (→ 0), so
 * `count === 0` is always a trustworthy existence check.
 */
export interface CountResult {
  count: number;
  exact: boolean;
}

/**
 * Reserved for the deferred v2 exact mode — 1.0 locks the slot to `false`, so
 * passing `exact: true` is a compile-time error (ADR-0008 §4).
 */
export interface CountOptions extends QueryOptions {
  exact?: false;
}

interface CollectionBase<C extends CollectionMeta, Rec> {
  findMany<W extends WhereOf<C>>(args?: FindManyArgs<C, W>): Promise<FindManyResult<Rec>>;
  // No RiderGuard here, deliberately: count reads only the manifest, so a
  // rider-only where just widens the upper bound (ADR-0008 §3) — count never
  // downloads the dataset, so the rider rule has nothing to guard (ADR-0013).
  count<W extends WhereOf<C>>(where?: W & ValidateWhere<W, C>, opts?: CountOptions): Promise<CountResult>;
  getSchema(): C;
}

export type Collection<C extends CollectionMeta, Rec> = CollectionBase<C, Rec> & GetMember<C, Rec>;

export interface ClientOptions {
  basePath: string;
  /**
   * Injectable for non-browser / testing; defaults to global `fetch`. The manifest request passes
   * `cache: "no-cache"` (and `"reload"` when recovering from a stale one, #32) in its `init`; a
   * wrapper should forward `init` so the browser sees it.
   */
  fetch?: typeof fetch;
  /**
   * Client-level result ceiling (default 10_000), a guardrail distinct from
   * per-query `limit` — fail-loud (ADR-0004/0007): an explicit `limit` above
   * it throws `LIMIT_EXCEEDED`, and an unbounded query that would match more
   * than it throws rather than silently truncating.
   */
  maxResults?: number;
  /**
   * Set by codegen when the build pre-compressed the manifest. Only the manifest needs telling:
   * everything else it points at carries `.gz`/`.br` in its own path. Hand-written callers of
   * `createClient` must match their deploy; the generated `connect()` already does.
   */
  manifestCompression?: Compression;
  /** @deprecated Use `manifestCompression: "gzip"`. */
  manifestGzip?: boolean;
}

export type GenericClient<S extends SchemaMeta, Records> = {
  [K in keyof S]: K extends keyof Records ? Collection<S[K], Records[K]> : never;
};

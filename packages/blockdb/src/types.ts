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
  /** The enabled operator names for this field — data, not implied by `kind` (ADR-0003 §7). */
  readonly operators: readonly string[];
  /** Multi-valued (string[]) → the list operators `some`/`every`/`hasEvery`/`isEmpty` (ADR-0010). */
  readonly multi?: boolean;
  /** This field is the user PK. */
  readonly pk?: boolean;
  /** Value can be missing → is null / is absent / exists surface. */
  readonly absent?: boolean;
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
  not: V; // filter-only rider
  in: V[];
  startsWith: string;
  contains: string; // opt-in (trigram index) + prunes
  endsWith: string; // opt-in (reversed index) + prunes
  // Lexicographic ranges: only a string SORT field is ever granted these (ADR-0003 §7), so PickOps
  // keeps them off secondary string fields, whose operator lists never include them.
  gt: string;
  gte: string;
  lt: string;
  lte: string;
};
type AllNumberOps = {
  equals: number;
  not: number; // filter-only rider
  in: number[];
  gt: number;
  gte: number;
  lt: number;
  lte: number;
};
type AllDateOps = {
  // dates compare as ISO strings
  equals: string;
  not: string; // filter-only rider
  in: string[];
  gt: string;
  gte: string;
  lt: string;
  lte: string;
};
type AllBoolOps = {
  equals: boolean;
  not: boolean; // filter-only rider
};

type PickOps<All, Ops extends string> = {
  [K in Extract<keyof All, Ops>]?: All[K];
};

type AbsentOps<F> = F extends { absent: true } ? { isNull?: true; isAbsent?: true; exists?: boolean } : {};

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
    ? PickOps<AllStringOps<ValuesOf<F>>, F["operators"][number]> & AbsentOps<F>
    : F extends { kind: "number" }
      ? PickOps<AllNumberOps, F["operators"][number]> & AbsentOps<F>
      : F extends { kind: "date" }
        ? PickOps<AllDateOps, F["operators"][number]> & AbsentOps<F>
        : F extends { kind: "boolean" }
          ? PickOps<AllBoolOps, F["operators"][number]> & AbsentOps<F>
          : never;

/** The where type: ONLY indexed fields, each with ONLY its valid operators. */
export type WhereOf<C extends CollectionMeta> = {
  [K in keyof C["fields"]]?: FilterFor<C["fields"][K]>;
};

/** orderBy over indexed fields only. */
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
// Filter-only rider rule (ADR-0003 §7): only `not`/negation cannot prune, so a
// where whose sole constraint is `not` would force a full scan. Encoded at the
// type level via a branded required property whose NAME is the fix message.
// ---------------------------------------------------------------------------
type RiderOp = "not";
type FieldHasPruning<F> = F extends object ? (Exclude<keyof F, RiderOp> extends never ? false : true) : false;
type FieldHasRider<F> = F extends object ? (Extract<keyof F, RiderOp> extends never ? false : true) : false;
type AnyPrunes<W> = true extends { [K in keyof W]: FieldHasPruning<NonNullable<W[K]>> }[keyof W] ? true : false;
type AnyRides<W> = true extends { [K in keyof W]: FieldHasRider<NonNullable<W[K]>> }[keyof W] ? true : false;
export type RiderGuard<W> = AnyRides<W> extends true
  ? AnyPrunes<W> extends true
    ? {}
    : { "❌ add a pruning filter — `not` cannot be the only constraint": never }
  : {};

// Defense-in-depth: the SAME rule at runtime, for untyped JS callers and
// dynamically-built where objects the compiler never sees.
const RIDER_OPS = new Set<string>(["not"]);
export function assertWhereHasPruning(where: Record<string, Record<string, unknown>> | undefined): void {
  if (!where) return;
  const fields = Object.values(where);
  if (fields.length === 0) return;
  const hasPruning = fields.some((filter) => Object.keys(filter ?? {}).some((op) => !RIDER_OPS.has(op)));
  if (!hasPruning) {
    throw new Error(
      "blockdb: `not` cannot be the only constraint — " +
        "add a pruning filter (equals / in / startsWith / contains / endsWith / range / some / every / hasEvery / isEmpty).",
    );
  }
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
  : { get(id: PkIdOf<C>): Promise<Rec | null> };

// ---------------------------------------------------------------------------
// The collection surface: `findMany` (T2) + `count` (T4) + `getSchema` +
// `get(id)` (T8, conditional on a declared PK).
// ---------------------------------------------------------------------------
export interface FindManyArgs<C extends CollectionMeta, W extends WhereOf<C>> {
  where?: W & ValidateWhere<W, C> & RiderGuard<W>;
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
export interface CountOptions {
  exact?: false;
}

interface CollectionBase<C extends CollectionMeta, Rec> {
  findMany<W extends WhereOf<C>>(args?: FindManyArgs<C, W>): Promise<FindManyResult<Rec>>;
  // No RiderGuard here, deliberately: a `not`-only where cannot refine an
  // un-fetched count, so it just widens the upper bound (ADR-0008 §3) — count
  // never full-scans, so the rider rule has nothing to guard.
  count<W extends WhereOf<C>>(where?: W & ValidateWhere<W, C>, opts?: CountOptions): Promise<CountResult>;
  getSchema(): C;
}

export type Collection<C extends CollectionMeta, Rec> = CollectionBase<C, Rec> & GetMember<C, Rec>;

export interface ClientOptions {
  basePath: string;
  /** Injectable for non-browser / testing; defaults to global `fetch`. */
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

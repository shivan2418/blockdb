# ADR-0005 — Package & CLI public contract

**Status:** Accepted
**Date:** 2026-07-21
**Ticket:** [T6 — Package & CLI public contract (#9)](https://github.com/shivan2418/static-shard/issues/9)
**Depends on:** T1 (data model / config-as-source-of-truth), T2 (ADR-0001, query surface), T4 (ADR-0003, index/manifest + `formatVersion`), T5 (ADR-0004, the runtime + generated-facade "blend").

## Context

`static-shard` ships as npm packages. This ADR fixes the **public contract**: how many packages and how they're versioned, the CLI command/flag surface, the config file, the on-disk output, the runtime↔build compatibility handshake, the consumer integration flow, and the 1.0 publish gate. ADR-0004 settled *what* the runtime and generated code are; this settles *how they're delivered and driven*. The map is **plan-only** — this is the spec a build session executes against, not code (the sole exception: the `LICENSE` file, created with this ADR).

## Decision

### 1. Two packages, split, lockstep-versioned

- **`static-shard`** — the runtime (ADR-0004). Browser-first, **zero third-party deps**, **ESM-only** for 1.0, `"type":"module"`, `sideEffects:false`. Owns the bare name; installed as a **production** dependency. `exports`: `{ ".": { "types": …, "import": … } }`, `files:["dist"]`, **no `bin`**.
- **`static-shard-cli`** — the Node-only build tool (infer → shard → index → codegen + the T7 wizard). Installed as a **devDependency** / run via `npx`. `bin` name **`static-shard`** (clean in package scripts; bootstrap via `npx static-shard-cli init`). `files:["dist","config.schema.json"]`.

**Why split:** static-shard is the Prisma/Drizzle case — a prod-dep runtime *and* a heavy devDep builder in one project. Splitting keeps the "zero-dep, no WASM" promise literally true in the consumer's production tree, not just the browser bundle, and isolates the build tool's dependencies (TUI lib, CSV parser, …) from the app.

**Lockstep versioning (Storybook-style):** both packages share one version and release together (one monorepo, one version number). **The package version *is* the compatibility contract** — no separate ABI integer. Breaking change ⇒ major bump on both.

### 2. The CLI contract is language-neutral

Everything the CLI consumes/produces is language-agnostic: input = `static-shard.config.json` + its published `config.schema.json` + the flag set; output = the static `shard-data/` tree + generated `schema.ts`/`client.ts` (plain **text templates**). The browser runtime never depends on the CLI's language. Therefore a **future Rust/Go reimplementation is non-breaking** — same flags, schema, tree, templates; only *distribution* changes (esbuild/swc-style per-platform binaries behind optional-deps + a resolver shim), the `bin` name and contract unchanged. The heavy cost (`--full-scan` inference over ~1GB) is all CLI-side build-time work — never in the runtime — so it's the cleanly swappable part. Lockstep is a numbering policy, so a native CLI adopts the same version and stamp.

### 3. Three input surfaces, one resolved config

Precedence: **CLI flags > config file > inferred defaults.** Every wizard choice is a first-class CLI flag (nothing wizard-only) — sort field, indexed-field set, chunk size, per-field operator toggles all have flags; `init --yes` + flags = **zero prompts**. All surfaces converge on a **single committed** `static-shard.config.json`:

- **Format:** one JSON file with `"$schema"` (editor autocomplete/validation), a `formatVersion`, the human *choices*, and a **machine-owned `schema` block** (the baked `SchemaDescriptor`). Chosen over a TS config because the wizard/flags/`--reinfer` are the primary authoring paths — JSON round-trips trivially, needs no transpile dependency, diffs cleanly, and makes the drift check simple. It is also language-neutral (see §2).
- Flags always resolve **through** the config: a fully flag-driven run still writes/updates the file, and `build` always needs a config present (no config-less builds in 1.0). The committed file is the durable record of what built.

### 4. Commands: `init` · `build` · `inspect`

- **`init`** — interactive (launches the T7 wizard) *or* fully flag-driven: detect → **infer** (sampled | `--full-scan`) → recommend → confirm knobs + operator toggles → **persist config**. The **only** place inference happens (incl. `--reinfer`). *(Amended 2026-09-23: `--reinfer` refreshes only facts about the data (kinds, `absent`/`nullable`, lists, value sets, added and removed fields) and keeps every choice, including the sort field, pk, indexed set, text opt-ins and compression. It used to re-derive the sort field and indexed set from inference and drop compression, which silently re-planned tuned deploys.)* *(Amended 2026-09-23, #29: inference streams. Each field keeps counts, a capped enum set and a distinct counter that is exact (by 53-bit hash) up to 1,000,000 values and a HyperLogLog estimate past it, so `init` reads an input of any size in bounded memory. Past the cap a field reads as unique, and so pk-shaped, when no repeat of its first million values was seen and its estimate is within three standard errors of its value count. The wizard's live estimates profile a reservoir sample of 2,000 records drawn from the whole input instead of its first 2,000.)* Input-seeding flags (positional input path/glob, `--format`, `--delimiter`, `--records`) live here; after `init` they're baked into config.
- **`build`** — headless, no TTY: read config → **replay** the baked `SchemaDescriptor` (**fail loud** on drift — `build` *never* re-infers) → shard → index → write the served tree → **regenerate** `schema.ts`/`client.ts` (generation folded in, no standalone `generate` for 1.0). Flags: `--config`, `--out`, `--no-clean`. Accepts the choice-flags as one-shot overrides (flags > file).
- **`inspect`** — read-only report over a config or built dir: shard count + size distribution, manifest size (root + sidecars), per-field index sizes, cost estimates, skew / oversized-record / low-card-sort warnings. Flags: `--config`/`--dir`, `--json`.
- Global: `--config`, `--cwd`, `--help`, `--version`, `--quiet`/`--verbose`.

### 5. Two outputs

- **Data artifacts** → config `output`, default **`public/shard-data/`** (most static frameworks serve `public/` at web root ⇒ `basePath` `/shard-data`). Cleaned on build by default; `--no-clean` preserves old files (atomic blue/green swaps). Served tree:
  ```
  <output>/
    manifest.json                       # STABLE name (never hashed) — the entry point
    zonemaps/<field>.json               # secondary-field zonemap sidecars (spilled past ~1MB root budget, ADR-0003)
    index/<field>/<chunkhash>.json      # lazy inverted-index chunks (~40–50KB, ADR-0003)
    shards/<hashprefix>/<hash>.ndjson   # content-hashed NDJSON shards (prefix subdirs past ~1k, ADR-0002)
  ```
  Everything except `manifest.json` is **content-hashed + immutable** (cache-forever); `manifest.json` is the stable pointer that swaps atomically on redeploy.
- **Generated client** (`schema.ts` + `client.ts`) → config `clientOut`, default **`src/shard-db/`**, **committed** by the user (`import { connect } from './shard-db/client'`).

### 6. Compatibility handshake

- **`manifest.formatVersion` = the package major** — *refines ADR-0003* (concretely defines `formatVersion` as the major rather than an independent counter). One number governs both data-format and code-contract compatibility.
- The CLI **stamps** the full build version into `manifest.json` and into a header comment on generated `client.ts` (`// generated by static-shard@X.Y.Z — do not edit`).
- At **`connect()`** the runtime asserts its own major == `manifest.formatVersion`; same major → always compatible (SemVer), major mismatch → **fail loud**: *"data/client built with static-shard 1.x but runtime is 2.x — align versions and re-run `static-shard build`."*
- **`basePath`:** config carries a `basePath` field (the public URL of `output`; wizard defaults it by stripping the static root, `public/shard-data` → `/shard-data`). The CLI **bakes it as the default** into the generated `connect()`, so `connect()` with **no args** works for the standard deploy; `connect({ basePath: 'https://cdn…' })` overrides. (The runtime's `createClient` still takes `basePath` per ADR-0004; the facade supplies the default.)

### 7. Consumer integration

```bash
pnpm add static-shard && pnpm add -D static-shard-cli
npx static-shard-cli init      # → static-shard.config.json
npx static-shard build         # → public/shard-data/ + src/shard-db/{schema,client}.ts  (commit these)
```
```ts
import { connect } from './shard-db/client'
const db = connect()
const hits = await db.movies.findMany({ where: { year: { gte: 2000 } } })
```
Framework-agnostic (pure `fetch`); browser + SSR/Node ≥18 (global `fetch`, injectable for tests). **No framework adapters in 1.0.**

### 8. Naming / keywords / README / LICENSE

- Name + description kept (match the locked positioning). **Keywords extended** with `typescript`, `typed`, `codegen`, `cdn`, `no-backend` (mirrored onto the CLI as relevant).
- README's "Why / when / alternatives" kept; a **Quickstart** (the §7 flow + the two committed outputs) is specified as a build deliverable.
- **`LICENSE` = MIT**, Emil Elgaard, 2026 — created with this ADR (in both packages at publish).

## Minimum publish-readiness gate for 1.0

**Package hygiene (both, lockstep):** same version, released together; `exports`/`types`/`files`/`bin` correct; `sideEffects:false` on runtime; ESM `dist/` + `.d.ts`; `LICENSE` + `README` (pitch + Quickstart); `repository`/`homepage`/`bugs`/`keywords`; **`npm pack --dry-run` inspected** (no source/fixtures/test-data in tarball; **runtime `dependencies` empty**, verified).
**Runtime:** ADR-0004 type machinery ported from the prototype, green under `tsc` (the `@ts-expect-error` suite *is* the type test); `formatVersion`-as-major check wired; **in-editor autocomplete crispness verified** (the open ADR-0004 item).
**CLI:** `init`/`build`/`inspect` implemented; **flag-equivalence** honored (`--yes` fully non-interactive); drift fails loud; clean-on-build + `--no-clean`; `config.schema.json` published + `$schema`-referenced; config round-trips; generated files stamped.
**End-to-end (hard acceptance test):** **1–2 shipped example pages** built on static-shard (in `examples/`, e.g. the movie-catalog browser + one more shape) that **build → deploy → query in a browser** — living documentation *and* the proof the whole contract works. Deploy-guidance doc (map fog) at least stubbed or explicitly deferred.
**Comment hygiene:** no prototype/teaching/throwaway comments in shipped code; comments explain non-obvious intent only; **generated files carry only the version-stamp + `do not edit` header**.
**CI/release:** CI typechecks + tests both packages + the pack-size check; lockstep release tooling (changesets fixed-mode or a version script); `engines.node >=18`. *(Amended 2026-09-22: the published packages declare `>=20`, the lowest Node that CI tests and vitest 4 runs on; Node 18 is EOL. The monorepo root declares `^20.19.0 || >=22.12.0` for vite 8. Dev dependencies use caret ranges on their current major instead of `latest`, and `@types/node` tracks the floor (`^20`) so newer Node APIs fail typecheck. CI runs on Node 20 and 24; `.nvmrc` pins development to 24 and `packageManager` pins pnpm.)*

## Consequences

- **T7 (#10, wizard)** must honor the flag-equivalence contract — every prompt maps to a flag defined here — and persists `static-shard.config.json` in this shape; it stays purely the interactive UX layer over this contract.
- **T8 (#11, error/partial-failure semantics)** slots onto the `connect()`/runtime surface fixed here.
- The build session gets a concrete package layout, command surface, config schema, output tree, and publish checklist — the way to a publishable 1.0 is now clear.

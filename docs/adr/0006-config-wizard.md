# ADR-0006 — Config wizard: linear flow, interaction model & dep-light TUI

**Status:** Accepted
**Date:** 2026-07-21
**Ticket:** [T7 — TUI config wizard (#10)](https://github.com/shivan2418/static-shard/issues/10)
**Depends on:** [T1 — Data model (#2)](https://github.com/shivan2418/static-shard/issues/2), [ADR-0002 — Sharding (#6)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0002-sharding-strategy.md), [ADR-0003 — Index & manifest (#7)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0003-index-and-manifest-design.md), [ADR-0005 — Package & CLI contract (#9)](https://github.com/shivan2418/static-shard/blob/master/docs/adr/0005-package-and-cli-contract.md)
**Refines:** ADR-0005 (§ the CLI's TUI dependency policy), ADR-0002/0003 (which delegated the wizard's *presentation* of their knobs/estimates to T7)

## Context

ADR-0002 committed the wizard to three knobs (sort field · indexed-field set · chunk size) each with a "live consequence estimate," ADR-0003 §7/§11 added per-field operator toggles and the cost-estimation formulas, and ADR-0005 made `init` the one inference site that persists `static-shard.config.json`. T7 owned the missing piece: **how the wizard actually looks and flows**, and — surfaced during prototyping — **which TUI library the CLI takes on to build it.**

This was a `/prototype` ticket. Three shapes were built on a shared, pure estimator (a faithful implementation of the ADR-0003 §11 formulas) driven by a **real profiled dataset** (a 116,138-record / 72.5 MB Scryfall export). Shape A (linear wizard) was chosen over a dense "live cockpit" (B) and a "review & override" (C). Shape A was then rebuilt in Ink to validate the look and lock the interaction model. Prototype: [`prototypes/config-wizard/`](https://github.com/shivan2418/static-shard/tree/master/prototypes/config-wizard).

## Decision

### 1. Flow — a linear wizard, one decision per screen
Six stages: **detect → sort field → filter fields → text search → file size → review**. Hand-holding over density; the recommendation-first and single-cockpit shapes were rejected (a first-time user wants to be led; the cockpit's power-user density loses newcomers). `init` is the *only* inference site (ADR-0005); the wizard is a config generator and is **never required to build** (T1: config is the source of truth).

### 2. Interaction model
- **`←/→` move between stages; `↑/↓` move within a step; `space` chooses/toggles; `Enter` advances the detect screen and writes on review.**
- **Sort field** — single-select list; the heuristic-recommended field (ADR-0002 §2: prefer number/date + high cardinality, PK tiebreak) is marked, not forced.
- **Filter fields** — multi-select list (queryable ⟺ indexed). Shows per-field cost (always-paid vs pay-on-use). *(Amended 2026-09-23, ADR-0013: now "Fast filters". Every field is filterable, and this step picks which filters get an index so they prune.)*
- **Text search** — a **flat checklist**, one row per (field × operator), each toggled with `space` exactly like the filter list. This replaced an earlier focused-card + `e`/`c` letter-key design that tested as unintuitive. Rows carry a plain description and the live extra-index cost; the **`contains` row turns red with a "bigger than the data" warning** when its trigram index would exceed the field's own column (ADR-0003 §7). `endsWith`/`contains` are off by default and each unlocks its operator in the generated types (T5).
- **File size** — a `↑/↓` list of byte targets, each showing its resulting file count; default from ADR-0002 §5's `clamp(max(2MB, p95), 512KB, 8MB)`.
- **Review** — leads with a plain-language summary + any warnings; the config file to be written is **collapsed by default** (expand/preview on demand), so the summary is the focus, not a wall of JSON.

### 3. Live consequences, in plain language
The three estimate axes are surfaced as **Data files** / **First download** (the always-loaded manifest, against its ~1 MB comfort budget) / **Download per query** (bytes + request count for a representative equality and range query), plus an **Extra search indexes** total that reacts as operators toggle. Copy is deliberately jargon-free (no "zonemap", "postings", "request amplification" on screen). Skew / oversized-record / low-cardinality-sort warnings (ADR-0002 §5/§6) surface inline on the relevant step.

### 4. TUI implementation — dep-light, no React (refines ADR-0005)
Ink (React for the terminal) produced the best look and is retained as the **validated UX reference**, but the shipping `static-shard-cli` **will not take the React dependency**: Ink drags in `react` + `react-reconciler` + `yoga-layout`, a footprint at odds with the project's minimalism even as a build-time devDependency. The CLI implements the wizard **hand-rolled (zero runtime deps, per the `tui.ts` approach) or with one tiny prompt library.** The only capability given up is Ink's flexbox side-*panel*; live estimates render **inline** (above the controls) instead — the frame is re-rendered on each keystroke. The runtime `static-shard` package is unaffected: **zero-dep, no WASM** stands (ADR-0005).

### 5. Field scale — scrollable list + small recommended default
A real dataset surfaces far more than a demo's worth of fields (the Scryfall record: 63 top-level keys → ~91 scalar-leaf paths once nested objects expand, plus multi-valued arrays — T1 indexes per scalar-leaf path). Therefore the **filter-fields and text-search steps must present a scrollable / type-to-filter list**, and `init` must **recommend a *small* default indexed set (opt-in), not opt-out-of-everything** — indexing ~90 fields by default would blow the manifest and build. The auto-heuristic seeds the default and candidate ordering; the persisted config is the declared source of truth.

## Consequences

- **The post-map build session** implements the wizard against this ADR: the six-stage flow, the interaction model, the plain-language estimate axes wired to `estimator.ts`, the flat operator checklist with the live `contains` warning, and the collapsed review — all in a **dep-light** renderer.
- **T6 / ADR-0005 (#9)** gains a constraint: the CLI's TUI is dep-light (no React/Ink); this is the concrete realization of ADR-0005's "heavy inference is CLI-side, runtime stays zero-dep."
- **T5 / ADR-0004 (#8)**: operator toggles set the per-field `operators` config that drives the generated types — unchanged, now with a validated UX for producing it.
- The prototype's `estimator.ts` (pure, faithful to ADR-0003 §11) is the reusable core the build lifts for the wizard's live estimates and the `build`-time exact re-report.
- Out of scope here (deferred to the build): exact terminal-rendering library choice if a tiny lib is preferred over hand-rolled ANSI; accessibility/no-TTY fallback for `init` (pairs with `init --yes`, ADR-0005).

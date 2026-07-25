import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHUNK_STEPS,
  applyKey,
  buildWizardData,
  createInitialState,
  deriveWizardChoices,
  estimateForState,
  renderFrame,
  type WizardState,
} from "../src/wizard.js";
import { init } from "../src/init.js";

const PRODUCTS = [
  { id: "p1", category: "electronics", price: 100, name: "Widget", description: "a fine widget for widgets" },
  { id: "p2", category: "electronics", price: 200, name: "Gadget", description: "a gadget that gadgets" },
  { id: "p3", category: "books", price: 15, name: "Novel", description: "a novel about novels" },
  { id: "p4", category: "books", price: 20, name: "Textbook", description: "a textbook for textbooks" },
  { id: "p5", category: "toys", price: 30, name: "Blocks", description: "blocks that stack" },
];

describe("buildWizardData", () => {
  test("infers fields, sort candidates, and recommendations via the same inferSchema init uses", () => {
    const data = buildWizardData(PRODUCTS);
    expect(data.recordCount).toBe(5);
    expect(data.fields.map((f) => f.name).sort()).toEqual(
      ["category", "description", "id", "name", "price"].sort(),
    );
    // alphabetical ordering
    expect(data.fields.map((f) => f.name)).toEqual(["category", "description", "id", "name", "price"]);
    expect(data.sortCandidates).toEqual(["price"]); // only always-present, single-valued number/date field
    expect(data.recommendedSortField).toBe("price");
    expect(data.recommendedPk).toBe("id");
  });

  test("throws on an empty record set", () => {
    expect(() => buildWizardData([])).toThrow(/no records/i);
  });
});

describe("createInitialState", () => {
  test("defaults to the recommended sort field, recommended indexed set, and a chunk-step-snapped shard size", () => {
    const data = buildWizardData(PRODUCTS);
    const state = createInitialState(data);
    expect(state.stage).toBe(0);
    expect(state.sortField).toBe(data.recommendedSortField);
    expect([...state.indexedFields].sort()).toEqual([...data.recommendedIndexed].sort());
    expect(CHUNK_STEPS).toContain(state.shardBytes);
    expect(state.endsWithFields.size).toBe(0);
    expect(state.containsFields.size).toBe(0);
  });
});

describe("applyKey — stage navigation", () => {
  test("left/right move between stages and clamp at the ends", () => {
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    state = applyKey(data, state, { type: "left" }); // already at 0
    expect(state.stage).toBe(0);
    for (let i = 0; i < 10; i++) state = applyKey(data, state, { type: "right" });
    expect(state.stage).toBe(5); // clamped at the last stage
    for (let i = 0; i < 10; i++) state = applyKey(data, state, { type: "left" });
    expect(state.stage).toBe(0);
  });

  test("enter advances the detect screen", () => {
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    state = applyKey(data, state, { type: "enter" });
    expect(state.stage).toBe(1);
  });

  test("cancel sets quit regardless of stage", () => {
    const data = buildWizardData(PRODUCTS);
    const state = createInitialState(data);
    expect(applyKey(data, state, { type: "cancel" }).quit).toBe(true);
  });
});

describe("applyKey — sort field step", () => {
  function toStage1(data: ReturnType<typeof buildWizardData>) {
    return applyKey(data, createInitialState(data), { type: "right" });
  }

  test("space selects the field under the cursor and clears it from indexed/endsWith/contains", () => {
    const withRank = PRODUCTS.map((p, i) => ({ ...p, rank: i + 1 }));
    const data = buildWizardData(withRank);
    expect(data.sortCandidates.sort()).toEqual(["price", "rank"]);
    let state = toStage1(data);
    // pre-seed "rank" into the indexed set to prove picking it as sort field clears it back out
    state = { ...state, indexedFields: new Set([...state.indexedFields, "rank"]) };
    const idx = data.sortCandidates.indexOf("rank");
    for (let i = 0; i < idx; i++) state = applyKey(data, state, { type: "down" });
    state = applyKey(data, state, { type: "space" });
    expect(state.sortField).toBe("rank");
    expect(state.indexedFields.has("rank")).toBe(false);
  });

  test("typing narrows the candidate list (type-to-filter, ADR-0006 §5)", () => {
    const withRank = PRODUCTS.map((p, i) => ({ ...p, rank: i + 1 }));
    const data = buildWizardData(withRank);
    let state = toStage1(data);
    state = applyKey(data, state, { type: "char", value: "r" });
    state = applyKey(data, state, { type: "char", value: "a" });
    expect(state.filterQuery).toBe("ra");
    state = applyKey(data, state, { type: "space" }); // only "rank" matches "ra"
    expect(state.sortField).toBe("rank");
    state = applyKey(data, state, { type: "backspace" });
    expect(state.filterQuery).toBe("r");
  });
});

describe("applyKey — filter fields step", () => {
  function toStage2(data: ReturnType<typeof buildWizardData>) {
    let state = createInitialState(data);
    state = applyKey(data, state, { type: "right" });
    state = applyKey(data, state, { type: "right" });
    return state;
  }

  test("space toggles a field's indexed membership and clears endsWith/contains when turned off", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    state = { ...state, endsWithFields: new Set(["category"]), containsFields: new Set(["category"]) };
    const idx = data.fields.filter((f) => f.name !== state.sortField).findIndex((f) => f.name === "category");
    for (let i = 0; i < idx; i++) state = applyKey(data, state, { type: "down" });

    if (!state.indexedFields.has("category")) state = applyKey(data, state, { type: "space" }); // ensure on first
    expect(state.indexedFields.has("category")).toBe(true);
    state = applyKey(data, state, { type: "space" }); // toggle off
    expect(state.indexedFields.has("category")).toBe(false);
    expect(state.endsWithFields.has("category")).toBe(false);
    expect(state.containsFields.has("category")).toBe(false);
  });

  test("the sort field itself never appears in the filterable list", () => {
    const data = buildWizardData(PRODUCTS);
    const state = toStage2(data);
    // walking every candidate and toggling must never be able to select the sort field
    for (let i = 0; i < 20; i++) {
      const s = applyKey(data, { ...state, cursor: i }, { type: "space" });
      expect(s.indexedFields.has(state.sortField)).toBe(false);
    }
  });

  test("select-all indexes every currently-visible candidate, leaving already-indexed fields' endsWith/contains untouched", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    state = { ...state, indexedFields: new Set(["category"]), containsFields: new Set(["category"]) };
    state = applyKey(data, state, { type: "select-all" });
    const visible = data.fields.filter((f) => f.name !== state.sortField).map((f) => f.name);
    for (const name of visible) expect(state.indexedFields.has(name)).toBe(true);
    expect(state.containsFields.has("category")).toBe(true); // untouched, not cleared by select-all
  });

  test("select-all only affects fields matching the active type-to-filter query", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    state = applyKey(data, state, { type: "char", value: "o" }); // "category", "novel"-ish... narrow to matches
    state = applyKey(data, state, { type: "select-all" });
    const matching = data.fields.filter((f) => f.name !== state.sortField && f.name.includes("o")).map((f) => f.name);
    const nonMatching = data.fields.filter((f) => f.name !== state.sortField && !f.name.includes("o")).map((f) => f.name);
    expect(matching.length).toBeGreaterThan(0);
    for (const name of matching) expect(state.indexedFields.has(name)).toBe(true);
    for (const name of nonMatching) expect(state.indexedFields.has(name)).toBe(false);
  });

  test("invert flips every currently-visible candidate's indexed membership, clearing endsWith/contains for any turned off", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    const visible = data.fields.filter((f) => f.name !== state.sortField).map((f) => f.name);
    const before = new Set(state.indexedFields);
    state = { ...state, endsWithFields: new Set(before.has("category") ? ["category"] : []) };
    state = applyKey(data, state, { type: "invert" });
    for (const name of visible) expect(state.indexedFields.has(name)).toBe(!before.has(name));
    if (before.has("category")) expect(state.endsWithFields.has("category")).toBe(false);

    // inverting twice returns to the original selection
    state = applyKey(data, state, { type: "invert" });
    expect([...state.indexedFields].sort()).toEqual([...before].sort());
  });

  test("the list fills the reported terminal height instead of a fixed page size", () => {
    const wideRecord: Record<string, unknown> = { price: 1 };
    for (let i = 0; i < 40; i++) wideRecord[`field${i}`] = i;
    const data = buildWizardData([wideRecord, { ...wideRecord, price: 2 }, { ...wideRecord, price: 3 }]);
    const state = toStage2(data);
    const estimate = estimateForState(data, state);

    const checklistRowCount = (terminalRows: number) => {
      const rendered = renderFrame(data, state, estimate, undefined, terminalRows);
      return rendered.split("\n").filter((l) => l.includes("[x]") || l.includes("[ ]")).length;
    };

    const shortScreen = checklistRowCount(20);
    const tallScreen = checklistRowCount(60);
    expect(tallScreen).toBeGreaterThan(shortScreen);
    expect(shortScreen).toBeGreaterThanOrEqual(3); // never below the MIN_VISIBLE_ROWS floor
    expect(tallScreen).toBeLessThan(41); // still windowed, not the whole 41-candidate list at once

    // omitting terminalRows falls back to DEFAULT_TERMINAL_ROWS (24) rather than an unbounded list.
    const rendered = renderFrame(data, state, estimate);
    const defaultScreen = rendered.split("\n").filter((l) => l.includes("[x]") || l.includes("[ ]")).length;
    expect(defaultScreen).toBe(checklistRowCount(24));
  });
});

describe("applyKey — text search step", () => {
  function toStage3WithIndexedStrings(data: ReturnType<typeof buildWizardData>): WizardState {
    let state = createInitialState(data);
    state = { ...state, indexedFields: new Set(["category", "name", "description"]) };
    state = applyKey(data, state, { type: "right" });
    state = applyKey(data, state, { type: "right" });
    state = applyKey(data, state, { type: "right" });
    return state;
  }

  test("rows are only string, indexed, non-sort, non-multi fields, one row per operator", () => {
    const data = buildWizardData(PRODUCTS);
    const state = toStage3WithIndexedStrings(data);
    const rendered = renderFrame(data, state, estimateForState(data, state));
    expect(rendered).toContain("category");
    expect(rendered).toContain("ends with");
    expect(rendered).toContain("contains");
    expect(rendered).not.toContain("price"); // sort field excluded
  });

  test("space toggles the operator for the row under the cursor", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage3WithIndexedStrings(data);
    state = applyKey(data, state, { type: "space" }); // first row = (first eligible field, endsWith)
    const firstEligible = data.fields
      .filter((f) => f.name !== state.sortField && state.indexedFields.has(f.name) && f.kind === "string" && !f.multi)
      .sort((a, b) => (a.name < b.name ? -1 : 1))[0]!.name;
    expect(state.endsWithFields.has(firstEligible)).toBe(true);
  });

  test("a `contains` index estimated bigger than its own column surfaces as a warning and renders red", () => {
    // "description" is long free text with high per-value entropy relative to a tiny 5-record sample —
    // its trigram index is expected to dwarf the raw column at this scale.
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    state = { ...state, indexedFields: new Set(["description"]), containsFields: new Set(["description"]) };
    const estimate = estimateForState(data, state);
    expect(estimate.costs.indexes.description?.containsExceedsColumn).toBe(true);
    expect(estimate.warnings.some((w) => w.includes("description"))).toBe(true);

    const rendered = renderFrame(data, { ...state, stage: 3 }, estimate);
    expect(rendered).toContain("\x1b[31m"); // red ANSI escape somewhere in the frame
    expect(rendered).toContain("bigger than the data");
  });
});

describe("applyKey — file size step", () => {
  test("up/down move through CHUNK_STEPS and set shardBytes to match", () => {
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    for (let i = 0; i < 4; i++) state = applyKey(data, state, { type: "right" });
    expect(state.stage).toBe(4);
    const startCursor = state.cursor;
    state = applyKey(data, state, { type: "down" });
    expect(state.cursor).toBe(Math.min(CHUNK_STEPS.length - 1, startCursor + 1));
    expect(state.shardBytes).toBe(CHUNK_STEPS[state.cursor]);
    state = applyKey(data, state, { type: "up" });
    expect(state.shardBytes).toBe(CHUNK_STEPS[state.cursor]);
  });
});

describe("applyKey — review step", () => {
  function toReview(data: ReturnType<typeof buildWizardData>): WizardState {
    let state = createInitialState(data);
    for (let i = 0; i < 5; i++) state = applyKey(data, state, { type: "right" });
    return state;
  }

  test("space toggles the collapsed JSON preview", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toReview(data);
    expect(state.reviewJsonExpanded).toBe(false);
    state = applyKey(data, state, { type: "space" });
    expect(state.reviewJsonExpanded).toBe(true);
  });

  test("enter marks the state persisted (the wizard's one write trigger)", () => {
    const data = buildWizardData(PRODUCTS);
    const state = applyKey(data, toReview(data), { type: "enter" });
    expect(state.persisted).toBe(true);
  });
});

describe("flag-equivalence (ADR-0006 §1 / T12 acceptance)", () => {
  let tmpDir: string;

  test("wizard-derived choices produce a config identical to init --yes + the equivalent flags", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "static-shard-wizard-"));
    try {
      writeFileSync(path.join(tmpDir, "products.ndjson"), PRODUCTS.map((p) => JSON.stringify(p)).join("\n") + "\n");

      const data = buildWizardData(PRODUCTS);
      let state = createInitialState(data);
      // drive a handful of real interactions: change the indexed set, opt a field into contains,
      // and shrink the shard size — then land on review and persist.
      state = applyKey(data, state, { type: "right" }); // -> stage 1 (sort field), keep the recommendation
      state = applyKey(data, state, { type: "right" }); // -> stage 2 (filter fields)
      const nameIdx = data.fields.filter((f) => f.name !== state.sortField).findIndex((f) => f.name === "name");
      for (let i = 0; i < nameIdx; i++) state = applyKey(data, state, { type: "down" });
      state = applyKey(data, state, { type: "space" }); // index "name"
      state = applyKey(data, state, { type: "right" }); // -> stage 3 (text search)
      state = applyKey(data, state, { type: "space" }); // toggle the first row's operator on
      state = applyKey(data, state, { type: "right" }); // -> stage 4 (file size)
      state = applyKey(data, state, { type: "down" }); // bump shard size up one step
      state = applyKey(data, state, { type: "right" }); // -> stage 5 (review)
      state = applyKey(data, state, { type: "enter" }); // persist
      expect(state.persisted).toBe(true);

      const choices = deriveWizardChoices(state);

      const wizardConfigPath = path.join(tmpDir, "wizard.config.json");
      const { config: viaWizard } = init({
        cwd: tmpDir,
        configPath: wizardConfigPath,
        yes: true,
        reinfer: true,
        fullScan: true,
        inputPath: "products.ndjson",
        sortField: choices.sortField,
        indexedFields: choices.indexedFields,
        endsWithFields: choices.endsWithFields,
        containsFields: choices.containsFields,
        shardBytes: choices.shardBytes,
      });

      const flagsConfigPath = path.join(tmpDir, "flags.config.json");
      const { config: viaFlags } = init({
        cwd: tmpDir,
        configPath: flagsConfigPath,
        yes: true,
        fullScan: true,
        inputPath: "products.ndjson",
        sortField: choices.sortField,
        indexedFields: choices.indexedFields,
        endsWithFields: choices.endsWithFields,
        containsFields: choices.containsFields,
        shardBytes: choices.shardBytes,
      });

      expect(viaWizard).toEqual(viaFlags);
      expect(existsSync(wizardConfigPath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

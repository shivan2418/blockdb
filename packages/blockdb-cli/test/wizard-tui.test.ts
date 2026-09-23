import { describe, expect, test } from "vitest";
import { ensureInteractiveTTY, runInteractiveInit } from "../src/wizard-tui.js";

describe("ensureInteractiveTTY (ADR-0006 §4 no-TTY fallback)", () => {
  test("throws a clear, --yes-pointing error when stdin isn't a TTY", () => {
    expect(() => ensureInteractiveTTY({ isTTY: false })).toThrow(/--yes/);
    expect(() => ensureInteractiveTTY({ isTTY: undefined })).toThrow(/--yes/);
  });

  test("does not throw when stdin is a TTY", () => {
    expect(() => ensureInteractiveTTY({ isTTY: true })).not.toThrow();
  });
});

describe("runInteractiveInit", () => {
  test("fails loud synchronously on a non-TTY stdin instead of hanging on keypresses", () => {
    expect(() =>
      runInteractiveInit({
        cwd: "/tmp",
        configPath: "/tmp/blockdb.config.json",
        inputPath: "products.ndjson",
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
      }),
    ).toThrow(/--yes/);
  });
});

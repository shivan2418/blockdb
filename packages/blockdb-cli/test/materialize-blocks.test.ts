import { describe, expect, test } from "vitest";
import { materializeBlocks } from "../src/block.js";

describe("materializeBlocks", () => {
  test("serializes each group to newline-terminated NDJSON with a content hash", () => {
    const groups = [
      [{ year: 2000, title: "A" }],
      [
        { year: 2001, title: "B" },
        { year: 2001, title: "C" },
      ],
    ];
    const files = materializeBlocks(groups);
    expect(files).toHaveLength(2);
    expect(files[0]!.content).toBe('{"year":2000,"title":"A"}\n');
    expect(files[0]!.count).toBe(1);
    expect(files[1]!.count).toBe(2);
    expect(files[1]!.content).toBe('{"year":2001,"title":"B"}\n{"year":2001,"title":"C"}\n');
    for (const file of files) {
      expect(file.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
    }
  });

  test("identical block content produces identical hashes (dedup/determinism)", () => {
    const groups = [[{ a: 1 }], [{ a: 1 }]];
    const files = materializeBlocks(groups);
    expect(files[0]!.hash).toBe(files[1]!.hash);
  });
});

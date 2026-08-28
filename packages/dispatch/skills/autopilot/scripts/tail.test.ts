import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCursor, readRange, splitCompleteLines } from "./tail";

describe("splitCompleteLines", () => {
  test("returns complete lines", () => {
    expect(splitCompleteLines("one\ntwo\n")).toEqual({
      complete: ["one", "two"],
      partial: "",
    });
  });

  test("holds a trailing partial line", () => {
    expect(splitCompleteLines("one\ntwo")).toEqual({
      complete: ["one"],
      partial: "two",
    });
  });

  test("handles empty input", () => {
    expect(splitCompleteLines("")).toEqual({ complete: [], partial: "" });
  });

  test("handles a single partial line", () => {
    expect(splitCompleteLines("one")).toEqual({
      complete: [],
      partial: "one",
    });
  });

  test("preserves empty complete lines", () => {
    expect(splitCompleteLines("\n\npartial")).toEqual({
      complete: ["", ""],
      partial: "partial",
    });
  });

  test("keeps carriage returns for the parser to trim", () => {
    expect(splitCompleteLines("one\r\ntwo\r\n")).toEqual({
      complete: ["one\r", "two\r"],
      partial: "",
    });
  });
});

describe("nextCursor", () => {
  test("advances from the previous cursor", () => {
    expect(nextCursor(4, 9)).toEqual({ from: 4, reset: false });
  });

  test("resets after truncation", () => {
    expect(nextCursor(9, 4)).toEqual({ from: 0, reset: true });
  });

  test("does not reset when the file is unchanged", () => {
    expect(nextCursor(9, 9)).toEqual({ from: 9, reset: false });
  });
});

describe("readRange", () => {
  function withTempFile(content: string, run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "readrange-"));
    const path = join(dir, "log.txt");
    writeFileSync(path, content);
    try {
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("reads a byte range from the middle of a file", () => {
    withTempFile("0123456789", (path) => {
      const bytes = readRange(path, 3, 7);
      expect(Buffer.from(bytes).toString()).toBe("3456");
    });
  });

  test("reads from zero to the full size", () => {
    withTempFile("hello", (path) => {
      const bytes = readRange(path, 0, 5);
      expect(Buffer.from(bytes).toString()).toBe("hello");
    });
  });

  test("returns fewer bytes than asked when the file is shorter than requested", () => {
    withTempFile("abc", (path) => {
      const bytes = readRange(path, 0, 100);
      expect(Buffer.from(bytes).toString()).toBe("abc");
    });
  });

  test("returns an empty range when from equals size", () => {
    withTempFile("abc", (path) => {
      const bytes = readRange(path, 3, 3);
      expect(bytes.length).toBe(0);
    });
  });
});

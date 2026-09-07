import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextCursor,
  readRangeChunks,
  splitCompleteLines,
  tailFileChunks,
} from "./tail";

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

describe("readRangeChunks", () => {
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

  function readAll(path: string, from: number, size: number, chunk?: number) {
    const parts = [...readRangeChunks(path, from, size, chunk)];
    return {
      text: Buffer.concat(parts.map((p) => Buffer.from(p))).toString(),
      lengths: parts.map((p) => p.length),
    };
  }

  test("reads a byte range from the middle of a file", () => {
    withTempFile("0123456789", (path) => {
      expect(readAll(path, 3, 7).text).toBe("3456");
    });
  });

  test("reads from zero to the full size", () => {
    withTempFile("hello", (path) => {
      expect(readAll(path, 0, 5).text).toBe("hello");
    });
  });

  test("returns fewer bytes than asked when the file is shorter than requested", () => {
    withTempFile("abc", (path) => {
      expect(readAll(path, 0, 100).text).toBe("abc");
    });
  });

  test("returns an empty range when from equals size", () => {
    withTempFile("abc", (path) => {
      expect(readAll(path, 3, 3).lengths).toEqual([]);
    });
  });

  // The point of the rewrite: no allocation scales with the range. Asserting
  // only on reassembled content would pass on the old whole-file read too.
  test("每個 chunk 都不超過上限，且會切成多塊", () => {
    withTempFile("0123456789abcdefghij", (path) => {
      const { text, lengths } = readAll(path, 0, 20, 6);
      expect(text).toBe("0123456789abcdefghij");
      expect(lengths).toEqual([6, 6, 6, 2]);
    });
  });

  // All three callers decode immediately and would not notice a reused buffer;
  // a fourth that batched chunks would, only on multi-chunk files.
  test("chunk 之間不共用 buffer", () => {
    withTempFile("aaaabbbbcccc", (path) => {
      const held = [...readRangeChunks(path, 0, 12, 4)].map((c) =>
        Buffer.from(c.buffer, c.byteOffset, c.length),
      );
      expect(held.map((b) => b.toString())).toEqual(["aaaa", "bbbb", "cccc"]);
    });
  });
});

describe("tailFileChunks", () => {
  function freshState() {
    return {
      cursor: 0,
      partial: "",
      decoder: new TextDecoder(),
      seen: [] as string[],
    };
  }

  function withTempFile(content: string, run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "tailchunks-"));
    const path = join(dir, "log.jsonl");
    writeFileSync(path, content);
    try {
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("delivers every complete line and lands the cursor on size", () => {
    withTempFile("a\nb\nc\n", (path) => {
      const state = freshState();
      tailFileChunks(
        path,
        state,
        6,
        () => {},
        (s, line) => s.seen.push(line),
        2,
      );
      expect(state.seen).toEqual(["a", "b", "c"]);
      expect(state.cursor).toBe(6);
      expect(state.partial).toBe("");
    });
  });

  // Invariant 1. Both call sites used to hand-roll the pull-before-reset order,
  // and getting it wrong is invisible: the state is cleared and then never
  // refilled, so the agent silently reports zero.
  test("一個開不起來的檔案不會觸發 reset", () => {
    const state = freshState();
    // size < cursor is what makes nextCursor report a reset; with it the other
    // way round this test passes no matter where onReset sits.
    state.cursor = 999;
    state.partial = "kept";
    let resetCalls = 0;

    expect(() =>
      tailFileChunks(
        join(tmpdir(), "definitely-not-here-9f3a.jsonl"),
        state,
        10,
        () => {
          resetCalls += 1;
        },
        (s, line) => s.seen.push(line),
      ),
    ).toThrow();

    expect(resetCalls).toBe(0);
    expect(state.partial).toBe("kept"); // nothing cleared
    expect(state.cursor).toBe(999);
  });

  // Invariant 2. Lines are handed over per chunk, so the cursor has to move per
  // chunk too — leaving it until the loop ends re-ingests them after a failure.
  test("cursor 逐塊推進，不是最後才跳到 size", () => {
    withTempFile("aa\nbb\ncc\ndd\n", (path) => {
      const state = freshState();
      const cursorAtLine: number[] = [];
      tailFileChunks(
        path,
        state,
        12,
        () => {},
        (s, line) => {
          s.seen.push(line);
          cursorAtLine.push(s.cursor);
        },
        3,
      );
      expect(state.seen).toEqual(["aa", "bb", "cc", "dd"]);
      // Strictly increasing and never the final size until the last line.
      expect(cursorAtLine).toEqual([3, 6, 9, 12]);
    });
  });

  test("reset 清掉 partial 並在 onReset 之前 flush decoder", () => {
    withTempFile("x\n", (path) => {
      const state = freshState();
      state.cursor = 500; // larger than size → nextCursor reports a reset
      state.partial = "stale";
      let sawPartial = "unset";
      tailFileChunks(
        path,
        state,
        2,
        (s) => {
          sawPartial = s.partial;
        },
        (s, line) => s.seen.push(line),
      );
      expect(sawPartial).toBe(""); // cleared before the caller's own reset runs
      expect(state.seen).toEqual(["x"]);
      expect(state.cursor).toBe(2);
    });
  });
});

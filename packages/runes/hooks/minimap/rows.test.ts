import { expect, test } from "claude-code/testing";

import { lines, rowsOf, stem } from "./rows";

const jsonl = (...entries: object[]) =>
  entries.map((e) => JSON.stringify(e)).join("\n");

test("rowsOf keeps prompts, reply text and tool calls, in order, and skips the rest", () => {
  const text = jsonl(
    { type: "user", uuid: "u1", message: { content: "hello" } },
    { type: "user", uuid: "m1", isMeta: true, message: { content: "meta" } },
    {
      type: "user",
      uuid: "c1",
      message: { content: "<command-name>/x</command-name>" },
    },
    {
      type: "user",
      uuid: "s1",
      isSidechain: true,
      message: { content: "sub" },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "sure" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
          { type: "tool_use", id: "toolu_2", name: "Grep", input: {} },
        ],
      },
    },
    {
      type: "user",
      uuid: "r1",
      message: { content: [{ type: "tool_result" }] },
    },
  );
  expect(rowsOf(text)).toEqual([
    { id: "u1", kind: "prompt", size: 5 },
    { id: "a1", kind: "reply", size: 4 },
    { id: "toolu_1", kind: "bash", size: 16 },
    { id: "toolu_2", kind: "tool", size: 2 },
  ]);
});

test("rowsOf skips a line that does not parse", () => {
  expect(
    rowsOf(
      `{oops\n${jsonl({ type: "user", uuid: "u1", message: { content: "x" } })}`,
    ),
  ).toHaveLength(1);
});

test("stem drops the last uuid group, which an assistant row's requestId zeroes", () => {
  expect(stem("0ff20add-2cc5-423b-b80d-000000000000")).toBe(
    stem("0ff20add-2cc5-423b-b80d-35365556d3f9"),
  );
});

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    kind: i % 2 ? "reply" : "prompt",
    size: 10 + i,
  }));

test("lines fits the whole session into the pane's rows, every line exactly bar cells wide", () => {
  const out = lines(rows(50), new Set(), 12, 20);
  expect(out.length).toBeLessThanOrEqual(12);
  for (const line of out)
    expect(line.segments.reduce((n, s) => n + s.cells, 0)).toBe(20);
});

test("a line points at its first prompt and is here when any of its rows is on screen", () => {
  const out = lines(rows(4), new Set([stem("id-3")]), 2, 10);
  expect(out.map((l) => l.target)).toEqual(["id-0", "id-2"]);
  expect(out.map((l) => l.isHere)).toEqual([false, true]);
});

test("a bucket with more rows than cells keeps only what fits", () => {
  const [line] = lines(rows(30), new Set(), 1, 8);
  expect(line!.segments.reduce((n, s) => n + s.cells, 0)).toBe(8);
});

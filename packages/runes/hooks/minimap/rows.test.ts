import { expect, test } from "claude-code/testing";

import { COLOR } from "./minimap";
import { TOOL_KIND, kindAt, lines, rowsOfBytes, stem } from "./rows";

const jsonl = (...entries: object[]) =>
  entries.map((e) => JSON.stringify(e)).join("\n");

const rowsOf = async (text: string) =>
  (
    await rowsOfBytes(
      (async function* () {
        yield new TextEncoder().encode(`${text}\n`);
      })(),
    )
  ).rows;

test("rowsOf keeps prompts, reply text and tool calls, in order, and skips the rest", async () => {
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
  expect(await rowsOf(text)).toEqual([
    { id: "u1", kind: "prompt", size: 5 },
    { id: "a1", kind: "reply", size: 4 },
    { id: "toolu_1", kind: "bash", size: 16 },
    { id: "toolu_2", kind: "tool", size: 2 },
  ]);
});

test("rowsOf skips a line that does not parse", async () => {
  expect(
    await rowsOf(
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

test("kindAt reads a line's segments as one strip, top to bottom when the map lies sideways", () => {
  const line = {
    target: "a",
    isHere: false,
    segments: [
      { kind: "prompt", cells: 2 },
      { kind: "bash", cells: 1 },
    ],
  };
  expect([0, 1, 2].map((i) => kindAt(line, i))).toEqual([
    "prompt",
    "prompt",
    "bash",
  ]);
  expect(kindAt(line, 3)).toBeUndefined();
});

const cut = (bytes: Uint8Array, size: number) =>
  (async function* () {
    for (let at = 0; at < bytes.length; at += size)
      yield bytes.slice(at, at + size);
  })();

test("rowsOfBytes gives the same rows however the bytes are cut, and counts the bytes it read", async () => {
  const text = `${jsonl(
    { type: "user", uuid: "u1", message: { content: "你好，世界" } },
    {
      type: "assistant",
      uuid: "a1",
      message: { content: [{ type: "text", text: "哈囉" }] },
    },
    { type: "user", uuid: "u2", message: { content: "last" } },
  )}\n`;
  const bytes = new TextEncoder().encode(text);
  for (const size of [1, 2, 7, bytes.length])
    expect(await rowsOfBytes(cut(bytes, size))).toEqual({
      rows: [
        { id: "u1", kind: "prompt", size: 5 },
        { id: "a1", kind: "reply", size: 2 },
        { id: "u2", kind: "prompt", size: 4 },
      ],
      bytes: bytes.length,
    });
});

// the writer may be mid-line; the next read starts at that line
test("rowsOfBytes holds back a line with no newline yet", async () => {
  const done = `${jsonl({ type: "user", uuid: "u1", message: { content: "a" } })}\n`;
  const text = `${done}{"type":"user","uuid":"u2","mess`;
  const read = await rowsOfBytes(cut(new TextEncoder().encode(text), 5));
  expect(read.rows.map((r) => r.id)).toEqual(["u1"]);
  expect(read.bytes).toBe(new TextEncoder().encode(done).length);
});

test("every kind a row can take has a bubble colour", () => {
  for (const kind of ["prompt", "reply", ...Object.values(TOOL_KIND)])
    expect(Object.keys(COLOR)).toContain(kind);
});

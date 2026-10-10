import { expect, test, type Engine } from "claude-code/testing";
import type { On, SessionMessage } from "claude-code";

import { DEFAULTS } from "../config";
import { SEARCH_ICON, runsOf } from "./fold";
import { CONFIG, eventually, find, startSession } from "./test-session";

const use = (
  tool_use_id: string,
  tool: string,
  input: Record<string, unknown> = {},
  isError?: true,
) => ({
  tool_use_id,
  tool,
  input,
  result: "ok",
  ...(isError ? { isError } : {}),
});

const said = (role: "user" | "assistant", text: string): SessionMessage => ({
  role,
  text,
  toolUses: [],
});
const called = (...toolUses: ReturnType<typeof use>[]): SessionMessage => ({
  role: "assistant",
  text: "",
  toolUses,
});
const answered = (...ids: string[]): SessionMessage =>
  ({
    role: "user",
    text: "",
    toolUses: [],
    toolResults: ids.map((tool_use_id) => ({ tool_use_id, text: "ok" })),
  }) as never;

// a run of five calls closed by Claude's reply: an Edit stays out, and so does the Bash that failed
const RUN: SessionMessage[] = [
  said("user", "tidy it"),
  called(use("b1", "Bash", { command: "ls", description: "List the files" })),
  answered("b1"),
  called(
    use("b2", "Bash", { command: "pwd" }),
    use("g1", "Grep", { pattern: "x" }),
  ),
  answered("b2", "g1"),
  called(
    use("e1", "Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }),
  ),
  answered("e1"),
  called(use("b3", "Bash", { command: "false" }, true)),
  answered("b3"),
  said("assistant", "done"),
];

const ROW = (
  id: string,
  tool: string,
  input: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolUse",
    requestId: id,
    props: {
      tool_use_id: id,
      tool,
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: { stdout: "ok", stderr: "" },
      ...more,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const RESULT = (id: string, tool: string) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolResult",
    requestId: id,
    props: { tool_use_id: id, tool, output: "ok", isErrored: false },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const start = async (
  $: Engine,
  on: On,
  messages: SessionMessage[],
  files?: Map<string, string>,
) => {
  await startSession($, on, { messages, ...(files ? { files } : {}) });
  // the runs are read after session.start, off the render path
  expect(
    await eventually(
      async () =>
        (await find($, ROW("b1", "Bash", { command: "ls" }), {
          key: "fold",
        })) !== undefined,
    ),
  ).toBe(true);
};

test("runsOf folds the finished, unkept calls between two replies and heads the run with the first", () => {
  const runs = runsOf(RUN, { keep: ["Edit", "Write"], min: 2 });
  const titles = [
    { tool: "Bash", text: "List the files" },
    { tool: "Bash", text: "Bash pwd" },
    { tool: "Grep", text: "Grep x" },
  ];
  expect(runs.get("b1")).toEqual({
    run: "b1",
    isHead: true,
    label: "3 calls · Bash 2 · Grep 1",
    titles,
  });
  expect(runs.get("b2")).toEqual({
    run: "b1",
    isHead: false,
    label: "3 calls · Bash 2 · Grep 1",
    titles,
  });
  expect(runs.get("g1")?.isHead).toBe(false);
  expect(runs.has("e1")).toBe(false);
  expect(runs.has("b3")).toBe(false);
});

test("runsOf folds the live run from its first call, and holds a closed run to min", () => {
  // no reply has closed b1, b2 and g1 yet, and they fold all the same
  expect(runsOf(RUN.slice(0, 5), { keep: [], min: 2 }).get("b1")?.label).toBe("3 calls · Bash 2 · Grep 1");
  const live = [said("user", "go"), called(use("b1", "Bash")), answered("b1")];
  expect(runsOf(live, { keep: [], min: 2 }).get("b1")?.label).toBe("1 call · Bash 1");
  // once a reply closes it, a run below min is drawn as its cards
  expect(runsOf([...live, said("assistant", "ok")], { keep: [], min: 2 }).size).toBe(0);
});

test("runsOf folds a call still running, from tool.call before the transcript holds it", () => {
  const running = { tool_use_id: "b9", tool: "Bash", input: { command: "sleep 9" } };
  const runs = runsOf(RUN.slice(0, 5), { keep: [], min: 2, pending: [running] });
  expect(runs.get("b9")).toMatchObject({ run: "b1", isHead: false, label: "4 calls · Bash 3 · Grep 1" });
  expect(runs.get("b1")?.titles.at(-1)).toEqual({ tool: "Bash", text: "Bash sleep 9", isRunning: true });
  // a pending call the transcript already holds is counted once
  const stored = [said("user", "go"), called({ tool_use_id: "b9", tool: "Bash", input: { command: "sleep 9" } } as never)];
  expect(runsOf(stored, { keep: [], min: 2, pending: [running] }).get("b9")?.label).toBe("1 call · Bash 1");
});

test("runsOf names an MCP tool by its own name, without the server prefix", () => {
  const mcp = [
    called(use("m1", "mcp__srv__ping"), use("m2", "mcp__srv__ping")),
    answered("m1", "m2"),
    said("assistant", "ok"),
  ];
  expect(runsOf(mcp, { keep: [], min: 2 }).get("m1")?.label).toBe(
    "2 calls · ping 2",
  );
});

test("the run's first row draws the summary in place of its card", async ($, on) => {
  await start($, on, RUN);
  const head = ROW("b1", "Bash", { command: "ls" });
  expect((await find($, head, { key: "fold" }))?.text.trim()).toBe(
    "▸ 3 calls · Bash 2 · Grep 1",
  );
  expect(await find($, head, { key: "bash" })).toBeUndefined();
});

test("the folded summary lists each call's title under it, and an unfolded one leaves that to the cards", async ($, on) => {
  await start($, on, RUN);
  const head = await $.ui.mount(ROW("b1", "Bash", { command: "ls" }));
  // each title leads with its tool's rune icon, a search its own
  expect((await head.find({ key: "fold:title:0" }))?.text.trim()).toBe(`${DEFAULTS.bash.icon}  List the files`);
  expect((await head.find({ key: "fold:title:2" }))?.text.trim()).toBe(`${SEARCH_ICON}  Grep x`);
  await head.press({ key: "fold" });
  expect(await head.find({ key: "fold:title:0" })).toBeUndefined();
  await head.unmount();
});

const GROUP = (ids: [string, string][]) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolGroup",
    requestId: "group",
    props: {
      calls: ids.map(([tool_use_id, tool]) => ({ tool_use_id, tool, input: {}, isRunning: false })),
      isActive: false,
      isExpanded: true,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

test("a ToolGroup holding the run's first call draws the summary, and that call's own row inside it does not", async ($, on) => {
  await start($, on, RUN);
  const group = await $.ui.mount(GROUP([["b1", "Bash"], ["b2", "Bash"], ["g1", "Grep"]]));
  expect((await group.find({ key: "fold" }))?.text.trim()).toBe("▸ 3 calls · Bash 2 · Grep 1");
  await group.press({ key: "fold" });
  const head = ROW("b1", "Bash", { command: "ls" });
  expect(await find($, head, { key: "fold" })).toBeUndefined();
  expect(await find($, head, { key: "bash" })).toBeDefined();
  await group.unmount();
});

test("the run's other rows draw nothing, ahead of the rune that would draw them", async ($, on) => {
  await start($, on, RUN);
  const member = ROW("b2", "Bash", { command: "pwd" });
  expect(await find($, member, { key: "bash" })).toBeUndefined();
  expect(await find($, member, { key: "fold" })).toBeUndefined();
  // a tool no rune draws keeps its own result row, which folds with it
  expect(
    await find($, RESULT("g1", "Grep"), { key: "fold:result" }),
  ).toBeDefined();
});

test("a kept tool and a failed call stay drawn by their own rune", async ($, on) => {
  await start($, on, RUN);
  expect(
    await find(
      $,
      ROW("b3", "Bash", { command: "false" }, { isErrored: true }),
      { key: "bash" },
    ),
  ).toBeDefined();
  expect(
    await find(
      $,
      ROW("e1", "Edit", {
        file_path: "/a.ts",
        old_string: "a",
        new_string: "b",
      }),
      { key: "fold" },
    ),
  ).toBeUndefined();
});

test("pressing the summary unfolds every row of the run, and pressing it again folds them", async ($, on) => {
  await start($, on, RUN);
  const head = await $.ui.mount(ROW("b1", "Bash", { command: "ls" }));
  await head.press({ key: "fold" });
  expect((await head.find({ key: "fold" }))?.text.trim()).toBe(
    "▾ 3 calls · Bash 2 · Grep 1",
  );
  expect(await head.find({ key: "bash" })).toBeDefined();
  expect(
    await find($, ROW("b2", "Bash", { command: "pwd" }), { key: "bash" }),
  ).toBeDefined();
  await head.press({ key: "fold" });
  expect(await head.find({ key: "bash" })).toBeUndefined();
  await head.unmount();
});

test("transcript.fold.enabled false draws every row as before", async ($, on) => {
  await startSession($, on, {
    messages: RUN,
    files: new Map([[CONFIG, "transcript:\n  fold:\n    enabled: false\n"]]),
  });
  expect(
    await find($, ROW("b2", "Bash", { command: "pwd" }), { key: "bash" }),
  ).toBeDefined();
});

test("fold.keep empty folds an Edit too", async ($, on) => {
  await start(
    $,
    on,
    RUN,
    new Map([[CONFIG, 'transcript:\n  fold:\n    keep: ""\n']]),
  );
  expect(
    (
      await find($, ROW("b1", "Bash", { command: "ls" }), { key: "fold" })
    )?.text.trim(),
  ).toBe("▸ 4 calls · Bash 2 · Grep 1 · Edit 1");
});

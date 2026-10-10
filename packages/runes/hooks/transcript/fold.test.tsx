import { expect, test, type Engine } from "claude-code/testing";
import type { On, SessionMessage } from "claude-code";

import { DEFAULTS } from "../config";
import { SEARCH_ICON, runsOf, spinner } from "./fold";
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
          key: "fold:title",
        })) !== undefined,
    ),
  ).toBe(true);
};

test("runsOf folds the finished, unkept calls between two replies, and the last one closes the run", () => {
  const runs = runsOf(RUN, { keep: ["Edit", "Write"], min: 2 });
  const shared = {
    run: "b1",
    ids: ["b1", "b2", "g1"],
    label: "3 calls · Bash 2 · Grep 1",
  };
  expect(runs.get("b1")).toEqual({
    ...shared,
    isLast: false,
    title: { tool: "Bash", text: "List the files" },
  });
  expect(runs.get("b2")?.title).toEqual({ tool: "Bash", text: "Bash pwd" });
  expect(runs.get("g1")).toEqual({
    ...shared,
    isLast: true,
    title: { tool: "Grep", text: "Grep x" },
  });
  expect(runs.has("e1")).toBe(false);
  expect(runs.has("b3")).toBe(false);
});

test("runsOf folds the live run from its first call, and holds a closed run to min", () => {
  // no reply has closed b1, b2 and g1 yet, and they fold all the same
  expect(runsOf(RUN.slice(0, 5), { keep: [], min: 2 }).get("b1")?.label).toBe(
    "3 calls · Bash 2 · Grep 1",
  );
  const live = [said("user", "go"), called(use("b1", "Bash")), answered("b1")];
  expect(runsOf(live, { keep: [], min: 2 }).get("b1")?.label).toBe(
    "1 call · Bash 1",
  );
  // once a reply closes it, a run below min is drawn as its cards
  expect(
    runsOf([...live, said("assistant", "ok")], { keep: [], min: 2 }).size,
  ).toBe(0);
});

test("runsOf folds a call still running, from tool.call before the transcript holds it", () => {
  const running = {
    tool_use_id: "b9",
    tool: "Bash",
    input: { command: "sleep 9" },
  };
  const runs = runsOf(RUN.slice(0, 5), {
    keep: [],
    min: 2,
    pending: [running],
  });
  expect(runs.get("b9")).toMatchObject({
    run: "b1",
    isLast: true,
    label: "4 calls · Bash 3 · Grep 1",
  });
  expect(runs.get("b9")?.title).toEqual({
    tool: "Bash",
    text: "Bash sleep 9",
    isRunning: true,
  });
  // a pending call the transcript already holds is counted once
  const stored = [
    said("user", "go"),
    called({
      tool_use_id: "b9",
      tool: "Bash",
      input: { command: "sleep 9" },
    } as never),
  ];
  expect(
    runsOf(stored, { keep: [], min: 2, pending: [running] }).get("b9")?.label,
  ).toBe("1 call · Bash 1");
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

const B1 = ROW("b1", "Bash", { command: "ls" });
const B2 = ROW("b2", "Bash", { command: "pwd" });
const E1 = ROW("e1", "Edit", {
  file_path: "/a.ts",
  old_string: "a",
  new_string: "b",
});

test("each folded row draws its own title in place of its card, and the run's last row draws the summary under it", async ($, on) => {
  await start($, on, RUN);
  // each title leads with its tool's rune icon, a search its own
  expect((await find($, B1, { key: "fold:title" }))?.text.trim()).toBe(
    `${DEFAULTS.bash.icon}  List the files`,
  );
  expect(await find($, B1, { key: "bash" })).toBeUndefined();
  expect(await find($, B1, { key: "fold" })).toBeUndefined();
  expect(
    (
      await find($, ROW("g1", "Grep", { pattern: "x" }), { key: "fold:title" })
    )?.text.trim(),
  ).toBe(`${SEARCH_ICON}  Grep x`);
  expect((await find($, E1, { key: "fold" }))?.text.trim()).toBe(
    "▸ 4 calls · Bash 2 · Grep 1 · Edit 1",
  );
  // a tool no rune draws keeps its own result row, which folds with it
  expect(
    await find($, RESULT("g1", "Grep"), { key: "fold:result" }),
  ).toBeDefined();
});

test("pressing a title unfolds that call alone, under its title, and pressing it again folds it", async ($, on) => {
  await start($, on, RUN);
  const row = await $.ui.mount(B2);
  await row.press({ key: "fold:open" });
  expect((await row.find({ key: "fold:title" }))?.text.trim()).toBe(
    `${DEFAULTS.bash.icon}  Bash pwd`,
  );
  expect(await row.find({ key: "bash" })).toBeDefined();
  expect(await find($, B1, { key: "bash" })).toBeUndefined();
  expect((await find($, E1, { key: "fold" }))?.text.trim()).toBe(
    "▸ 4 calls · Bash 2 · Grep 1 · Edit 1",
  );
  await row.press({ key: "fold:open" });
  expect(await row.find({ key: "bash" })).toBeUndefined();
  await row.unmount();
});

test("pressing the summary unfolds every call of the run, and pressing it again folds them", async ($, on) => {
  await start($, on, RUN);
  const last = await $.ui.mount(E1);
  await last.press({ key: "fold" });
  expect((await last.find({ key: "fold" }))?.text.trim()).toBe(
    "▾ 4 calls · Bash 2 · Grep 1 · Edit 1",
  );
  expect(await find($, B1, { key: "bash" })).toBeDefined();
  expect(await find($, B2, { key: "bash" })).toBeDefined();
  await last.press({ key: "fold" });
  expect(await find($, B1, { key: "bash" })).toBeUndefined();
  await last.unmount();
});

const GROUP = (ids: [string, string][]) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolGroup",
    requestId: "group",
    props: {
      calls: ids.map(([tool_use_id, tool]) => ({
        tool_use_id,
        tool,
        input: {},
        isRunning: false,
      })),
      isActive: false,
      isExpanded: true,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

test("a folded ToolGroup draws its calls' titles itself, and hands back to the engine once one is unfolded", async ($, on) => {
  await start($, on, RUN);
  const group = await $.ui.mount(
    GROUP([
      ["b2", "Bash"],
      ["g1", "Grep"],
    ]),
  );
  expect((await group.find({ key: "fold:title:1" }))?.text.trim()).toBe(
    `${SEARCH_ICON}  Grep x`,
  );
  // the kit has no engine beneath a group to redraw it with, so the hand-back shows in the unfolded call's own row
  await group.press({ key: "fold:open:0" }).catch(() => {});
  await group.unmount().catch(() => {});
  expect(await find($, B2, { key: "bash" })).toBeDefined();
});

test("a kept tool and a failed call stay drawn by their own rune", async ($, on) => {
  await start(
    $,
    on,
    RUN,
    new Map([[CONFIG, 'transcript:\n  fold:\n    keep: "Edit"\n']]),
  );
  expect(
    await find(
      $,
      ROW("b3", "Bash", { command: "false" }, { isErrored: true }),
      { key: "bash" },
    ),
  ).toBeDefined();
  expect(await find($, E1, { key: "fold:title" })).toBeUndefined();
});

test("transcript.fold.enabled false draws every row as before", async ($, on) => {
  await startSession($, on, {
    messages: RUN,
    files: new Map([[CONFIG, "transcript:\n  fold:\n    enabled: false\n"]]),
  });
  expect(await find($, B2, { key: "bash" })).toBeDefined();
});

test("spinner steps through its frames and wraps", () => {
  expect(spinner(0)).toBe("⠋");
  expect(spinner(1)).toBe("⠙");
  expect(spinner(10)).toBe("⠋");
});

test("a running call's title starts with a spinner after its icon", async ($, on) => {
  const running = [
    said("user", "go"),
    called({
      tool_use_id: "b1",
      tool: "Bash",
      input: { command: "sleep 9" },
    } as never),
  ];
  await start($, on, running);
  const head = ROW("b1", "Bash", { command: "sleep 9" }, { isRunning: true });
  expect((await find($, head, { key: "fold:title" }))?.text.trim()).toBe(
    `${DEFAULTS.bash.icon}  ⠋ Bash sleep 9`,
  );
});

const ask = (
  id: string,
  questions: [string, string][],
  answers: Record<string, string>,
) =>
  ({
    tool_use_id: id,
    tool: "AskUserQuestion",
    input: {
      questions: questions.map(([question, header]) => ({
        question,
        header,
        options: [],
        multiSelect: false,
      })),
    },
    result: { questions: [], answers },
  }) as never;

test("an AskUserQuestion is titled by its question, with each answer under it", () => {
  const one = [
    said("user", "go"),
    called(ask("q1", [["Which DB?", "DB"]], { "Which DB?": "Postgres" })),
    answered("q1"),
    said("assistant", "ok"),
  ];
  expect(runsOf(one, { keep: [], min: 1 }).get("q1")?.title).toEqual({
    tool: "AskUserQuestion",
    text: "Which DB?",
    answers: ["Postgres"],
  });
  // several questions are titled by their headers, and each answer names its own
  const two = [
    said("user", "go"),
    called(
      ask(
        "q2",
        [
          ["Which DB?", "DB"],
          ["Which cache?", "Cache"],
        ],
        { "Which DB?": "Postgres", "Which cache?": "Redis" },
      ),
    ),
    answered("q2"),
    said("assistant", "ok"),
  ];
  expect(runsOf(two, { keep: [], min: 1 }).get("q2")?.title).toEqual({
    tool: "AskUserQuestion",
    text: "DB · Cache",
    answers: ["DB: Postgres", "Cache: Redis"],
  });
});

test("a folded run draws an AskUserQuestion's answer under its title, two cells further in", async ($, on) => {
  const run = [
    said("user", "go"),
    called(ask("b1", [["Which DB?", "DB"]], { "Which DB?": "Postgres" })),
    answered("b1"),
    said("assistant", "ok"),
  ];
  await startSession($, on, { messages: run });
  const row = ROW("b1", "AskUserQuestion");
  expect(
    await eventually(
      async () => (await find($, row, { key: "fold:answer:0" })) !== undefined,
    ),
  ).toBe(true);
  const title = (await find($, row, { key: "fold:title" }))!.text;
  const answer = (await find($, row, { key: "fold:answer:0" }))!.text;
  expect(answer.trim()).toBe("Postgres");
  // the answer starts two cells right of where the title's text does
  expect(answer.length - answer.trimStart().length).toBe(
    title.indexOf("Which DB?") + 2,
  );
});

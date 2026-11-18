import { expect, test, type Engine } from "claude-code/testing";
import type { On, SessionMessage } from "claude-code";

import { DEFAULTS } from "../config";
import { PALETTES } from "./bubble";
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
  expect(runsOf(RUN.slice(0, 5), { keep: [], min: 2 }).get("b1")?.label).toBe(
    "3 calls · Bash 2 · Grep 1",
  );
  const live = [said("user", "go"), called(use("b1", "Bash")), answered("b1")];
  expect(runsOf(live, { keep: [], min: 2 }).get("b1")?.label).toBe(
    "1 call · Bash 1",
  );
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

test("runsOf spins only a call tool.call still holds, never a stored call merely missing its result", () => {
  const stored = [
    said("user", "go"),
    called({
      tool_use_id: "v1",
      tool: "Bash",
      input: { command: "ls" },
    } as never),
  ];
  expect(
    runsOf(stored, { keep: [], min: 1 }).get("v1")?.title.isRunning,
  ).toBeUndefined();
  const done = {
    tool_use_id: "p1",
    tool: "Poll",
    input: {},
    isDone: true as const,
  };
  expect(
    runsOf(stored, { keep: [], min: 1, pending: [done] }).get("p1")?.title
      .isRunning,
  ).toBeUndefined();
  expect(
    runsOf(stored, {
      keep: [],
      min: 1,
      pending: [{ ...done, tool_use_id: "v1" }],
    }).get("v1")?.title.isRunning,
  ).toBeUndefined();
});

test("runsOf leaves code mode's REPL and Poll out of the tally and hides Poll's title", () => {
  const coded = [
    said("user", "go"),
    called(use("r1", "REPL", { description: "Survey the files" })),
    called(
      use("v1", "Bash", { command: "ls" }),
      use("v2", "Bash", { command: "pwd" }),
    ),
    called(use("p1", "Poll")),
  ];
  const runs = runsOf(coded, { keep: [], min: 1 });
  expect(runs.get("p1")?.label).toBe("2 calls · Bash 2");
  expect(runs.get("p1")?.title.isHidden).toBe(true);
  expect(runs.get("p1")?.title.text).toBe("Waiting for the script...");
  expect(runs.get("r1")?.title.isHidden).toBeUndefined();
  expect(
    runsOf([called(use("r1", "REPL"))], { keep: [], min: 1 }).get("r1")?.label,
  ).toBe("1 call · REPL 1");
});

test("a folded Poll draws no title line", async ($, on) => {
  await startSession($, on, {
    messages: [
      said("user", "go"),
      called(use("r1", "REPL")),
      called(use("p1", "Poll")),
    ],
  });
  const repl = ROW("r1", "REPL");
  expect(
    await eventually(
      async () => (await find($, repl, { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
  expect(
    await find($, ROW("p1", "Poll"), { key: "fold:title" }),
  ).toBeUndefined();
  expect(await find($, ROW("p1", "Poll"), { key: "fold:row" })).toBeDefined();
});

test("a Poll the engine still runs draws its title with a spinner, though tool.call never saw it", async ($, on) => {
  await startSession($, on, {
    messages: [
      said("user", "go"),
      called(use("r1", "REPL")),
      called(use("p1", "Poll")),
    ],
  });
  expect(
    await eventually(
      async () =>
        (await find($, ROW("r1", "REPL"), { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
  const waiting = ROW("p1", "Poll", {}, { isRunning: true });
  expect(await find($, waiting, { key: "fold:title" })).toBeDefined();
  expect(await find($, waiting, { key: "fold:spinner" })).toBeDefined();
});

test("runsOf nests a REPL's own calls under it, and only those", () => {
  const runs = runsOf(
    [
      said("user", "go"),
      called(use("b1", "Bash", { command: "ls" })),
      called(use("r1", "REPL", { description: "Survey" })),
      called(use("repl_1", "Bash", { command: "pwd" })),
      called(use("repl_2", "Read", { file_path: "/a.ts" })),
    ],
    { keep: [], min: 1 },
  );
  expect(runs.get("repl_1")?.title.depth).toBe(1);
  expect(runs.get("repl_2")?.title.depth).toBe(1);
  expect(runs.get("r1")?.title.depth).toBeUndefined();
  expect(runs.get("b1")?.title.depth).toBeUndefined();
});

test("a nested title's icon sits two cells right of its REPL's", async ($, on) => {
  await startSession($, on, {
    messages: [
      said("user", "go"),
      called(use("r1", "REPL", { description: "Survey" })),
      called(use("repl_1", "Bash", { command: "pwd" })),
    ],
  });
  const repl = ROW("r1", "REPL", { description: "Survey" });
  expect(
    await eventually(
      async () => (await find($, repl, { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
  const outer = (await find($, repl, { key: "fold:title" }))!.text;
  const inner = (await find($, ROW("repl_1", "Bash", { command: "pwd" }), {
    key: "fold:title",
  }))!.text;
  expect(inner.indexOf(DEFAULTS.bash.icon)).toBe(outer.indexOf("\u{F0AD}") + 2);
});

test("a REPL's calls hang off it on a guide, the last one closing it", async ($, on) => {
  await startSession($, on, {
    messages: [
      said("user", "go"),
      called(use("r1", "REPL", { description: "Survey" })),
      called(use("repl_1", "Bash", { command: "pwd" })),
      called(use("repl_2", "Bash", { command: "ls" })),
      called(use("p1", "Poll")),
    ],
  });
  const first = ROW("repl_1", "Bash", { command: "pwd" });
  expect(
    await eventually(
      async () => (await find($, first, { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
  expect((await find($, first, { key: "fold:title" }))!.text).toStartWith(
    "· │ ",
  );
  expect(
    (await find($, ROW("repl_2", "Bash", { command: "ls" }), {
      key: "fold:title",
    }))!.text,
  ).toStartWith("· └ ");
});

test("a dispatched REPL spins until a Poll reports its eval, and only in the latest run", async ($, on) => {
  await startSession($, on, {
    messages: [
      said("user", "first"),
      called(use("r0", "REPL", { description: "Old" })),
      said("assistant", "done"),
      said("user", "go"),
      called(use("r1", "REPL", { description: "Survey" })),
    ],
  });
  const dispatched = (id: string, evalId: number) =>
    ROW(
      id,
      "REPL",
      { description: "x" },
      {
        output: {
          result: `(dispatched #${evalId})`,
          evalId,
          asyncDispatched: true,
        },
      },
    );
  expect(
    await eventually(
      async () =>
        (await find($, dispatched("r1", 7), { key: "fold:spinner" })) !==
        undefined,
    ),
  ).toBe(true);
  expect(
    await find($, dispatched("r0", 6), { key: "fold:spinner" }),
  ).toBeUndefined();
  await find(
    $,
    ROW(
      "p9",
      "Poll",
      {},
      {
        output: {
          content: '<event kind="repl-eval" at="t" eval="7" status="settled">',
        },
      },
    ),
    { key: "fold:title" },
  );
  expect(
    await eventually(
      async () =>
        (await find($, dispatched("r1", 7), { key: "fold:spinner" })) ===
        undefined,
    ),
  ).toBe(true);
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
  expect((await find($, B1, { key: "fold:title" }))?.text.trim()).toBe(
    `· ${DEFAULTS.bash.icon}  List the files`,
  );
  expect(await find($, B1, { key: "bash" })).toBeUndefined();
  expect(await find($, B1, { key: "fold" })).toBeUndefined();
  expect(
    (
      await find($, ROW("g1", "Grep", { pattern: "x" }), { key: "fold:title" })
    )?.text.trim(),
  ).toBe(`· ${SEARCH_ICON}  Grep x`);
  expect((await find($, E1, { key: "fold" }))?.text.trim()).toBe(
    "▸ 4 calls · Bash 2 · Grep 1 · Edit 1",
  );
  expect(
    await find($, RESULT("g1", "Grep"), { key: "fold:result" }),
  ).toBeDefined();
});

test("pressing a title unfolds that call alone, under its title, and pressing it again folds it", async ($, on) => {
  await start($, on, RUN);
  const row = await $.ui.mount(B2);
  await row.press({ key: "fold:open" });
  expect((await row.find({ key: "fold:title" }))?.text.trim()).toBe(
    `▾ ${DEFAULTS.bash.icon}  Bash pwd`,
  );
  expect(await row.find({ key: "bash" })).toBeDefined();
  const rail = (await row.find({ key: "fold:rail" })) as
    { props?: { backgroundColor?: string } } | undefined;
  expect(rail?.props?.backgroundColor).toBeDefined();
  expect(rail?.props?.backgroundColor).toBe(PALETTES.dark.surface);
  expect(await row.find({ key: "fold:opened" })).toBeUndefined();
  expect(await find($, B1, { key: "bash" })).toBeUndefined();
  expect((await find($, E1, { key: "fold" }))?.text.trim()).toBe(
    "▸ 4 calls · Bash 2 · Grep 1 · Edit 1",
  );
  await row.press({ key: "fold:open" });
  expect(await row.find({ key: "bash" })).toBeUndefined();
  expect(await row.find({ key: "fold:rail" })).toBeUndefined();
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
    `· ${SEARCH_ICON}  Grep x`,
  );
  // the kit has no engine beneath a group to redraw it with, so the hand-back shows in the unfolded call's own row
  await group.press({ key: "fold:open:0" }).catch(() => {});
  await group.unmount().catch(() => {});
  expect(await find($, B2, { key: "bash" })).toBeDefined();
});

test("a folded ToolGroup spins each call by its own state, not the group's", async ($, on) => {
  await startSession($, on, {
    messages: [
      said("user", "go"),
      called(use("r1", "REPL", { description: "Survey" })),
      called(use("p1", "Poll")),
    ],
  });
  const group = (calls: object[]) =>
    ({
      plugin: "runes",
      surface: "terminal",
      component: "ToolGroup",
      requestId: "group",
      props: { calls, isActive: true, isExpanded: true },
      viewport: { columns: 60, rows: 40 },
    }) as never;
  const repl = {
    tool_use_id: "r1",
    tool: "REPL",
    input: { description: "Survey" },
    isRunning: false,
    output: { result: "(dispatched #4)", evalId: 4, asyncDispatched: true },
  };
  const poll = { tool_use_id: "p1", tool: "Poll", input: {}, isRunning: true };
  expect(
    await eventually(
      async () =>
        (await find($, group([repl, poll]), { key: "fold:spinner:0" })) !==
        undefined,
    ),
  ).toBe(true);
  expect(
    await find($, group([repl, poll]), { key: "fold:spinner:1" }),
  ).toBeDefined();
  const done = {
    ...poll,
    isRunning: false,
    output: {
      content: '<event kind="repl-eval" at="t" eval="4" status="settled">',
    },
  };
  await find($, group([repl, done]), { key: "fold:group" });
  expect(
    await find($, group([repl, done]), { key: "fold:spinner:0" }),
  ).toBeUndefined();
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

const hang = (on: On) => on("tool.call", () => new Promise(() => {}) as never);
const inFlight = async ($: Engine, id: string, command: string) => {
  void $.tool.call({ tool: "Bash", tool_use_id: id, command } as never);
  expect(
    await eventually(
      async () =>
        (await find($, ROW(id, "Bash", { command }, { isRunning: true }), {
          key: "fold:spinner",
        })) !== undefined,
    ),
  ).toBe(true);
};

test("a running call's spinner sits left of its icon and turns on its own frame clock, with no hook event", async ($, on) => {
  const running = [
    said("user", "go"),
    called({
      tool_use_id: "b1",
      tool: "Bash",
      input: { command: "sleep 9" },
    } as never),
  ];
  hang(on);
  await start($, on, running);
  await inFlight($, "b1", "sleep 9");
  const head = ROW("b1", "Bash", { command: "sleep 9" }, { isRunning: true });
  const row = await $.ui.mount(head);
  // the Client draws its own tree, read with `in`, so its text is not the title Box's
  expect((await row.find({ key: "fold:title" }))?.text).toStartWith(
    `${DEFAULTS.bash.icon}  Bash sleep 9`,
  );
  const frame = async () =>
    (await row.find({ type: "Text", in: "fold:spinner" }))?.text;
  expect(await frame()).toBe("⠋ ");
  await row.advance(80);
  expect(await frame()).toBe("⠙ ");
  await row.advance(720);
  expect(await frame()).toBe("⠋ ");
  await row.unmount();
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
  expect(answer.length - answer.trimStart().length).toBe(
    title.indexOf("Which DB?") + 2,
  );
});

test("a title takes its tool's icon from config.yaml as read at draw time", async ($, on) => {
  await startSession($, on, {
    messages: RUN,
    files: new Map([[CONFIG, 'transcript:\n  bash:\n    icon: "Z"\n']]),
  });
  expect(
    await eventually(
      async () =>
        (await find($, B1, { key: "fold:title" }))?.text.trim() ===
        "· Z  List the files",
    ),
  ).toBe(true);
});

const RUNNING = ROW("p1", "Bash", { command: "sleep 9" }, { isRunning: true });
const TURN_END = {
  answer: "",
  durationMs: 0,
  isAborted: false,
  turnId: "t",
} as const;

const callPending = async ($: Engine, on: On) => {
  on("tool.call", () => ({ result: "ok" }) as never);
  on("turn.complete", () => ({ text: "" }) as never);
  await startSession($, on);
  await $.tool.call({
    tool: "Bash",
    tool_use_id: "p1",
    command: "sleep 9",
  } as never);
  expect(
    await eventually(
      async () => (await find($, RUNNING, { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
};

for (const reason of ["answer", "aborted", "refusal", "error"] as const)
  test(`a turn ending with ${reason} clears the calls tool.call held as pending`, async ($, on) => {
    await callPending($, on);
    await $.turn.complete({ ...TURN_END, reason } as never);
    expect(
      await eventually(
        async () =>
          (await find($, RUNNING, { key: "fold:title" })) === undefined,
      ),
    ).toBe(true);
  });

test("a call stops spinning once tool.call returns, before the turn ends", async ($, on) => {
  await callPending($, on);
  expect(
    await eventually(
      async () =>
        (await find($, ROW("p1", "Bash", { command: "sleep 9" }), {
          key: "fold:spinner",
        })) === undefined,
    ),
  ).toBe(true);
});

test("a subagent's turn ending leaves the main loop's pending calls held", async ($, on) => {
  await callPending($, on);
  await $.turn.complete({
    ...TURN_END,
    reason: "answer",
    agentId: "a",
  } as never);
  await new Promise((r) => setTimeout(r, 30));
  expect(await find($, RUNNING, { key: "fold:title" })).toBeDefined();
});

test("a running title's spinner and a folded title's dot hold the same two cells, so the icons share a column", async ($, on) => {
  const messages = [
    said("user", "go"),
    called(use("b0", "Bash", { command: "ls" })),
    answered("b0"),
    called({
      tool_use_id: "b1",
      tool: "Bash",
      input: { command: "sleep 9" },
    } as never),
  ];
  hang(on);
  await startSession($, on, { messages });
  const done = ROW("b0", "Bash", { command: "ls" });
  expect(
    await eventually(
      async () => (await find($, done, { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
  await inFlight($, "b1", "sleep 9");
  const row = await $.ui.mount(
    ROW("b1", "Bash", { command: "sleep 9" }, { isRunning: true }),
  );
  const spinner = (await row.find({ key: "fold:spinner" })) as
    { props?: { width?: number } } | undefined;
  const running = (await row.find({ key: "fold:title" }))!.text;
  await row.unmount();
  const folded = (await find($, done, { key: "fold:title" }))!.text;
  expect(spinner?.props?.width).toBe(2);
  expect(folded.indexOf(DEFAULTS.bash.icon)).toBe(2);
  expect(running.indexOf(DEFAULTS.bash.icon)).toBe(0);
});

test("a folded row is answered before any card rune builds its card", async ($, on) => {
  const messages = [
    said("user", "go"),
    called(
      use("b1", "Bash", { command: "ls" }),
      use("r1", "Read", { file_path: "/a.ts" }),
      use("e1", "Edit", { file_path: "/a.ts" }),
    ),
    answered("b1", "r1", "e1"),
    said("assistant", "ok"),
  ];
  await startSession($, on, { messages });
  const rows = [
    [ROW("b1", "Bash", { command: "ls" }), "bash"],
    [ROW("r1", "Read", { file_path: "/a.ts" }), "read"],
    [ROW("e1", "Edit", { file_path: "/a.ts" }), "edit"],
  ] as const;
  expect(
    await eventually(
      async () =>
        (await find($, rows[0][0], { key: "fold:title" })) !== undefined,
    ),
  ).toBe(true);
  for (const [row, card] of rows) {
    expect(await find($, row, { key: "fold:title" })).toBeDefined();
    expect(await find($, row, { key: card })).toBeUndefined();
  }
});

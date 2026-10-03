import { expect, test, type Engine } from "claude-code/testing";

import { CONFIG, startSession, find } from "./test-session";

const INPUT = {
  description: "Review the diff",
  prompt: "Look at the diff.\nReport bugs.",
  subagent_type: "Explore",
  model: "opus",
};

const CALL = (more: Record<string, unknown> = {}, component = "ToolUse") =>
  ({
    plugin: "runes",
    surface: "terminal",
    component,
    requestId: "a1",
    props: {
      tool_use_id: "a1",
      tool: "Agent",
      input: INPUT,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...more,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const DONE = {
  status: "completed",
  agentId: "ag1",
  content: [{ type: "text", text: "Found one bug." }],
  totalToolUseCount: 14,
  totalDurationMs: 92_000,
  totalTokens: 48_210,
  usage: {},
  toolStats: {
    readCount: 6,
    searchCount: 3,
    bashCount: 0,
    editFileCount: 2,
    linesAdded: 40,
    linesRemoved: 3,
    otherToolCount: 0,
  },
  prompt: INPUT.prompt,
};


test("a finished agent draws its task, model, run totals and tool stats", async ($, on) => {
  await startSession($, on);
  const card = CALL({ output: DONE });
  expect(await find($, card, { key: "agent" })).toBeDefined();
  expect(
    await find($, card, { type: "Text", text: /Review the diff · opus/ }),
  ).toBeDefined();
  expect(
    await find($, card, {
      type: "Text",
      text: "Explore · 14 tools · 1m 32s · 48.2k tokens",
    }),
  ).toBeDefined();
  expect(
    await find($, card, {
      type: "Text",
      text: "6 reads · 3 searches · 2 edits +40 −3",
    }),
  ).toBeDefined();
});

test("the prompt and the report fold away, each unfolding with a fold row at its end", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(CALL({ output: DONE }));
  expect((await row.find({ key: "prompt:toggle" }))?.text.trim()).toBe(
    "▸ prompt · 2 lines",
  );
  expect((await row.find({ key: "report:toggle" }))?.text.trim()).toBe(
    "▸ report · 1 line",
  );
  expect(
    await row.find({ type: "Text", text: "Found one bug." }),
  ).toBeUndefined();
  await row.press({ key: "report:toggle" });
  expect(
    await row.find({ type: "Text", text: "Found one bug." }),
  ).toBeDefined();
  expect(await row.find({ type: "Text", text: /Report bugs/ })).toBeUndefined();
  expect((await row.find({ key: "report:end:more" }))?.text.trim()).toBe(
    "▾ fold",
  );
  await row.press({ key: "report:end:more" });
  expect(
    await row.find({ type: "Text", text: "Found one bug." }),
  ).toBeUndefined();
  await row.press({ key: "prompt:toggle" });
  expect(await row.find({ type: "Text", text: "Report bugs." })).toBeDefined();
  await row.unmount();
});

test("a hand-back's report is the one drawn", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(
    CALL({
      output: {
        ...DONE,
        handback: "send",
        handbackReport: { text: "The whole report." },
      },
    }),
  );
  await row.press({ key: "report:toggle" });
  expect(
    await row.find({ type: "Text", text: "The whole report." }),
  ).toBeDefined();
  await row.unmount();
});

test("a background agent says so, names its id and has no report yet", async ($, on) => {
  await startSession($, on);
  const card = CALL({
    output: {
      status: "async_launched",
      agentId: "ag2",
      description: "x",
      prompt: "p",
      outputFile: "/o",
    },
  });
  expect(
    await find($, card, {
      type: "Text",
      text: /Review the diff · opus · background/,
    }),
  ).toBeDefined();
  expect(
    await find($, card, { type: "Text", text: "Explore · ag2" }),
  ).toBeDefined();
  expect(await find($, card, { key: "report:toggle" })).toBeUndefined();
});

test("a running agent shows its prompt fold and no totals", async ($, on) => {
  await startSession($, on);
  const card = CALL({ isRunning: true });
  expect(
    await find($, card, { type: "Text", text: /· running/ }),
  ).toBeDefined();
  expect(await find($, card, { type: "Text", text: "Explore" })).toBeDefined();
  expect(await find($, card, { key: "prompt:toggle" })).toBeDefined();
});

test("an errored agent draws the text the model read", async ($, on) => {
  await startSession($, on);
  const card = CALL({ isErrored: true, output: "Agent type not found." });
  expect(
    await find($, card, { type: "Text", text: "Agent type not found." }),
  ).toBeDefined();
});

test("the engine's own result block under an Agent call is left empty", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on);
  expect(
    await find($, CALL({ output: DONE }, "ToolResult"), {
      type: "Text",
      text: "engine",
    }),
  ).toBeUndefined();
});

test("enabled.agent: false hands the row to the engine", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, {
    files: new Map([[CONFIG, "agent:\n  enabled: false\n"]]),
  });
  expect(
    await find($, CALL({ output: DONE }), { key: "agent" }),
  ).toBeUndefined();
  expect(
    await find($, CALL({ output: DONE }, "ToolResult"), {
      type: "Text",
      text: "engine",
    }),
  ).toBeDefined();
});

test("a full model id shows as its family", async ($, on) => {
  await startSession($, on);
  const card = CALL({ input: { ...INPUT, model: undefined }, output: { ...DONE, resolvedModel: "claude-sonnet-5-5" } });
  expect(
    await find($, card, { type: "Text", text: /Review the diff · sonnet\s*$/ }),
  ).toBeDefined();
});

test("the effort a subagent's requests carry joins its model as model/effort", async ($, on) => {
  // stands in for the engine sending the request
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [] } as never;
  });
  await startSession($, on);
  // the stream runs its hooks only as it is read
  for await (const _ of $.turn.step({
    turnId: "t1",
    index: 0,
    model: "claude-sonnet-5-5",
    effort: "low",
    messageCount: 1,
    agentId: "ag1",
  } as never));
  const card = CALL({ input: { ...INPUT, model: "claude-sonnet-5-5" }, output: DONE });
  expect(
    await find($, card, { type: "Text", text: /Review the diff · sonnet\/low/ }),
  ).toBeDefined();
});

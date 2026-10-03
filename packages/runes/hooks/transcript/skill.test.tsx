import { expect, test } from "claude-code/testing";

import { CONFIG, startSession, find } from "./test-session";

const CALL = (
  more: Record<string, unknown> = {},
  input: Record<string, unknown> = {
    skill: "chronicle:commit",
    args: "simple",
  },
  component = "ToolUse",
) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component,
    requestId: "s1",
    props: {
      tool_use_id: "s1",
      tool: "Skill",
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...more,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const INLINE = {
  success: true,
  commandName: "chronicle:commit",
  allowedTools: ["Bash", "Read"],
  model: "opus",
};

const FORKED = {
  success: true,
  commandName: "chronicle:commit",
  status: "forked",
  agentId: "ag9",
  result: "Committed 2 changes.\nAll clean.",
};

test("an inline skill draws its name, model, args and tool count", async ($, on) => {
  await startSession($, on);
  const card = CALL({ output: INLINE });
  expect(await find($, card, { key: "skill" })).toBeDefined();
  expect(
    await find($, card, { type: "Text", text: /chronicle:commit · opus/ }),
  ).toBeDefined();
  expect(await find($, card, { type: "Text", text: "simple" })).toBeDefined();
  expect(
    await find($, card, { type: "Text", text: "inline · 2 tools" }),
  ).toBeDefined();
  expect(await find($, card, { key: "result:toggle" })).toBeUndefined();
});

test("a read-only load says so", async ($, on) => {
  await startSession($, on);
  const card = CALL({
    output: { ...INLINE, allowedTools: undefined, readOnly: true },
  });
  expect(
    await find($, card, { type: "Text", text: "inline · read-only" }),
  ).toBeDefined();
});

test("a forked skill folds its result, unfolding with a fold row at its end", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(CALL({ output: FORKED }));
  expect(await row.find({ type: "Text", text: "forked · ag9" })).toBeDefined();
  expect((await row.find({ key: "result:toggle" }))?.text.trim()).toBe(
    "▸ result · 2 lines",
  );
  expect(await row.find({ type: "Text", text: "All clean." })).toBeUndefined();
  await row.press({ key: "result:toggle" });
  expect(await row.find({ type: "Text", text: "All clean." })).toBeDefined();
  await row.press({ key: "result:end:more" });
  expect(await row.find({ type: "Text", text: "All clean." })).toBeUndefined();
  await row.unmount();
});

test("a background fork says so and has no result fold", async ($, on) => {
  await startSession($, on);
  const card = CALL({
    output: { ...FORKED, background: true, result: "Launched." },
  });
  expect(
    await find($, card, {
      type: "Text",
      text: /chronicle:commit · background/,
    }),
  ).toBeDefined();
  expect(await find($, card, { key: "result:toggle" })).toBeUndefined();
});

test("a running skill with no args draws only its name", async ($, on) => {
  await startSession($, on);
  const card = CALL({ isRunning: true }, { skill: "simplify" });
  expect(
    await find($, card, { type: "Text", text: /simplify · running/ }),
  ).toBeDefined();
});

test("an errored skill draws the text the model read", async ($, on) => {
  await startSession($, on);
  const card = CALL({ isErrored: true, output: "Unknown skill: nope" });
  expect(
    await find($, card, { type: "Text", text: "Unknown skill: nope" }),
  ).toBeDefined();
});

test("the engine's own result block under a Skill call is left empty", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on);
  expect(
    await find($, CALL({ output: INLINE }, undefined, "ToolResult"), {
      type: "Text",
      text: "engine",
    }),
  ).toBeUndefined();
});

test("enabled.skill: false hands the row to the engine", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, {
    files: new Map([[CONFIG, "skill:\n  enabled: false\n"]]),
  });
  expect(
    await find($, CALL({ output: INLINE }), { key: "skill" }),
  ).toBeUndefined();
  expect(
    await find($, CALL({ output: INLINE }, undefined, "ToolResult"), {
      type: "Text",
      text: "engine",
    }),
  ).toBeDefined();
});

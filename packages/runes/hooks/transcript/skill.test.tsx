import { expect, test } from "claude-code/testing";

import { CONFIG, HOME, eventually, startSession, find } from "./test-session";

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

test("an inline skill draws its name, model, args and success", async ($, on) => {
  await startSession($, on);
  const card = CALL({ output: INLINE });
  expect(await find($, card, { key: "skill" })).toBeDefined();
  expect(
    await find($, card, { type: "Text", text: /chronicle:commit · opus/ }),
  ).toBeDefined();
  expect(await find($, card, { type: "Text", text: "simple" })).toBeDefined();
  expect(
    await find($, card, {
      type: "Text",
      text: "success",
    }),
  ).toBeDefined();
  expect(await find($, card, { key: "result:toggle" })).toBeUndefined();
});

test("a forked skill folds its result, unfolding with a fold row at its end", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(CALL({ output: FORKED }));
  expect(await row.find({ type: "Text", text: "success" })).toBeDefined();
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

test("a skill that failed says so", async ($, on) => {
  await startSession($, on);
  const card = CALL({ output: { ...INLINE, success: false, allowedTools: [] } });
  expect(
    await find($, card, { type: "Text", text: "failed" }),
  ).toBeDefined();
});

// records every path read, so a test can tell a SKILL.md stays unread until its fold opens
class Reads extends Map<string, string> {
  read: string[] = [];
  override get(key: string) {
    this.read.push(key);
    return super.get(key);
  }
}

const PLUGINS = `${HOME}/.claude/plugins/installed_plugins.json`;
const ROOT = "/cache/chronicle/0.22.2";

test("SKILL.md is read only once its fold is pressed, from the installed plugin's path", async ($, on) => {
  const files = new Reads([
    [
      PLUGINS,
      JSON.stringify({
        version: 2,
        plugins: { "chronicle@q-lab": [{ scope: "user", installPath: ROOT }] },
      }),
    ],
    [`${ROOT}/skills/commit/SKILL.md`, "# Chronicle Commit\nOne agent."],
  ]);
  await startSession($, on, { files });
  const row = await $.ui.mount(CALL({ output: INLINE }));
  expect((await row.find({ key: "skill.md:toggle" }))?.text.trim()).toBe(
    "▸ SKILL.md",
  );
  expect(files.read.filter((p) => p !== CONFIG)).toEqual([]);
  await row.press({ key: "skill.md:toggle" });
  expect(
    await eventually(async () =>
      Boolean(await row.find({ type: "Text", text: /One agent\./ })),
    ),
  ).toBe(true);
  expect((await row.find({ key: "skill.md:toggle" }))?.text.trim()).toBe(
    "▾ fold",
  );
  await row.press({ key: "skill.md:toggle" });
  expect(await row.find({ type: "Text", text: /One agent\./ })).toBeUndefined();
  expect((await row.find({ key: "skill.md:toggle" }))?.text.trim()).toBe(
    "▸ SKILL.md · 2 lines",
  );
  await row.unmount();
});

test("a personal skill's SKILL.md is read from ~/.claude/skills", async ($, on) => {
  await startSession($, on, {
    files: new Map([
      [`${HOME}/.claude/skills/tidy/SKILL.md`, "Tidy the tree."],
    ]),
  });
  const row = await $.ui.mount(CALL({ output: INLINE }, { skill: "tidy" }));
  await row.press({ key: "skill.md:toggle" });
  expect(
    await eventually(async () =>
      Boolean(await row.find({ type: "Text", text: /Tidy the tree\./ })),
    ),
  ).toBe(true);
  await row.unmount();
});

test("a skill with no SKILL.md on disk says so once opened", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(CALL({ output: INLINE }, { skill: "simplify" }));
  await row.press({ key: "skill.md:toggle" });
  expect(
    await eventually(async () =>
      Boolean(await row.find({ type: "Text", text: "(no SKILL.md found)" })),
    ),
  ).toBe(true);
  await row.unmount();
});

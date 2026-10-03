import { expect, test, type Engine } from "claude-code/testing";

import { mute } from "./bubble";
import { xterm256 } from "./ansi";
import { CONFIG, eventually, startSession } from "./test-session";

const CALL = (
  input: Record<string, unknown>,
  more: Record<string, unknown> = {},
) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolUse",
    requestId: "t1",
    props: {
      tool_use_id: "t1",
      tool: "Bash",
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...more,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

// the engine draws ToolResult inside its ToolUse row, so the output arrives on the call
const RESULT = (output: unknown, isErrored = false) =>
  CALL({ command: "ls" }, { output, isErrored });

test("a running Bash call draws no output card and no link", async ($, on) => {
  await startSession($, on);
  const call = CALL({ command: "sleep 9" }, { isRunning: true });
  expect(await find($, call, { key: "bash" })).toBeDefined();
  expect(await find($, call, { key: "bash:output" })).toBeUndefined();
  expect(await find($, call, { type: "Text", text: /┬/ })).toBeUndefined();
});

const OUT = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
  interrupted: false,
});

const find = async (
  $: Engine,
  event: never,
  query: Parameters<Awaited<ReturnType<Engine["ui"]["mount"]>>["find"]>[0],
) => {
  const row = await $.ui.mount(event);
  const found = await row.find(query);
  await row.unmount();
  return found;
};

type Node = { children?: unknown[] };
// find() drops an element's own hover, which sits beside its props; its children keep theirs
const within = async ($: Engine, event: never, key: string, text: RegExp) => {
  const walk = (n: Node): Node | undefined => {
    for (const c of n.children ?? []) {
      if (typeof c !== "object" || c === null) continue;
      const own = ((c as Node).children ?? []).filter(
        (x) => typeof x === "string",
      );
      if (own.length && text.test(own.join(""))) return c as Node;
      const hit = walk(c as Node);
      if (hit) return hit;
    }
    return undefined;
  };
  const card = await find($, event, { key });
  return card ? walk(card) : undefined;
};

test("a Bash call draws its description in the header and the command after a $", async ($, on) => {
  await startSession($, on);
  const call = CALL({
    command: "bun test hooks/",
    description: "Run the tests",
  });
  expect(await find($, call, { key: "bash" })).toBeDefined();
  expect(
    await find($, call, { type: "Text", text: /Run the tests/ }),
  ).toBeDefined();
  expect(
    await find($, call, { type: "Text", text: "$ bun test hooks/" }),
  ).toBeDefined();
  // the call's card hands the link down to its output
  expect(await find($, call, { type: "Text", text: /┬/ })).toBeDefined();
});

test("a Bash call with no description is headed Bash", async ($, on) => {
  await startSession($, on);
  expect(
    await find($, CALL({ command: "ls" }), { type: "Text", text: /Bash/ }),
  ).toBeDefined();
});

test("a Bash call taller than fold_lines folds to its head", async ($, on) => {
  await startSession($, on, {
    files: new Map([[CONFIG, "bash:\n  fold_lines: 2\n"]]),
  });
  const call = CALL({ command: "a\nb\nc\nd" });
  expect(await find($, call, { type: "Text", text: "  c" })).toBeUndefined();
  expect(await find($, call, { key: "cmd:more:row" })).toBeDefined();
});

test("a Bash result draws its own card, linked to the call above it", async ($, on) => {
  await startSession($, on);
  const result = RESULT(OUT("42 pass\n0 fail\n"));
  expect(await find($, result, { key: "bash:output" })).toBeDefined();
  expect(
    await find($, result, { type: "Text", text: "42 pass" }),
  ).toBeDefined();
  expect(await find($, result, { type: "Text", text: /┴/ })).toBeDefined();
  // the trailing newline is not a blank line of output
  expect(await find($, result, { key: "out:2" })).toBeUndefined();
});

test("a Bash result strips ANSI escapes and draws stderr in the error colour", async ($, on) => {
  await startSession($, on);
  const result = RESULT(OUT("\x1b[32mok\x1b[0m", "warn: x"));
  expect(await find($, result, { type: "Text", text: "ok" })).toBeDefined();
  expect(await within($, result, "bash:output", /^warn: x$/)).toMatchObject({
    props: { color: mute("#c94f4f") },
    hover: { color: "#c94f4f" },
  });
});

test("an errored Bash result draws the text the model read in the error colour", async ($, on) => {
  await startSession($, on);
  const result = RESULT("Exit code 1\nboom", true);
  expect(await find($, result, { type: "Text", text: "boom" })).toBeDefined();
  expect(await within($, result, "bash:output", /error $/)).toMatchObject({
    props: { color: mute("#c94f4f") },
    hover: { color: "#c94f4f" },
  });
});

test("Bash cards draw no bar, and the link runs down the middle column", async ($, on) => {
  await startSession($, on);
  const result = RESULT({ stdout: "ok", stderr: "" });
  const card = await find($, result, { key: "bash:output" });
  expect(card?.children?.[0]?.props?.backgroundColor).toBeUndefined();
  // 60 columns leave a 53-cell inner, so the 57-cell frame's middle is column 28
  const tee = await find($, result, { type: "Text", text: /┬/ });
  const stem = await find($, result, { type: "Text", text: /^\s{2,}│$/ });
  expect(String(tee?.text).indexOf("┬")).toBe(28);
  // the ┬ meets the ┴ directly, so the link takes no row of its own
  expect(stem).toBeUndefined();
  expect(
    await find($, result, { type: "Text", text: "\u{EF11}  output " }),
  ).toBeDefined();
  // the output card sits two columns in, so its frame's column 26 is the call's 28;
  // its ┴ sits in the rule after "╭─ <icon>  output ", which starts at column 13
  expect(await find($, result, { key: "bash:output" })).toMatchObject({
    props: { marginLeft: 2 },
  });
  const elbow = await find($, result, { type: "Text", text: /┴/ });
  expect(String(elbow?.text).indexOf("┴")).toBe(26 - 13);
});

test("an empty Bash result says so", async ($, on) => {
  await startSession($, on);
  expect(
    await find($, RESULT(OUT("")), { type: "Text", text: "(no output)" }),
  ).toBeDefined();
});

const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });

test("enabled.bash: false hands both rows to the engine", async ($, on) => {
  engine(on);
  await startSession($, on, {
    files: new Map([[CONFIG, "bash:\n  enabled: false\n"]]),
  });
  expect(
    await find($, CALL({ command: "ls" }), { key: "bash" }),
  ).toBeUndefined();
  expect(
    await find($, RESULT(OUT("x")), { key: "bash:output" }),
  ).toBeUndefined();
});

test("another tool's row is left to the engine", async ($, on) => {
  engine(on);
  await startSession($, on);
  const call = CALL({ file_path: "/a" }) as unknown as { props: object };
  const read = { ...call, props: { ...call.props, tool: "Read" } } as never;
  expect(await find($, read, { key: "bash" })).toBeUndefined();
  expect(await find($, read, { type: "Text", text: "engine" })).toBeDefined();
});

test("a Bash call highlights the command name and its flags", async ($, on) => {
  await startSession($, on);
  const call = CALL({ command: "bun test --parallel" });
  expect(await within($, call, "bash", /^bun$/)).toMatchObject({
    props: { bold: true, color: mute("#5f8f6a") },
    hover: { color: "#5f8f6a", scope: "t1:call" },
  });
  // dimColor lit every card at once, live, so the quiet kinds take a grey hex instead
  expect(await within($, call, "bash", /^--parallel$/)).toMatchObject({
    props: { color: mute("#8a8a8a") },
    hover: { color: "#8a8a8a", scope: "t1:call" },
  });
});

test("mute halves the saturation and dims to three quarters, keeping the hue", () => {
  const spread = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(...c) - Math.min(...c);
  };
  expect(spread(mute("#c94f4f"))).toBeLessThan(spread("#c94f4f"));
  // a grey has no saturation to lose, so only the dimming shows: 0x80 * 0.75 = 0x60
  expect(mute("#808080")).toBe("#606060");
});

test("a card's borders rest muted and light to the full colour under the pointer", async ($, on) => {
  await startSession($, on);
  const call = CALL({ command: "ls" });
  expect(await within($, call, "bash", /^╰─+┬─+╯$/)).toMatchObject({
    props: { color: mute("#5f8f6a") },
    hover: { color: "#5f8f6a", scope: "t1:call" },
  });
});

test("a foldable card folds and unfolds from a full-width row under a divider", async ($, on) => {
  await startSession($, on, {
    files: new Map([[CONFIG, "bash:\n  fold_lines: 2\n"]]),
  });
  const row = await $.ui.mount(CALL({ command: "a\nb\nc\nd" }));
  expect(await row.find({ key: "cmd:2" })).toBeUndefined();
  expect(await row.find({ key: "cmd:toggle" })).toBeUndefined();
  expect(await row.find({ type: "Text", text: /^├─+┤$/ })).toBeDefined();
  // the label pads to the 53-cell inner width, so the whole row takes the press
  const more = await row.find({ key: "cmd:more" });
  expect(more?.text.trim()).toBe("▸ 2 more lines");
  expect(more?.text.length).toBe(53);
  await row.press({ key: "cmd:more" });
  expect(await row.find({ key: "cmd:2" })).toBeDefined();
  expect((await row.find({ key: "cmd:more" }))?.text.trim()).toBe("▾ fold");
  await row.press({ key: "cmd:more" });
  expect(await row.find({ key: "cmd:2" })).toBeUndefined();
  await row.unmount();
  expect(await find($, CALL({ command: "ls" }), { key: "cmd:more" })).toBeUndefined();
});

test("plain text rests a muted grey and lights to a light grey under its own card's pointer", async ($, on) => {
  await startSession($, on);
  expect(
    await within($, CALL({ command: "bun test" }), "bash", /^test$/),
  ).toMatchObject({
    props: { color: mute("#d4d4d4") },
    hover: { color: "#d4d4d4", scope: "t1:call" },
  });
  expect(
    await within($, RESULT(OUT("42 pass")), "bash:output", /^42 pass$/),
  ).toMatchObject({
    props: { color: mute("#d4d4d4") },
    hover: { color: "#d4d4d4", scope: "t1:out" },
  });
});

test("a card is only as wide as its frame, so the pointer beside it does not light it", async ($, on) => {
  await startSession($, on);
  const result = RESULT(OUT("ok"));
  expect(await find($, result, { key: "bash" })).toMatchObject({ props: { alignSelf: "flex-start" } });
  expect(await find($, result, { key: "bash:output" })).toMatchObject({ props: { alignSelf: "flex-start" } });
});

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

test("a JSON result goes through glow as a json fence and draws its colours, muted", async ($, on) => {
  const stdins: string[] = [];
  await startSession($, on, {
    run: (e) => {
      stdins.push(e.init?.stdin ?? "");
      // glow's margin plus the code block's own indent, then chroma's colours
      return ran('\n    \x1b[38;5;187m{\x1b[0m\x1b[38;5;140m"a"\x1b[0m\x1b[38;5;187m}\x1b[0m\n\n');
    },
  });
  const result = RESULT(OUT('{"a":1}\n'));
  expect(
    await eventually(async () => (await within($, result, "bash:output", /^"a"$/)) !== undefined),
  ).toBe(true);
  expect(stdins).toContain('```json\n{"a":1}\n```');
  expect(await within($, result, "bash:output", /^"a"$/)).toMatchObject({
    props: { color: mute(xterm256(140)) },
    hover: { color: xterm256(140), scope: "t1:out" },
  });
  // the block's indent goes, so the text starts at the card's edge
  expect(await within($, result, "bash:output", /^\{$/)).toBeDefined();
});

test("output of no known language never reaches glow", async ($, on) => {
  const stdins: string[] = [];
  await startSession($, on, { run: (e) => (stdins.push(e.init?.stdin ?? ""), ran("")) });
  expect(await within($, RESULT(OUT("# total 3\n- 42 pass")), "bash:output", /^# total 3$/)).toBeDefined();
  await new Promise((r) => setTimeout(r, 20));
  expect(stdins.some((s) => s.includes("total 3"))).toBe(false);
});

test("on a light terminal mute lifts a colour toward white instead of dimming it", () => {
  expect(mute("#808080", true)).toBe("#a0a0a0");
});

test("glow's light style switches the cards to the light palette", async ($, on) => {
  await startSession($, on, { files: new Map([[CONFIG, "glow:\n  style: light\n"]]) });
  expect(
    await within($, CALL({ command: "bun test --parallel" }), "bash", /^test$/),
  ).toMatchObject({
    props: { color: mute("#4d4d4c", true) },
    hover: { color: "#4d4d4c", scope: "t1:call" },
  });
  expect(
    await within($, CALL({ command: "bun test --parallel" }), "bash", /^--parallel$/),
  ).toMatchObject({
    props: { color: mute("#8e908c", true) },
    hover: { color: "#8e908c", scope: "t1:call" },
  });
});

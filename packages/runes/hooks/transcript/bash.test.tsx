import { expect, test, type Engine } from "claude-code/testing";

import { mute } from "./bubble";
import { xterm256 } from "./ansi";
import {
  CONFIG,
  eventually,
  startSession,
  find,
  within,
  ran,
} from "./test-session";

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

test("a successful Bash result taller than fold_lines folds to its head", async ($, on) => {
  await startSession($, on, {
    files: new Map([[CONFIG, "bash:\n  fold_lines: 3\n"]]),
  });
  const row = await $.ui.mount(RESULT(OUT("1\n2\n3\n4\n5\n6\n7\n")));
  expect(await row.find({ key: "out:2" })).toBeDefined();
  for (const key of ["out:3", "out:after", "out:6"])
    expect(await row.find({ key })).toBeUndefined();
  await row.unmount();
});

test("an unfolded card draws at full colour with no hover until it folds again", async ($, on) => {
  await startSession($, on, {
    files: new Map([[CONFIG, "bash:\n  fold_lines: 3\n"]]),
  });
  const result = RESULT(OUT("1\n2\n3\n4\n5\n6\n7\n"));
  // the fold state is the module's, so a press on one mount shows in the next draw
  const toggle = async () => {
    const row = await $.ui.mount(result);
    await row.press({ key: "out:more" });
    await row.unmount();
  };
  expect(await within($, result, "bash:output", /^1$/)).toMatchObject({
    props: { color: mute("#d4d4d4") },
  });
  await toggle();
  const open = await within($, result, "bash:output", /^7$/);
  expect(open).toMatchObject({ props: { color: "#d4d4d4" } });
  expect((open as { hover?: unknown }).hover).toBeUndefined();
  await toggle();
  expect(await within($, result, "bash:output", /^1$/)).toMatchObject({
    props: { color: mute("#d4d4d4") },
  });
});

// the output card's lines as drawn, a divider as "—", so a tail on the wrong side of the fold fails
const outLines = async ($: Engine, event: never) => {
  const card = await find($, event, { key: "bash:output" });
  return (card?.text.match(/├─+┤|│[^│]*│/g) ?? []).map((l) =>
    l.startsWith("├") ? "—" : l.slice(1, -1).trim(),
  );
};
const SEVEN = OUT("1\n2\n3\n4\n5\n6\n7\n");
const fold = (lines: number) => ({
  files: new Map([[CONFIG, `bash:\n  fold_lines: ${lines}\n`]]),
});

test("unfolding the command lights only the command card", async ($, on) => {
  await startSession($, on, fold(2));
  const event = CALL(
    { command: "a\nb\nc\nd" },
    { output: { stdout: "1\n2\n3\n", stderr: "" } },
  );
  const row = await $.ui.mount(event);
  await row.press({ key: "cmd:more" });
  await row.unmount();
  // `d` reads as a command name, so its full colour is the bash green
  expect(await within($, event, "bash", /^d$/)).toEqual({
    type: "Text",
    props: { bold: true, color: "#5f8f6a" },
    children: ["d"],
  });
  expect(await within($, event, "bash", /^╰─+┬─+╯$/)).toMatchObject({
    props: { color: "#5f8f6a" },
  });
  // the output is folded still, so it stays dim
  expect(await within($, event, "bash:output", /^1$/)).toMatchObject({
    props: { color: mute("#d4d4d4") },
  });
});

test("an errored Bash result taller than fold_lines folds to its head and its tail around the fold row", async ($, on) => {
  await startSession($, on, fold(3));
  const result = RESULT(SEVEN, true);
  const toggle = async () => {
    const row = await $.ui.mount(result);
    await row.press({ key: "out:more" });
    await row.unmount();
  };
  expect(await outLines($, result)).toEqual(["1", "2", "—", "▸ 4 more lines", "—", "7"]);
  await toggle();
  expect(await outLines($, result)).toEqual(["1", "2", "3", "4", "5", "6", "7", "—", "▾ fold"]);
  await toggle();
  expect(await outLines($, result)).toEqual(["1", "2", "—", "▸ 4 more lines", "—", "7"]);
});

test("an errored Bash result with fold_lines 1 keeps only its last line", async ($, on) => {
  await startSession($, on, fold(1));
  expect(await outLines($, RESULT(SEVEN, true))).toEqual(["▸ 6 more lines", "—", "7"]);
});

test("an errored Bash result with fold_lines 2 keeps one head and one tail line", async ($, on) => {
  await startSession($, on, fold(2));
  expect(await outLines($, RESULT(SEVEN, true))).toEqual(["1", "—", "▸ 5 more lines", "—", "7"]);
});

test("an errored Bash result at fold_lines draws whole, and one past it folds", async ($, on) => {
  await startSession($, on, fold(3));
  expect(await outLines($, RESULT(OUT("1\n2\n3\n"), true))).toEqual(["1", "2", "3"]);
  expect(await outLines($, RESULT(OUT("1\n2\n3\n4\n"), true))).toEqual(["1", "2", "—", "▸ 1 more lines", "—", "4"]);
});

test("an interrupted Bash result keeps its tail too", async ($, on) => {
  await startSession($, on, fold(3));
  const result = CALL({ command: "ls" }, { output: SEVEN, isInterrupted: true });
  expect(await outLines($, result)).toEqual(["1", "2", "—", "▸ 4 more lines", "—", "7"]);
});

test("the tail of an errored result is the text the model read, stderr last", async ($, on) => {
  await startSession($, on, fold(3));
  expect(await outLines($, RESULT("Exit code 1\na\nb\nc\nfatal: boom", true))).toEqual([
    "Exit code 1",
    "a",
    "—",
    "▸ 2 more lines",
    "—",
    "fatal: boom",
  ]);
  const both = RESULT(OUT("1\n2\n3\n4\n5\n", "warn: x\nerror: y"), true);
  expect(await outLines($, both)).toEqual(["1", "2", "—", "▸ 4 more lines", "—", "error: y"]);
  expect(await within($, both, "bash:output", /^error: y$/)).toMatchObject({
    props: { color: mute("#c94f4f") },
  });
});

test("a successful Bash result at fold_lines 1 still folds to its head alone", async ($, on) => {
  await startSession($, on, fold(1));
  expect(await outLines($, RESULT(SEVEN))).toEqual(["1", "—", "▸ 6 more lines"]);
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
  // 60 columns leave a 53-cell inner; the call keeps 2 columns free on its right, so its 55-cell frame's middle is column 27
  const tee = await find($, result, { type: "Text", text: /┬/ });
  const stem = await find($, result, { type: "Text", text: /^\s{2,}│$/ });
  expect(String(tee?.text).indexOf("┬")).toBe(27);
  // the ┬ meets the ┴ directly, so the link takes no row of its own
  expect(stem).toBeUndefined();
  expect(
    await find($, result, { type: "Text", text: "\u{EF11}  output " }),
  ).toBeDefined();
  // the output card sits two columns in, so its frame's column 25 is the call's 27;
  // its ┴ sits in the rule after "╭─ <icon>  output ", which starts at column 13
  expect(await find($, result, { key: "bash:output" })).toMatchObject({
    props: { marginLeft: 2 },
  });
  const elbow = await find($, result, { type: "Text", text: /┴/ });
  expect(String(elbow?.text).indexOf("┴")).toBe(25 - 13);
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
  const call = CALL({ pattern: "x" }) as unknown as { props: object };
  const grep = { ...call, props: { ...call.props, tool: "Grep" } } as never;
  expect(await find($, grep, { key: "bash" })).toBeUndefined();
  expect(await find($, grep, { type: "Text", text: "engine" })).toBeDefined();
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
  // the label pads to the call's 51-cell inner width, so the whole row takes the press
  const more = await row.find({ key: "cmd:more" });
  expect(more?.text.trim()).toBe("▸ 2 more lines");
  expect(more?.text.length).toBe(51);
  await row.press({ key: "cmd:more" });
  expect(await row.find({ key: "cmd:2" })).toBeDefined();
  expect((await row.find({ key: "cmd:more" }))?.text.trim()).toBe("▾ fold");
  await row.press({ key: "cmd:more" });
  expect(await row.find({ key: "cmd:2" })).toBeUndefined();
  await row.unmount();
  expect(
    await find($, CALL({ command: "ls" }), { key: "cmd:more" }),
  ).toBeUndefined();
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
  expect(await find($, result, { key: "bash" })).toMatchObject({
    props: { alignSelf: "flex-start" },
  });
  expect(await find($, result, { key: "bash:output" })).toMatchObject({
    props: { alignSelf: "flex-start" },
  });
});

test("a JSON result goes through glow as a json fence and draws its colours, muted", async ($, on) => {
  const stdins: string[] = [];
  await startSession($, on, {
    run: (e) => {
      stdins.push(e.init?.stdin ?? "");
      // glow's margin plus the code block's own indent, then chroma's colours
      return ran(
        '\n    \x1b[38;5;187m{\x1b[0m\x1b[38;5;140m"a"\x1b[0m\x1b[38;5;187m}\x1b[0m\n\n',
      );
    },
  });
  const result = RESULT(OUT('{"a":1}\n'));
  expect(
    await eventually(
      async () =>
        (await within($, result, "bash:output", /^"a"$/)) !== undefined,
    ),
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
  await startSession($, on, {
    run: (e) => (stdins.push(e.init?.stdin ?? ""), ran("")),
  });
  expect(
    await within(
      $,
      RESULT(OUT("# total 3\n- 42 pass")),
      "bash:output",
      /^# total 3$/,
    ),
  ).toBeDefined();
  await new Promise((r) => setTimeout(r, 20));
  expect(stdins.some((s) => s.includes("total 3"))).toBe(false);
});

test("on a light terminal mute lifts a colour toward white instead of dimming it", () => {
  expect(mute("#808080", true)).toBe("#a0a0a0");
});

test("glow's light style switches the cards to the light palette", async ($, on) => {
  await startSession($, on, {
    files: new Map([[CONFIG, "glow:\n  style: light\n"]]),
  });
  expect(
    await within($, CALL({ command: "bun test --parallel" }), "bash", /^test$/),
  ).toMatchObject({
    props: { color: mute("#4d4d4c", true) },
    hover: { color: "#4d4d4c", scope: "t1:call" },
  });
  expect(
    await within(
      $,
      CALL({ command: "bun test --parallel" }),
      "bash",
      /^--parallel$/,
    ),
  ).toMatchObject({
    props: { color: mute("#8e908c", true) },
    hover: { color: "#8e908c", scope: "t1:call" },
  });
});

// what Jev's command-only request answers: code in typescript, no risk
const JEV = (over: { code?: number; risk?: number } = {}) => {
  const code = over.code ?? 0.99;
  return {
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        answers: {
          kind: {
            type: "choice",
            choice: "code",
            confidence: 1,
            probabilities: {
              markdown: 0,
              json: 0,
              diff: 0,
              code,
              plain: 1 - code,
            },
          },
          language: {
            type: "choice",
            choice: "typescript",
            confidence: 1,
            probabilities: { typescript: 1, other: 0 },
          },
          risk: { type: "noul", noul: over.risk ?? 0.1 },
        },
      }),
    },
  } as never;
};

const CMD = (command: string, stdout: string) =>
  CALL({ command }, { output: OUT(stdout) });

test("with no TYPESAFE_API_KEY nothing is sent and the output stays as it was", async ($, on) => {
  const sent: string[] = [];
  on("http.fetch", (_$, e) => (sent.push(e.url), JEV()));
  await startSession($, on, { run: () => ran("") });
  expect(
    await within(
      $,
      CMD("make report", "const a = 1\nconst b = 2\n"),
      "bash:output",
      /^const a = 1$/,
    ),
  ).toBeDefined();
  await new Promise((r) => setTimeout(r, 30));
  expect(sent).toEqual([]);
});

test("with a key, a command Jev is sure prints code goes through glow, and the output is never sent", async ($, on) => {
  const bodies: string[] = [];
  const stdins: string[] = [];
  on("http.fetch", (_$, e) => (bodies.push(String(e.init?.body)), JEV()));
  await startSession($, on, {
    env: { TYPESAFE_API_KEY: "k" },
    run: (e) => (
      stdins.push(e.init?.stdin ?? ""),
      ran("\n    \x1b[38;5;140mconst a\x1b[0m\n")
    ),
  });
  const call = CMD(
    "make report TOKEN=abcdef1234567890abcdef",
    "const a = 1\nconst b = 2\n",
  );
  expect(
    await eventually(
      async () =>
        (await within($, call, "bash:output", /^const a$/)) !== undefined,
    ),
  ).toBe(true);
  expect(stdins.some((s) => s.startsWith("```typescript\n"))).toBe(true);
  // one request, for the command, with its token masked and none of the output in it
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("make report");
  expect(bodies[0]).not.toContain("abcdef1234567890abcdef");
  expect(bodies[0]).not.toContain("const a = 1");
});

test("a command the local list denies is never sent to Jev", async ($, on) => {
  const sent: string[] = [];
  on("http.fetch", (_$, e) => (sent.push(e.url), JEV()));
  await startSession($, on, {
    env: { TYPESAFE_API_KEY: "k" },
    run: () => ran(""),
  });
  expect(
    await within(
      $,
      CMD("env", "HOME=/x\nPATH=/bin\n"),
      "bash:output",
      /^HOME=\/x$/,
    ),
  ).toBeDefined();
  await new Promise((r) => setTimeout(r, 30));
  expect(sent).toEqual([]);
});

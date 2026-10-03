import type { On } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";


import { prompt, segments } from "./prompt";
import { CONFIG, eventually, startSession } from "./test-session";
import { cells, innerWidth, wrap } from "./text";

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});


const ROW = (text: string, isExpanded = false) =>
  ({
    component: "UserMessage",
    requestId: "m1",
    props: { text, origin: { kind: "composer" }, isExpanded },
  }) as never;

test("segments splits system-reminder blocks out of the prompt body", () => {
  expect(
    segments("hi\n<system-reminder>\nctx\n</system-reminder>\nbye"),
  ).toEqual([
    { kind: "body", text: "hi" },
    { kind: "reminder", text: "ctx" },
    { kind: "body", text: "bye" },
  ]);
  expect(segments("plain")).toEqual([{ kind: "body", text: "plain" }]);
});

test("a reminder starts folded and its toggle unfolds it", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  prompt(on);
  const row = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...ROW("hi\n<system-reminder>\nsecret\n</system-reminder>"),
  });
  expect(await row.find({ key: "prompt" })).toBeDefined();
  expect(await row.find({ key: "reminder:1:body" })).toBeUndefined();
  await row.press({ key: "reminder:1" });
  expect(await row.find({ key: "reminder:1:body" })).toBeDefined();
  await row.unmount();
});

test("a long prompt folds past the line cap", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  prompt(on);
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const row = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...ROW(long),
  });
  // the same fold block as the Bash cards: a divider, then a centred label padded to the row
  expect(await row.find({ type: "Text", text: /^├─+┤$/ })).toBeDefined();
  const more = await row.find({ key: "body:0:more" });
  expect(more?.text.trim()).toBe("▸ 14 more lines");
  expect(more?.text.length).toBe(innerWidth());
  expect(more?.props.dimColor).toBeUndefined();
  await row.unmount();
});

test("an expanded row still starts folded", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  prompt(on);
  const row = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...ROW("hi\n<system-reminder>\nsecret\n</system-reminder>", true),
  });
  expect(await row.find({ key: "reminder:1:body" })).toBeUndefined();
  await row.unmount();
});

test("wrap breaks by cell width and counts CJK as two", () => {
  expect(wrap("abcdef", 4)).toEqual(["abcd", "ef"]);
  expect(wrap("中文字", 4)).toEqual(["中文", "字"]);
  expect(wrap("a\nb", 4)).toEqual(["a", "b"]);
});

test("a prompt body renders through glow once the worker has run", async ($, on) => {
  await startSession($, on, { run: () => ran(0, "\n  \x1b[1mhello\x1b[m world\n  second line\n\n") });
  const mount = () =>
    $.ui.mount({ plugin: "runes", surface: "terminal", ...ROW("**hello** world second line") });
  expect(
    await eventually(async () => {
      const row = await mount();
      const found = (await row.find({ type: "Text", text: "hello" })) !== undefined;
      await row.unmount();
      return found;
    }),
  ).toBe(true);
  const row = await mount();
  expect(await row.find({ key: "body:0:1" })).toBeDefined();
  expect(await row.find({ key: "body:0:2" })).toBeUndefined();
  await row.unmount();
});

test("a reminder's head is cut to the row by cell width, so CJK cannot push the border out", async ($) => {
  const head = "中".repeat(60);
  const row = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...ROW(`hi\n<system-reminder>\n${head}\n</system-reminder>`),
  });
  const button = await row.find({ key: "reminder:1" });
  const label = String((button as { text?: string } | undefined)?.text ?? "");
  expect(label).toContain("中");
  expect(cells(label)).toBeLessThanOrEqual(innerWidth());
  await row.unmount();
});

const drawPrompt = async ($: Engine, on: On, config: string) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, { files: new Map([[CONFIG, config]]), run: () => ran(1, "") });
  const row = await $.ui.mount({ plugin: "runes", surface: "terminal", ...ROW("hi") });
  const bubble = await row.find({ key: "prompt" });
  const engine = await row.find({ type: "Text", text: "engine" });
  await row.unmount();
  return { bubble, engine };
};

test("side: left puts the prompt's bar first, in the configured colour", async ($, on) => {
  const { bubble } = await drawPrompt($, on, 'prompt:\n  side: left\n  color: "#00ff00"\n');
  expect(bubble?.children?.[0]).toMatchObject({ props: { backgroundColor: "#00ff00" } });
});

test("the prompt's bar sits on the right by default", async ($, on) => {
  const { bubble } = await drawPrompt($, on, "");
  expect(bubble?.children?.at(-1)).toMatchObject({ props: { backgroundColor: "#1b5ea6" } });
});

test("enabled.prompt: false hands the row to the engine", async ($, on) => {
  const { bubble, engine } = await drawPrompt($, on, "prompt:\n  enabled: false\n");
  expect(bubble).toBeUndefined();
  expect(engine).toBeDefined();
});

test("an icon alone on a right-side header gets one space after it", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, { files: new Map([[CONFIG, 'prompt:\n  icon: "P"\n']]), run: () => ran(1, "") });
  const row = await $.ui.mount({ plugin: "runes", surface: "terminal", ...ROW("hi") });
  const label = await row.find({ type: "Text", text: /^ P $/ });
  await row.unmount();
  expect(label).toBeDefined();
});

test("a right-side bubble keeps one column to its bar, its slack going left", async ($, on) => {
  const { bubble } = await drawPrompt($, on, "");
  expect(bubble?.props.justifyContent).toBe("flex-end");
  expect((bubble?.children?.[0] as { props?: { flexGrow?: number } }).props?.flexGrow).toBeUndefined();
});

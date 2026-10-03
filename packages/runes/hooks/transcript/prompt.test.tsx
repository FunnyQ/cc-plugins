import { expect, test } from "claude-code/testing";
import type { On } from "claude-code";

import { prompt, segments } from "./prompt";
import { wrap } from "./text";

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

// glow exits non-zero, so the body takes the plain wrap path these tests pin
const noGlow = (on: On) => on("process.run", () => ran(1, ""));

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
  noGlow(on);
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
  noGlow(on);
  prompt(on);
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const row = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...ROW(long),
  });
  expect(await row.find({ key: "body:0:more" })).toBeDefined();
  await row.unmount();
});

test("an expanded row still starts folded", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  noGlow(on);
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

test("a prompt body renders through glow when it is there", async ($, on) => {
  on("process.run", () => ran(0, "\n  \x1b[1mhello\x1b[m world\n  second line\n\n"));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  const row = await $.ui.mount({ plugin: "runes", surface: "terminal", ...ROW("**hello** world second line") });
  expect(await row.find({ key: "body:0:1" })).toBeDefined();
  expect(await row.find({ key: "body:0:2" })).toBeUndefined();
  expect(await row.find({ type: "Text", text: "hello" })).toBeDefined();
  await row.unmount();
});

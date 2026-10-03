import { expect, test } from "claude-code/testing";

import { prompt, segments, wrap } from "./prompt";

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
  expect(await row.find({ key: "body:0:more" })).toBeDefined();
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

import { expect, test } from "claude-code/testing";

const REPLY = (text: string) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "AssistantMessage",
    requestId: "a1",
    props: { text, isFirstOfReply: true },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const GLOW =
  "\n  \x1b[38;5;252;1mhi\x1b[m\x1b[38;5;252m there\x1b[m      \n  \x1b[38;5;252msecond\x1b[m\n\n";

const ran = (exitCode: number, stdout: string) => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

test("a reply draws glow's lines inside the orange bubble", async ($, on) => {
  const calls: (readonly string[])[] = [];
  on("process.run", (_$, e) => {
    calls.push(e.argv);
    return ran(0, GLOW);
  });
  const row = await $.ui.mount(REPLY("**hi** there\n\nsecond"));
  expect(await row.find({ key: "reply" })).toBeDefined();
  expect(await row.find({ key: "line:0" })).toBeDefined();
  expect(await row.find({ key: "line:1" })).toBeDefined();
  // glow's blank first and last lines are trimmed
  expect(await row.find({ key: "line:2" })).toBeUndefined();
  expect(await row.find({ type: "Text", text: "hi" })).toBeDefined();
  expect(calls[0][0]).toBe("glow");
  await row.unmount();
});

test("a reply keeps the engine's drawing when glow fails", async ($, on) => {
  on("process.run", () => ran(1, ""));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  const row = await $.ui.mount(REPLY("other text"));
  expect(await row.find({ key: "reply" })).toBeUndefined();
  await row.unmount();
});

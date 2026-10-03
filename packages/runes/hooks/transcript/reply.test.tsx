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
  let home: string | undefined;
  on("process.run", (_$, e) => {
    calls.push(e.argv);
    home = e.init?.env?.HOME;
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
  // a mod's child gets no HOME, and glow then writes its config under a literal ~ in the cwd
  expect(home).toBe("/tmp/q-lab/runes/glow");
  await row.unmount();
});

test("a reply glow cannot render still draws its raw text in the bubble", async ($, on) => {
  on("process.run", () => ran(1, ""));
  const row = await $.ui.mount(REPLY("other text"));
  expect(await row.find({ key: "reply" })).toBeDefined();
  expect(await row.find({ type: "Text", text: "other text" })).toBeDefined();
  await row.unmount();
});

test("one failed glow run is retried on the next draw instead of turning glow off", async ($, on) => {
  let calls = 0;
  on("process.run", () => {
    calls++;
    if (calls === 1) throw new Error("aborted");
    return ran(0, GLOW);
  });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  let row = await $.ui.mount(REPLY("retry me"));
  // the failed draw falls back to the raw text, not glow's
  expect(await row.find({ type: "Text", text: "hi" })).toBeUndefined();
  await row.unmount();
  row = await $.ui.mount(REPLY("retry me"));
  expect(await row.find({ type: "Text", text: "hi" })).toBeDefined();
  await row.unmount();
});

// last in the file: it leaves glow marked missing for the module
test("glow failing to start suggests installing it, once", async ($, on) => {
  on("process.run", () => {
    throw new Error("cannot start glow");
  });
  const toasts: string[] = [];
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
  });
  for (const text of ["a", "b", "c", "d"]) {
    const row = await $.ui.mount(REPLY(text));
    expect(await row.find({ key: "reply" })).toBeDefined();
    await row.unmount();
  }
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain("brew install glow");
});

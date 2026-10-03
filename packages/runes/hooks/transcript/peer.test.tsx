import { expect, test } from "claude-code/testing";

import { mute } from "./bubble";
import { CONFIG, startSession } from "./test-session";

const FRAME =
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:";

const PEER = (text: string, name = "chronicle:lawspeaker") =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "UserMessage",
    requestId: "p1",
    props: { text, origin: { kind: "peer" }, isExpanded: false, from: { name } },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});

const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });

test("a hand-back draws as a card titled with the agent, its report unindented and its frame folded", async ($, on) => {
  engine(on);
  await startSession($, on, { run: () => ran(1, "") });
  const row = await $.ui.mount(PEER(`${FRAME}\n  simple commit\n  2fb2aa8 fix: x`));
  expect(await row.find({ key: "peer" })).toBeDefined();
  expect(await row.find({ type: "Text", text: /chronicle:lawspeaker/ })).toBeDefined();
  expect(await row.find({ type: "Text", text: /^simple commit$/ })).toBeDefined();
  expect(await row.find({ type: "Text", text: /^2fb2aa8 fix: x$/ })).toBeDefined();
  expect(await row.find({ type: "Text", text: /NOT a message from the user/ })).toBeUndefined();
  await row.press({ key: "frame" });
  expect(await row.find({ type: "Text", text: /NOT a message from the user/ })).toBeDefined();
  await row.unmount();
});

test("a peer message with no hand-back frame draws whole, with no frame toggle", async ($, on) => {
  engine(on);
  await startSession($, on, { run: () => ran(1, "") });
  const row = await $.ui.mount(PEER("plain note", "worker"));
  expect(await row.find({ type: "Text", text: /^plain note$/ })).toBeDefined();
  expect(await row.find({ key: "frame" })).toBeUndefined();
  await row.unmount();
});

test("a report taller than fold_lines folds to its head", async ($, on) => {
  engine(on);
  await startSession($, on, { files: new Map([[CONFIG, "peer:\n  fold_lines: 2\n"]]), run: () => ran(1, "") });
  const report = ["a", "b", "c", "d"].map((l) => `  ${l}`).join("\n");
  const row = await $.ui.mount(PEER(`${FRAME}\n${report}`));
  expect(await row.find({ type: "Text", text: /^c$/ })).toBeUndefined();
  expect((await row.find({ key: "body:more" }))?.text.trim()).toBe("▸ 2 more lines");
  await row.unmount();
});

test("enabled.peer: false hands the row to the engine", async ($, on) => {
  engine(on);
  await startSession($, on, { files: new Map([[CONFIG, "enabled:\n  peer: false\n"]]), run: () => ran(1, "") });
  const row = await $.ui.mount(PEER("plain note"));
  expect(await row.find({ key: "peer" })).toBeUndefined();
  expect(await row.find({ type: "Text", text: "engine" })).toBeDefined();
  await row.unmount();
});

test("a peer card sits two columns in and rests dim, frame and text alike", async ($, on) => {
  engine(on);
  await startSession($, on, { run: () => ran(1, "") });
  const row = await $.ui.mount(PEER("plain note"));
  const card = await row.find({ key: "peer" });
  expect(card?.props.marginLeft).toBe(2);
  expect(card?.children?.[0]).toMatchObject({ props: { backgroundColor: mute("#9b7fd1") } });
  expect(await row.find({ key: "body:0" })).toBeDefined();
  const body = await row.find({ type: "Text", text: /^plain note$/ });
  expect(body?.props.dimColor).toBe(true);
  await row.unmount();
});

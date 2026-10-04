import { expect, test, type Engine } from "claude-code/testing";


import { CONFIG, eventually, startSession } from "./test-session";

const REPLY = (text: string, requestId = "a1") =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "AssistantMessage",
    requestId,
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

// mounts the reply once and reports whether the query matches what it drew
const draws = async (
  $: Engine,
  reply: never,
  query: Parameters<Awaited<ReturnType<Engine["ui"]["mount"]>>["find"]>[0],
) => {
  const row = await $.ui.mount(reply);
  const found = (await row.find(query)) !== undefined;
  await row.unmount();
  return found;
};

test("a reply draws glow's lines inside the orange bubble once the worker has run", async ($, on) => {
  let home: string | undefined;
  await startSession($, on, { run: (e) => {
    home = e.init?.env?.HOME;
    return ran(0, GLOW);
  } });
  expect(
    await eventually(() =>
      draws($, REPLY("**hi** there\n\nsecond"), { type: "Text", text: "hi" }),
    ),
  ).toBe(true);
  const row = await $.ui.mount(REPLY("**hi** there\n\nsecond"));
  expect(await row.find({ key: "line:1" })).toBeDefined();
  // glow's blank first and last lines are trimmed
  expect(await row.find({ key: "line:2" })).toBeUndefined();
  await row.unmount();
  // a mod's child gets no HOME, and glow then writes its config under a literal ~ in the cwd
  expect(home).toBe("/tmp/q-lab/runes/glow");
});

test("a draw never waits on glow: it shows the raw text in the bubble first", async ($, on) => {
  let release = () => {};
  await startSession($, on, { run: () => new Promise((r) => (release = () => r(ran(0, GLOW)))) as never });
  const row = await $.ui.mount(REPLY("still rendering"));
  expect(await row.find({ key: "reply" })).toBeDefined();
  expect(
    await row.find({ type: "Text", text: "still rendering" }),
  ).toBeDefined();
  await row.unmount();
  release();
});

test("a streamed reply keeps its last formatted text while the next chunk renders", async ($, on) => {
  let release = () => {};
  await startSession($, on, { run: (e) =>
    e.init?.stdin === "first"
      ? ran(0, GLOW)
      : (new Promise((r) => (release = () => r(ran(0, GLOW)))) as never) });
  expect(
    await eventually(() =>
      draws($, REPLY("first", "s1"), { type: "Text", text: "hi" }),
    ),
  ).toBe(true);
  expect(
    await draws($, REPLY("first and more", "s1"), { type: "Text", text: "hi" }),
  ).toBe(true);
  release();
});

test("a reply glow cannot render still draws its raw text in the bubble", async ($, on) => {
  await startSession($, on, { run: () => ran(1, "") });
  expect(await draws($, REPLY("other text"), { key: "reply" })).toBe(true);
  expect(
    await draws($, REPLY("other text"), { type: "Text", text: "other text" }),
  ).toBe(true);
});

test("glow failing to start suggests installing it, once", async ($, on) => {
  const host = await startSession($, on, {
    run: () => {
      throw new Error("cannot start glow");
    },
  });
  expect(
    await eventually(
      async () =>
        (await draws($, REPLY("a"), { key: "reply" })) && host.toasts.length > 0,
    ),
  ).toBe(true);
  for (const text of ["b", "c"])
    expect(await draws($, REPLY(text), { key: "reply" })).toBe(true);
  expect(host.toasts).toHaveLength(1);
  expect(host.toasts[0]).toContain("brew install glow");
});

test("enabled.reply: false hands the reply to the engine", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, { files: new Map([[CONFIG, "reply:\n  enabled: false\n"]]), run: () => ran(1, "") });
  expect(await draws($, REPLY("x"), { key: "reply" })).toBe(false);
  expect(await draws($, REPLY("x"), { type: "Text", text: "engine" })).toBe(true);
});

test("side: right moves the reply's bar after the bubble", async ($, on) => {
  await startSession($, on, { files: new Map([[CONFIG, "reply:\n  side: right\n"]]), run: () => ran(1, "") });
  const row = await $.ui.mount(REPLY("x"));
  const bubble = await row.find({ key: "reply" });
  await row.unmount();
  expect(bubble?.children?.at(-1)).toMatchObject({ props: { backgroundColor: "#d97757" } });
});

test("a drawn bubble still runs the chain, so a plugin beneath sees the row", async ($, on) => {
  const host = await startSession($, on, { run: () => ran(1, "") });
  expect(await draws($, REPLY("x", "row-1"), { key: "reply" })).toBe(true);
  expect(host.beneath).toContain("row-1");
});

test("the desktop keeps the engine's own reply: runes draws nothing there", async ($, on) => {
  await startSession($, on, { run: () => ran(0, GLOW) });
  // mount refuses a surface where the plugin drew nothing
  await expect(
    $.ui.mount({ ...(REPLY("hi") as object), surface: "desktop" } as never),
  ).rejects.toThrow("runes drew nothing on the desktop surface");
  const term = await $.ui.mount(REPLY("hi"));
  expect(await term.find({ key: "reply" })).toBeDefined();
  await term.unmount();
});

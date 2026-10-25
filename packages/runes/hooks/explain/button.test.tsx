import type { On } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";

import { CONFIG, fakeHost } from "../transcript/test-session";
import { CHROME } from "./checker";

const BAND = {
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const REPLY = "<mode>text</mode><title>T</title><body>b</body>";

const setup = async (
  $: Engine,
  on: On,
  yaml = "",
  surface: "terminal" | "desktop" = "terminal",
  hasSurvey = false,
) => {
  fakeHost(on, { files: new Map([[CONFIG, yaml]]) });
  const forks: unknown[] = [];
  const opens: { id: string }[] = [];
  let release = () => {};
  let gate: Promise<void> = Promise.resolve();
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  on("ui.open", (_$, e) => {
    opens.push(e as { id: string });
    return { value: { isPlaced: true } } as never;
  });
  on("model.fork", async (_$, e) => {
    forks.push(e);
    await gate;
    return { value: { isAnswered: true, text: REPLY, usage: USAGE } } as never;
  });
  on("session.start", (_$, e) => e as never);
  await $.session.start({ cwd: "/", surface, isInteractive: true });
  const ui = await $.ui.mount({
    plugin: "runes",
    surface,
    ...BAND,
    props: { ...BAND.props, hasSurvey },
  });
  const hold = () => {
    gate = new Promise((r) => {
      release = r;
    });
  };
  return { ui, forks, opens, hold, release: () => release() };
};

const label = async (ui: Awaited<ReturnType<Engine["ui"]["mount"]>>) =>
  (await ui.find({ key: "explain" }))?.text ?? "";

test("the button draws below clawd-row with its label", async ($, on) => {
  const { ui } = await setup($, on);
  expect(await label(ui)).toContain("[Explain plz!]");
  const row = (await ui.find({ key: "explain-row" })) as { props?: { justifyContent?: string } } | undefined;
  expect(row?.props?.justifyContent).toBe("flex-end");
  type Slot = { props?: { justifyContent?: string; width?: number } } | undefined;
  const under = (await ui.find({ key: "explain-under-clawd" })) as Slot;
  const slot = (await ui.find({ key: "clawd-slot" })) as Slot;
  expect(under?.props?.justifyContent).toBe("center");
  expect(slot?.props?.justifyContent).toBe("center");
  expect(under?.props?.width).toBeGreaterThanOrEqual("[Explain plz!]".length);
  expect(slot?.props?.width).toBe(under?.props?.width);
  const band = await ui.find({ key: "explain-band" });
  const keys = (band?.children ?? []).map((c) => (c as { props?: { key?: string } }).props?.key);
  expect(keys.indexOf("explain-row")).toBeGreaterThan(
    keys.indexOf("clawd-row"),
  );
  expect(keys.indexOf("clawd-row")).toBeGreaterThanOrEqual(0);
  await ui.unmount();
});

test("a press forks once and opens the runes-explain pane", async ($, on) => {
  const { ui, forks, opens } = await setup($, on);
  await ui.press({ key: "explain" });
  expect(forks).toHaveLength(1);
  expect(opens[0]?.id).toBe("runes-explain");
  await ui.unmount();
});

test("explain off draws no button and keeps the Clawd row", async ($, on) => {
  const { ui } = await setup($, on, "explain:\n  enabled: false\n");
  expect(await ui.find({ key: "explain" })).toBeUndefined();
  expect(await ui.find({ key: "clawd-row" })).toBeDefined();
  expect(await ui.find({ key: "explain-band" })).toBeUndefined();
  await ui.unmount();
});

test("Clawd off with no map and no lesson draws the button row alone", async ($, on) => {
  const { ui } = await setup($, on, "clawd:\n  enabled: false\n");
  expect(await ui.find({ key: "explain-row" })).toBeDefined();
  expect(await ui.find({ key: "clawd-row" })).toBeUndefined();
  expect(await ui.find({ text: "engine" })).toBeUndefined();
  await ui.unmount();
});

test("a running fork reads explaining… and ignores a second press", async ($, on) => {
  const { ui, forks, hold, release } = await setup($, on);
  hold();
  const first = ui.press({ key: "explain" });
  for (let i = 0; i < 20 && !(await label(ui)).includes("[explaining…]"); i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(await label(ui)).toContain("[explaining…]");
  await ui.press({ key: "explain" });
  expect(forks).toHaveLength(1);
  release();
  await first;
  expect(await label(ui)).toContain("[Explain plz!]");
  await ui.unmount();
});

test("a survey draws the engine, no button", async ($, on) => {
  const { ui } = await setup($, on, "", "terminal", true);
  expect(await ui.find({ text: "engine" })).toBeDefined();
  expect(await ui.find({ key: "explain" })).toBeUndefined();
  await ui.unmount();
});

test("the desktop draws no button", async ($, on) => {
  const { ui } = await setup($, on, "", "desktop");
  expect(await ui.find({ key: "explain" })).toBeUndefined();
  await ui.unmount();
});

// The kit runs no Agent tool.check beneath a spawn, so this pins what the live allow needs: the spawn is made by runes'
// own ui.press hook after the press's bottom returned, not by the closure, since the engine leaves every runes hook out of a closure's spawn
test("a press that writes an html page spawns the checker from inside runes' own press hook", async ($, on) => {
  const html = "<mode>html</mode><title>Flow</title><summary>s</summary><main><p>m</p></main>";
  mock.clock(on);
  fakeHost(on, {
    files: new Map([[CONFIG, ""], [CHROME, ""]]),
    run: () => ({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }),
  });
  const spawns: string[] = [];
  const spawnsPastBottom: number[] = [];
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  on("ui.open", () => ({ value: { isPlaced: true } }) as never);
  on("model.fork", () => ({ value: { isAnswered: true, text: html, usage: USAGE } }) as never);
  on("agent.spawn", (_$, e) => {
    spawns.push(e.prompt.split("\n")[0]!);
    return { agentId: "k1", model: "sonnet" } as never;
  });
  on("ui.press", async (_$, e, next) => {
    const pressed = await next(e);
    spawnsPastBottom.push(spawns.length);
    return pressed;
  });
  on("session.start", (_$, e) => e as never);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  const ui = await $.ui.mount({ plugin: "runes", surface: "terminal", ...BAND });
  await ui.press({ key: "explain" });
  await ui.unmount();
  expect(spawns).toEqual([expect.stringMatching(/^Check this explainer page: .*\.html$/)]);
  expect(spawnsPastBottom).toEqual([0]);
});

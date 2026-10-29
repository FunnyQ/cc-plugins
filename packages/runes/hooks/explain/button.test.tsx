import type { On } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";

import { CONFIG, HOME, fakeHost, ran } from "../transcript/test-session";

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
  const opens: { id: string; focus?: boolean }[] = [];
  let release = () => {};
  let gate: Promise<void> = Promise.resolve();
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  on("ui.open", (_$, e) => {
    opens.push(e as { id: string; focus?: boolean });
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

// inside Clawd's slot, so the map beside it ends on the button's line rather than above an empty one
// beside Clawd, stacked, so the band needs no line of its own for them and the map ends level with Clawd
test("the buttons stack left of Clawd inside clawd-slot, right-aligned, with no row of their own", async ($, on) => {
  const { ui } = await setup($, on);
  expect(await label(ui)).toContain("[Explain plz!]");
  type Node =
    | {
        props?: {
          key?: string;
          flexDirection?: string;
          alignItems?: string;
          width?: number;
        };
        children?: Node[];
      }
    | undefined;
  const slot = (await ui.find({ key: "clawd-slot" })) as Node;
  expect(slot?.props).toMatchObject({
    flexDirection: "row",
    alignItems: "flex-end",
  });
  expect(slot?.props?.width).toBeGreaterThanOrEqual("[Explain plz!]".length);
  const first = slot?.children?.[0];
  // a column's alignItems leaves a Button at the left edge, so each sits in a row that pushes it right
  expect(first?.props).toMatchObject({
    key: "explain-buttons",
    flexDirection: "column",
  });
  for (const line of first?.children ?? [])
    expect(line?.props).toMatchObject({
      flexDirection: "row",
      justifyContent: "flex-end",
      width: first?.props?.width,
    });
  expect(first?.children?.map((c) => c?.children?.[0]?.props?.key)).toEqual([
    "explain",
    "explain-open",
  ]);
  expect(slot?.children?.at(-1)?.props?.key).toBe("clawd");
  await ui.unmount();
});

test("a press forks once and opens the runes-explain pane", async ($, on) => {
  const { ui, forks, opens } = await setup($, on);
  await ui.press({ key: "explain" });
  expect(forks).toHaveLength(1);
  expect(opens[0]?.id).toBe("runes-explain");
  // the answer is read, not typed into, so the prompt keeps the keyboard
  expect(opens[0]?.focus).toBeFalsy();
  await ui.unmount();
});

test("[Tell me…] opens the runes-explain pane and forks nothing", async ($, on) => {
  const { ui, forks, opens } = await setup($, on);
  expect((await ui.find({ key: "explain-open" }))?.text).toContain(
    "[Tell me…]",
  );
  await ui.press({ key: "explain-open" });
  expect(forks).toHaveLength(0);
  expect(opens.map((o) => o.id)).toEqual(["runes-explain"]);
  expect(opens[0]?.focus).toBe(true);
  await ui.unmount();
});

test("explain off draws no button and keeps the Clawd row", async ($, on) => {
  const { ui } = await setup($, on, "explain:\n  enabled: false\n");
  expect(await ui.find({ key: "explain" })).toBeUndefined();
  expect(await ui.find({ key: "clawd-row" })).toBeDefined();
  await ui.unmount();
});

test("Clawd off with no map and no lesson draws the button row alone", async ($, on) => {
  const { ui } = await setup($, on, "clawd:\n  enabled: false\n");
  expect(await ui.find({ key: "explain-buttons" })).toBeDefined();
  expect(await ui.find({ key: "clawd" })).toBeUndefined();
  expect(await ui.find({ text: "engine" })).toBeUndefined();
  await ui.unmount();
});

test("Clawd off puts the buttons flush right, not centred in Clawd's empty slot", async ($, on) => {
  const { ui } = await setup($, on, "clawd:\n  enabled: false\n");
  type Node =
    | { props?: { key?: string; justifyContent?: string }; children?: Node[] }
    | undefined;
  const row = (await ui.find({ key: "clawd-row" })) as Node;
  expect(row?.props?.justifyContent).toBe("flex-end");
  expect(row?.children?.map((c) => c?.props?.key)).toEqual(["explain-buttons"]);
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

test("the desktop draws both buttons, and a press forks and opens the pane", async ($, on) => {
  const { ui, forks, opens } = await setup($, on, "", "desktop");
  // a desktop draws a native button, so the terminal's brackets would read as text
  expect(await label(ui)).toBe("Explain plz!");
  expect((await ui.find({ key: "explain-open" }))?.text).toBe("Tell me…");
  // drawn as the desktop's own buttons, the first its primary
  expect((await ui.find({ key: "explain" }))?.props).toMatchObject({
    variant: "primary",
  });
  expect((await ui.find({ key: "explain" }))?.props.plain).toBeUndefined();
  expect((await ui.find({ key: "explain-open" }))?.props.plain).toBeUndefined();
  // a native button is taller than a text line, so the stack keeps a line between them or they overlap
  type Node =
    | {
        props?: { key?: string; flexDirection?: string; gap?: number };
        children?: Node[];
      }
    | undefined;
  const pair = (await ui.find({ key: "explain-buttons" })) as Node;
  expect(pair?.props).toMatchObject({ flexDirection: "column", gap: 2 });
  expect(pair?.children?.map((c) => c?.props?.key)).toEqual([
    "explain",
    "explain-open",
  ]);
  expect(await ui.find({ key: "explain-open" })).toBeDefined();
  await ui.press({ key: "explain" });
  expect(forks).toHaveLength(1);
  expect(opens[0]?.id).toBe("runes-explain");
  await ui.unmount();
});

// The kit runs no Agent tool.check beneath a spawn, so this pins what the live allow needs: the spawn is made by runes'
// own ui.press hook after the press's bottom returned, not by the closure, since the engine leaves every runes hook out of a closure's spawn
test("a press that writes an html page spawns the checker from inside runes' own press hook", async ($, on) => {
  const html =
    "<mode>html</mode><title>Flow</title><summary>s</summary><main><p>m</p></main>";
  mock.clock(on);
  fakeHost(on, {
    files: new Map([[CONFIG, ""]]),
    probe: () => ran(JSON.stringify({
      platform: "darwin", wsl: false, home: HOME, tmp: "/tmp", chrome: "/test/chrome",
    })),
    run: () => ({
      value: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }),
  });
  const spawns: string[] = [];
  const spawnsPastBottom: number[] = [];
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  on("ui.open", () => ({ value: { isPlaced: true } }) as never);
  on(
    "session.id",
    () => ({ value: "94e739d6-4f3e-4ab7-8896-2a0aebe5aac2" }) as never,
  );
  on(
    "model.fork",
    () => ({ value: { isAnswered: true, text: html, usage: USAGE } }) as never,
  );
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
  const ui = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...BAND,
  });
  await ui.press({ key: "explain" });
  await ui.unmount();
  expect(spawns).toEqual([
    expect.stringMatching(/^Check this explainer page: .*\.html$/),
  ]);
  expect(spawnsPastBottom).toEqual([0]);
});

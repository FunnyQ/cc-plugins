import type { On } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";

import { DEFAULTS, TEMPLATE } from "./config";
import { CONFIG, fakeHost } from "./transcript/test-session";

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

const start = async ($: Engine, on: On, files = new Map<string, string>()) => {
  const clock = mock.clock(on);
  const host = { ...fakeHost(on, { files }), clock };
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  on("session.start", (_$, e) => e as never);
  return host;
};
const run = async ($: Engine, args: string) =>
  String((await $.command.run({ command: "runes", args } as never)).text);
const hasClawd = async ($: Engine) => {
  const ui = await $.ui.mount({
    plugin: "runes",
    surface: "terminal",
    ...BAND,
  });
  const found = (await ui.find({ key: "clawd" })) !== undefined;
  await ui.unmount();
  return found;
};
const session = ($: Engine) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

test("a first session writes the template, carrying the switches over from the store", async ($, on) => {
  const host = await start($, on);
  host.store.set("rune:clawd", false);
  await session($);
  expect(host.files.get(CONFIG)).toBe(
    TEMPLATE({ ...DEFAULTS.enabled, clawd: false }),
  );
  expect(host.store.has("rune:clawd")).toBe(false);
  expect(await hasClawd($)).toBe(false);
});

test("/runes clawd off writes the line and hides Clawd, and /runes on brings it back", async ($, on) => {
  const host = await start($, on);
  await session($);
  expect(await run($, "clawd off")).toContain("clawd: off");
  const text = host.files.get(CONFIG)!;
  expect(text).toContain("clawd:\n  enabled: false\n");
  expect(text).toContain("# the person's bubble");
  expect(await hasClawd($)).toBe(false);

  await run($, "on");
  expect(host.files.get(CONFIG)).toBe(TEMPLATE(DEFAULTS.enabled));
  expect(await hasClawd($)).toBe(true);
});

test("a broken file falls back to defaults with one toast, and /runes refuses to write", async ($, on) => {
  const broken = "clawd:\n  enabled: false\n  [oops\n";
  const host = await start($, on, new Map([[CONFIG, broken]]));
  await session($);
  expect(host.toasts).toHaveLength(0);
  await host.clock.advance(1000);
  expect(host.toasts).toHaveLength(1);
  expect(host.toasts[0]).toContain("YAML Parse error");
  expect(await hasClawd($)).toBe(true);
  expect(await run($, "clawd off")).toContain("nothing written");
  expect(host.files.get(CONFIG)).toBe(broken);
});

test("an edit that does not read back as intended is refused", async ($, on) => {
  const text = "clawd:\n  enabled: true\nclawd:\n  enabled: true\n";
  const host = await start($, on, new Map([[CONFIG, text]]));
  await session($);
  expect(await run($, "clawd off")).toContain("nothing written");
  // the sections added since still go in, but neither clawd block is touched
  expect(host.files.get(CONFIG)!.startsWith(text)).toBe(true);
});

test("an invalid field toasts its name and keeps its default", async ($, on) => {
  const host = await start(
    $,
    on,
    new Map([[CONFIG, "clawd:\n  enabled: off\n"]]),
  );
  await session($);
  expect(host.toasts).toHaveLength(0);
  await host.clock.advance(1000);
  expect(host.toasts).toHaveLength(1);
  expect(host.toasts[0]).toContain("clawd.enabled");
  expect(await hasClawd($)).toBe(true);
});

test("/runes reload re-reads a hand edit", async ($, on) => {
  const host = await start($, on);
  await session($);
  host.files.set(
    CONFIG,
    host.files.get(CONFIG)!.replace("clawd:\n  enabled: true", "clawd:\n  enabled: false"),
  );
  expect(await run($, "reload")).toContain("clawd: off");
  expect(await hasClawd($)).toBe(false);
});

test("a file from an older runes moves its switches into their sections and gains the sections added since", async ($, on) => {
  const old = "enabled:\n  clawd: false\nreply:\n  side: right   # mine\n";
  const host = await start($, on, new Map([[CONFIG, old]]));
  await session($);
  const text = host.files.get(CONFIG)!;
  expect(text).not.toMatch(/^enabled:/m);
  expect(text).toContain("clawd:\n  enabled: false\n");
  expect(text).toContain("reply:\n  enabled: true\n  side: right   # mine\n");
  expect(text).toContain("bash:\n  enabled: true");
  expect(text).toContain("peer:\n  enabled: true");
  expect(await hasClawd($)).toBe(false);
});

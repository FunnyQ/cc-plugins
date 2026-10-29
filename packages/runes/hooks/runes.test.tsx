import type { On } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";

import { DEFAULTS, PARSE, TEMPLATE } from "./config";
import { CONFIG, HOME, fakeHost, ran } from "./transcript/test-session";
import type { FixtureEnv, FixtureRuntimeInfo } from "./transcript/test-session";

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
  expect(host.files.get(CONFIG)).toBe(
    TEMPLATE({ ...DEFAULTS.enabled, minimap: true }),
  );
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
  expect(host.files.get(CONFIG)!.startsWith(text)).toBe(true);
});

test("an upgrade whose read-back is shadowed by a duplicate key is not written", async ($, on) => {
  const text =
    "clawd:\n  enabled: true\ntranscript:\n  enabled: true\ntranscript:\n  enabled: true\n";
  const host = await start($, on, new Map([[CONFIG, text]]));
  await session($);
  expect(host.files.get(CONFIG)).toBe(text);
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
    host.files
      .get(CONFIG)!
      .replace("clawd:\n  enabled: true", "clawd:\n  enabled: false"),
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
  expect(text).toContain(
    "  reply:\n    enabled: true\n    side: right   # mine\n",
  );
  expect(text).toContain("  bash:\n    enabled: true");
  expect(text).toContain("  peer:\n    enabled: true");
  expect(await hasClawd($)).toBe(false);
});

// The kit does not grant test hooks env/process calls; drive the host's envelopes directly.
const fixtureHost = (opts?: Parameters<typeof fakeHost>[1]) => {
  const hooks = new Map<string, (_$: unknown, event: unknown) => unknown>();
  fakeHost(
    ((name: string, hook: (_$: unknown, event: unknown) => unknown) => {
      hooks.set(name, hook);
    }) as On,
    opts,
  );
  const call = async <T,>(name: string, event: unknown): Promise<T> => {
    const result = await hooks.get(name)!(undefined, event);
    expect(Object.prototype.hasOwnProperty.call(result, "value")).toBe(true);
    return (result as { value: T }).value;
  };
  return {
    env: {
      get: (name: string) => call<string | undefined>("env.get", { name }),
    },
    process: {
      run: (argv: string[], init?: { stdin: string }) =>
        call<ReturnType<typeof ran>["value"]>("process.run", { argv, init }),
    },
    fs: {
      write: (path: string, text: string) =>
        call<void>("fs.write", { path, text }),
      read: (path: string) => call<string | undefined>("fs.read", { path }),
      exists: (path: string) => call<boolean>("fs.exists", { path }),
    },
  };
};

const environments: {
  name: string;
  env: FixtureEnv;
  home: string | undefined;
  profile: string | undefined;
}[] = [
  { name: "default HOME", env: {}, home: HOME, profile: undefined },
  {
    name: "absent HOME with USERPROFILE",
    env: { HOME: undefined, USERPROFILE: "C:\\Users\\Q" },
    home: undefined,
    profile: "C:\\Users\\Q",
  },
  {
    name: "empty HOME with USERPROFILE",
    env: { HOME: "", USERPROFILE: "C:\\Users\\Q" },
    home: "",
    profile: "C:\\Users\\Q",
  },
  {
    name: "both home values absent",
    env: { HOME: undefined, USERPROFILE: undefined },
    home: undefined,
    profile: undefined,
  },
  {
    name: "explicit HOME without USERPROFILE",
    env: { HOME: "/fixture/home", USERPROFILE: undefined },
    home: "/fixture/home",
    profile: undefined,
  },
];
for (const fixture of environments) {
  test(`the host preserves ${fixture.name}`, async () => {
    const host = fixtureHost({ env: fixture.env });
    expect(await host.env.get("HOME")).toBe(fixture.home);
    expect(await host.env.get("USERPROFILE")).toBe(fixture.profile);
  });
}

const runtimes: FixtureRuntimeInfo[] = [
  {
    platform: "win32",
    wsl: false,
    home: "C:\\Users\\Q 測試",
    tmp: "C:\\Temp\\Q & %#'",
  },
  { platform: "darwin", wsl: false, home: "/Users/q", tmp: "/tmp/q" },
  { platform: "linux", wsl: false, home: "/home/q", tmp: "/tmp/q" },
  { platform: "linux", wsl: true, home: "/home/wsl-q", tmp: "/tmp/wsl-q" },
];
const PROBE = [
  "bun",
  "-e",
  "process.stdout.write(JSON.stringify({ platform: process.platform }))",
];
for (const runtime of runtimes) {
  test(`the host injects a ${runtime.platform}${runtime.wsl ? " WSL" : ""} runtime probe`, async () => {
    const calls: string[][] = [];
    const host = fixtureHost({
      run: (e) => {
        calls.push(e.argv);
        return ran(JSON.stringify(runtime));
      },
    });
    const result = await host.process.run(PROBE);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(runtime);
    expect(calls).toEqual([PROBE]);
  });
}

test("the host keeps YAML parsing separate from injected Bun probes", async () => {
  let calls = 0;
  const host = fixtureHost({
    run: () => {
      calls++;
      return ran("probe");
    },
  });
  const parsed = await host.process.run(PARSE, {
    stdin: "clawd:\n  enabled: false\n",
  });
  expect(parsed.exitCode).toBe(0);
  expect(JSON.parse(parsed.stdout)).toEqual({ clawd: { enabled: false } });
  const broken = await host.process.run(PARSE, { stdin: "[oops" });
  expect(broken.exitCode).toBe(1);
  expect(broken.stderr).toContain("YAML Parse error");
  const empty = await host.process.run(PARSE, { stdin: "" });
  expect(JSON.parse(empty.stdout)).toEqual({});
  expect(calls).toBe(0);
  expect((await host.process.run(PROBE)).stdout).toBe("probe");
  expect((await host.process.run([...PARSE, "extra"])).stdout).toBe("probe");
  expect(calls).toBe(2);
});

test("the host preserves a nonzero runtime probe result", async () => {
  const host = fixtureHost({ run: () => ran("partial", 7, "probe failed") });
  expect(await host.process.run(PROBE)).toEqual({
    exitCode: 7,
    stdout: "partial",
    stderr: "probe failed",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  });
});

test("the host preserves a throwing runtime probe", async () => {
  const host = fixtureHost({
    run: () => {
      throw new Error("fixture probe unavailable");
    },
  });
  let message = "";
  try {
    await host.process.run(PROBE);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("fixture probe unavailable");
});

test("the host refuses unhandled openers and keeps filesystem writes in memory", async () => {
  const files = new Map<string, string>();
  const host = fixtureHost({ files });
  for (const argv of [
    ["open", "/fixture/page.html"],
    ["cmd.exe", "/c", "start", "", "C:\\fixture.html"],
    PROBE,
  ]) {
    const result = await host.process.run(argv);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("Unhandled fixture command");
  }
  await host.fs.write("/fixture/only-in-memory.txt", "fixture");
  expect(await host.fs.read("/fixture/only-in-memory.txt")).toBe("fixture");
  expect(files.get("/fixture/only-in-memory.txt")).toBe("fixture");
  expect(await host.fs.exists("/fixture/missing.txt")).toBe(false);
});

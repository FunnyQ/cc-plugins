import type { EngineInterface, On } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

import { runtime } from "../platform";
import { where } from "../transcript/where";
import type { ExplainView } from "../../types";
import { HOME, startSession } from "../transcript/test-session";
import {
  CHECK_TIMEOUT_MS,
  CHECKER,
  CHECKER_PROMPT,
  checker,
  parseVerdict,
  registerChecker,
  startCheck,
} from "./checker";

const CHROME = "/test/chrome";
const DIR = `${HOME}/.local/share/q-lab/runes/explain`;
const PAGE = `${DIR}/repo/20261025-1200-fork.html`;
const end = {
  answer: "",
  durationMs: 0,
  isAborted: false,
  turnId: "t",
  reason: "answer",
} as const;
const shot = (html: string, mode = "wide", root = "/plugin") =>
  `bun '${root.replaceAll("\\", "/")}/hooks/explain/checker-cli.ts' ${mode} '${html.replaceAll("\\", "/")}'`;
const task = (page: string, token: string) =>
  `Check this explainer page: ${page}\nYour check token is ${token}.\nWide screenshot: ${shot(page)}\nNarrow screenshot: ${shot(page, "narrow")}`;
const openedPage = (page: string) => [JSON.stringify({ op: "open", path: page })];
const HANDBACK =
  "Do not hand back. Reply with your check token, then OK, FIXED <n>, or FAILED <reason>, as your final message.";

// the plugin's own hooks, loaded through register.tsx, with a checker subagent `k1` and another agent `o` running
const session = async ($: Engine, on: On, env: Record<string, string> = {}) => {
  on(
    "agent.list",
    () =>
      ({
        value: [
          { id: "k1", type: CHECKER, description: "", status: "running" },
          {
            id: "o",
            type: "general-purpose",
            description: "",
            status: "running",
          },
        ],
      }) as never,
  );
  on("agent.offer", (_$, e) => e as never);
  on("tool.check", () => ({ decision: "ask" }) as never);
  on("tool.call", () => ({ result: "ran" }) as never);
  return startSession($, on, { env });
};

const asks = expect.objectContaining({ decision: "ask" });
const allows = expect.objectContaining({ decision: "allow" });

test("parseVerdict reads the last non-empty line and an optional token", () => {
  const unreadable = { check: "failed", note: "unreadable verdict" };
  expect(parseVerdict("OK")).toEqual({ check: "ok" });
  expect(parseVerdict("FIXED 2")).toEqual({
    check: "fixed",
    note: "2 fix(es)",
  });
  expect(parseVerdict("FAILED chrome crashed")).toEqual({
    check: "failed",
    note: "chrome crashed",
  });
  expect(parseVerdict("FIXED x")).toEqual(unreadable);
  expect(parseVerdict("FIXED 0")).toEqual(unreadable);
  expect(parseVerdict("FAILED")).toEqual(unreadable);
  expect(parseVerdict("")).toEqual(unreadable);
  expect(parseVerdict("Looked fine.\nOK\n\n")).toEqual({ check: "ok" });
  expect(parseVerdict("c3 FIXED 2")).toEqual({
    token: "c3",
    check: "fixed",
    note: "2 fix(es)",
  });
});

test("the session registers the checker on sonnet at medium effort, with a prompt carrying the contract", async ($, on) => {
  const host = await session($, on);
  expect(host.registered).toEqual([
    {
      name: "explain-checker",
      description:
        "Screenshots a runes explainer page and fixes broken diagram labels. Spawned by runes alone.",
      prompt: CHECKER_PROMPT,
      tools: ["Bash", "Read", "Edit"],
      model: "sonnet",
      effort: "medium",
      omitClaudeMd: true,
    },
  ]);
  for (const s of [
    "exact wide and narrow screenshot commands",
    "Written by a fork of this session",
    "FAILED page taller than the screenshot",
    "`ink`, `ink-accent`, `dash`, `wash-warm`, `wash-cool`, `wash-sage`, `label`, `label-soft`, `part`",
    "24 viewBox units",
    "never edit an `svg` with class `pele`",
    "at most 3",
    "`OK`",
    "`FIXED <n>`",
    "`FAILED <reason>`",
  ])
    expect(CHECKER_PROMPT).toContain(s);
});

test("the checker is hidden from the model, and the engine's own Agent call passes through", async ($, on) => {
  await session($, on);
  expect(await $.agent.offer({ agent: CHECKER } as never)).toEqual(
    expect.objectContaining({ isOffered: false }),
  );
  expect(
    await $.tool.check({
      tool: "Agent",
      input: { subagent_type: CHECKER, prompt: "x" },
    } as never),
  ).toEqual(asks);
});

test("Bash allows exactly the two pending commands and revokes them after settlement", async () => {
  const r = await rig();
  await startCheck(r.$, "a", PAGE);
  const bash = (command: string, agentId: string | undefined = "k1") => r.permission(1, { command }, agentId);
  expect(await bash(shot(PAGE))).toEqual({ decision: "allow" });
  expect(await bash(shot(PAGE, "narrow"))).toEqual({ decision: "allow" });
  for (const command of [shot("/etc/passwd.html"), shot(PAGE) + "; echo unsafe", shot(PAGE) + " ", shot(PAGE, "other"), shot(PAGE.replace(".html", "-other.html")), "echo ok"]) {
    expect(await bash(command)).toEqual({ decision: "ask" });
  }
  for (const command of [
    shot(`${DIR}/../x.html`),
    shot(`${DIR}/%2e%2e/x.html`),
    shot(PAGE) + " $HOME",
    shot(PAGE).replace("'/plugin/hooks/explain/checker-cli.ts'", "/plugin/hooks/explain/checker-cli.ts"),
    shot(PAGE) + " --screenshot=/tmp/x.png",
    shot(PAGE) + ` --screenshot=${DIR}/../x.png`,
    shot(PAGE) + " --log-net-log=/tmp/outside.json",
    shot(PAGE) + " https://example.com",
    shot(PAGE) + ` file://${DIR}/repo/other.html`,
    `"${CHROME}" --headless=new https://example.com # file://${PAGE}`,
  ]) expect(await bash(command)).toEqual({ decision: "ask" });
  expect(await r.permission(1, { command: shot(PAGE) }, "")).toEqual({ decision: "ask" });
  expect(await bash(shot(PAGE), "o")).toEqual({ decision: "ask" });
  await r.turnEnd({ agentId: "k1", answer: `${r.token(0)} OK` });
  expect(await bash(shot(PAGE))).toEqual({ decision: "ask" });
});

test("Read and Edit allow inside the explainer root only, and only for the checker", async ($, on) => {
  await session($, on);
  for (const tool of ["Read", "Edit"]) {
    const call = (file_path: string, agentId?: string) =>
      $.tool.check({ tool, input: { file_path }, agentId } as never);
    expect(await call(PAGE, "k1")).toEqual(allows);
    expect(await call(PAGE)).toEqual(asks);
    expect(await call(PAGE, "o")).toEqual(asks);
    expect(await call("/etc/passwd", "k1")).toEqual(asks);
    expect(await call(`${DIR}/../../x`, "k1")).toEqual(asks);
  }
});

test("with HOME missing, Bash, Read and Edit all pass through", async ($, on) => {
  await session($, on, { HOME: "" });
  const loose = shot("/.local/share/q-lab/runes/explain/x.html");
  expect(
    await $.tool.check({
      tool: "Bash",
      input: { command: loose },
      agentId: "k1",
    } as never),
  ).toEqual(asks);
  for (const tool of ["Read", "Edit"])
    expect(
      await $.tool.check({
        tool,
        input: { file_path: "/.local/share/q-lab/runes/explain/x.html" },
        agentId: "k1",
      } as never),
    ).toEqual(asks);
});

test("the checker's hand-back is denied; another agent's or the main loop's passes", async ($, on) => {
  await session($, on);
  const back = (agentId?: string) =>
    $.tool.call({ tool: "SubagentHandback", input: {}, agentId } as never);
  expect(await back("k1")).toEqual(expect.objectContaining({ deny: HANDBACK }));
  expect(JSON.stringify(await back("o"))).not.toContain("Do not hand back");
  expect(JSON.stringify(await back())).not.toContain("Do not hand back");
});

// startCheck needs a hook's `$`, which the kit's `$` cannot stand in for (it has no fs), and the kit loads the plugin
// as its own module instance, so settling is driven on this file's instance: a fake `$`, and `checker` on a fake `on`
type Hooks = Record<
  string,
  (($: unknown, e: unknown, next: unknown) => Promise<unknown>)[]
>;

let epoch = 0;

// `geometry` is the geometry CLI's stdout; absent, the CLI exits 1, and an Error is a run that cannot start
const rig = async (
  opts: { chrome?: boolean; deny?: string; geometry?: string | Error; root?: string; home?: string; windows?: boolean; openError?: boolean | "throw" } = {},
) => {
  // checker.ts keeps its pending checks and token counter per module, so each rig starts far enough on to expire the last rig's leftovers
  let now = (epoch += 10 * CHECK_TIMEOUT_MS);
  let version = 1;
  const fresh = (): ExplainView => ({
    entries: ["a", "b"].map((id) => ({
      id,
      at: 1,
      title: id,
      kind: "html" as const,
      summary: "",
      path: `/p/${id}`,
      check: "pending" as const,
    })),
    isRunning: false,
  });
  let explain = fresh();
  const spawns: { prompt: string }[] = [];
  const opened: string[][] = [];
  const measured: string[][] = [];
  const removed: string[][] = [];
  const agents: { id: string; type: string }[] = [];
  const $ = {
    plugin: { name: "runes", root: opts.root ?? "/plugin" },
    clock: { now: async () => now },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        if (argv[1]?.endsWith("/hooks/platform-cli.ts")) {
          const operation = JSON.parse(init!.stdin!);
          if (operation.op === "cleanup-check") removed.push([init!.stdin!]);
          else opened.push([init!.stdin!]);
          if (operation.op === "open" && opts.openError === "throw") throw new Error("opener refused");
          return { exitCode: operation.op === "open" && opts.openError ? 7 : 0, stdout: "", stderr: "opener refused" };
        }
        if (argv[0] === "bun") {
          measured.push(argv);
          if (opts.geometry instanceof Error) throw opts.geometry;
          return opts.geometry === undefined
            ? { exitCode: 1, stdout: "", stderr: "" }
            : { exitCode: 0, stdout: opts.geometry, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    agent: {
      spawn: async (e: { prompt: string }) => {
        if (opts.deny) return { deny: opts.deny };
        spawns.push(e);
        const id = `k${spawns.length}`;
        agents.push({ id, type: CHECKER });
        return { agentId: id, model: "sonnet" };
      },
      list: async () => agents,
    },
    state: {
      get: async () => ({ value: explain, version }),
      set: async (_ref: unknown, value: ExplainView) => {
        explain = value;
        version++;
        return { isSet: true, version };
      },
    },
  } as unknown as EngineInterface;
  const hooks: Hooks = {};
  const fakeOn = ((event: string, ...rest: unknown[]) => {
    (hooks[event] ??= []).push(rest.at(-1) as Hooks[string][number]);
    return { catch: () => undefined };
  }) as unknown as On;
  checker(fakeOn);
  const turnEnd = async (e: Record<string, unknown>) => {
    const event = { ...end, ...e };
    const body = hooks["turn.complete"]![event.isAborted ? 1 : 0]!;
    return body($, event, async () => ({ text: "" }));
  };
  const entry = (id: string) =>
    explain.entries.find((x) => x.id === id) as {
      check: string;
      note?: string;
    };
  runtime.info = { platform: opts.windows ? "win32" : "darwin", wsl: false, home: opts.home ?? HOME, tmp: "/tmp", chrome: opts.chrome === false ? null : CHROME };
  where.home = opts.home ?? HOME;
  await registerChecker({ ...$, agent: { ...$.agent, register: async () => ({}) } } as unknown as EngineInterface);
  await turnEnd({});
  opened.length = 0;
  removed.length = 0;
  explain = fresh();
  const token = (i: number) =>
    spawns[i]!.prompt.match(/token is (c\d+)\./)![1]!;
  return {
    $,
    permission: (index: number, input: unknown, agentId = "k1") =>
      hooks["tool.check"]![index]!($, { input, agentId }, async () => ({ decision: "ask" })),
    token,
    hooks,
    spawns,
    opened,
    measured,
    removed,
    entry,
    turnEnd,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

test("checker registers four tool.check hooks and two turn.complete hooks", async () => {
  const r = await rig();
  expect(r.hooks["tool.check"]).toHaveLength(4);
  expect(r.hooks["turn.complete"]).toHaveLength(2);
  expect(r.hooks["tool.call"]).toHaveLength(1);
  expect(r.hooks["agent.offer"]).toHaveLength(1);
});

test("the Agent check allows this plugin's spawn of the checker and passes any other through", async () => {
  const r = await rig();
  const agentCheck = r.hooks["tool.check"]![0]!;
  const next = (plugin: string) =>
    Object.assign(async () => ({ decision: "ask" }), { origin: { plugin } });
  expect(
    await agentCheck(r.$, { input: { subagent_type: CHECKER } }, next("runes")),
  ).toEqual({ decision: "allow" });
  expect(
    await agentCheck(r.$, { input: { subagent_type: CHECKER } }, next("guard")),
  ).toEqual({ decision: "ask" });
  expect(
    await agentCheck(
      r.$,
      { input: { subagent_type: "general-purpose" } },
      next("runes"),
    ),
  ).toEqual({
    decision: "ask",
  });
});

test("missing Chrome settles the check as skipped and opens the page", async () => {
  const r = await rig({ chrome: false });
  await startCheck(r.$, "a", PAGE);
  expect(r.spawns).toHaveLength(0);
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "skipped", note: "no Chrome" }),
  );
  expect(r.opened).toEqual([openedPage(PAGE)]);
});

test("a clean geometry check settles ok and opens the page without spawning the checker", async () => {
  const r = await rig({ geometry: '{"faults":[]}' });
  await startCheck(r.$, "a", PAGE);
  expect(r.measured).toEqual([
    ["bun", "/plugin/hooks/explain/geometry-cli.ts", CHROME, PAGE],
  ]);
  expect(r.spawns).toHaveLength(0);
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "ok", note: "geometry clean" }),
  );
  expect(r.opened).toEqual([openedPage(PAGE)]);
});

test("geometry faults go to the checker's task message", async () => {
  const r = await rig({
    geometry: '{"faults":["1280: figure 1 \\"C\\" overlaps \\"D\\""]}',
  });
  await startCheck(r.$, "a", PAGE);
  expect(r.spawns[0]!.prompt).toBe(
    task(PAGE, r.token(0)) + `\nA geometry check found:\n- 1280: figure 1 "C" overlaps "D"`,
  );
  expect(r.entry("a")).toEqual(expect.objectContaining({ check: "pending" }));
});

test("a geometry check that fails, cannot start, or prints no verdict leaves the checker as before", async () => {
  for (const geometry of [undefined, new Error("bun: not found"), "garbage"]) {
    const r = await rig({ geometry });
    await startCheck(r.$, "a", PAGE);
    expect(r.spawns[0]!.prompt).toBe(
      task(PAGE, r.token(0)),
    );
  }
});

test("settling removes the page's screenshots, whichever way it settles", async () => {
  const shots = [JSON.stringify({ op: "cleanup-check", page: PAGE })];
  const clean = await rig({ geometry: '{"faults":[]}' });
  await startCheck(clean.$, "a", PAGE);
  expect(clean.removed).toEqual([shots]);
  const answered = await rig();
  await startCheck(answered.$, "a", PAGE);
  expect(answered.removed).toEqual([]);
  await answered.turnEnd({
    agentId: "k1",
    answer: `${answered.token(0)} FIXED 1`,
  });
  expect(answered.removed).toEqual([shots]);
});

test("a denied spawn settles the check as failed with the deny text", async () => {
  const r = await rig({ deny: "not allowed" });
  await startCheck(r.$, "a", PAGE);
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "failed", note: "not allowed" }),
  );
  expect(r.opened).toEqual([openedPage(PAGE)]);
});

test("startCheck returns at the spawn; the checker's answer settles it exactly once", async () => {
  const r = await rig();
  await startCheck(r.$, "a", PAGE);
  expect(r.spawns).toEqual([
    {
      subagentType: CHECKER,
      prompt: task(PAGE, r.token(0)),
      description: "check explainer layout",
    } as never,
  ]);
  expect(r.entry("a")).toEqual(expect.objectContaining({ check: "pending" }));
  expect(r.opened).toEqual([]);
  expect(
    await r.turnEnd({ agentId: "k1", answer: `Done.\n${r.token(0)} FIXED 2` }),
  ).toEqual({ text: "" });
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "fixed", note: "2 fix(es)" }),
  );
  expect(r.opened).toEqual([openedPage(PAGE)]);
  await r.turnEnd({ agentId: "k1", answer: `${r.token(0)} OK` });
  expect(r.entry("a")).toEqual(expect.objectContaining({ check: "fixed" }));
  expect(r.opened).toHaveLength(1);
});

test("an untokened answer settles by agentId, and an aborted turn fails its check", async () => {
  const r = await rig();
  await startCheck(r.$, "a", "/p/a");
  await startCheck(r.$, "b", "/p/b");
  await r.turnEnd({ agentId: "k2", answer: "OK" });
  expect(r.entry("b")).toEqual(expect.objectContaining({ check: "ok" }));
  expect(r.entry("a")).toEqual(expect.objectContaining({ check: "pending" }));
  await r.turnEnd({ agentId: "k1", isAborted: true, reason: "aborted" });
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "failed", note: "aborted" }),
  );
});

test("a turn end from another agent or the main loop settles nothing", async () => {
  const r = await rig();
  await startCheck(r.$, "a", "/p/a");
  await r.turnEnd({ answer: `${r.token(0)} OK` });
  await r.turnEnd({ agentId: "o", answer: `${r.token(0)} OK` });
  expect(r.entry("a")).toEqual(expect.objectContaining({ check: "pending" }));
  expect(r.opened).toEqual([]);
});

test("two checks answered in reverse order each get their own verdict", async () => {
  const r = await rig();
  await startCheck(r.$, "a", "/p/a");
  await startCheck(r.$, "b", "/p/b");
  await r.turnEnd({ agentId: "k2", answer: `${r.token(1)} OK` });
  await r.turnEnd({ agentId: "k1", answer: `${r.token(0)} FIXED 1` });
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "fixed", note: "1 fix(es)" }),
  );
  expect(r.entry("b")).toEqual(expect.objectContaining({ check: "ok" }));
  expect(r.opened).toEqual([
    openedPage("/p/b"),
    openedPage("/p/a"),
  ]);
});

test("a check times out at the first turn end of any loop after 180 s", async () => {
  const r = await rig();
  await startCheck(r.$, "a", PAGE);
  r.advance(CHECK_TIMEOUT_MS - 1);
  await r.turnEnd({});
  expect(r.entry("a")).toEqual(expect.objectContaining({ check: "pending" }));
  r.advance(1);
  await r.turnEnd({});
  expect(r.entry("a")).toEqual(
    expect.objectContaining({ check: "failed", note: "timed out" }),
  );
  expect(r.opened).toEqual([openedPage(PAGE)]);
});

for (const [name, late] of [
  ["tokened", { answer: "TOKEN OK" }],
  ["untokened", { answer: "OK" }],
  ["non-answer", { reason: "error" }],
] as const)
  test(`a timed-out check's late ${name} answer leaves the newer check pending`, async () => {
    const r = await rig();
    await startCheck(r.$, "a", "/p/a");
    r.advance(CHECK_TIMEOUT_MS);
    await startCheck(r.$, "b", "/p/b");
    expect(r.entry("a")).toEqual(
      expect.objectContaining({ check: "failed", note: "timed out" }),
    );
    await r.turnEnd({
      agentId: "k1",
      ...late,
      answer: late.answer?.replace("TOKEN", r.token(0)),
    });
    expect(r.entry("b")).toEqual(expect.objectContaining({ check: "pending" }));
    expect(r.opened).toEqual([openedPage("/p/a")]);
  });

test("Windows containment accepts separator and case aliases but rejects parent segments, siblings and drives", async () => {
  const r = await rig({ windows: true, home: "C:\\Users\\Q Space" });
  await startCheck(r.$, "a", PAGE);
  for (const index of [2, 3]) {
    for (const file_path of ["c:/users/q space/.local/share/q-lab/runes/explain/repo/page.html", "C:\\Users\\Q Space\\.local\\share\\q-lab\\runes\\explain\\page.html"]) {
      expect(await r.permission(index, { file_path })).toEqual({ decision: "allow" });
    }
    for (const file_path of ["C:/Users/Q Space/.local/share/q-lab/runes/explain/../page.html", "C:/Users/Q Space/.local/share/q-lab/runes/explain-other/page.html", "D:/Users/Q Space/.local/share/q-lab/runes/explain/page.html"]) {
      expect(await r.permission(index, { file_path })).toEqual({ decision: "ask" });
    }
  }
});

test("screenshot commands quote spaces, substitutions and UNC paths while unsafe quotes fall through", async () => {
  for (const [root, page, allowed] of [
    ["C:\\Users\\Q Space\\plugin", "C:\\Users\\Q Space\\page.html", true],
    ["/plugin/$(echo unsafe)", "/home/q/空間 & %#.html", true],
    ["\\\\server\\share\\plugin", "\\\\server\\share\\page.html", true],
    ["/plugin's", PAGE, false],
    ["/plugin", "/page's.html", false],
    ["/plugin\nother", PAGE, false],
    ["/plugin", "/page\nother.html", false],
  ] as const) {
    const r = await rig({ root });
    await startCheck(r.$, "a", page);
    for (const mode of ["wide", "narrow"]) {
      const command = shot(page, mode, root);
      expect(await r.permission(1, { command })).toEqual({ decision: allowed ? "allow" : "ask" });
      if (allowed) expect(r.spawns[0]!.prompt).toContain(command);
    }
  }
});

test("all verdicts use shared operations and preserve the verdict when opening fails", async () => {
  for (const openError of [false, true, "throw"] as const)
    for (const outcome of ["ok", "skipped", "failed", "timeout"] as const) {
      const r = await rig({ chrome: outcome !== "skipped", geometry: outcome === "ok" ? '{"faults":[]}' : undefined, openError });
      await startCheck(r.$, "a", PAGE);
      if (outcome === "failed") await r.turnEnd({ agentId: "k1", answer: `${r.token(0)} FAILED broken` });
      if (outcome === "timeout") { r.advance(CHECK_TIMEOUT_MS); await r.turnEnd({}); }
      expect(r.entry("a").check).toBe(outcome === "timeout" ? "failed" : outcome);
      expect(r.opened).toEqual([openedPage(PAGE)]);
      expect(r.removed).toEqual([[JSON.stringify({ op: "cleanup-check", page: PAGE })]]);
      if (openError) expect(r.entry("a").note).toContain("opener refused");
    }
});

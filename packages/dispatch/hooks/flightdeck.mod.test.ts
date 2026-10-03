import type { On } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";

import type { DeckSnapshot } from "./flightdeck/types.ts";

type Answer = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  delay?: number;
};

const snap = (
  plan: string,
  over: Partial<DeckSnapshot> = {},
): DeckSnapshot => ({
  deckSource: "tasks",
  plan,
  slug: plan.split("/").pop()!,
  planTitle: "Plan",
  counts: {
    total: 2,
    done: 1,
    inProgress: 1,
    ready: 0,
    blocked: 0,
    invalid: 0,
  },
  buckets: [{ name: "api", done: 1, total: 2 }],
  waves: [["api/01", "api/02"]],
  unschedulable: [],
  currentWave: 1,
  tasks: {
    "api/01": {
      ref: "api/01",
      title: "Add schema",
      state: "done",
      attempts: 1,
      score: null,
      time: { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:03:12Z" },
      tokens: null,
    },
    "api/02": {
      ref: "api/02",
      title: "Add token route",
      state: "in-progress",
      attempts: 2,
      score: { weighted: 3.8, threshold: 4, passed: false },
      time: null,
      tokens: null,
    },
  },
  agents: [],
  crew: [],
  errors: 0,
  ...over,
});
const good = (plan: string): Answer => ({
  exitCode: 0,
  stdout: JSON.stringify(snap(plan)),
});

// Stands for the engine beneath the mod: processes, panes, toasts, the clock and the tool's own answer.
function world(
  on: On,
  answer: (argv: readonly string[]) => Answer,
  tool: { isError?: boolean; stdout?: string } = {},
  // false stands for a terminal under the unasked floor: the pane opens but waits undrawn
  place: { next: boolean } = { next: true },
) {
  const clock = mock.clock(on);
  const runs: (readonly string[])[] = [];
  const panes = new Map<string, string>();
  const placed = new Set<string>();
  const opens: Record<string, unknown>[] = [];
  const toasts: string[] = [];
  on("process.run", async (_$, e) => {
    runs.push(e.argv);
    const a = answer(e.argv);
    if (a.delay) await clock.sleep(a.delay);
    return {
      value: {
        exitCode: a.exitCode,
        stdout: a.stdout ?? "",
        stderr: a.stderr ?? "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  on(
    "ui.panes",
    () =>
      ({
        value: [...panes].map(([id, title]) => ({
          id,
          title,
          isShown: true,
          isFocused: false,
          isPlaced: placed.has(id),
        })),
      }) as never,
  );
  on("ui.open", (_$, e) => {
    panes.set(e.id, e.title ?? e.id);
    opens.push({ ...e });
    if (!place.next)
      return { value: { isPlaced: false, reason: "144 columns, 100 now" } } as never;
    placed.add(e.id);
    return { value: { isPlaced: true } } as never;
  });
  on("ui.close", (_$, e) => {
    panes.delete(e.id);
    placed.delete(e.id);
    return { value: undefined } as never;
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined } as never;
  });
  on("session.cwd", () => ({ value: "/cwd" }) as never);
  on(
    "tool.call",
    () =>
      ({
        result: { stdout: tool.stdout ?? "", stderr: "", interrupted: false },
        text: "ok",
        ...(tool.isError ? { isError: true } : {}),
      }) as never,
  );
  const snapshots = (plan?: string) =>
    runs.filter(
      (argv) =>
        argv[1]?.endsWith("/deck-snapshot.ts") &&
        argv[2] !== "--latest" &&
        (!plan || argv[2] === plan),
    );
  return { clock, runs, panes, opens, toasts, snapshots };
}

const run = async ($: Engine, args: string) =>
  String((await $.command.run({ command: "flightdeck", args } as never)).text);

const PANE_PROPS = (placement: "dock" | "inline") => ({
  title: "Flightdeck",
  isFocused: false,
  bodyColumns: 40,
  placement,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
});
const mountPane = ($: Engine, placement: "dock" | "inline" = "dock") =>
  $.ui.mount({
    plugin: "dispatch",
    surface: "terminal",
    component: "Pane",
    requestId: "flightdeck",
    props: PANE_PROPS(placement),
  } as never);
const drawnText = async ($: Engine, placement: "dock" | "inline" = "dock") => {
  const ui = await mountPane($, placement);
  const texts = [...(await ui.findAll({ type: "Text" })), ...(await ui.findAll({ type: "Button" }))].map((el) => el.text);
  await ui.unmount();
  return texts.join("\n");
};

test("/flightdeck <dir> opens the pane and snapshots that dir; a bare /flightdeck closes it", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!));
  expect(await run($, "/abs/docs/x")).toContain("/abs/docs/x");
  expect(w.opens).toEqual([
    { id: "flightdeck", title: "Flightdeck · x", columns: 40, rows: 2 },
  ]);
  expect(w.snapshots()).toEqual([
    [
      "bun",
      expect.stringMatching(/\/skills\/autopilot\/scripts\/deck-snapshot\.ts$/),
      "/abs/docs/x",
    ],
  ] as never);
  expect(w.panes.has("flightdeck")).toBe(true);

  expect(await run($, "")).toBe("Flightdeck closed.");
  expect(w.panes.has("flightdeck")).toBe(false);
  await w.clock.advance(4000);
  expect(w.snapshots()).toHaveLength(1);
});

test("/flightdeck close closes an open pane", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!));
  await run($, "/abs/docs/x");
  expect(await run($, "close")).toBe("Flightdeck closed.");
  expect(w.panes.has("flightdeck")).toBe(false);
});

test("a bare /flightdeck resolves the latest run under the repo root", async ($, on) => {
  const w = world(on, (argv) => {
    if (argv[0] === "git") return { exitCode: 0, stdout: "/repo\n" };
    if (argv[2] === "--latest")
      return {
        exitCode: 0,
        stdout: JSON.stringify({ plan: "/repo/docs/feat" }),
      };
    return good(argv[2]!);
  });
  await run($, "");
  expect(w.runs.find((argv) => argv[2] === "--latest")?.[3]).toBe("/repo");
  expect(w.panes.get("flightdeck")).toBe("Flightdeck · feat");
  expect(w.snapshots("/repo/docs/feat")).toHaveLength(1);
});

test("a bare /flightdeck with no run says so and opens nothing", async ($, on) => {
  const w = world(on, (argv) =>
    argv[0] === "git" ? { exitCode: 128 } : { exitCode: 3 },
  );
  expect(await run($, "")).toBe("No flightplan run found under /cwd/docs");
  expect(w.opens).toEqual([]);
});

test("a successful flightdeck.ts --plan Bash call opens the pane on that plan, result unchanged", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!));
  const ran = await $.tool.call({
    tool: "Bash",
    command: 'bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"',
  } as never);
  expect(ran.text).toBe("ok");
  expect(w.panes.get("flightdeck")).toBe("Flightdeck · x");
  expect(w.snapshots("/abs/docs/x")).toHaveLength(1);
});

test("a launch whose --plan is a shell variable opens on the plan the launcher printed", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!), {
    stdout: "http://localhost:5757/\nflightdeck plan: /abs/docs/x\n",
  });
  await $.tool.call({
    tool: "Bash",
    command: 'D=/abs/docs/x; bun $B/autopilot/scripts/flightdeck.ts --plan "$D"; echo done',
  } as never);
  expect(w.panes.get("flightdeck")).toBe("Flightdeck · x");
  expect(w.snapshots("/abs/docs/x")).toHaveLength(1);
});

test("an auto-open the terminal is too narrow to place toasts how to show it", async ($, on) => {
  const place = { next: false };
  const w = world(on, (argv) => good(argv[2]!), {}, place);
  await $.tool.call({
    tool: "Bash",
    command: 'bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"',
  } as never);
  expect(w.toasts).toEqual([
    "Flightdeck is waiting for a wider terminal. Type /flightdeck to show it.",
  ]);

  place.next = true;
  expect(await run($, "")).toContain("/abs/docs/x");
  expect(w.panes.has("flightdeck")).toBe(true);
  expect(w.opens).toHaveLength(2);
});

test("an errored flightdeck.ts --plan Bash call opens nothing", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!), { isError: true });
  const ran = await $.tool.call({
    tool: "Bash",
    command: 'bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"',
  } as never);
  expect(ran.isError).toBe(true);
  expect(w.opens).toEqual([]);
  expect(w.runs).toEqual([]);
});

test("an unrelated Bash call opens nothing", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!));
  await $.tool.call({
    tool: "Bash",
    command: "bun test flightdeck.test.ts",
  } as never);
  expect(w.opens).toEqual([]);
});

test("a failing snapshot after a good one keeps the good one and marks it stale", async ($, on) => {
  let fail = false;
  const w = world(on, (argv) =>
    fail
      ? { exitCode: 1, stderr: "boom: tree unreadable\nstack" }
      : good(argv[2]!),
  );
  await run($, "/abs/docs/x");
  expect(await drawnText($)).not.toContain("stale");

  fail = true;
  await w.clock.advance(2000);
  expect(w.snapshots()).toHaveLength(2);
  const text = await drawnText($);
  expect(text).toContain("stale");
  expect(text).toContain("api/02");
  expect(text).not.toContain("boom");
});

test("a failure before any snapshot draws the child's first stderr line, clipped to the width", async ($, on) => {
  const w = world(on, () => ({
    exitCode: 2,
    stderr: `no tasks/ or graph.json in /${"long/".repeat(20)}\nmore`,
  }));
  await run($, "/abs/nope");
  expect(w.snapshots()).toHaveLength(1);
  const text = await drawnText($);
  expect(text.startsWith("no tasks/ or graph.json in")).toBe(true);
  expect(text.endsWith("…")).toBe(true);
  expect(text.length).toBe(40);
});

test("a tick that finds the pane gone cancels the ticker and runs no child", async ($, on) => {
  const w = world(on, (argv) => good(argv[2]!));
  await run($, "/abs/docs/x");
  await w.clock.advance(2000);
  expect(w.snapshots()).toHaveLength(2);
  w.panes.delete("flightdeck");
  await w.clock.advance(2000);
  await w.clock.advance(6000);
  expect(w.snapshots()).toHaveLength(2);
});

test("/flightdeck close during a slow --latest lookup leaves the pane closed", async ($, on) => {
  const w = world(on, (argv) =>
    argv[2] === "--latest"
      ? {
          exitCode: 0,
          stdout: JSON.stringify({ plan: "/repo/docs/a" }),
          delay: 500,
        }
      : argv[0] === "git"
        ? { exitCode: 0, stdout: "/repo\n" }
        : good(argv[2]!),
  );
  const lookup = run($, "");
  await w.clock.settle();
  await run($, "close");
  await w.clock.advance(500);
  await lookup;
  expect(w.panes.has("flightdeck")).toBe(false);
  expect(w.opens).toEqual([]);
  expect(w.snapshots()).toEqual([]);
});

test("/flightdeck <planB> during a slow --latest lookup leaves the pane on plan B", async ($, on) => {
  const w = world(on, (argv) =>
    argv[2] === "--latest"
      ? {
          exitCode: 0,
          stdout: JSON.stringify({ plan: "/repo/docs/a" }),
          delay: 500,
        }
      : argv[0] === "git"
        ? { exitCode: 0, stdout: "/repo\n" }
        : good(argv[2]!),
  );
  const lookup = run($, "");
  await w.clock.settle();
  await run($, "/repo/docs/b");
  await w.clock.advance(500);
  await lookup;
  expect(w.panes.get("flightdeck")).toBe("Flightdeck · b");
  await w.clock.advance(2000);
  expect(w.snapshots("/repo/docs/a")).toEqual([]);
  expect(w.snapshots("/repo/docs/b")).toHaveLength(2);
});

test("switching to plan B before A's first snapshot returns discards A's result and leaves only B's ticker", async ($, on) => {
  const w = world(on, (argv) =>
    argv[2] === "/abs/a" ? { ...good("/abs/a"), delay: 1000 } : good(argv[2]!),
  );
  const openA = run($, "/abs/a");
  await w.clock.settle();
  await run($, "/abs/b");
  await w.clock.advance(1000);
  await openA;
  expect(await drawnText($)).toContain("api/01");
  const ui = await mountPane($);
  await ui.press({ key: "open" });
  await ui.unmount();
  expect(w.runs.at(-1)?.slice(-2)).toEqual(["--plan", "/abs/b"]);

  await w.clock.advance(4000);
  expect(w.snapshots("/abs/a")).toHaveLength(1);
  expect(w.snapshots("/abs/b")).toHaveLength(3);
});

test("closing before A's first snapshot returns discards it and leaves no ticker", async ($, on) => {
  const w = world(on, (argv) => ({ ...good(argv[2]!), delay: 1000 }));
  const openA = run($, "/abs/a");
  await w.clock.settle();
  await run($, "close");
  await w.clock.advance(1000);
  await openA;
  expect(await drawnText($)).toBe("Loading…");
  await w.clock.advance(6000);
  expect(w.snapshots()).toHaveLength(1);
});

test("pressing a card toasts its details, and Open flightdeck toasts a failed launch", async ($, on) => {
  const w = world(on, (argv) =>
    argv[1]?.endsWith("/flightdeck.ts")
      ? { exitCode: 1, stderr: "port in use\ntrace" }
      : good(argv[2]!),
  );
  await run($, "/abs/docs/x");
  const ui = await mountPane($);
  await ui.press({ key: "card:api/02" });
  await ui.press({ key: "card:api/01" });
  await ui.press({ key: "open" });
  await ui.unmount();
  expect(w.toasts).toEqual([
    "api/02 · Add token route · in-progress · attempt 2 · score 3.8/4.0 failed",
    "api/01 · Add schema · done · attempt 1",
    "port in use",
  ]);
  expect(w.runs.at(-1)).toEqual([
    "bun",
    expect.stringMatching(/\/skills\/autopilot\/scripts\/flightdeck\.ts$/),
    "--plan",
    "/abs/docs/x",
  ] as never);
});

test("agents with no task sit in a bordered box above the waves; none means no box", async ($, on) => {
  const dev = { role: "dev", ref: "api/02", attempt: 2, label: "dev-a", startedAt: null };
  world(on, (argv) => ({
    exitCode: 0,
    stdout: JSON.stringify(
      snap(argv[2]!, {
        agents: [dev],
        crew: [{ role: "scout", label: "scout-wave-2", status: "in-flight", startedAt: null, elapsedMs: null }],
      }),
    ),
  }));
  await run($, "/abs/docs/x");
  const ui = await mountPane($);
  const box = await ui.find({ key: "loose-agents" });
  expect(box).toBeDefined();
  const texts = (await ui.findAll({ type: "Text" })).map((el) => el.text);
  const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
  expect(at("scout scout-wave-2")).toBeGreaterThan(-1);
  expect(at("scout scout-wave-2")).toBeLessThan(at("running"));
  expect(at("wave 1/1")).toBeLessThan(at("running"));
  expect(at("running")).toBeLessThan(at("W1"));
  expect(at("dev #2")).toBeGreaterThan(at("W1"));
  await ui.unmount();
});

test("a pane with no taskless agents draws no agent box", async ($, on) => {
  world(on, (argv) => good(argv[2]!));
  await run($, "/abs/docs/x");
  const ui = await mountPane($);
  expect(await ui.find({ key: "loose-agents" })).toBeUndefined();
  await ui.unmount();
});

test("a done task's tokens are read once, with --usage, and kept on later ticks", async ($, on) => {
  const w = world(on, (argv) => {
    // every snapshot carries the run's time; only a --usage one carries tokens
    const s = snap(argv[2]!, { time: { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:04:12Z" } });
    if (argv.includes("--usage")) {
      s.tasks["api/01"]!.tokens = 1_234_567;
      s.tokens = 2_000_000;
    }
    return { exitCode: 0, stdout: JSON.stringify(s) };
  });
  await run($, "/abs/docs/x");
  await w.clock.advance(8000);
  const usage = w.runs.filter((argv) => argv.includes("--usage"));
  expect(usage).toHaveLength(1);
  const texts = await drawnText($);
  expect(texts).toContain("3m12s");
  expect(texts).toContain("1.2M tok");
  expect(texts).toContain("2.0M tok");
  expect(texts).toContain("Total Cost");
  const ui = await mountPane($);
  expect(await ui.find({ key: "totals" })).toBeDefined();
  await ui.unmount();
});

test("the inline seat draws two lines: the summary and the current wave's cards", async ($, on) => {
  world(on, (argv) => good(argv[2]!));
  await run($, "/abs/docs/x");
  const ui = await mountPane($, "inline");
  expect(await ui.find({ key: "open" })).toBeUndefined();
  expect(await ui.find({ key: "card:api/01" })).toBeDefined();
  const rows = ((await ui.drawn()) as { children: unknown[] }).children;
  await ui.unmount();
  expect(rows).toHaveLength(2);
});

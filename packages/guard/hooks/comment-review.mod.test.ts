import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { CLEAN, MARK } from "./reviewer.ts";

const REPORT = "🧹 comment-sweep: 1 comment block(s), 3 lines, in app.ts.";
const turn = { turnId: "t", text: "go" };
const end = {
  answer: "",
  durationMs: 0,
  isAborted: false,
  turnId: "t",
  reason: "answer",
} as const;

// Stands for the engine beneath the mod: the sweep script's answers, the agent runner, the prompt queue, and toasts. A noun answering a primitive answers `{ value }`.
function world(
  on: On,
  opts: { report?: string; settled?: string[]; bun?: false; agentFile?: false } = {},
) {
  const runs: { argv: readonly string[]; stdin?: string }[] = [];
  const spawns: { subagent_type?: string; prompt: string }[] = [];
  const registered: Record<string, unknown>[] = [];
  const submitted: string[] = [];
  const toasts: string[] = [];
  const statuses: (string | undefined)[] = [];
  const clock = mock.clock(on);
  on("session.id", () => ({ value: "s-1" }) as never);
  on("session.cwd", () => ({ value: "/repo" }) as never);
  on("process.run", (_$, e) => {
    if (opts.bun === false) throw new Error("ENOENT bun");
    runs.push({ argv: e.argv, stdin: e.init?.stdin });
    const found =
      e.argv[2] === "sweep" && opts.report !== undefined
        ? JSON.stringify({
            report: opts.report,
            blocks: 1,
            ask: "",
            note: null,
            settled: opts.settled,
          })
        : "";
    return {
      value: {
        exitCode: 0,
        stdout: found,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  on("fs.read", (_$, e) => {
    if (opts.agentFile === false || !e.path.endsWith("/agents/comments-reaper.md")) {
      throw new Error("ENOENT");
    }
    return {
      value: "---\nname: comments-reaper\ntools: [\"Read\"]\n---\n\nJudge each + line.\n",
    } as never;
  });
  on("agent.register", (_$, e) => {
    registered.push(e as never);
    return { value: { agent: `guard:${e.name}` } } as never;
  });
  on("agent.spawn", (_$, e) => {
    spawns.push(e as never);
    return { model: "sonnet", agentId: `r${spawns.length}` } as never;
  });
  on(
    "agent.list",
    () =>
      ({
        value: spawns.map((_, i) => ({
          id: `r${i + 1}`,
          description: "review added comments",
          type: "guard:comment-reviewer",
          status: "running",
        })),
      }) as never,
  );
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return e as never;
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined } as never;
  });
  on("ui.status", (_$, e) => {
    statuses.push(e.text);
    return { value: undefined } as never;
  });
  on("session.start", (_$, e) => e as never);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }) as never);
  on("turn.complete", () => ({ text: "" }) as never);
  const sweeps = () => runs.filter((r) => r.argv[2] === "sweep").length;
  const snapshots = () => runs.filter((r) => r.argv[2] === "snapshot").length;
  return {
    runs,
    spawns,
    registered,
    submitted,
    toasts,
    statuses,
    clock,
    sweeps,
    snapshots,
  };
}

test("the session registers the reviewer on sonnet at medium effort, read-only", async ($, on) => {
  const w = world(on);
  await $.session.start({
    cwd: "/repo",
    surface: "terminal",
    isInteractive: true,
  } as never);
  expect(w.registered).toHaveLength(1);
  expect(w.registered[0]).toEqual(
    expect.objectContaining({
      name: "comment-reviewer",
      model: "sonnet",
      effort: "medium",
      tools: ["Read", "Grep", "Glob"],
      prompt: "Judge each + line.",
    }),
  );
});

test("an unreadable agent file registers no reviewer and says so", async ($, on) => {
  const w = world(on, { agentFile: false });
  await $.session.start({
    cwd: "/repo",
    surface: "terminal",
    isInteractive: true,
  } as never);
  expect(w.registered).toHaveLength(0);
  expect(w.toasts.join("\n")).toContain("comments-reaper.md");
});

test("a main turn's start snapshots the worktree for this session", async ($, on) => {
  const w = world(on);
  await $.turn.start(turn);
  expect(w.runs[0]!.argv.slice(2)).toEqual(["snapshot"]);
  expect(w.runs[0]!.argv[1]).toEndWith("/hooks/comment-sweep.ts");
  expect(JSON.parse(w.runs[0]!.stdin!)).toEqual({
    session_id: "s-1",
    cwd: "/repo",
  });
});

test("a turn that added a reportable block sends the report to the reviewer", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  expect(w.runs.at(-1)!.argv.slice(2)).toEqual(["sweep", "--json"]);
  expect(w.spawns).toHaveLength(1);
  expect(w.spawns[0]!.subagent_type).toBe("guard:comment-reviewer");
  expect(w.spawns[0]!.prompt).toContain(REPORT);
});

test("a report Jev settled skips the reviewer and delivers its DELETEs", async ($, on) => {
  const w = world(on, {
    report: REPORT,
    settled: ["app.ts:2 DELETE — Jev p=0.90: restates the code"],
  });
  await $.turn.start(turn);
  await $.turn.complete(end);
  expect(w.spawns).toHaveLength(0);
  expect(w.submitted).toHaveLength(1);
  expect(w.submitted[0]).toStartWith(MARK);
  expect(w.submitted[0]).toContain("app.ts:2 DELETE — Jev p=0.90: restates the code");
  expect(w.statuses).toEqual([]);
});

test("a report Jev settled as all KEEP submits nothing", async ($, on) => {
  const w = world(on, { report: REPORT, settled: [] });
  await $.turn.start(turn);
  await $.turn.complete(end);
  expect(w.spawns).toHaveLength(0);
  expect(w.submitted).toHaveLength(0);
});

test("a turn that added nothing reportable spawns no reviewer", async ($, on) => {
  const w = world(on);
  await $.turn.start(turn);
  await $.turn.complete(end);
  expect(w.sweeps()).toBe(1);
  expect(w.spawns).toHaveLength(0);
});

test("the reviewer's verdicts come back as a prompt for the main agent", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  await $.turn.complete({
    ...end,
    agentId: "r1",
    answer: "app.ts:2 DELETE — restates",
  });
  expect(w.submitted).toHaveLength(1);
  expect(w.submitted[0]).toStartWith(MARK);
  expect(w.submitted[0]).toContain("app.ts:2 DELETE — restates");
});

test("a running reviewer stays pinned under the prompt until it answers", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  expect(w.statuses).toEqual([`${MARK}: reviewing 1 comment block(s)…`]);
  await $.turn.complete({ ...end, agentId: "r1", answer: CLEAN });
  expect(w.statuses.at(-1)).toBeUndefined();
});

test("a reviewer silent past the stale limit is unpinned", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  await w.clock.advance(11 * 60_000);
  await $.turn.start({ turnId: "t2", text: "more" });
  await $.turn.complete({ ...end, turnId: "t2" });
  expect(w.statuses).toEqual([
    `${MARK}: reviewing 1 comment block(s)…`,
    undefined,
    `${MARK}: reviewing 1 comment block(s)…`,
  ]);
});

test("a reviewer that keeps every line submits nothing", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  await $.turn.complete({ ...end, agentId: "r1", answer: CLEAN });
  expect(w.submitted).toHaveLength(0);
});

test("another agent's turn end is not mistaken for the reviewer's", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  await $.turn.complete({ ...end, agentId: "other", answer: "x" });
  expect(w.submitted).toHaveLength(0);
  expect(w.sweeps()).toBe(1);
});

test("the delivery turn's own fix-up summons no second review", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start({ turnId: "d", text: `${MARK} reviewed …` });
  await $.turn.complete({ ...end, turnId: "d" });
  expect(w.sweeps()).toBe(1);
  expect(w.spawns).toHaveLength(0);
});

test("turns that end while the reviewer runs carry over into the next review", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete(end);
  await $.turn.start({ turnId: "t2", text: "more" });
  await $.turn.complete({ ...end, turnId: "t2" });
  expect(w.sweeps()).toBe(1);

  await $.turn.complete({
    ...end,
    agentId: "r1",
    answer: "app.ts:2 DELETE — x",
  });
  await $.turn.start({ turnId: "d", text: w.submitted[0]! });
  expect(w.snapshots()).toBe(2);
  await $.turn.complete({ ...end, turnId: "d" });
  expect(w.sweeps()).toBe(2);
  expect(w.spawns).toHaveLength(2);
});

test("an interrupted turn carries over instead of being swept", async ($, on) => {
  const w = world(on, { report: REPORT });
  await $.turn.start(turn);
  await $.turn.complete({ ...end, reason: "aborted", isAborted: true });
  await $.turn.start({ turnId: "t2", text: "again" });
  expect(w.sweeps()).toBe(0);
  expect(w.snapshots()).toBe(1);
});

test("a missing bun says so instead of guarding nothing in silence", async ($, on) => {
  const w = world(on, { bun: false });
  await $.turn.start(turn);
  expect(w.toasts.join("\n")).toContain("bun");
});

test("only guard's own spawn of its reviewer skips the permission check", async ($, on) => {
  world(on);
  on("tool.check", () => ({ decision: "ask" }) as never);
  const check = await $.tool.check({
    tool: "Agent",
    input: { subagent_type: "guard:comment-reviewer", prompt: "x" },
  } as never);
  expect(check.decision).toBe("ask");
});

test("the reviewer's hand-back is refused, so its report reaches no card", async ($, on) => {
  const w = world(on, { report: REPORT });
  on("tool.call", () => ({ result: {}, text: "delivered" }) as never);
  await $.turn.start(turn);
  await $.turn.complete(end);
  const ran = await $.tool.call({
    tool: "SubagentHandback",
    agentId: "r1",
    report: "x",
  } as never);
  expect((ran as { deny?: string }).deny).toContain("final message");
  expect(w.spawns).toHaveLength(1);
});

test("another agent's hand-back goes through", async ($, on) => {
  world(on, { report: REPORT });
  on("tool.call", () => ({ result: {}, text: "delivered" }) as never);
  const ran = await $.tool.call({
    tool: "SubagentHandback",
    agentId: "other",
    report: "x",
  } as never);
  expect((ran as { deny?: string }).deny).toBeUndefined();
});

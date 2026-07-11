import { describe, expect, it } from "bun:test";
import { join } from "path";
import {
  compareVersionsDesc,
  DEFAULT_WAIT_TIMEOUT_MS,
  extractFinalText,
  liveGate,
  resolveHerdScript,
  runLive,
  type HerdClient,
  type LocatorDeps,
  type RunLiveDeps,
  type RunLiveOpts,
} from "./live";
import { RESULT_END_MARKER } from "./relay-prompt";
import { BACKENDS } from "./backends";

// ---------------------------------------------------------------------------
// resolveHerdScript
// ---------------------------------------------------------------------------

const SIBLING = "/repo/packages/herdr/skills/herdr/scripts/herd.ts";

function locator(overrides: Partial<LocatorDeps> = {}): LocatorDeps {
  return {
    env: {},
    scriptDir: "/repo/packages/relay/skills/relay/scripts",
    homeDir: "/home/q",
    fileExists: () => false,
    listDir: () => [],
    ...overrides,
  };
}

describe("resolveHerdScript", () => {
  it("prefers the HERD_SCRIPT_PATH override when it exists", () => {
    const deps = locator({
      env: { HERD_SCRIPT_PATH: "/custom/herd.ts" },
      fileExists: (p) => p === "/custom/herd.ts" || p === SIBLING,
    });

    expect(resolveHerdScript(deps)).toBe("/custom/herd.ts");
  });

  it("ignores a HERD_SCRIPT_PATH that does not exist", () => {
    const deps = locator({
      env: { HERD_SCRIPT_PATH: "/missing/herd.ts" },
      fileExists: (p) => p === SIBLING,
    });

    expect(resolveHerdScript(deps)).toBe(SIBLING);
  });

  it("finds the repo-sibling herd.ts (4-up marketplace layout)", () => {
    const deps = locator({ fileExists: (p) => p === SIBLING });

    expect(resolveHerdScript(deps)).toBe(SIBLING);
  });

  it("scans plugin caches newest-version-first, across both harnesses", () => {
    const claudeRoot = "/home/q/.claude/plugins/cache";
    const codexRoot = "/home/q/.codex/plugins/cache";
    const newest = join(
      codexRoot,
      "q-lab-marketplace/herdr/0.10.0/skills/herdr/scripts/herd.ts",
    );
    const older = join(
      codexRoot,
      "q-lab-marketplace/herdr/0.9.1/skills/herdr/scripts/herd.ts",
    );

    const deps = locator({
      fileExists: (p) => p === newest || p === older,
      listDir: (p) => {
        if (p === claudeRoot) return []; // herdr not installed for Claude here
        if (p === codexRoot) return ["q-lab-marketplace"];
        if (p === join(codexRoot, "q-lab-marketplace/herdr"))
          // Directory order is arbitrary — numeric-aware sort must pick 0.10.0
          return ["0.9.1", "0.10.0"];
        return [];
      },
    });

    expect(resolveHerdScript(deps)).toBe(newest);
  });

  it("returns null when nothing resolves", () => {
    expect(resolveHerdScript(locator())).toBeNull();
  });
});

describe("compareVersionsDesc", () => {
  it("sorts numerically, not lexically", () => {
    expect(["0.2.0", "0.10.0", "0.9.1"].sort(compareVersionsDesc)).toEqual([
      "0.10.0",
      "0.9.1",
      "0.2.0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// liveGate
// ---------------------------------------------------------------------------

describe("liveGate", () => {
  const base = {
    env: { HERDR_ENV: "1" },
    headless: false,
    mode: "delegate" as const,
    backend: BACKENDS.codex,
    herdScriptPath: "/x/herd.ts",
  };

  it("goes live when everything lines up", () => {
    expect(liveGate(base)).toEqual({ live: true });
  });

  it("stays headless outside herdr, silently", () => {
    expect(liveGate({ ...base, env: {} })).toEqual({ live: false });
  });

  it("stays headless on --headless, silently", () => {
    expect(liveGate({ ...base, headless: true })).toEqual({ live: false });
  });

  it("stays headless for image mode, silently", () => {
    expect(liveGate({ ...base, mode: "image" })).toEqual({ live: false });
  });

  it("reports a reason when the backend has no live seam", () => {
    const backend = { ...BACKENDS.codex, invokeLive: undefined };
    const gate = liveGate({ ...base, backend });

    expect(gate.live).toBe(false);
    expect(gate.reason).toContain("no live-pane support");
  });

  it("reports a reason when herd.ts is unresolved", () => {
    const gate = liveGate({ ...base, herdScriptPath: null });

    expect(gate.live).toBe(false);
    expect(gate.reason).toContain("herd.ts not found");
  });
});

// ---------------------------------------------------------------------------
// extractFinalText
// ---------------------------------------------------------------------------

describe("extractFinalText", () => {
  it("strips the marker and trailing whitespace", () => {
    expect(extractFinalText(`# Answer\n\nbody\n${RESULT_END_MARKER}\n\n`)).toBe(
      "# Answer\n\nbody",
    );
  });

  it("returns null when the marker is absent (mid-write)", () => {
    expect(extractFinalText("# Answer\n\nbody\n")).toBeNull();
  });

  it("returns null when text follows the marker", () => {
    expect(
      extractFinalText(`body\n${RESULT_END_MARKER}\ntrailing junk\n`),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runLive
// ---------------------------------------------------------------------------

type HerdCall = { verb: string; args: unknown[] };

function fakeHerd(options: {
  statuses: string[]; // status returned per get() call (last repeats)
  spawnError?: Error;
  sendError?: Error;
  closeError?: Error;
  getErrorAtGet?: number;
  preSpawnAgents?: string[]; // list() result before spawn (snapshot)
  postSpawnAgents?: string[]; // list() result after spawn (leak probe)
  visible?: string; // what read({source:"visible"}) returns (input-box probe)
}): { herd: HerdClient; calls: HerdCall[] } {
  const calls: HerdCall[] = [];
  let gets = 0;
  let lists = 0;
  const herd: HerdClient = {
    async spawn(opts) {
      calls.push({ verb: "spawn", args: [opts] });
      if (options.spawnError) throw options.spawnError;
      return { name: "relay-codex-delegate-ab12" };
    },
    async list() {
      calls.push({ verb: "list", args: [] });
      const names =
        lists++ === 0
          ? (options.preSpawnAgents ?? [])
          : (options.postSpawnAgents ?? options.preSpawnAgents ?? []);
      return names.map((name) => ({ name }));
    },
    async send(target, text) {
      calls.push({ verb: "send", args: [target, text] });
      if (options.sendError) throw options.sendError;
      return {};
    },
    async keys(target, ...keys) {
      calls.push({ verb: "keys", args: [target, ...keys] });
      return {};
    },
    async wait(target, opts) {
      calls.push({ verb: "wait", args: [target, opts] });
      return {};
    },
    async get(target) {
      calls.push({ verb: "get", args: [target] });
      if (options.getErrorAtGet === gets + 1) throw new Error("get failed");
      const status =
        options.statuses[Math.min(gets++, options.statuses.length - 1)];
      return { status };
    },
    async read(target, opts) {
      calls.push({ verb: "read", args: [target, opts] });
      return options.visible ?? "";
    },
    async close(target) {
      calls.push({ verb: "close", args: [target] });
      if (options.closeError) throw options.closeError;
      return {};
    },
  };
  return { herd, calls };
}

function runLiveHarness(options: {
  statuses: string[];
  resultAppearsAtGet?: number; // result.md exists from this get() count on
  resultContent?: string;
  waitTimeoutMs?: number;
  spawnError?: Error;
  sendError?: Error;
  closeError?: Error;
  getErrorAtGet?: number;
  loadError?: Error;
  preSpawnAgents?: string[];
  postSpawnAgents?: string[];
  visible?: string;
  keepPane?: boolean;
}) {
  const { herd, calls } = fakeHerd(options);
  const errors: string[] = [];
  let clock = 0;
  let gets = 0;

  const opts: RunLiveOpts = {
    backend: "codex",
    mode: "delegate",
    spec: { agentBin: "codex", argv: ["-m", "gpt-6"] },
    herdScriptPath: "/x/herd.ts",
    bootstrapText: "Read the file /tmp/relay/run/live-prompt.md …",
    resultPath: "/tmp/relay/run/result.md",
    cwd: "/repo",
    waitTimeoutMs: options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    keepPane: options.keepPane ?? false,
    env: ["RELAY_DELEGATED=1"],
  };

  const deps: RunLiveDeps = {
    loadHerd: async () => {
      if (options.loadError) throw options.loadError;
      return herd;
    },
    fileExists: (p) => {
      if (p !== opts.resultPath) return false;
      return (
        options.resultAppearsAtGet !== undefined &&
        gets >= options.resultAppearsAtGet
      );
    },
    readFile: () => options.resultContent ?? "",
    stderr: (text) => errors.push(text),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };

  // Track get() count for fileExists gating (herd.get is already counted in
  // calls; mirror it here without reaching into fakeHerd internals).
  const originalGet = herd.get.bind(herd);
  herd.get = async (target) => {
    gets++;
    return originalGet(target);
  };

  return { run: () => runLive(opts, deps), calls, errors, opts };
}

describe("runLive", () => {
  it("spawns, sends only the bootstrap line, and captures the marked result", async () => {
    const content = `# Result\n\nAll done.\n${RESULT_END_MARKER}\n`;
    const { run, calls, errors } = runLiveHarness({
      statuses: ["working", "idle"],
      resultAppearsAtGet: 2,
      resultContent: content,
    });

    const result = await run();

    expect(result).toEqual({
      ok: true,
      agentName: "relay-codex-delegate-ab12",
      text: "# Result\n\nAll done.",
    });

    const spawn = calls.find((c) => c.verb === "spawn")!.args[0] as Record<
      string,
      unknown
    >;
    expect(spawn.role).toBe("relay-codex-delegate");
    expect(spawn.agent).toBe("codex");
    expect(spawn.argv).toEqual(["-m", "gpt-6"]);
    expect(spawn.env).toEqual(["RELAY_DELEGATED=1"]);
    // Opens its own tab; split stays as a fallback for an older herd.ts.
    expect(spawn.newTab).toBe(true);
    expect(spawn.split).toBe("down");
    expect(spawn.cwd).toBe("/repo");

    // Exactly one send, carrying the one-line bootstrap — never the prompt body.
    const sends = calls.filter((c) => c.verb === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].args[1]).toContain("live-prompt.md");

    // Progress lines surfaced each poll.
    expect(errors.some((e) => e.includes("working"))).toBe(true);
  });

  it("closes the pane by default after a verified success", async () => {
    const content = `# Result\n${RESULT_END_MARKER}\n`;
    const { run, calls } = runLiveHarness({
      statuses: ["working", "idle"],
      resultAppearsAtGet: 2,
      resultContent: content,
    });

    const result = await run();

    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.verb === "close")).toEqual([
      { verb: "close", args: ["relay-codex-delegate-ab12"] },
    ]);
  });

  it("keeps the pane open on verified success when keepPane is true", async () => {
    const content = `# Result\n${RESULT_END_MARKER}\n`;
    const { run, calls } = runLiveHarness({
      statuses: ["working", "idle"],
      resultAppearsAtGet: 2,
      resultContent: content,
      keepPane: true,
    });

    const result = await run();

    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.verb === "close")).toBe(false);
  });

  it("still returns ok when closing the pane fails after verified success", async () => {
    const content = `# Result\n${RESULT_END_MARKER}\n`;
    const { run, calls, errors } = runLiveHarness({
      statuses: ["working", "idle"],
      resultAppearsAtGet: 2,
      resultContent: content,
      closeError: new Error("close failed"),
    });

    const result = await run();

    expect(result).toEqual({
      ok: true,
      agentName: "relay-codex-delegate-ab12",
      text: "# Result",
    });
    expect(calls.some((c) => c.verb === "close")).toBe(true);
    expect(errors.some((e) => e.includes("failed to close pane"))).toBe(true);
  });

  it("keeps polling while the marker is missing, then times out pending — without closing", async () => {
    const { run, calls } = runLiveHarness({
      statuses: ["working"],
      resultAppearsAtGet: 1,
      resultContent: "partial answer, no marker yet\n",
      waitTimeoutMs: 12_000,
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || !result.pending) throw new Error("expected pending");
    expect(result.agentName).toBe("relay-codex-delegate-ab12");
    expect(result.report).toContain("relay-codex-delegate-ab12");
    expect(result.report).toContain("/tmp/relay/run/result.md");
    expect(result.report).toContain("wait");
    expect(result.report).toContain("close");
    expect(result.report).toContain("NOT a failure");
    // relay never kills or closes the pane.
    expect(calls.some((c) => c.verb === "close")).toBe(false);
  });

  it("fails without closing when the agent settled at timeout without a verified result", async () => {
    const { run, calls } = runLiveHarness({
      statuses: ["done"],
      waitTimeoutMs: 4_000,
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || result.pending) throw new Error("expected failure");
    expect(result.agentName).toBe("relay-codex-delegate-ab12");
    expect(result.error).toContain("settled");
    expect(result.error).toContain("done");
    expect(calls.some((c) => c.verb === "close")).toBe(false);
  });

  it("times out pending when the final status check is unreadable", async () => {
    const { run, calls } = runLiveHarness({
      statuses: ["working"],
      waitTimeoutMs: 4_000,
      getErrorAtGet: 2,
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || !result.pending) throw new Error("expected pending");
    expect(result.agentName).toBe("relay-codex-delegate-ab12");
    expect(result.report).toContain("NOT a failure");
    expect(calls.some((c) => c.verb === "close")).toBe(false);
  });

  it("keeps polling when the marker landed but the agent is still working", async () => {
    const content = `early write\n${RESULT_END_MARKER}\n`;
    const { run, calls } = runLiveHarness({
      statuses: ["working", "working", "idle"],
      resultAppearsAtGet: 1,
      resultContent: content,
    });

    const result = await run();

    expect(result.ok).toBe(true);
    // Completed on the third poll (first idle), not the first marker sighting.
    expect(calls.filter((c) => c.verb === "get")).toHaveLength(3);
  });

  it("completes when the agent parks at 'done' (codex) with a marked result", async () => {
    const content = `4\n${RESULT_END_MARKER}\n`;
    const { run, calls } = runLiveHarness({
      statuses: ["working", "done"], // codex settles to done, not idle
      resultAppearsAtGet: 2,
      resultContent: content,
    });

    const result = await run();

    expect(result).toEqual({
      ok: true,
      agentName: "relay-codex-delegate-ab12",
      text: "4",
    });
    // 'done' is treated as activity → it must never trigger a bootstrap nudge.
    expect(calls.filter((c) => c.verb === "send")).toHaveLength(1);
  });

  it("re-sends the bootstrap (at most twice) when the pane never leaves idle — lost delivery", async () => {
    const { run, calls, errors, opts } = runLiveHarness({
      statuses: ["idle"], // never works, no result file ever appears
      waitTimeoutMs: 22_000, // 5 polls
    });

    const result = await run();

    expect(result.ok).toBe(false);
    const sends = calls.filter((c) => c.verb === "send");
    // Initial bootstrap + exactly two full re-sends (recovers BOTH a swallowed
    // Enter and lost text — a bare Enter can't restore a lost line), then stop.
    expect(sends).toHaveLength(3);
    expect(sends[1].args[1]).toBe(opts.bootstrapText);
    expect(sends[2].args[1]).toBe(opts.bootstrapText);
    expect(errors.some((e) => e.includes("re-sending the bootstrap"))).toBe(
      true,
    );
  });

  it("recovers via the bootstrap re-send and never nudges after seeing activity", async () => {
    const content = `2\n${RESULT_END_MARKER}\n`;
    const { run, calls } = runLiveHarness({
      statuses: ["idle", "working", "idle"], // stuck → nudged → runs → done
      resultAppearsAtGet: 3,
      resultContent: content,
    });

    const result = await run();

    expect(result.ok).toBe(true);
    const sends = calls.filter((c) => c.verb === "send");
    expect(sends).toHaveLength(2); // bootstrap + one nudge only
  });

  it("presses Enter only (never re-sends) when the bootstrap sits unsubmitted in the input", async () => {
    const { run, calls, errors } = runLiveHarness({
      statuses: ["idle"], // never leaves idle, no result file
      waitTimeoutMs: 7_000, // one poll → one nudge
      visible: "Read the file /tmp/relay/run/live-prompt.md …", // full line present
    });

    const result = await run();

    expect(result.ok).toBe(false);
    // Only the initial bootstrap was sent — the nudge pressed Enter, no duplicate.
    const sends = calls.filter((c) => c.verb === "send");
    expect(sends).toHaveLength(1);
    const keys = calls.filter((c) => c.verb === "keys");
    expect(keys[0].args).toEqual(["relay-codex-delegate-ab12", "enter"]);
    expect(errors.some((e) => e.includes("pressing Enter"))).toBe(true);
  });

  it("clears the line then re-sends on a partial paste (head present, tail missing)", async () => {
    const { run, calls, errors } = runLiveHarness({
      statuses: ["idle"],
      waitTimeoutMs: 4_000, // one poll → one nudge (budget checked before the sleep)
      visible: "Read the file /tmp/relay/run/liv", // truncated — no tail token
    });

    const result = await run();

    expect(result.ok).toBe(false);
    const keys = calls.filter((c) => c.verb === "keys");
    expect(keys[0].args).toEqual([
      "relay-codex-delegate-ab12",
      "ctrl+a",
      "ctrl+k",
    ]);
    const sends = calls.filter((c) => c.verb === "send");
    expect(sends).toHaveLength(2); // initial + one re-send after clearing
    expect(errors.some((e) => e.includes("partial bootstrap"))).toBe(true);
  });

  it("falls back cleanly when herd.ts cannot be loaded (nothing spawned)", async () => {
    const { run, calls } = runLiveHarness({
      statuses: [],
      loadError: new Error("module not found"),
    });

    const result = await run();

    expect(result).toEqual({
      ok: false,
      pending: false,
      error: "failed to load herd.ts: module not found",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports a spawn failure without an agent name (safe to fall back)", async () => {
    const { run } = runLiveHarness({
      statuses: [],
      spawnError: new Error("no herdr session"),
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || result.pending) throw new Error("expected error");
    expect(result.agentName).toBeUndefined();
    expect(result.error).toContain("no herdr session");
  });

  it("surfaces the leaked pane name when spawn throws AFTER creating it (no headless fallback)", async () => {
    // agent start created the pane, then returned malformed JSON → spawn threw.
    const { run } = runLiveHarness({
      statuses: [],
      spawnError: new Error("bad JSON envelope"),
      preSpawnAgents: ["relay-codex-delegate-old1"],
      postSpawnAgents: [
        "relay-codex-delegate-old1",
        "relay-codex-delegate-9x2f",
      ],
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || result.pending) throw new Error("expected error");
    // agentName present → relay reports instead of double-running headless.
    expect(result.agentName).toBe("relay-codex-delegate-9x2f");
    expect(result.error).toContain("bad JSON envelope");
  });

  it("does not mistake a pre-existing kept-open pane for a leaked spawn", async () => {
    // A same-prefix pane from an earlier run (user chose keep) is in BOTH
    // snapshots — a genuinely failed spawn must still allow headless fallback.
    const { run } = runLiveHarness({
      statuses: [],
      spawnError: new Error("no herdr session"),
      preSpawnAgents: ["relay-codex-delegate-kept"],
      postSpawnAgents: ["relay-codex-delegate-kept"],
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || result.pending) throw new Error("expected error");
    expect(result.agentName).toBeUndefined();
  });

  it("reports a send failure WITH the agent name (pane already exists)", async () => {
    const { run } = runLiveHarness({
      statuses: [],
      sendError: new Error("pane gone"),
    });

    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok || result.pending) throw new Error("expected error");
    expect(result.agentName).toBe("relay-codex-delegate-ab12");
    expect(result.error).toContain("pane gone");
  });
});

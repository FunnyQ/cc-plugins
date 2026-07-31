/**
 * live.ts — relay's optional live-pane execution layer.
 *
 * When relay runs inside herdr (HERDR_ENV=1), delegates/reviews can run in a
 * VISIBLE, take-over-able sibling pane driving the backend's interactive TUI
 * instead of a blocking headless spawn. The herdr wrapper (herd.ts) is loaded
 * via DYNAMIC import only when the live path is actually taken — relay must
 * stay portable to machines with no herdr plugin installed at all, so there is
 * no static herdr import anywhere in relay.
 *
 * Result capture is a file contract (see relay-prompt.appendFileContract):
 * the delegate writes its final answer to <dir>/result.md ending with
 * RESULT_END_MARKER; relay polls for agent-idle + marker. Pane reads are a
 * dead end — alt-screen TUIs leave scrollback empty.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import type { Backend, LiveSpec, Mode } from "./types";
import { RESULT_END_MARKER } from "./relay-prompt";

export const DEFAULT_WAIT_TIMEOUT_MS = 600_000; // 10 min
export const POLL_INTERVAL_MS = 5_000;
export const SPAWN_IDLE_WAIT_MS = 20_000;

// relay.ts is this file's sibling by construction, so the pending report can
// print a runnable `relay collect` line without relay.ts plumbing its own path
// down here. fileURLToPath, NOT url.pathname: a plugin cache under a directory
// with a space arrives percent-encoded, and %20 in a printed command is a path
// that does not exist.
const RELAY_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "relay.ts",
);

// Quote a value for a command line we PRINT for someone to copy. Bare when it
// is already shell-safe (the common case, so reports stay readable); single
// quoted otherwise, since install paths really do contain spaces.
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// herd.ts locator
// ---------------------------------------------------------------------------

export type LocatorDeps = {
  env: Record<string, string | undefined>;
  scriptDir: string; // relay's own scripts/ dir (for the repo-sibling probe)
  homeDir: string;
  fileExists: (path: string) => boolean;
  listDir: (path: string) => string[]; // entry names; [] when missing/unreadable
};

export function defaultLocatorDeps(): LocatorDeps {
  return {
    env: process.env,
    // fileURLToPath, not url.pathname: an install path containing a space
    // arrives percent-encoded, and the sibling probe would then miss herd.ts
    // and silently fall back to headless.
    scriptDir: dirname(fileURLToPath(import.meta.url)),
    homeDir: homedir(),
    fileExists: existsSync,
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}

// Numeric-aware DESC version comparator: "3.10.0" sorts above "3.9.1".
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.isNaN(pa[i]) || pa[i] === undefined ? 0 : pa[i];
    const nb = Number.isNaN(pb[i]) || pb[i] === undefined ? 0 : pb[i];
    if (na !== nb) return nb - na;
  }
  return 0;
}

/**
 * Locate herd.ts without any hard dependency on the herdr plugin:
 * 1. HERD_SCRIPT_PATH env override
 * 2. Repo sibling (this marketplace checkout: packages/relay ↔ packages/herdr)
 * 3. Plugin caches of BOTH harnesses, newest version first — the cross-harness
 *    scan rescues Codex-side relay when herdr is only installed for Claude.
 * 4. null → caller falls back headless.
 */
export function resolveHerdScript(
  deps: LocatorDeps = defaultLocatorDeps(),
): string | null {
  const override = deps.env.HERD_SCRIPT_PATH;
  if (override && deps.fileExists(override)) return override;

  const sibling = join(
    deps.scriptDir,
    "../../../../herdr/skills/herdr/scripts/herd.ts",
  );
  if (deps.fileExists(sibling)) return sibling;

  const cacheRoots = [
    join(deps.homeDir, ".claude", "plugins", "cache"),
    join(deps.homeDir, ".codex", "plugins", "cache"),
  ];
  for (const root of cacheRoots) {
    for (const marketplace of deps.listDir(root)) {
      const versionsDir = join(root, marketplace, "herdr");
      const versions = deps.listDir(versionsDir).sort(compareVersionsDesc);
      for (const version of versions) {
        const candidate = join(
          versionsDir,
          version,
          "skills",
          "herdr",
          "scripts",
          "herd.ts",
        );
        if (deps.fileExists(candidate)) return candidate;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type LiveGateInput = {
  env: Record<string, string | undefined>;
  headless: boolean; // --headless escape hatch
  mode: Mode;
  backend: Backend;
  herdScriptPath: string | null;
};

export type LiveGateResult = { live: boolean; reason?: string };

/**
 * Live iff inside herdr, not opted out, mode has a live path, the backend
 * exposes the live seam, and herd.ts resolved. `reason` is set only for
 * non-user denials (surfaced on stderr when HERDR_ENV=1) — env-off, --headless
 * and image mode are expected, silent outcomes.
 */
export function liveGate(input: LiveGateInput): LiveGateResult {
  if (input.env.HERDR_ENV !== "1") return { live: false };
  if (input.headless) return { live: false };
  if (input.mode !== "delegate" && input.mode !== "review") {
    return { live: false };
  }
  if (!input.backend.invokeLive) {
    return {
      live: false,
      reason: `${input.backend.name} has no live-pane support`,
    };
  }
  if (!input.herdScriptPath) {
    return { live: false, reason: "herd.ts not found (herdr plugin missing?)" };
  }
  return { live: true };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// The slice of herd.ts's createHerd() surface runLive drives.
export type HerdClient = {
  spawn(opts: {
    role: string;
    agent: string;
    cwd?: string;
    split?: "right" | "down";
    newTab?: boolean;
    workspace?: string;
    argv?: string[];
    env?: string[];
  }): Promise<{ name: string }>;
  send(target: string, text: string): Promise<unknown>;
  keys(target: string, ...keys: string[]): Promise<unknown>;
  wait(
    target: string,
    opts?: { status?: string; timeoutMs?: number },
  ): Promise<unknown>;
  get(target: string): Promise<{ status: string }>;
  read(
    target: string,
    opts?: { lines?: number; source?: string },
  ): Promise<string>;
  list(): Promise<HerdAgent[]>;
  close(target: string): Promise<unknown>;
};

export type HerdAgent = {
  name: string | null;
  type?: string | null;
  status?: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  cwd?: string;
  foregroundCwd?: string;
};

export type CallerLocation = {
  workspaceId: string;
  tabId: string;
  paneId: string;
  source: "env" | "runtime";
};

function callerAgentType(
  env: Record<string, string | undefined>,
): string | null {
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.OPENCODE_SESSION_ID) return "opencode";
  if (env.CLAUDE_CODE_SESSION_ID) return "claude";
  return null;
}

function hasLocation(agent: HerdAgent): agent is HerdAgent & {
  paneId: string;
  tabId: string;
  workspaceId: string;
} {
  return !!(agent.paneId && agent.tabId && agent.workspaceId);
}

/** True when `base` is `target` or one of its ancestor directories. Compared on
 * path segments, so /repo never matches a /repo-other sibling. */
function isAncestorOrSame(base: string | undefined, target: string): boolean {
  if (!base) return false;
  if (base === target) return true;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix);
}

/** How closely a pane's cwd covers the caller's: the length of the deepest of
 * its two cwds that contains `cwd`, or null when neither does. */
function cwdMatchDepth(agent: HerdAgent, cwd: string): number | null {
  const covering = [agent.cwd, agent.foregroundCwd].filter(
    (base): base is string => isAncestorOrSame(base, cwd),
  );
  if (!covering.length) return null;
  return Math.max(...covering.map((base) => base.length));
}

/** Resolve the live caller from Herdr's current runtime state. Codex tool
 * subprocesses can inherit stale HERDR_* ids from its long-lived app-server,
 * so inherited identity is accepted only when its workspace/tab/pane triple
 * uniquely matches an active caller, or its pane still describes this cwd.
 *
 * A pane's cwd is where it was opened; relay's process.cwd() is wherever the
 * agent happens to be running (a sub-agent, or a plain `cd` into a package),
 * which is commonly NESTED under it. So "describes this cwd" means the pane's
 * cwd contains ours — the deepest containing pane wins, and only a tie at that
 * depth is genuinely ambiguous. */
export function resolveCallerLocation(
  agents: HerdAgent[],
  input: {
    env: Record<string, string | undefined>;
    cwd: string;
  },
): CallerLocation | null {
  const expectedType = callerAgentType(input.env);
  const matchesType = (agent: HerdAgent) =>
    expectedType === null || agent.type === expectedType;

  const inheritedWorkspace = input.env.HERDR_WORKSPACE_ID;
  const inheritedTab = input.env.HERDR_TAB_ID;
  const inheritedPane = input.env.HERDR_PANE_ID;
  if (inheritedWorkspace && inheritedTab && inheritedPane) {
    const exactIdentity = agents.filter(
      (agent) =>
        hasLocation(agent) &&
        matchesType(agent) &&
        (agent.status === "working" || agent.status === "blocked") &&
        agent.workspaceId === inheritedWorkspace &&
        agent.tabId === inheritedTab &&
        agent.paneId === inheritedPane,
    );
    if (exactIdentity.length > 1) return null;
    const exact = exactIdentity[0];
    if (exact && hasLocation(exact)) {
      return {
        workspaceId: exact.workspaceId,
        tabId: exact.tabId,
        paneId: exact.paneId,
        source: "env",
      };
    }
  }

  const inherited = agents.find(
    (agent) =>
      agent.paneId === input.env.HERDR_PANE_ID &&
      hasLocation(agent) &&
      matchesType(agent) &&
      cwdMatchDepth(agent, input.cwd) !== null,
  );
  if (inherited && hasLocation(inherited)) {
    return {
      workspaceId: inherited.workspaceId,
      tabId: inherited.tabId,
      paneId: inherited.paneId,
      source: "env",
    };
  }

  const candidates = agents
    .filter(
      (agent) =>
        hasLocation(agent) &&
        matchesType(agent) &&
        (agent.status === "working" || agent.status === "blocked"),
    )
    .map((agent) => ({ agent, depth: cwdMatchDepth(agent, input.cwd) }))
    .filter((c): c is { agent: HerdAgent; depth: number } => c.depth !== null);
  if (!candidates.length) return null;

  const deepest = Math.max(...candidates.map((c) => c.depth));
  const best = candidates.filter((c) => c.depth === deepest);
  if (best.length !== 1) return null;

  const resolved = best[0]?.agent;
  if (!resolved || !hasLocation(resolved)) return null;
  return {
    workspaceId: resolved.workspaceId,
    tabId: resolved.tabId,
    paneId: resolved.paneId,
    source: "runtime",
  };
}

export type LiveRunResult =
  | { ok: true; agentName: string; text: string }
  | { ok: false; pending: true; agentName: string; report: string }
  | { ok: false; pending: false; agentName?: string; error: string };

// Everything the result poll needs, independent of HOW the pane got there.
// `selfHeal` is present only on the spawn path: re-delivering a bootstrap makes
// sense only for a pane we just created, never for one already mid-task.
type PollContext = {
  agentName: string;
  herdScriptPath: string;
  resultPath: string;
  waitTimeoutMs: number;
  keepPane: boolean;
  label: string; // "codex delegate" | "collect"
  selfHeal?: { bootstrapText: string };
};

export type RunLiveOpts = {
  backend: string;
  mode: Mode;
  spec: LiveSpec;
  herdScriptPath: string;
  bootstrapText: string; // one-liner sent to the pane (full prompt rides a file)
  resultPath: string;
  cwd: string;
  waitTimeoutMs: number;
  keepPane: boolean;
  env?: string[];
  callerEnv: Record<string, string | undefined>;
};

// Reattach to a pane that is already running — no spawn, no bootstrap, so no
// backend/spec/cwd is needed. Everything here comes off a pending report.
export type CollectLiveOpts = {
  agentName: string;
  herdScriptPath: string;
  resultPath: string;
  waitTimeoutMs: number;
  keepPane: boolean;
};

export type RunLiveDeps = {
  loadHerd: (herdScriptPath: string) => Promise<HerdClient>;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  stderr: (text: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export function defaultRunLiveDeps(): RunLiveDeps {
  return {
    loadHerd: async (herdScriptPath) => {
      const mod = await import(herdScriptPath);
      return mod.createHerd() as HerdClient;
    },
    fileExists: existsSync,
    readFile: (path) => readFileSync(path, "utf-8"),
    stderr: (text) => process.stderr.write(text),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

// The result file is final only when its last non-empty line is the marker.
// Marker absent = mid-write (or not started) — keep polling.
export function extractFinalText(content: string): string | null {
  const trimmed = content.trimEnd();
  const lines = trimmed.split("\n");
  if (lines.at(-1)?.trim() !== RESULT_END_MARKER) return null;
  return lines.slice(0, -1).join("\n").trimEnd();
}

function pendingReport(ctx: PollContext, elapsedMs: number): string {
  const herd = `bun ${shellArg(ctx.herdScriptPath)}`;
  const agent = shellArg(ctx.agentName);
  const result = shellArg(ctx.resultPath);
  // Carry --keep-pane forward: without it a copied collect command would close
  // a pane the original caller explicitly asked to keep.
  const keep = ctx.keepPane ? " --keep-pane" : "";
  return [
    `Live ${ctx.label} still running after ${Math.round(elapsedMs / 1000)}s — this is NOT a failure.`,
    `The pane was left open; the agent keeps working.`,
    ``,
    `Agent: ${ctx.agentName}`,
    `Result file: ${ctx.resultPath}`,
    ``,
    `Keep waiting — this reattaches to the SAME pane, and is repeatable:`,
    `  bun ${shellArg(RELAY_SCRIPT_PATH)} collect --agent ${agent} --result ${result} --wait-timeout ${ctx.waitTimeoutMs}${keep}`,
    ``,
    `Or drive the pane by hand:`,
    `  cat ${result}   # collect the answer once written`,
    `  ${herd} read ${agent}                  # read the pane (holds the answer if result.md was never written)`,
    `  ${herd} close ${agent}                 # close the pane when done`,
    `  ${herd} wait ${agent} --timeout ${ctx.waitTimeoutMs}   # blocks until \`idle\` ONLY — codex parks at \`done\`, so prefer collect`,
    ``,
  ].join("\n");
}

/**
 * Spawn the backend TUI in a sibling pane, send the bootstrap line, and poll
 * for agent-idle + result-file marker. A verified success closes the pane
 * unless keepPane is set. Timeout exits are status-aware: still-working panes
 * return pending, already-settled panes without a verified result return
 * failure, and every non-success outcome leaves the pane open for postmortem.
 */
export async function runLive(
  opts: RunLiveOpts,
  deps: RunLiveDeps = defaultRunLiveDeps(),
): Promise<LiveRunResult> {
  let herd: HerdClient;
  try {
    herd = await deps.loadHerd(opts.herdScriptPath);
  } catch (error) {
    return {
      ok: false,
      pending: false,
      error: `failed to load herd.ts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const role = `relay-${opts.backend}-${opts.mode}`;

  // Snapshot existing agent names BEFORE spawning: `herd.spawn` wraps an
  // external CLI call that can fail after its side effect (pane created, then
  // malformed/empty JSON or a transient non-zero). The diff below tells a
  // truly-failed spawn apart from one that leaked a live pane.
  let namesBefore = new Set<string>();
  let callerLocation: CallerLocation | null = null;
  try {
    const agents = await herd.list();
    namesBefore = new Set(
      agents.map((a) => a.name).filter((n): n is string => n !== null),
    );
    callerLocation = resolveCallerLocation(agents, {
      env: opts.callerEnv,
      cwd: opts.cwd,
    });
  } catch {
    /* handled by the caller-location guard below */
  }
  if (!callerLocation) {
    return {
      ok: false,
      pending: false,
      error:
        "could not uniquely resolve the calling Herdr workspace from current agent state",
    };
  }

  let agentName: string | undefined;
  try {
    const spawned = await herd.spawn({
      role,
      agent: opts.spec.agentBin,
      argv: opts.spec.argv.length ? opts.spec.argv : undefined,
      env: opts.env,
      cwd: opts.cwd,
      workspace: callerLocation.workspaceId,
      // Open the agent in its OWN tab so the caller's pane keeps its full size.
      // `split` is kept as a fallback: an older herd.ts without newTab support
      // ignores newTab and degrades to a down-split instead of failing.
      newTab: true,
      split: "down",
    });
    agentName = spawned.name;
  } catch (error) {
    // If a NEW agent with our role prefix appeared despite the throw, the pane
    // is real: surface its name so relay reports the error instead of falling
    // back headless — a fallback here would run the task twice.
    let leaked: string | undefined;
    try {
      leaked = (await herd.list())
        .map((a) => a.name)
        .find(
          (n): n is string =>
            n !== null && n.startsWith(`${role}-`) && !namesBefore.has(n),
        );
    } catch {
      /* herdr unreachable — assume nothing spawned */
    }
    return {
      ok: false,
      pending: false,
      agentName: leaked,
      error: `failed to spawn live pane: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    // Best-effort settle before the bootstrap send — a TUI that never reports
    // idle (or a slow start) should not abort the run.
    try {
      await herd.wait(agentName, {
        status: "idle",
        timeoutMs: SPAWN_IDLE_WAIT_MS,
      });
    } catch {
      /* proceed to send regardless */
    }
    await herd.send(agentName, opts.bootstrapText);
  } catch (error) {
    return {
      ok: false,
      pending: false,
      agentName,
      error: `failed to send bootstrap to ${agentName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Announce the recovery handles BEFORE the long poll begins. If this
  // foreground process is KILLED mid-run (e.g. a caller's exec cap) rather than
  // timing out cleanly, relay never reaches the pending report below — so the
  // result path + reattach commands would be lost. Emitting them up front keeps
  // the run recoverable from stderr alone.
  deps.stderr(
    `[relay live] ${agentName} running — recover if this call is interrupted:\n` +
      `  cat ${opts.resultPath}   # the answer, once written\n` +
      `  bun ${opts.herdScriptPath} read ${agentName}   # read the pane if result.md is missing\n`,
  );

  return pollForResult(
    herd,
    {
      agentName,
      herdScriptPath: opts.herdScriptPath,
      resultPath: opts.resultPath,
      waitTimeoutMs: opts.waitTimeoutMs,
      keepPane: opts.keepPane,
      label: `${opts.backend} ${opts.mode}`,
      selfHeal: { bootstrapText: opts.bootstrapText },
    },
    deps,
  );
}

/**
 * Reattach to an ALREADY-RUNNING live pane and poll for its result.
 *
 * This is the follow-up to a pending report: relay stopped watching, but the
 * delegate kept working. Rather than killing it (losing the work) or declaring
 * failure (spawning a second writer for the same task), the caller runs this
 * for another bounded window — repeatably, so a task may take as long as it
 * takes while every individual call still returns inside the caller's own
 * timeout cap.
 *
 * It reuses runLive's settled+marker contract exactly, which is the point:
 * `done` counts as settled, so it does not repeat the `herd wait --until idle`
 * trap of never noticing a finished codex.
 */
export async function collectLive(
  opts: CollectLiveOpts,
  deps: RunLiveDeps = defaultRunLiveDeps(),
): Promise<LiveRunResult> {
  let herd: HerdClient;
  try {
    herd = await deps.loadHerd(opts.herdScriptPath);
  } catch (error) {
    return {
      ok: false,
      pending: false,
      error: `failed to load herd.ts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Probe once before committing to a long poll. Inside the loop a get()
  // failure is treated as a transient herdr hiccup, so a typo'd or already-
  // closed agent would otherwise burn the whole window before reporting.
  try {
    await herd.get(opts.agentName);
  } catch (error) {
    return {
      ok: false,
      pending: false,
      error: `cannot reattach to ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return pollForResult(
    herd,
    {
      agentName: opts.agentName,
      herdScriptPath: opts.herdScriptPath,
      resultPath: opts.resultPath,
      waitTimeoutMs: opts.waitTimeoutMs,
      keepPane: opts.keepPane,
      label: "collect",
    },
    deps,
  );
}

// Poll a live pane until it settles with a verified result, or the budget runs
// out. Shared by the spawn path (runLive) and the reattach path (collectLive).
async function pollForResult(
  herd: HerdClient,
  ctx: PollContext,
  deps: RunLiveDeps,
): Promise<LiveRunResult> {
  const agentName = ctx.agentName;

  // Stable head/tail tokens of the bootstrap, used to detect whether the line
  // is sitting in the pane's input box (fully, partially, or not at all).
  const bootstrapText = ctx.selfHeal?.bootstrapText ?? "";
  const bootWords = bootstrapText.trim().split(/\s+/);
  const bootHead = bootWords.slice(0, 3).join(" ");
  const bootTail = bootWords.slice(-3).join(" ");

  const start = deps.now();
  // Bootstrap-delivery self-heal: a TUI that is still settling can swallow the
  // bootstrap's Enter — or the pasted text itself (both seen live: codex kept
  // the line in its input box unsubmitted; opencode reported idle before its
  // input existed and received an empty message). If the agent has NEVER left
  // idle and no result file exists, inspect the input box (at most twice) and
  // act on what's actually there instead of blindly re-sending — a blind
  // re-send would DUPLICATE the instruction when the text is already present.
  // No self-heal on the reattach path: the pane is already mid-task, so a
  // re-send would duplicate the instruction into a working agent.
  let sawActivity = !ctx.selfHeal;
  let nudgesLeft = ctx.selfHeal ? 2 : 0;
  while (deps.now() - start < ctx.waitTimeoutMs) {
    await deps.sleep(POLL_INTERVAL_MS);

    let status = "unknown";
    try {
      status = (await herd.get(agentName)).status;
    } catch {
      /* transient herdr hiccup — keep polling */
    }
    const elapsed = Math.round((deps.now() - start) / 1000);
    deps.stderr(`[relay live] ${agentName}: ${status} (${elapsed}s elapsed)\n`);
    if (status === "working" || status === "blocked") sawActivity = true;

    // "settled" = the agent is no longer actively working: `idle` (finished a
    // turn, ready for input) OR `done` (finished, pane not yet looked at). codex
    // in particular parks at `done` after answering, so gating only on `idle`
    // would poll to the timeout even with a complete result file. `done` also
    // counts as activity — the agent clearly ran — so we never nudge it.
    const settled = status === "idle" || status === "done";
    if (status === "done") sawActivity = true;

    // Complete only when the agent has settled AND the marker landed — a marker
    // while still working means the file may be a partial/older write.
    if (!settled) continue;
    if (deps.fileExists(ctx.resultPath)) {
      const text = extractFinalText(deps.readFile(ctx.resultPath));
      if (text !== null) {
        if (!ctx.keepPane) {
          try {
            await herd.close(agentName);
          } catch (error) {
            deps.stderr(
              `[relay live] ${agentName}: failed to close pane after verified success: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          }
        }
        return { ok: true, agentName, text };
      }
      continue;
    }
    if (!sawActivity && nudgesLeft > 0) {
      nudgesLeft--;
      // Read the pane's visible input before nudging. Three cases seen live:
      //   full text present, Enter swallowed (codex) → press Enter only
      //   text lost entirely (opencode)              → re-send the bootstrap
      //   partial paste                              → clear the line, re-send
      let visible = "";
      try {
        visible = await herd.read(agentName, { source: "visible" });
      } catch {
        /* read failed — fall through to a plain re-send */
      }
      const hasHead = bootHead !== "" && visible.includes(bootHead);
      const hasTail = bootTail !== "" && visible.includes(bootTail);
      if (hasHead && hasTail) {
        deps.stderr(
          `[relay live] ${agentName}: bootstrap present but unsubmitted — pressing Enter\n`,
        );
        try {
          await herd.keys(agentName, "enter");
        } catch {
          /* best-effort */
        }
      } else if (hasHead) {
        deps.stderr(
          `[relay live] ${agentName}: partial bootstrap in the input — clearing then re-sending\n`,
        );
        try {
          await herd.keys(agentName, "ctrl+a", "ctrl+k");
        } catch {
          /* best-effort */
        }
        try {
          await herd.send(agentName, bootstrapText);
        } catch {
          /* best-effort */
        }
      } else {
        deps.stderr(
          `[relay live] ${agentName}: idle with no result yet — re-sending the bootstrap (it may not have been delivered)\n`,
        );
        try {
          await herd.send(agentName, bootstrapText);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  let finalStatus = "unknown";
  try {
    finalStatus = (await herd.get(agentName)).status;
  } catch {
    /* unknowable means we must not assume the agent finished */
  }
  if (finalStatus === "idle" || finalStatus === "done") {
    return {
      ok: false,
      pending: false,
      agentName,
      error: `agent settled (${finalStatus}) at timeout without a verified result file`,
    };
  }

  return {
    ok: false,
    pending: true,
    agentName,
    report: pendingReport(ctx, deps.now() - start),
  };
}

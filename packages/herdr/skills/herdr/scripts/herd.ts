#!/usr/bin/env bun

import {
  compareProjects,
  matchProjects,
  queryZoxide,
  readRegistry,
  type ProjectCandidate,
} from "./project-registry.ts";
import {
  appendFileContract,
  createAskRunDir,
  extractFinalText,
} from "./ask-contract.ts";
import { join } from "node:path";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (args: string[]) => Promise<RunResult>;

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

export const herdrRunner: Runner = async (args) => {
  const proc = Bun.spawn([HERDR_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

export class HerdrError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

function envelope(raw: string): any {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function failure(args: string[], result: RunResult, parsed: any): HerdrError {
  return new HerdrError(
    parsed?.error?.message ||
      result.stderr.trim() ||
      result.stdout.trim() ||
      `herdr ${args.join(" ")} exited ${result.code}`,
    parsed?.error?.code,
  );
}

/** herdr's agent_status enum, in full. `done` means the agent finished but its
 *  pane has not been looked at — codex parks there instead of returning to `idle`. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type AgentInfo = {
  name: string | null; // manual name given at `agent start`, if any
  type: string | null; // detected agent type (claude/codex/opencode), if any
  status: string; // idle | working | blocked | done | unknown
  paneId: string;
  tabId: string;
  workspaceId: string;
  terminalId: string;
  cwd: string;
  foregroundCwd?: string;
  interactiveReady?: boolean;
  focused: boolean;
};

export type SpawnOpts = {
  role: string; // human label, e.g. "reviewer" — the unique name is derived from it
  agent: string; // herdr agent kind, e.g. "codex" | "claude" | "opencode"
  cwd?: string;
  split?: "right" | "down"; // default "down"
  newTab?: boolean; // open the agent in its OWN new tab instead of splitting the caller's pane (takes precedence over split)
  newWorkspace?: boolean; // open the agent in a FRESH workspace instead of the caller's (takes precedence over newTab/split)
  tabLabel?: string; // label for the new tab (newTab/newWorkspace only); defaults to the generated agent name
  workspace?: string;
  tab?: string;
  env?: string[]; // KEY=VALUE entries
  argv?: string[]; // extra args passed to the agent binary
  task?: string; // if set: wait for idle, then send + submit this prompt
  waitTimeoutMs?: number; // idle-wait budget when task is set (default 20000)
};

export type SpawnResult = AgentInfo & {
  name: string;
  startBlocked?: true;
  task?: { sent: boolean; reason?: string };
};
export type SendOpts = {
  wait?: boolean; // settle after submitting instead of returning immediately
  status?: AgentStatus | AgentStatus[]; // narrows the settle set; implies wait
  timeoutMs?: number; // settle budget; implies wait
};

export type SendResult = {
  target: string;
  paneId: string | null;
  submitted: boolean;
  waited: boolean;
  status?: string; // the agent's status once herdr returned
};
export type KeysResult = { target: string; paneId: string; keys: string[] };
export type CloseResult = { target: string; paneId: string; closed: true };

/** An agent plus the human-readable labels of the tab and workspace holding it.
 *  `agent list` carries only ids, so the labels come from `workspace list` and
 *  `tab list`. A workspace label is the project name — the one handle that is
 *  both stable and meaningful across projects, which is what `tell` addresses by. */
export type AgentLocation = AgentInfo & {
  workspaceLabel: string | null;
  tabLabel: string | null;
};

export type SpawnedAgent = {
  workspaceId: string;
  paneId: string;
  name: string;
  cwd: string;
};

export type TellResult = SendResult & {
  matched: AgentLocation;
  spawned?: SpawnedAgent;
};

export type AskResult = {
  agentName: string;
  paneId: string;
  matched: AgentLocation;
  spawned?: SpawnedAgent;
} & (
  | { pending: false; answer: string }
  | { pending: true; resultPath: string; report: string }
);

function randHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex").slice(0, n);
}

/** herdr takes a repeated `--until`, so every status option accepts one or many. */
function asStatuses(
  status: AgentStatus | AgentStatus[] | undefined,
): AgentStatus[] {
  if (status === undefined) return [];
  return Array.isArray(status) ? status : [status];
}

function normAgent(a: any): AgentInfo {
  return {
    name: a.name ?? null,
    type: a.agent ?? null,
    status: a.agent_status ?? "unknown",
    paneId: a.pane_id,
    tabId: a.tab_id,
    workspaceId: a.workspace_id,
    terminalId: a.terminal_id,
    cwd: a.cwd,
    foregroundCwd: a.foreground_cwd,
    interactiveReady: a.interactive_ready,
    focused: !!a.focused,
  };
}

export function cleanLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label
    .replace(
      /^[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\s]+/u,
      "",
    )
    .trim();
  return trimmed || null;
}

export function addressOf(agent: AgentLocation): string {
  if (agent.name) return agent.name;
  if (agent.workspaceLabel) {
    return agent.tabLabel
      ? `${agent.workspaceLabel}/${agent.tabLabel}`
      : agent.workspaceLabel;
  }
  return agent.paneId;
}

/**
 * Find the agents a human-typed fragment addresses.
 *
 * One rule, no tiers: split the fragment on `/`, and keep an agent when EVERY
 * part appears (case-insensitively) somewhere in its name, workspace label, tab
 * label, pane id, or either cwd. So `api-service` finds a project, `web-app/
 * dashboard` narrows two agents sharing a workspace down to one, and
 * `clients/acme` works even though one part matches a path and the other a label.
 *
 * An exact name or pane id short-circuits. Both are unique by construction, so
 * neither may be diluted by some other agent whose cwd happens to contain it —
 * and for the pane id the short-circuit is what makes it the escape hatch at
 * all. Two tabs in one workspace may carry the SAME label, which makes their
 * `workspace/tab` addresses identical and leaves a caller resolving an ambiguity
 * no readable fragment can split; the pane id always can. Substring matching
 * alone would not deliver that: pane numbers are unpadded, so `w6:p1` is a
 * substring of `w6:p10` and the escape hatch would re-fail exactly in the busy
 * workspace that needed it.
 *
 * `selfPaneId` drops the calling pane. Prompting yourself is never the intent,
 * and the caller's own project label is exactly the fragment most likely to be
 * typed by an agent handing work off from inside that project.
 */
export function matchAgents(
  agents: AgentLocation[],
  fragment: string,
  opts: { selfPaneId?: string } = {},
): AgentLocation[] {
  const query = fragment.trim().toLowerCase();
  if (!query) return [];

  const pool = opts.selfPaneId
    ? agents.filter((a) => a.paneId !== opts.selfPaneId)
    : agents;

  const exact = pool.filter(
    (a) => a.name?.toLowerCase() === query || a.paneId.toLowerCase() === query,
  );
  if (exact.length) return exact;

  const parts = query.split("/").filter(Boolean);
  return pool.filter((agent) => {
    const haystack = [
      agent.name,
      agent.workspaceLabel,
      agent.tabLabel,
      agent.paneId,
      agent.cwd,
      agent.foregroundCwd,
    ]
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.toLowerCase());
    return parts.every((part) => haystack.some((v) => v.includes(part)));
  });
}

export type HerdDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createHerd(run: Runner = herdrRunner, deps: HerdDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  async function callJson(args: string[]): Promise<any> {
    const result = await run(args);
    const parsed = envelope(result.stdout.trim() || result.stderr.trim());
    if (result.code !== 0 || parsed?.error) {
      throw failure(args, result, parsed);
    }
    return parsed?.result ?? parsed;
  }

  async function callText(args: string[]): Promise<string> {
    const result = await run(args);
    if (result.code === 0) return result.stdout;
    throw failure(
      args,
      result,
      envelope(result.stderr.trim() || result.stdout.trim()),
    );
  }

  async function callVoid(args: string[]): Promise<void> {
    await callText(args);
  }

  async function list(): Promise<AgentInfo[]> {
    const r = await callJson(["agent", "list"]);
    return (r.agents ?? []).map(normAgent);
  }

  /** Every agent, joined to the workspace and tab labels that name it. Three
   *  round trips instead of one, so `list()` stays the cheap path relay uses. */
  async function directory(): Promise<AgentLocation[]> {
    const [agents, workspaces, tabs] = await Promise.all([
      list(),
      callJson(["workspace", "list"]),
      callJson(["tab", "list"]),
    ]);
    const wsLabels = new Map<string, string | null>(
      (workspaces.workspaces ?? []).map((w: any) => [
        w.workspace_id,
        cleanLabel(w.label),
      ]),
    );
    const tabLabels = new Map<string, string | null>(
      (tabs.tabs ?? []).map((t: any) => [t.tab_id, cleanLabel(t.label)]),
    );
    return agents.map((agent) => ({
      ...agent,
      workspaceLabel: wsLabels.get(agent.workspaceId) ?? null,
      tabLabel: tabLabels.get(agent.tabId) ?? null,
    }));
  }

  async function get(target: string): Promise<AgentInfo> {
    const r = await callJson(["agent", "get", target]);
    return normAgent(r.agent ?? r);
  }

  /** Resolve a live name after any cross-workspace move may have changed its pane id. */
  async function resolvePane(target: string): Promise<string> {
    return (await get(target)).paneId;
  }

  async function genName(role: string): Promise<string> {
    const base =
      role
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    const existing = new Set(
      (await list()).map((a) => a.name).filter(Boolean) as string[],
    );
    for (let i = 0; i < 5; i++) {
      const name = `${base}-${randHex(4)}`;
      if (!existing.has(name)) return name;
    }
    return `${base}-${randHex(8)}`;
  }

  /**
   * Block until `target` reports one of `status`.
   *
   * The default stays `idle` — the ONE status that means "the TUI will accept
   * input". That is what spawn()'s settle-before-send needs, and it is what
   * every existing caller already passes explicitly. herdr's own bare `agent
   * wait` defaults to idle|done|blocked instead, but that set is a MONITORING
   * predicate, not a readiness one: `blocked` means the agent is parked on a
   * human approval, so a wait that returns there hands a stuck pane to an
   * unattended caller.
   *
   * Pass an array for a completion wait — codex parks at `done` rather than
   * returning to `idle`, so `["idle", "done"]` is the settled test. That is
   * still only a status check: it cannot tell a finished agent from one that
   * has not started yet (a fresh agent reports `idle` before its first turn).
   * Callers needing a real completion signal pair it with their own evidence,
   * the way relay's `collect` gates on a result-file marker.
   */
  async function wait(
    target: string,
    opts: {
      status?: AgentStatus | AgentStatus[];
      timeoutMs?: number;
    } = {},
  ): Promise<any> {
    const statuses =
      opts.status === undefined ? ["idle"] : asStatuses(opts.status);
    if (statuses.length === 0) {
      throw new HerdrError("wait requires at least one status");
    }
    const timeout = opts.timeoutMs ?? 15000;
    return callJson([
      "agent",
      "wait",
      target,
      ...statuses.flatMap((s) => ["--until", s]),
      "--timeout",
      String(timeout),
    ]);
  }

  async function read(
    target: string,
    opts: {
      lines?: number;
      source?: "recent-unwrapped" | "recent" | "visible" | "detection";
    } = {},
  ): Promise<string> {
    const lines = opts.lines ?? 40;
    // `visible` works while an agent is active. For a longer idle transcript,
    // callers opt into recent-unwrapped with enough lines to exceed the viewport.
    const source = opts.source ?? "visible";
    return callText([
      "agent",
      "read",
      target,
      "--source",
      source,
      "--lines",
      String(lines),
    ]);
  }

  /**
   * Submit through herdr's paste-aware, timing-safe agent prompt path.
   *
   * With `wait`, herdr settles the agent in the same call, so a send-then-wait
   * pair collapses into one round trip. It also gains a signal a separate wait
   * cannot give: a prompt accepted from a non-working state must produce observed
   * working or blocked activity within five seconds — an unrelated status change
   * no longer settles it since 0.9.0 — or herdr returns `agent_prompt_stalled`
   * — the agent took the text but never acted on it. Keep `timeoutMs` above 5000;
   * at or below it herdr reports a plain `timeout` and that distinction is lost.
   */
  async function send(
    target: string,
    text: string,
    opts: SendOpts = {},
  ): Promise<SendResult> {
    const statuses = asStatuses(opts.status);
    // herdr rejects `--until` without `--wait`, and a caller passing either a
    // status set or a budget has already asked to settle. Imply it.
    const waited =
      opts.wait === true || statuses.length > 0 || opts.timeoutMs !== undefined;

    const args = ["agent", "prompt", target, text];
    if (waited) {
      args.push("--wait");
      args.push(...statuses.flatMap((s) => ["--until", s]));
      if (opts.timeoutMs !== undefined) {
        args.push("--timeout", String(opts.timeoutMs));
      }
    }
    const r = await callJson(args);
    const agent = r.agent ?? {};
    return {
      target,
      paneId: agent.pane_id ?? null,
      submitted: true,
      waited,
      status: agent.agent_status,
    };
  }

  async function keys(
    target: string,
    ...keyNames: string[]
  ): Promise<KeysResult> {
    if (keyNames.length === 0) {
      throw new HerdrError("keys requires at least one key");
    }
    const paneId = await resolvePane(target);
    await callVoid(["pane", "send-keys", paneId, ...keyNames]);
    return { target, paneId, keys: keyNames };
  }

  async function focusedTabId(): Promise<string | null> {
    try {
      const r = await callJson(["tab", "list"]);
      const tabs: any[] = r.tabs ?? [];
      return tabs.find((t) => t.focused)?.tab_id ?? null;
    } catch {
      return null;
    }
  }

  const SHELL_READY_TIMEOUT_MS = 10_000;
  const SHELL_RETRY_MIN_MS = 150;
  const SHELL_RETRY_MAX_MS = 1_000;

  function isPaneNotReady(error: unknown): boolean {
    if (!(error instanceof HerdrError)) return false;
    return (
      error.code === "agent_pane_busy" ||
      /not an available shell/i.test(error.message)
    );
  }

  /**
   * Start `name` in an EXISTING pane, retrying while the pane is still booting.
   *
   * herdr's `agent start --pane` requires a pane sitting at its interactive
   * shell prompt, but `pane split` / `tab create` return as soon as the pane
   * exists — its shell is typically a beat behind. Starting immediately loses
   * that race and fails with `agent_pane_busy`, so poll until the shell shows
   * up. Every other error fails fast: only readiness is transient.
   *
   * Still required on herdr 0.8.2, despite its "agent start now waits for new
   * pane shells" note — measured, not assumed. That internal wait covers agent
   * readiness AFTER the pane check, not the check itself: an occupied pane is
   * waited out (verified to both a 3s and a 20s timeout), but a pane whose
   * shell has not spawned yet is still rejected outright.
   *
   * Measured with real `--kind codex` agents under THIS function's exact
   * conditions — in-process JSON parse, no subprocess between split and start,
   * `Q_NO_BANNER=1` on the new pane. `agent_pane_busy` hit 13 of 20 spawns.
   * The loop is not a rare-edge guard; it carries the majority case.
   *
   * The constants below are measured, not picked. Rejection comes back in
   * ~115ms — it is an immediate refusal, not a wait — and a single 150ms
   * backoff clears it: 7 of 8 busy spawns succeeded on attempt 2, none needed
   * a third, none failed. A clean start then takes ~4.4s to reach `idle`,
   * which is herdr's own readiness wait doing its job once the pane check has
   * passed. Note ~100ms of slack anywhere between the two calls hides all of
   * this: an early probe that shelled out to `python3` in that gap measured
   * 2 of 18 and nearly retired the loop.
   */
  async function startAgentInPane(
    name: string,
    paneId: string,
    opts: SpawnOpts,
  ): Promise<any> {
    const args = [
      "agent",
      "start",
      name,
      "--kind",
      opts.agent,
      "--pane",
      paneId,
      "--",
      ...(opts.argv ?? []),
    ];
    const deadline = now() + SHELL_READY_TIMEOUT_MS;
    let backoff = SHELL_RETRY_MIN_MS;
    for (;;) {
      try {
        return await callJson(args);
      } catch (error) {
        // herdr 0.8.2 returns `agent_not_ready` when detection sees a blocked
        // screen during startup. The agent is live and the name still resolves,
        // so recover its record rather than stranding a pane the caller was
        // never handed a handle to.
        if (error instanceof HerdrError && error.code === "agent_not_ready") {
          return {
            ...(await callJson(["agent", "get", name])),
            startBlocked: true,
          };
        }
        if (!isPaneNotReady(error) || now() >= deadline) throw error;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, SHELL_RETRY_MAX_MS);
      }
    }
  }

  /** `--env` flags for a pane/tab we are about to create. Spawned panes are for
   *  agents, not humans, so the interactive shell banner is noise that also
   *  muddies `read` output — suppress it the way the herdr zsh helpers do. A
   *  caller that sets Q_NO_BANNER itself wins. */
  function newPaneEnvArgs(opts: SpawnOpts): string[] {
    const callerEnv = opts.env ?? [];
    const env = callerEnv.some((e) => e.startsWith("Q_NO_BANNER="))
      ? callerEnv
      : ["Q_NO_BANNER=1", ...callerEnv];
    return env.flatMap((e) => ["--env", e]);
  }

  async function startInNewTab(name: string, opts: SpawnOpts): Promise<any> {
    // Only needed to restore focus at the end, and `--no-focus` cannot move it
    // meanwhile — so this round trip runs alongside the create/start, not before.
    const prevTabQuery = focusedTabId();

    const createArgs = ["tab", "create", "--no-focus"];
    // Pin the new tab to the CALLER's workspace, not whatever workspace happens
    // to have focus — otherwise a tab spawned while the user is looking at a
    // different workspace lands there. HERDR_WORKSPACE_ID is injected into every
    // herdr pane; an explicit opts.workspace still wins.
    const workspace = opts.workspace ?? process.env.HERDR_WORKSPACE_ID;
    if (workspace) createArgs.push("--workspace", workspace);
    if (opts.cwd) createArgs.push("--cwd", opts.cwd);
    createArgs.push(...newPaneEnvArgs(opts));
    createArgs.push("--label", opts.tabLabel ?? name);
    const created = await callJson(createArgs);
    const paneId: string | undefined = created.root_pane?.pane_id;
    if (!paneId)
      throw new HerdrError("tab create did not return a root pane id");

    const started = await startAgentInPane(name, paneId, opts);
    const prevTab = await prevTabQuery;
    if (prevTab) {
      try {
        await callVoid(["tab", "focus", prevTab]);
      } catch {}
    }
    return started;
  }

  async function startInNewWorkspace(
    name: string,
    opts: SpawnOpts,
  ): Promise<any> {
    const createArgs = ["workspace", "create", "--no-focus"];
    if (opts.cwd) createArgs.push("--cwd", opts.cwd);
    createArgs.push(...newPaneEnvArgs(opts));
    createArgs.push("--label", opts.tabLabel ?? name);
    const created = await callJson(createArgs);
    const paneId: string | undefined = created.root_pane?.pane_id;
    if (!paneId)
      throw new HerdrError("workspace create did not return a root pane id");
    return startAgentInPane(name, paneId, opts);
  }

  async function splitTargetPane(opts: SpawnOpts): Promise<string | null> {
    if (!opts.tab && !opts.workspace) return null;

    const listArgs = ["pane", "list"];
    // Herdr tab ids are workspace-qualified (for example `w3:t2`), which lets
    // tab-only callers scope pane discovery without a separate tab lookup.
    const workspace = opts.workspace ?? opts.tab?.split(":", 1)[0];
    if (workspace) listArgs.push("--workspace", workspace);
    const listed = await callJson(listArgs);
    const panes: any[] = listed.panes ?? [];
    const pane = opts.tab
      ? panes.find((candidate) => candidate.tab_id === opts.tab)
      : panes[0];
    if (!pane?.pane_id) {
      const scope = opts.tab
        ? `tab ${opts.tab}`
        : `workspace ${opts.workspace}`;
      throw new HerdrError(
        `spawn requires an existing pane in ${scope} to split from`,
      );
    }
    return pane.pane_id;
  }

  async function spawn(opts: SpawnOpts): Promise<SpawnResult> {
    const name = await genName(opts.role);

    let started: any;
    if (opts.newWorkspace) {
      started = await startInNewWorkspace(name, opts);
    } else if (opts.newTab) {
      started = await startInNewTab(name, opts);
    } else {
      const targetPaneId = await splitTargetPane(opts);
      const splitArgs = [
        "pane",
        "split",
        "--direction",
        opts.split ?? "down",
        "--no-focus",
      ];
      if (targetPaneId) splitArgs.push("--pane", targetPaneId);
      if (opts.cwd) splitArgs.push("--cwd", opts.cwd);
      splitArgs.push(...newPaneEnvArgs(opts));
      const created = await callJson(splitArgs);
      const paneId: string | undefined = created.pane?.pane_id;
      if (!paneId) throw new HerdrError("pane split did not return a pane id");
      started = await startAgentInPane(name, paneId, opts);
    }
    const info = normAgent(started.agent ?? started);

    const startBlocked: true | undefined = started.startBlocked || undefined;

    let task: { sent: boolean; reason?: string } | undefined;
    if (opts.task && startBlocked) {
      task = { sent: false, reason: "agent_not_ready" };
    } else if (opts.task) {
      try {
        await wait(name, {
          status: "idle",
          timeoutMs: opts.waitTimeoutMs ?? 20000,
        });
      } catch {}
      // herdr 0.8.2 rejects a prompt to a blocked agent with `agent_blocked` and
      // sends nothing. Throwing here would strand a pane the caller cannot name,
      // so report the block in the result and let them read + clear the dialog.
      try {
        await send(name, opts.task);
        task = { sent: true };
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "agent_blocked") {
          throw error;
        }
        task = { sent: false, reason: "agent_blocked" };
      }
    }
    return { ...info, name, startBlocked, task };
  }

  async function close(target: string): Promise<CloseResult> {
    const paneId = await resolvePane(target);
    await callJson(["pane", "close", paneId]);
    return { target, paneId, closed: true };
  }

  const primitives = { directory, get, spawn, send, wait, close };
  return {
    list,
    directory,
    get,
    resolvePane,
    genName,
    spawn,
    send,
    ...createBroker(primitives, {
      ...deps,
      selfPaneId: process.env.HERDR_PANE_ID,
    }),
    keys,
    wait,
    read,
    close,
  };
}

export type BrokerPrimitives = {
  directory(): Promise<AgentLocation[]>;
  get(target: string): Promise<AgentInfo>;
  spawn(opts: SpawnOpts): Promise<SpawnResult>;
  send(target: string, text: string): Promise<SendResult>;
  wait(
    target: string,
    opts: { status?: AgentStatus | AgentStatus[]; timeoutMs?: number },
  ): Promise<unknown>;
  close(target: string): Promise<unknown>;
};

export function createBroker(
  p: BrokerPrimitives,
  deps: HerdDeps & { selfPaneId?: string } = {},
) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const { directory, get, spawn, send, wait, close } = p;

  /** Either an already-reachable live agent, or a project known only from the
   *  registry/zoxide that has nothing live at its cwd — the caller decides
   *  what to do about a `project` (spawn with a task, spawn plain and drive
   *  it separately, etc). Shared by `tell` and `ask` so the fragment/registry/
   *  zoxide matching — and its two ambiguity messages — exist exactly once. */
  type Resolved =
    | { kind: "agent"; agent: AgentLocation }
    | { kind: "project"; path: string; name: string };

  /**
   * Resolve a human-typed fragment to exactly one live agent, or — when none
   * matches — to exactly one known-but-closed project.
   *
   * Ambiguity is a hard failure rather than a broadcast or a best guess: an
   * unwanted prompt cannot be recalled, and the agent that receives it will
   * act on it. Each listed candidate carries its pane id beside the readable
   * address, so the retry needs no second lookup even when two addresses
   * read alike.
   *
   * When no LIVE agent matches, fall through to known-but-closed projects
   * before giving up: the project registry (`~/.local/state/herdr-projects/
   * registry.json`, written by herdr-workbench), then zoxide's frecency
   * index. A resolved path is checked against every live agent's cwd first —
   * a renamed tab can still be reachable — so `kind: "project"` only comes
   * back once nothing already answers there. Ambiguity at the registry layer
   * is the same hard failure as at the agent layer: spawning into the wrong
   * repo is worse than telling the wrong agent, never picked automatically.
   */
  async function resolveProjectOrAgent(
    fragment: string,
    opts: {
      selfPaneId?: string;
      registryPath?: string;
    } = {},
  ): Promise<Resolved> {
    const agents = await directory();
    const selfPaneId = opts.selfPaneId ?? deps.selfPaneId;
    const matches = matchAgents(agents, fragment, { selfPaneId });

    const listed = (found: AgentLocation[]) =>
      found
        .map((a) => `  ${addressOf(a)}  [${a.paneId}]  ${a.status}  ${a.cwd}`)
        .join("\n");

    if (matches.length > 1) {
      throw new HerdrError(
        `"${fragment}" matches ${matches.length} agents — ask which one, then retry using its pane id:\n${listed(matches)}`,
      );
    }

    if (matches.length === 1) {
      return { kind: "agent", agent: matches[0]! };
    }

    const registry = await readRegistry(opts.registryPath);
    const projectMatches = matchProjects(registry, fragment).sort(
      compareProjects,
    );

    if (projectMatches.length > 1) {
      const listedProjects = projectMatches
        .map((p) => `  ${p.name}  ${p.path}`)
        .join("\n");
      throw new HerdrError(
        `"${fragment}" matches ${projectMatches.length} known projects — ask which one, then retry with a narrower fragment:\n${listedProjects}`,
      );
    }

    let resolved: ProjectCandidate | null = projectMatches[0] ?? null;
    if (!resolved) {
      const zpath = await queryZoxide(fragment);
      if (zpath) {
        resolved = {
          path: zpath,
          name: zpath.split("/").pop() || zpath,
          aliases: [],
        };
      }
    }

    if (!resolved) {
      const known = listed(agents.filter((a) => a.paneId !== selfPaneId));
      throw new HerdrError(
        `no agent matches "${fragment}"; checked the project registry and zoxide too${known ? `\navailable:\n${known}` : ""}`,
      );
    }

    const liveAtPath = agents.filter(
      (a) =>
        a.paneId !== selfPaneId &&
        (a.cwd === resolved!.path || a.foregroundCwd === resolved!.path),
    );
    if (liveAtPath.length > 1) {
      throw new HerdrError(
        `"${fragment}" resolved to ${resolved.path}, which ${liveAtPath.length} agents already have open — ask which one, then retry using its pane id:\n${listed(liveAtPath)}`,
      );
    }
    if (liveAtPath.length === 1) {
      return { kind: "agent", agent: liveAtPath[0]! };
    }

    return { kind: "project", path: resolved.path, name: resolved.name };
  }

  function locateSpawned(
    started: SpawnResult,
    projectName: string,
  ): { agent: AgentLocation; spawned: SpawnedAgent } {
    return {
      agent: {
        ...started,
        workspaceLabel: projectName,
        tabLabel: projectName,
      },
      spawned: {
        workspaceId: started.workspaceId,
        paneId: started.paneId,
        name: started.name,
        cwd: started.cwd,
      },
    };
  }

  async function tell(
    fragment: string,
    text: string,
    opts: {
      selfPaneId?: string;
      spawnAgent?: string;
      registryPath?: string;
    } = {},
  ): Promise<TellResult> {
    const resolved = await resolveProjectOrAgent(fragment, {
      selfPaneId: opts.selfPaneId,
      registryPath: opts.registryPath,
    });

    if (resolved.kind === "agent") {
      const matched = resolved.agent;
      const res = await send(matched.name ?? matched.paneId, text);
      return { ...res, matched };
    }

    const started = await spawn({
      role: resolved.name,
      agent: opts.spawnAgent ?? "claude",
      cwd: resolved.path,
      newWorkspace: true,
      tabLabel: resolved.name,
      task: text,
    });
    const { agent: matchedAgent, spawned } = locateSpawned(
      started,
      resolved.name,
    );
    return {
      target: started.name,
      paneId: started.paneId,
      submitted: started.task?.sent ?? false,
      waited: true,
      status: started.status,
      matched: matchedAgent,
      spawned,
    };
  }

  const ASK_POLL_INTERVAL_MS = 5_000;
  const ASK_DEFAULT_TIMEOUT_MS = 10 * 60_000;
  const ASK_SPAWN_IDLE_WAIT_MS = 20_000;

  /**
   * Poll `target` until it settles (idle/done) AND `resultPath`'s last line
   * is the sentinel — both, not either: a marker alone could be a stale file
   * from a previous run, and settled alone could be a mid-write snapshot.
   *
   * Settled with no verified file, even briefly, is NOT treated as done —
   * only the timeout distinguishes "ran out of patience while still working"
   * (pending, worth another `collect`) from "finished without ever producing
   * a file" (a hard failure — the target didn't follow the contract, and
   * waiting longer will not fix that).
   */
  type AskOutcome = { answer: string } | { pending: true };

  async function pollAskResult(
    target: string,
    resultPath: string,
    timeoutMs: number,
  ): Promise<AskOutcome> {
    const deadline = now() + timeoutMs;
    let settledWithoutFile = false;
    while (now() < deadline) {
      await sleep(ASK_POLL_INTERVAL_MS);
      let status: string;
      try {
        status = (await get(target)).status;
      } catch {
        continue; // transient herdr hiccup — keep polling
      }
      const settled = status === "idle" || status === "done";
      settledWithoutFile = settled;
      if (!settled) continue;

      let content: string;
      try {
        content = await Bun.file(resultPath).text();
      } catch {
        continue; // not written yet
      }
      const answer = extractFinalText(content);
      if (answer === null) continue; // exists but mid-write
      return { answer };
    }
    if (settledWithoutFile) {
      throw new HerdrError(
        `${target} settled without ever writing a valid result to ${resultPath}`,
      );
    }
    return { pending: true };
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function pendingReport(target: string, resultPath: string): string {
    const script = shellQuote(import.meta.path);
    return (
      `ask timed out waiting for an answer from "${target}" — it may still be working.\n` +
      `Result file: ${resultPath}\n` +
      `Re-check without re-asking: bun ${script} collect ${shellQuote(target)} --result ${shellQuote(resultPath)}`
    );
  }

  function buildAskResult(
    target: string,
    agent: AgentLocation,
    outcome: AskOutcome,
    resultPath: string,
    spawned?: SpawnedAgent,
  ): AskResult {
    if ("pending" in outcome) {
      return {
        agentName: target,
        paneId: agent.paneId,
        matched: agent,
        spawned,
        pending: true,
        resultPath,
        report: pendingReport(target, resultPath),
      };
    }
    return {
      agentName: target,
      paneId: agent.paneId,
      matched: agent,
      spawned,
      pending: false,
      answer: outcome.answer,
    };
  }

  /**
   * Ask another project's agent a question and wait for its answer, via the
   * file contract in ask-contract.ts. Resolution is identical to `tell`'s
   * (see `resolveProjectOrAgent`); the difference is entirely in what happens
   * after the target is found.
   *
   * A `project` result is spawned WITHOUT a `task` — `ask` drives the
   * question itself (file contract, then a one-line pointer, never the raw
   * question text: a multi-line prompt can submit prematurely in a TUI input,
   * and a long one risks ARG_MAX) — and only closes the pane it spawned
   * itself, and only on a verified success with `keepPane` unset. An agent
   * that was already running is never touched.
   */
  async function ask(
    fragment: string,
    question: string,
    opts: {
      selfPaneId?: string;
      spawnAgent?: string;
      registryPath?: string;
      timeoutMs?: number;
      keepPane?: boolean;
      resultDir?: string;
    } = {},
  ): Promise<AskResult> {
    const resolved = await resolveProjectOrAgent(fragment, {
      selfPaneId: opts.selfPaneId,
      registryPath: opts.registryPath,
    });

    let agent: AgentLocation;
    let spawned: SpawnedAgent | undefined;
    if (resolved.kind === "agent") {
      agent = resolved.agent;
    } else {
      const started = await spawn({
        role: resolved.name,
        agent: opts.spawnAgent ?? "claude",
        cwd: resolved.path,
        newWorkspace: true,
        tabLabel: resolved.name,
      });
      try {
        await wait(started.name, {
          status: "idle",
          timeoutMs: ASK_SPAWN_IDLE_WAIT_MS,
        });
      } catch {}
      ({ agent, spawned } = locateSpawned(started, resolved.name));
    }

    const target = agent.name ?? agent.paneId;
    const dir = createAskRunDir(opts.resultDir);
    const resultPath = join(dir, "result.md");
    const questionPath = join(dir, "question.md");
    await Bun.write(questionPath, appendFileContract(question, resultPath));
    await send(
      target,
      `Read the file ${questionPath} and answer the question in it, following the result-file instructions at the end.`,
    );

    const timeoutMs = opts.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS;
    const outcome = await pollAskResult(target, resultPath, timeoutMs);

    if (!("pending" in outcome) && spawned && !opts.keepPane) {
      try {
        await close(target);
      } catch {}
    }
    return buildAskResult(target, agent, outcome, resultPath, spawned);
  }

  async function collect(
    target: string,
    resultPath: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<AskResult> {
    const agent = await get(target);
    const located: AgentLocation = {
      ...agent,
      workspaceLabel: null,
      tabLabel: null,
    };
    const timeoutMs = opts.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS;
    const outcome = await pollAskResult(target, resultPath, timeoutMs);
    return buildAskResult(target, located, outcome, resultPath);
  }

  return { tell, ask, collect };
}

const APP_VERBS = new Set(["list", "tell", "ask", "collect"]);

export function runtimeFor(
  env: Record<string, string | undefined>,
  verb: string,
): { kind: "herdr" } | { kind: "app"; self: string } | { error: string } {
  if (env.HERDR_ENV === "1") return { kind: "herdr" };
  if (!env.HC_TERMINAL_ID) {
    return {
      error:
        "herd: not inside herdr (HERDR_ENV != 1) or herdr-app (no HC_TERMINAL_ID). These verbs only work inside one of them.",
    };
  }
  if (!APP_VERBS.has(verb)) {
    return {
      error: `herd ${verb}: under herdr-app use hc directly (read \`hc --skill\`); herd keeps only list, tell, ask and collect there.`,
    };
  }
  return { kind: "app", self: env.HC_TERMINAL_ID };
}

const BOOLEAN_FLAGS = new Set(["new-tab", "new-workspace"]);

const REPEATABLE_FLAGS = new Set(["status"]);

export function parseArgs(argv: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
  env: string[];
  rest: string[];
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const env: string[] = [];
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined) {
        flags[key] = true;
      } else if (key === "env") {
        env.push(next);
        i++;
      } else if (REPEATABLE_FLAGS.has(key) && key in flags) {
        const prev = flags[key];
        flags[key] = Array.isArray(prev)
          ? [...prev, next]
          : [prev as string, next];
        i++;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, env, rest };
}

/** Agent kinds herdr can start. The full list is longer (`herdr agent start
 *  --help`); these are the three this wrapper is used with. */
const AGENT_KINDS = "claude|codex|opencode";

export const VERB_USAGE: Record<string, string> = {
  list: `  herd list                            # every agent, with its workspace/tab address`,
  spawn: `  herd spawn <role> --agent <kind> [--cwd P] [--split down|right] [--new-tab] [--new-workspace] [--tab-label TEXT]
              [--workspace ID] [--tab ID] [--task "prompt"] [--wait-timeout MS] [--env K=V ...] [-- <extra argv>]
              # <kind> is a herdr agent kind: ${AGENT_KINDS} (no default — required)
              # --new-workspace opens a FRESH workspace instead of the caller's (wins over --new-tab)`,
  tell: `  herd tell [--agent KIND] <fragment> <text>   # hand work to an agent, fire-and-forget
              # <fragment> matches a workspace label (the project name), a tab label,
              # an agent name, a pane id, or a cwd. Slash-separate to narrow: web-app/dashboard
              # No live agent? Falls back to the herdr-workbench project registry, then zoxide;
              # a resolved project with no live agent gets one spawned into a fresh workspace.
              # --agent KIND   harness to start there (default claude); goes BEFORE <fragment>`,
  send: `  herd send [--wait] [--status idle|working|blocked|done|unknown]... [--timeout MS] <target> <text>
              # flags go BEFORE <target> so prompt text containing \`--\` survives`,
  ask: `  herd ask [--agent KIND] [--timeout MS] [--keep-pane] <fragment> <question>
              # like tell, but waits for and returns the answer via a result-file contract.
              # <fragment> addresses the target exactly as \`tell\` does.
              # --agent KIND   harness to start if none is running, e.g. ${AGENT_KINDS} (default claude)
              # --timeout MS   how long to wait for the answer (default 600000, 10 min)
              # --keep-pane    keep a pane ask itself spawned; an already-running agent
              #                is never closed either way
              # On timeout the result is {pending: true} with a "collect" command to redeem
              # later — do NOT re-ask. Flags go BEFORE <fragment>: everything from <fragment>
              # onward is the question verbatim, so a trailing flag is silently swallowed.`,
  collect: `  herd collect <target> --result PATH [--timeout MS]
              # redeem a pending ask's answer later, without re-sending the question`,
  keys: `  herd keys <target> <key> [key ...]   # bare key chords, e.g. enter | ctrl+a ctrl+k | shift+tab`,
  wait: `  herd wait <target> [--status idle|working|blocked|done|unknown]... [--timeout MS]`,
  read: `  herd read <target> [--lines N] [--source recent-unwrapped|recent|visible|detection]`,
  close: `  herd close <target>`,
};

const FOOTER = `Targets are agent NAMES (as returned by spawn/list), not pane ids.
All verbs print JSON except \`read\`, which prints the pane's text.`;

const USAGE = `herd — typed wrapper over the herdr CLI for in-session agent orchestration

Usage:
${Object.values(VERB_USAGE).join("\n")}

Run \`herd <verb> --help\` for one verb's flags.

${FOOTER}`;

export function wantsVerbHelp(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") return true;
    if (!a.startsWith("--")) return false;
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) i++;
  }
  return false;
}

export function parseLeadingFlags(
  verb: string,
  rest: string[],
  valued: string[],
  booleans: string[] = [],
): { flags: Record<string, string[] | true>; head?: string; text: string } {
  const flags: Record<string, string[] | true> = {};
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith("--")) {
    const key = rest[i]!.slice(2);
    if (booleans.includes(key)) {
      flags[key] = true;
      i += 1;
    } else if (valued.includes(key)) {
      const prev = flags[key];
      flags[key] = [...(Array.isArray(prev) ? prev : []), rest[i + 1]!];
      i += 2;
    } else {
      throw new HerdrError(`${verb}: unknown flag ${rest[i]}`);
    }
  }
  return { flags, head: rest[i], text: rest.slice(i + 1).join(" ") };
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb || verb === "-h" || verb === "--help") {
    console.log(USAGE);
    process.exit(verb ? 0 : 1);
  }
  if (verb === "help") {
    const topic = rest[0];
    if (topic && VERB_USAGE[topic]) {
      console.log(`${VERB_USAGE[topic]}\n\n${FOOTER}`);
    } else if (topic) {
      console.error(`herd: unknown verb "${topic}"\n\n${USAGE}`);
      process.exit(1);
    } else {
      console.log(USAGE);
    }
    process.exit(0);
  }
  if (VERB_USAGE[verb] && wantsVerbHelp(rest)) {
    console.log(`${VERB_USAGE[verb]}\n\n${FOOTER}`);
    process.exit(0);
  }
  const runtime = runtimeFor(process.env, verb);
  if ("error" in runtime) {
    console.error(runtime.error);
    process.exit(1);
  }
  // runtimeFor admits only list/tell/ask/collect under herdr-app, and the app
  // herd implements exactly those.
  const herd =
    runtime.kind === "app"
      ? ((await import("./herd-app.ts")).createHerdApp(undefined, {
          selfPaneId: runtime.self,
        }) as unknown as ReturnType<typeof createHerd>)
      : createHerd();
  const { positionals, flags, env, rest: restArgv } = parseArgs(rest);

  try {
    switch (verb) {
      case "list": {
        console.log(JSON.stringify(await herd.directory(), null, 2));
        break;
      }
      case "tell": {
        const {
          flags: f,
          head: fragment,
          text,
        } = parseLeadingFlags("tell", rest, ["agent"]);
        if (!fragment || !text)
          throw new HerdrError("tell requires <fragment> and <text>");
        const spawnAgent = Array.isArray(f.agent) ? f.agent.at(-1) : undefined;
        console.log(
          JSON.stringify(await herd.tell(fragment, text, { spawnAgent }), null, 2),
        );
        break;
      }
      case "spawn": {
        const role = positionals[0];
        const agent = flags.agent as string;
        if (!role || !agent)
          throw new HerdrError("spawn requires <role> and --agent <kind>");
        const res = await herd.spawn({
          role,
          agent,
          cwd: (flags.cwd as string) ?? process.cwd(),
          split: (flags.split as "right" | "down") ?? "down",
          newTab: flags["new-tab"] === true,
          newWorkspace: flags["new-workspace"] === true,
          tabLabel: flags["tab-label"] as string | undefined,
          workspace: flags.workspace as string | undefined,
          tab: flags.tab as string | undefined,
          env,
          argv: restArgv.length ? restArgv : undefined,
          task: flags.task as string | undefined,
          waitTimeoutMs: flags["wait-timeout"]
            ? Number(flags["wait-timeout"])
            : undefined,
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "send": {
        const {
          flags: f,
          head: target,
          text,
        } = parseLeadingFlags("send", rest, ["status", "timeout"], ["wait"]);
        const sendOpts: SendOpts = {};
        if (f.wait) sendOpts.wait = true;
        if (Array.isArray(f.status))
          sendOpts.status = f.status as AgentStatus[];
        if (Array.isArray(f.timeout))
          sendOpts.timeoutMs = Number(f.timeout.at(-1));
        if (!target || !text)
          throw new HerdrError("send requires <target> and <text>");
        const res = await herd.send(target, text, sendOpts);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "ask": {
        const {
          flags: f,
          head: fragment,
          text: question,
        } = parseLeadingFlags("ask", rest, ["agent", "timeout"], ["keep-pane"]);
        const askOpts: {
          spawnAgent?: string;
          timeoutMs?: number;
          keepPane?: boolean;
        } = {};
        if (Array.isArray(f.agent)) askOpts.spawnAgent = f.agent.at(-1);
        if (Array.isArray(f.timeout))
          askOpts.timeoutMs = Number(f.timeout.at(-1));
        if (f["keep-pane"]) askOpts.keepPane = true;
        if (!fragment || !question)
          throw new HerdrError("ask requires <fragment> and <question>");
        const res = await herd.ask(fragment, question, askOpts);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "collect": {
        const target = positionals[0];
        const resultPath = flags.result as string | undefined;
        if (!target || !resultPath)
          throw new HerdrError("collect requires <target> and --result PATH");
        const res = await herd.collect(target, resultPath, {
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "keys": {
        const target = positionals[0];
        const keyNames = positionals.slice(1);
        if (!target || keyNames.length === 0)
          throw new HerdrError("keys requires <target> and at least one <key>");
        console.log(
          JSON.stringify(await herd.keys(target, ...keyNames), null, 2),
        );
        break;
      }
      case "wait": {
        const target = positionals[0];
        if (!target) throw new HerdrError("wait requires <target>");
        const res = await herd.wait(target, {
          status: flags.status as AgentStatus | AgentStatus[] | undefined,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "read": {
        const target = positionals[0];
        if (!target) throw new HerdrError("read requires <target>");
        const text = await herd.read(target, {
          lines: flags.lines ? Number(flags.lines) : undefined,
          source: (flags.source as any) ?? undefined,
        });
        process.stdout.write(text);
        break;
      }
      case "close": {
        const target = positionals[0];
        if (!target) throw new HerdrError("close requires <target>");
        console.log(JSON.stringify(await herd.close(target), null, 2));
        break;
      }
      default:
        console.error(`herd: unknown verb "${verb}"\n\n${USAGE}`);
        process.exit(1);
    }
  } catch (err) {
    const e = err as Error;
    console.error(`herd: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

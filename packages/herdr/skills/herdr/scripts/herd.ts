#!/usr/bin/env bun
/**
 * herd.ts — a small, typed wrapper over the raw `herdr` CLI for in-session
 * agent orchestration. Collapses herdr's multi-step recipes (create pane → start →
 * prompt → wait → read) into eight verbs an agent can call without re-deriving the
 * CLI's sharp edges:
 *
 *   spawn  — start an agent in a fresh pane under a collision-proof name
 *   tell   — hand work to an ALREADY-RUNNING agent, addressed by project label
 *   send   — write a prompt to a running agent AND submit it (Enter)
 *   keys   — send bare key chords to the agent's pane
 *   wait   — block until the agent reaches a status
 *   read   — read a pane's recent output as clean text
 *   list   — the current agents as a typed array
 *   close  — close an agent's pane
 *
 * Design notes:
 * - Targets are addressed by NAME, never by pane id. Names follow an agent when
 *   a cross-workspace move gives its pane a new workspace-qualified id.
 * - One `agent prompt` command handles text, paste mode, submission timing, and Enter.
 * - `agent start` launches only in an existing pane, so `spawn` creates the pane
 *   first and puts environment variables on that pane.
 * - Runnable both as a CLI (`bun herd.ts <verb> …`) and as a module
 *   (`import { createHerd } from "./herd.ts"`) so relay can consume the same
 *   layer for a future live-pane strategy.
 */

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (args: string[]) => Promise<RunResult>;

/** Host herdr binary — honor HERDR_BIN_PATH (set inside herdr/plugin envs), else PATH. */
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

/** The real herdr CLI runner. Injectable so tests can mock it. */
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

/** herdr's JSON envelope, or null when the output is not JSON. */
function envelope(raw: string): any {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The one error ladder: herdr's own message, then whichever stream spoke. */
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

/** Normalized agent record — the shape callers actually want. */
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
  tabLabel?: string; // label for the new tab (newTab only); defaults to the generated agent name
  workspace?: string;
  tab?: string;
  env?: string[]; // KEY=VALUE entries
  argv?: string[]; // extra args passed to the agent binary
  task?: string; // if set: wait for idle, then send + submit this prompt
  waitTimeoutMs?: number; // idle-wait budget when task is set (default 20000)
};

export type SpawnResult = AgentInfo & {
  name: string;
  /** Set when `agent start` saw a blocked screen during startup. The agent is
   *  live and the name resolves; clear the dialog before prompting it. */
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

export type TellResult = SendResult & { matched: AgentLocation };

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

/** Strip herdr's leading nerd-font glyph from a tab/workspace label.
 *  Scoped to the private-use planes on purpose: a broader "leading punctuation"
 *  strip would eat the dot in a legitimate `.config` label.
 *
 *  All THREE private-use blocks are covered because herdr uses more than one —
 *  live tab labels here carry both U+EACD (BMP) and U+F09D1, which Nerd Fonts v3
 *  assigns in the supplementary plane. Narrowing this to the BMP would silently
 *  stop cleaning the most common label of all. */
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

/** How a human addresses this agent back — `workspace/tab`, else the pane id. */
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

/** Clock seam so the shell-readiness retry loop is testable without wall time. */
export type HerdDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createHerd(run: Runner = herdrRunner, deps: HerdDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

  /** Run a herdr command that returns a JSON envelope; unwrap `.result`, throw on error. */
  async function callJson(args: string[]): Promise<any> {
    const result = await run(args);
    const parsed = envelope(result.stdout.trim() || result.stderr.trim());
    if (result.code !== 0 || parsed?.error) {
      throw failure(args, result, parsed);
    }
    return parsed?.result ?? parsed;
  }

  /** Run a read command whose successful stdout is terminal text, not JSON. */
  async function callText(args: string[]): Promise<string> {
    const result = await run(args);
    if (result.code === 0) return result.stdout;
    // Failure order is the reverse of callJson's: the error rides stderr here.
    throw failure(
      args,
      result,
      envelope(result.stderr.trim() || result.stdout.trim()),
    );
  }

  /** Run a herdr command that prints nothing on success (send-text/send-keys/run).
   *  Shares callText's failure path so these errors carry herdr's error code —
   *  an `error.code === "agent_pane_busy"` check cannot fire without it, and
   *  keys() reaches herdr only through here. */
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

  /**
   * Fire-and-forget hand-off: resolve a human-typed fragment to exactly one
   * agent, then submit the text. No wait — the point is to drop work on another
   * project's agent and carry on.
   *
   * Ambiguity is a hard failure rather than a broadcast or a best guess: an
   * unwanted prompt cannot be recalled, and the agent that receives it will act
   * on it. Each listed candidate carries its pane id beside the readable address,
   * so the retry needs no second lookup even when two addresses read alike.
   */
  async function tell(
    fragment: string,
    text: string,
    opts: { selfPaneId?: string } = {},
  ): Promise<TellResult> {
    const agents = await directory();
    const selfPaneId = opts.selfPaneId ?? process.env.HERDR_PANE_ID;
    const matches = matchAgents(agents, fragment, { selfPaneId });

    // Everything a caller needs to put these in front of a human: the readable
    // address, the exact handle to retell with, and the two facts that tell two
    // agents in one project apart. A picker built from this needs no second lookup.
    const listed = (found: AgentLocation[]) =>
      found
        .map((a) => `  ${addressOf(a)}  [${a.paneId}]  ${a.status}  ${a.cwd}`)
        .join("\n");

    if (matches.length === 0) {
      const known = listed(agents.filter((a) => a.paneId !== selfPaneId));
      throw new HerdrError(
        `no agent matches "${fragment}"${known ? `\navailable:\n${known}` : ""}`,
      );
    }
    if (matches.length > 1) {
      throw new HerdrError(
        `"${fragment}" matches ${matches.length} agents — ask which one, then retell using its pane id:\n${listed(matches)}`,
      );
    }

    const matched = matches[0]!;
    const res = await send(matched.name ?? matched.paneId, text);
    return { ...res, matched };
  }

  async function get(target: string): Promise<AgentInfo> {
    const r = await callJson(["agent", "get", target]);
    return normAgent(r.agent ?? r);
  }

  /** Resolve a live name after any cross-workspace move may have changed its pane id. */
  async function resolvePane(target: string): Promise<string> {
    return (await get(target)).paneId;
  }

  /** Derive a collision-resistant agent name from a human role, e.g. "reviewer" → "reviewer-a3f9".
   *  The random suffix keeps concurrent sessions from picking the same name; the list check
   *  additionally avoids clashing with agents already alive in THIS session. */
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
    // A bare `agent wait` would silently fall back to herdr's idle|done|blocked
    // default, which is not what an empty array asked for. Fail instead.
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
   * cannot give: a prompt accepted from a non-working state must produce a
   * lifecycle change within five seconds, or herdr returns `agent_prompt_stalled`
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

  /** Send bare key chords to a target's pane (no text) — e.g. keys(name, "enter")
   *  to submit whatever sits in the input box, or keys(name, "ctrl+a", "ctrl+k")
   *  to clear a line. Wraps `pane send-keys`; re-resolves name → pane id first. */
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

  /** The currently-focused tab id, or null. Used to restore focus after a
   *  new-tab spawn. */
  async function focusedTabId(): Promise<string | null> {
    try {
      const r = await callJson(["tab", "list"]);
      const tabs: any[] = r.tabs ?? [];
      return tabs.find((t) => t.focused)?.tab_id ?? null;
    } catch {
      return null;
    }
  }

  /** How long to keep re-trying `agent start` while the target pane is still
   *  booting its shell, and the backoff between attempts. */
  const SHELL_READY_TIMEOUT_MS = 10_000;
  const SHELL_RETRY_MIN_MS = 150;
  const SHELL_RETRY_MAX_MS = 1_000;

  /** True for the one error that means "the pane exists but hasn't reached its
   *  interactive shell prompt yet" — the only condition worth re-trying. */
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

  /** Start the agent in a FRESH tab instead of splitting the caller's pane. */
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
    // Label the tab so the caller can tell at a glance what it's for. Defaults
    // to the generated agent name (which encodes role + a unique suffix).
    createArgs.push("--label", opts.tabLabel ?? name);
    const created = await callJson(createArgs);
    const paneId: string | undefined = created.root_pane?.pane_id;
    if (!paneId)
      throw new HerdrError("tab create did not return a root pane id");

    const started = await startAgentInPane(name, paneId, opts);
    // Give focus back to where the caller was.
    const prevTab = await prevTabQuery;
    if (prevTab) {
      try {
        await callVoid(["tab", "focus", prevTab]);
      } catch {
        /* best-effort */
      }
    }
    return started;
  }

  /** Resolve an existing pane to split when the caller targets a tab/workspace. */
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
    if (opts.newTab) {
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
      // With no explicit scope, preserve herdr's default of splitting the
      // current pane. A scoped spawn must split a pane found in that scope.
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
      // Prompting a blocked agent can only fail. Skip the settle wait too — it
      // would burn its full timeout waiting for an idle that needs a human.
      task = { sent: false, reason: "agent_not_ready" };
    } else if (opts.task) {
      // Best-effort: wait for the agent to settle, then submit the task.
      try {
        await wait(name, {
          status: "idle",
          timeoutMs: opts.waitTimeoutMs ?? 20000,
        });
      } catch {
        /* proceed to send regardless */
      }
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
    // Generated name is authoritative — spread info first so a null name from the
    // envelope can't clobber it.
    return { ...info, name, startBlocked, task };
  }

  async function close(target: string): Promise<CloseResult> {
    const paneId = await resolvePane(target);
    await callJson(["pane", "close", paneId]);
    return { target, paneId, closed: true };
  }

  return {
    list,
    directory,
    get,
    resolvePane,
    genName,
    spawn,
    send,
    tell,
    keys,
    wait,
    read,
    close,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function assertHerdrEnv(): void {
  if (process.env.HERDR_ENV !== "1") {
    console.error(
      "herd: not inside a herdr-managed pane (HERDR_ENV != 1). These verbs only work when running inside herdr.",
    );
    process.exit(1);
  }
}

/** Flags that never take a value (so a following token — even one starting with `--` — is not consumed). */
const BOOLEAN_FLAGS = new Set(["new-tab"]);

/** Flags that may be given more than once. The second occurrence turns the value
 *  into an array instead of overwriting the first — `herdr agent wait` takes a
 *  repeated `--until`, so `--status idle --status done` has to survive the parse. */
const REPEATABLE_FLAGS = new Set(["status"]);

/** Minimal flag parser: returns { positionals, flags, rest } where rest is everything after a bare `--`.
 *  Value-flags always consume the next token as their value — including values that start with `--`
 *  (e.g. `--task "--check src"`); only BOOLEAN_FLAGS and a missing token yield a boolean.
 *  A REPEATABLE_FLAGS key collects into an array once it appears twice; every other key keeps the
 *  last value. Exported for unit testing. */
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

const USAGE = `herd — typed wrapper over the herdr CLI for in-session agent orchestration

Usage:
  herd list                            # every agent, with its workspace/tab address
  herd spawn <role> --agent <kind> [--cwd P] [--split down|right] [--new-tab] [--tab-label TEXT]
              [--workspace ID] [--tab ID] [--task "prompt"] [--wait-timeout MS] [--env K=V ...] [-- <extra argv>]
  herd tell <fragment> <text>          # hand work to an existing agent, fire-and-forget
              # <fragment> matches a workspace label (the project name), a tab label,
              # an agent name, a pane id, or a cwd. Slash-separate to narrow: web-app/dashboard
  herd send [--wait] [--status idle|working|blocked|done|unknown]... [--timeout MS] <target> <text>
              # flags go BEFORE <target> so prompt text containing \`--\` survives
  herd keys <target> <key> [key ...]   # bare key chords, e.g. enter | ctrl+a ctrl+k | shift+tab
  herd wait <target> [--status idle|working|blocked|done|unknown]... [--timeout MS]
  herd read <target> [--lines N] [--source recent-unwrapped|recent|visible|detection]
  herd close <target>

Targets are agent NAMES (as returned by spawn/list), not pane ids.
All verbs print JSON except \`read\`, which prints the pane's text.`;

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb || verb === "-h" || verb === "--help") {
    console.log(USAGE);
    process.exit(verb ? 0 : 1);
  }
  assertHerdrEnv();
  const herd = createHerd();
  const { positionals, flags, env, rest: restArgv } = parseArgs(rest);

  try {
    switch (verb) {
      case "list": {
        // The CLI is the human/model discovery surface, so it prints the
        // labelled directory — the addresses `tell` accepts. The module-level
        // `list()` stays the bare, one-round-trip shape relay consumes.
        console.log(JSON.stringify(await herd.directory(), null, 2));
        break;
      }
      case "tell": {
        // Raw argv, for the same reason send uses it: prompt text may contain `--`.
        const [fragment, ...textParts] = rest;
        const text = textParts.join(" ");
        if (!fragment || !text)
          throw new HerdrError("tell requires <fragment> and <text>");
        console.log(JSON.stringify(await herd.tell(fragment, text), null, 2));
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
        // Parse from raw argv (not the generic flag parser) so prompt text that
        // starts with or contains `--` (e.g. "--please fix this") survives intact.
        // Flags are therefore only recognised BEFORE <target>; everything from
        // <target> onward is positional.
        const sendOpts: SendOpts = {};
        const statuses: AgentStatus[] = [];
        let i = 0;
        while (i < rest.length && rest[i]!.startsWith("--")) {
          const flag = rest[i]!;
          if (flag === "--wait") {
            sendOpts.wait = true;
            i += 1;
          } else if (flag === "--status") {
            statuses.push(rest[++i] as AgentStatus);
            i += 1;
          } else if (flag === "--timeout") {
            sendOpts.timeoutMs = Number(rest[++i]);
            i += 1;
          } else {
            throw new HerdrError(`send: unknown flag ${flag}`);
          }
        }
        if (statuses.length) sendOpts.status = statuses;
        const target = rest[i];
        const text = rest.slice(i + 1).join(" ");
        if (!target || !text)
          throw new HerdrError("send requires <target> and <text>");
        const res = await herd.send(target, text, sendOpts);
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
          // `--status` is repeatable, so parseArgs hands back a string OR an
          // array. Leave it undefined when absent so wait() applies its own
          // default rather than this layer duplicating it.
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

#!/usr/bin/env bun
/**
 * herd.ts — a small, typed wrapper over the raw `herdr` CLI for in-session
 * agent orchestration. Collapses herdr's multi-step recipes (split → parse id →
 * run → wait → read) into seven verbs an agent can call without re-deriving the
 * CLI's sharp edges:
 *
 *   spawn  — start an agent in a fresh pane under a collision-proof name
 *   send   — write a prompt to a running agent AND submit it (Enter)
 *   keys   — send bare key chords to the agent's pane
 *   wait   — block until the agent reaches a status
 *   read   — read a pane's recent output as clean text
 *   list   — the current agents as a typed array
 *   close  — close an agent's pane
 *
 * Design notes:
 * - Targets are addressed by NAME, never by pane id. herdr renumbers ids as
 *   panes open/close, so every call re-resolves name → pane id right before use.
 * - `agent send` writes LITERAL text (no Enter) — herdr's own help says so. So
 *   `send` always follows it with `pane send-keys <pane> enter` to submit.
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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
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

/** Normalized agent record — the shape callers actually want. */
export type AgentInfo = {
  name: string | null; // manual name given at `agent start`, if any
  type: string | null; // detected agent type (claude/codex/opencode), if any
  status: string; // idle | working | blocked | unknown
  paneId: string;
  tabId: string;
  workspaceId: string;
  terminalId: string;
  cwd: string;
  foregroundCwd?: string;
  focused: boolean;
};

export type SpawnOpts = {
  role: string; // human label, e.g. "reviewer" — the unique name is derived from it
  agent: string; // binary to launch in the pane, e.g. "codex" | "claude" | "opencode"
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
  task?: { sent: boolean };
};
export type SendResult = {
  target: string;
  paneId: string | null;
  submitted: boolean;
};
export type KeysResult = { target: string; paneId: string; keys: string[] };
export type CloseResult = { target: string; paneId: string; closed: true };

function randHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
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
    focused: !!a.focused,
  };
}

export function createHerd(run: Runner = herdrRunner) {
  /** Run a herdr command that returns a JSON envelope; unwrap `.result`, throw on error. */
  async function callJson(args: string[]): Promise<any> {
    const { stdout, stderr, code } = await run(args);
    let parsed: any = null;
    const raw = stdout.trim() || stderr.trim();
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (code !== 0 || parsed?.error) {
      const msg =
        parsed?.error?.message ||
        stderr.trim() ||
        stdout.trim() ||
        `herdr ${args.join(" ")} exited ${code}`;
      throw new HerdrError(msg, parsed?.error?.code);
    }
    return parsed?.result ?? parsed;
  }

  /** Run a herdr command that prints nothing on success (send-text/send-keys/run). */
  async function callVoid(args: string[]): Promise<void> {
    const { stderr, stdout, code } = await run(args);
    if (code !== 0) {
      throw new HerdrError(
        stderr.trim() ||
          stdout.trim() ||
          `herdr ${args.join(" ")} exited ${code}`,
      );
    }
  }

  async function list(): Promise<AgentInfo[]> {
    const r = await callJson(["agent", "list"]);
    return (r.agents ?? []).map(normAgent);
  }

  async function get(target: string): Promise<AgentInfo> {
    const r = await callJson(["agent", "get", target]);
    return normAgent(r.agent ?? r);
  }

  /** Re-resolve a target name → its current pane id (ids are not durable). */
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

  async function wait(
    target: string,
    opts: {
      status?: "idle" | "working" | "blocked" | "unknown";
      timeoutMs?: number;
    } = {},
  ): Promise<any> {
    const status = opts.status ?? "idle";
    const timeout = opts.timeoutMs ?? 15000;
    return callJson([
      "agent",
      "wait",
      target,
      "--status",
      status,
      "--timeout",
      String(timeout),
    ]);
  }

  async function read(
    target: string,
    opts: {
      lines?: number;
      source?: "recent-unwrapped" | "recent" | "visible";
    } = {},
  ): Promise<string> {
    const lines = opts.lines ?? 40;
    // Default to `visible` (the current screen), not `recent`: agent TUIs
    // (claude/codex) render into the alternate screen buffer, so their
    // scrollback — what `recent`/`recent-unwrapped` read — is often empty.
    // Pass `--source recent-unwrapped` explicitly for a scrolled log tail.
    const source = opts.source ?? "visible";
    // `agent read` returns a JSON envelope (unlike `pane read`'s plain text);
    // the transcript lives at result.read.text.
    const r = await callJson([
      "agent",
      "read",
      target,
      "--source",
      source,
      "--lines",
      String(lines),
    ]);
    return r.read?.text ?? "";
  }

  /** Write a prompt to a running agent and (by default) press Enter to submit it. */
  async function send(
    target: string,
    text: string,
    opts: { submit?: boolean } = {},
  ): Promise<SendResult> {
    const submit = opts.submit ?? true;
    await callJson(["agent", "send", target, text]); // literal text, no Enter
    let paneId: string | null = null;
    if (submit) {
      paneId = await resolvePane(target); // re-resolve right before use
      // Let the TUI finish processing the pasted text before pressing Enter —
      // an Enter that lands too fast can be swallowed (seen live with codex:
      // the text sits in the input box, never submitted). Tune/disable via
      // HERD_SUBMIT_SETTLE_MS.
      const settleMs = Number(process.env.HERD_SUBMIT_SETTLE_MS ?? 400);
      if (settleMs > 0) await Bun.sleep(settleMs);
      await callVoid(["pane", "send-keys", paneId, "enter"]);
    }
    return { target, paneId, submitted: submit };
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
   *  new-tab spawn (agent start --tab steals focus despite --no-focus). */
  async function focusedTabId(): Promise<string | null> {
    try {
      const r = await callJson(["tab", "list"]);
      const tabs: any[] = r.tabs ?? [];
      return tabs.find((t) => t.focused)?.tab_id ?? null;
    } catch {
      return null;
    }
  }

  /** Start the agent in a FRESH tab instead of splitting the caller's pane.
   *  herdr has no "agent start in a new empty tab" primitive: `tab create`
   *  leaves a shell root pane and `agent start --tab` splits within the tab. So
   *  we create the tab, start the agent in it, close the leftover shell root, and
   *  restore focus to the tab the caller was on. All post-start steps are
   *  best-effort — a real spawn already succeeded. */
  async function startInNewTab(name: string, opts: SpawnOpts): Promise<any> {
    const prevTab = await focusedTabId();

    const createArgs = ["tab", "create", "--no-focus"];
    // Pin the new tab to the CALLER's workspace, not whatever workspace happens
    // to have focus — otherwise a tab spawned while the user is looking at a
    // different workspace lands there. HERDR_WORKSPACE_ID is injected into every
    // herdr pane; an explicit opts.workspace still wins.
    const workspace = opts.workspace ?? process.env.HERDR_WORKSPACE_ID;
    if (workspace) createArgs.push("--workspace", workspace);
    if (opts.cwd) createArgs.push("--cwd", opts.cwd);
    // Label the tab so the caller can tell at a glance what it's for. Defaults
    // to the generated agent name (which encodes role + a unique suffix).
    createArgs.push("--label", opts.tabLabel ?? name);
    const created = await callJson(createArgs);
    const tabId: string | undefined = created.tab?.tab_id;
    const shellPaneId: string | undefined = created.root_pane?.pane_id;

    const args = ["agent", "start", name];
    if (opts.cwd) args.push("--cwd", opts.cwd);
    if (tabId) args.push("--tab", tabId);
    args.push("--no-focus");
    for (const e of opts.env ?? []) args.push("--env", e);
    args.push("--", opts.agent, ...(opts.argv ?? []));
    const started = await callJson(args);

    // Drop the shell root pane so the tab holds only the agent.
    if (shellPaneId) {
      try {
        await callJson(["pane", "close", shellPaneId]);
      } catch {
        /* best-effort — leave the shell pane rather than fail the spawn */
      }
    }
    // Give focus back to where the caller was.
    if (prevTab) {
      try {
        await callVoid(["tab", "focus", prevTab]);
      } catch {
        /* best-effort */
      }
    }
    return started;
  }

  async function spawn(opts: SpawnOpts): Promise<SpawnResult> {
    const name = await genName(opts.role);

    let started: any;
    if (opts.newTab) {
      started = await startInNewTab(name, opts);
    } else {
      const args = ["agent", "start", name];
      if (opts.cwd) args.push("--cwd", opts.cwd);
      if (opts.workspace) args.push("--workspace", opts.workspace);
      if (opts.tab) args.push("--tab", opts.tab);
      args.push("--split", opts.split ?? "down", "--no-focus");
      for (const e of opts.env ?? []) args.push("--env", e);
      args.push("--", opts.agent, ...(opts.argv ?? []));
      started = await callJson(args);
    }
    const info = normAgent(started.agent ?? started);

    let task: { sent: boolean } | undefined;
    if (opts.task) {
      // Best-effort: wait for the agent to settle, then submit the task.
      // A non-agent binary (e.g. a bare shell) never reports idle — send anyway.
      try {
        await wait(name, {
          status: "idle",
          timeoutMs: opts.waitTimeoutMs ?? 20000,
        });
      } catch {
        /* proceed to send regardless */
      }
      await send(name, opts.task);
      task = { sent: true };
    }
    // Generated name is authoritative — spread info first so a null name from the
    // envelope can't clobber it.
    return { ...info, name, task };
  }

  async function close(target: string): Promise<CloseResult> {
    const paneId = await resolvePane(target);
    await callJson(["pane", "close", paneId]);
    return { target, paneId, closed: true };
  }

  return {
    list,
    get,
    resolvePane,
    genName,
    spawn,
    send,
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
const BOOLEAN_FLAGS = new Set(["no-submit", "new-tab"]);

/** Minimal flag parser: returns { positionals, flags, rest } where rest is everything after a bare `--`.
 *  Value-flags always consume the next token as their value — including values that start with `--`
 *  (e.g. `--task "--check src"`); only BOOLEAN_FLAGS and a missing token yield a boolean.
 *  Exported for unit testing. */
export function parseArgs(argv: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
  env: string[];
  rest: string[];
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
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
  herd list
  herd spawn <role> --agent <bin> [--cwd P] [--split down|right] [--new-tab] [--tab-label TEXT]
              [--workspace ID] [--tab ID] [--task "prompt"] [--wait-timeout MS] [--env K=V ...] [-- <extra argv>]
  herd send <target> <text> [--no-submit]
  herd keys <target> <key> [key ...]   # bare key chords, e.g. enter | ctrl+a ctrl+k
  herd wait <target> [--status idle|working|blocked|unknown] [--timeout MS]
  herd read <target> [--lines N] [--source recent-unwrapped|recent|visible]
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
        console.log(JSON.stringify(await herd.list(), null, 2));
        break;
      }
      case "spawn": {
        const role = positionals[0];
        const agent = flags.agent as string;
        if (!role || !agent)
          throw new HerdrError("spawn requires <role> and --agent <bin>");
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
        const target = rest[0];
        const submit = !rest.includes("--no-submit");
        const text = rest
          .slice(1)
          .filter((t) => t !== "--no-submit")
          .join(" ");
        if (!target || !text)
          throw new HerdrError("send requires <target> and <text>");
        const res = await herd.send(target, text, { submit });
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
          status: (flags.status as any) ?? "idle",
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

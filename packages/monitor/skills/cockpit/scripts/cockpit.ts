#!/usr/bin/env bun
// cockpit CLI — produces the kernel data: decision trail,
// plus the control-loop client (wait/send) that talks to the daemon broker.
//   cockpit log    --session <id> --decision D --reason R [--tradeoff T]
//                  [--facet "LABEL: text" ...] [--file p ...] [--option o ...] [--diagram MERMAID] [--needs-call]
//   cockpit scribe --type <kind> --text <body> [--title <headline>] [--file <path>]... [--diagram MERMAID] [--session <id>]
//   cockpit scribe --recent [N]
//   cockpit scribe --prep [--provider <p>]
//   cockpit prep   [--provider <p>]
//   cockpit wait   <sessionId>            # park (long-poll) until the user answers; prints the answer
//   cockpit send   <sessionId> <answer>   # answer a parked session (CLI twin of a UI button)
//   cockpit restart [--port N] [--no-open] # bounce the daemon onto this install's code (wins the MCP respawn race)
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { findSession } from "./find-session";
import { lintDiagram } from "./diagram-lint";
import { latestOpenCallId } from "./call-log";
import { getLanguage, setLanguage } from "./config";
import { classifyDaemon } from "./restart-lifecycle";
import { cockpitHome } from "./cockpit-home";
import {
  readScopes,
  resolveNudgeEnabled,
  setScope,
  type NudgeScope,
  type ToggleAction,
} from "./nudge-toggle";

// ---------- Types ----------

// An open, self-labeled dimension of a decision's reasoning. Rather than a fixed
// set of fields (problem/rejected/risk), the caller picks the label that fits the
// case — REJECTED, CONSTRAINT, ASSUMPTION, PRIOR-ART, … — so a card can express
// whatever thinking that particular decision actually involved.
type Facet = { label: string; text: string };

// The lens axis: what kind of decision-trail entry is this?
// Defaults to "decision" when absent (backward compat — old logs have no field).
// Single source of truth: VALID_KINDS is the whitelist, DecisionKind is derived
// from it so the runtime list and the type can't drift. Keep in sync with the
// dashboard copy (decision-log.js KINDS) and the CSS per-kind selectors.
const VALID_KINDS = ["decision", "rationale", "learning", "caveat"] as const;
type DecisionKind = (typeof VALID_KINDS)[number];

// Who wrote the entry? "agent" = cockpit log (hand-authored), "scribe" = cockpit scribe (auto-written by thoughtful mode).
// Defaults to "agent" when absent (backward compat).
type DecisionSource = "agent" | "scribe";

type DecisionRecord = {
  id: string;
  type: "decision";
  kind?: DecisionKind; // NEW — lens axis; default "decision" when absent
  source?: DecisionSource; // NEW — who wrote it; default "agent" when absent
  decision: string;
  reason: string;
  tradeoff: string;
  facets: Facet[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  diagram?: string; // NEW — optional Mermaid source; rendered as a themed SVG in the card
  timestamp: string;
};

type RegistryEntry = {
  provider: Provider;
  project: string;
  sessionId: string;
  logPath: string;
  lastHeartbeat: string;
};

type Registry = { sessions: RegistryEntry[] };
type Provider = "claude" | "codex" | "opencode";

// ---------- Paths ----------

const COCKPIT_HOME = cockpitHome();
const REGISTRY_PATH = join(COCKPIT_HOME, "registry.json");
const DAEMON_PATH = join(COCKPIT_HOME, "daemon.json");

function projectCockpitDir(project: string): string {
  return join(project, ".cockpit");
}

function logPathFor(project: string, sessionId: string): string {
  return join(projectCockpitDir(project), "logs", `${sessionId}.jsonl`);
}

// ---------- Arg parsing ----------

type Args = {
  single: Record<string, string>;
  repeated: Record<string, string[]>;
  flags: Set<string>;
};

const SINGLE_FLAGS = new Set([
  "provider",
  "session",
  "log-language",
  "decision",
  "reason",
  "tradeoff",
  "call",
  "type",
  "text",
  "title",
  "diagram",
]);
const REPEATED_FLAGS = new Set(["file", "option", "facet"]);
const BOOL_FLAGS = new Set(["needs-call", "prep"]);

function parseArgs(argv: string[]): Args {
  const single: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const name = tok.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
    } else if (name === "recent") {
      // --recent takes an optional numeric value. Only consume the next token if
      // it looks like a plain integer — otherwise leave it for the next iteration
      // so flags like `--recent --provider codex` stay intact.
      flags.add("recent");
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        single["recent"] = next;
        i++;
      }
    } else if (REPEATED_FLAGS.has(name)) {
      (repeated[name] ||= []).push(argv[++i]);
    } else if (SINGLE_FLAGS.has(name)) {
      single[name] = argv[++i];
    } else {
      // unknown flag with a value — capture it loosely
      single[name] = argv[++i];
    }
  }
  return { single, repeated, flags };
}

// `--facet "LABEL: free text"` → { label, text }. Split on the first colon so the
// body can contain colons freely. A facet with no colon is kept as unlabeled text
// (label ""), and blank entries are dropped — never emit an empty stencil row.
function parseFacets(raw: string[]): Facet[] {
  return raw
    .map((entry) => {
      const i = entry.indexOf(":");
      if (i === -1) return { label: "", text: entry.trim() };
      return {
        label: entry.slice(0, i).trim(),
        text: entry.slice(i + 1).trim(),
      };
    })
    .filter((f) => f.text || f.label);
}

function parseProvider(value: string | undefined): Provider {
  if (!value || value === "claude") return "claude";
  if (value === "codex") return "codex";
  if (value === "opencode") return "opencode";
  console.error(`cockpit: invalid provider "${value}"`);
  process.exit(1);
}

// ---------- Registry ----------

function readRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    if (raw && Array.isArray(raw.sessions)) {
      return {
        sessions: raw.sessions.map((s: any) => ({
          ...s,
          provider:
            s?.provider === "codex" || s?.provider === "opencode"
              ? s.provider
              : "claude",
        })),
      };
    }
  } catch {
    // missing or corrupt → start fresh
  }
  return { sessions: [] };
}

// Long-ended sessions are never removed by upsert (keyed by sessionId, so they
// just accumulate), which both grows registry.json without bound and keeps their
// projects in the dashboard's project list forever — plus every /api/sessions
// poll stat()s each entry's log. Reap entries whose last signal is older than
// this on write. 14 days = the dashboard's "recent projects" look-back window.
const REGISTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Most-recent activity for an entry — mirrors registry.ts statusOf: max of the
// heartbeat and the log file's mtime (a session can be live well past its last
// heartbeat write). Missing/unparseable signals count as 0 (ancient).
function lastSignalMs(e: RegistryEntry): number {
  const hb = Date.parse(e.lastHeartbeat);
  let mtime = 0;
  try {
    mtime = statSync(e.logPath).mtimeMs;
  } catch {
    // log gone — heartbeat is the only signal
  }
  return Math.max(Number.isNaN(hb) ? 0 : hb, mtime);
}

// Single write path: reap stale entries, then persist. The just-touched entry
// always survives (fresh heartbeat → 0ms old), so no special-casing needed.
function writeRegistry(reg: Registry, now = Date.now()): void {
  reg.sessions = reg.sessions.filter(
    (s) => now - lastSignalMs(s) < REGISTRY_TTL_MS,
  );
  mkdirSync(COCKPIT_HOME, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function upsertSession(entry: RegistryEntry): void {
  const reg = readRegistry();
  const idx = reg.sessions.findIndex((s) => s.sessionId === entry.sessionId);
  if (idx >= 0) reg.sessions[idx] = entry;
  else reg.sessions.push(entry);
  writeRegistry(reg);
}

function refreshHeartbeat(
  project: string,
  sessionId: string,
  provider: Provider = "claude",
): void {
  const reg = readRegistry();
  const entry = reg.sessions.find((s) => s.sessionId === sessionId);
  const now = new Date().toISOString();
  if (entry) {
    entry.lastHeartbeat = now;
    writeRegistry(reg);
  } else {
    upsertSession({
      provider,
      project,
      sessionId,
      logPath: logPathFor(project, sessionId),
      lastHeartbeat: now,
    });
  }
}

// Read a decision-log jsonl into parsed decision records. Side-effect-free:
// drops blank and unparseable lines, returns only `type:"decision"` records, and
// yields [] on any read error. The single parse path so the "skip bad lines"
// policy lives in one place (recent-mode reader + scribe persistence guard).
function readDecisionRecords(logPath: string): DecisionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as DecisionRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is DecisionRecord => r !== null && r.type === "decision");
}

// Gate a --diagram argument through the lint before anything is written. The
// dashboard degrades a broken diagram to raw source where the author can't see
// it — failing loudly here is the only point in the loop where they can fix it.
function gateDiagram(cmd: string, src: string | undefined): void {
  if (!src) return;
  const problems = lintDiagram(src);
  if (problems.length === 0) return;
  console.error(
    `cockpit ${cmd}: --diagram failed lint — fix the Mermaid source and re-run:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// ---------- Subcommands ----------

function printRecentScribeEntries(
  project: string,
  provider: Provider,
  args: Args,
): void {
  const n = args.single["recent"] ? parseInt(args.single["recent"], 10) : 8;
  const sessionId =
    args.single["session"] || findSession(provider, project) || null;
  if (!sessionId) return;
  const logPath = logPathFor(project, sessionId);
  if (!existsSync(logPath)) return;
  const lines = readDecisionRecords(logPath);
  // Keep only scribe-sourced entries; old entries without source default to "agent"
  const scribeLines = lines.filter((r) => (r.source ?? "agent") === "scribe");
  const recent = scribeLines.slice(-n);
  for (const r of recent) {
    const title = r.decision || "(untitled)";
    const kind = r.kind ?? "decision";
    console.log(`${kind} · ${title} · ${r.timestamp}`);
  }
}

function printGitCommand(label: string, args: string[]): void {
  console.log(`$ ${label}`);
  const res = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (res.error) {
    console.log(`(not available: ${res.error.message})`);
    return;
  }
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || `exit ${res.status}`).trim();
    console.log(`(not available: ${msg})`);
    return;
  }
  const out = res.stdout.trimEnd();
  console.log(out || "(no output)");
}

function cmdPrep(args: Args): void {
  const project = process.cwd();
  const provider = parseProvider(args.single["provider"]);
  const sessionId = args.single["session"] || findSession(provider, project);
  if (!sessionId) {
    console.error("cockpit prep: could not auto-resolve the current session");
    process.exit(1);
  }
  console.log("Session id:");
  console.log(sessionId);
  console.log("");
  console.log("Decision-log language:");
  console.log(getLanguage());
}

function cmdLog(args: Args): void {
  const project = process.cwd();
  const provider = parseProvider(args.single["provider"]);
  // Prefer an explicit --session, but fall back to the live session id so a
  // decision can't be misfiled to the wrong (or a stale) session.
  const sessionId = args.single["session"] || findSession(provider, project);
  if (!sessionId) {
    console.error(
      "cockpit log: --session <id> is required (could not auto-resolve the current session)",
    );
    process.exit(1);
  }
  gateDiagram("log", args.single["diagram"]);
  const rec: DecisionRecord = {
    id: crypto.randomUUID(),
    type: "decision",
    kind: "decision", // explicit — hand-authored entries are always "decision"
    source: "agent", // explicit — cmdLog is the agent/manual path
    decision: args.single["decision"] || "",
    reason: args.single["reason"] || "",
    tradeoff: args.single["tradeoff"] || "",
    facets: parseFacets(args.repeated["facet"] || []),
    needs_your_call: args.flags.has("needs-call"),
    options: args.repeated["option"] || [],
    files: args.repeated["file"] || [],
    // Optional — omitted entirely when absent so the vast majority of entries
    // (no diagram) keep their lean shape.
    ...(args.single["diagram"] ? { diagram: args.single["diagram"] } : {}),
    timestamp: new Date().toISOString(),
  };

  const logPath = logPathFor(project, sessionId);
  mkdirSync(join(projectCockpitDir(project), "logs"), { recursive: true });
  const line = JSON.stringify(rec);
  appendFileSync(logPath, line + "\n");

  // Read-back guard: a successful append must be observable. If our entry isn't
  // the log's tail, surface it loudly instead of reporting a phantom success —
  // a silently dropped needs_your_call leaves the user with no card to answer
  // while the session parks a wait that can never be woken.
  let persisted: string | undefined;
  try {
    persisted = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .at(-1);
  } catch {
    persisted = undefined;
  }
  if (persisted !== line) {
    console.error(`cockpit log: entry did not persist to ${logPath}`);
    process.exit(1);
  }

  refreshHeartbeat(project, sessionId, provider);

  console.log(`cockpit: logged decision for ${sessionId}`);
  // Surface the callId so a caller can park `cockpit wait` on this exact call.
  // (wait/send also auto-resolve the open call from the log, so this is just an
  // explicit handle for scripted flows.)
  if (rec.needs_your_call) console.log(`  call:  ${rec.id}`);
}

function cmdScribe(args: Args): void {
  const project = process.cwd();
  const provider = parseProvider(args.single["provider"]);
  const isPrep = args.flags.has("prep");
  const isRecent = args.flags.has("recent");
  const hasType = !!args.single["type"];

  // ---- Prep mode: one-call setup for background scribe forks ----
  if (isPrep && !hasType) {
    console.log("Decision-log language:");
    console.log(getLanguage());
    console.log("");
    console.log("Recent scribe entries:");
    printRecentScribeEntries(project, provider, args);
    console.log("");
    console.log("Git change context:");
    printGitCommand("git diff", ["diff"]);
    console.log("");
    printGitCommand("git diff --staged", ["diff", "--staged"]);
    console.log("");
    printGitCommand("git log --oneline -5", ["log", "--oneline", "-5"]);
    process.exit(0);
  }

  // ---- Recent mode: list last N scribe entries for dedup ----
  if (isRecent && !hasType) {
    printRecentScribeEntries(project, provider, args);
    process.exit(0);
  }

  // ---- Write mode ----
  if (!hasType) {
    console.error(
      "cockpit scribe: --type <kind> is required (or use --recent to list recent entries)",
    );
    process.exit(1);
  }

  // Validate --type against the single-source whitelist. Validate the raw string
  // and only narrow to DecisionKind after the guard (no pre-validation cast).
  const rawKind = args.single["type"];
  if (!(VALID_KINDS as readonly string[]).includes(rawKind)) {
    console.error(
      `cockpit scribe: invalid --type "${rawKind}" — must be one of: ${VALID_KINDS.join(", ")}`,
    );
    process.exit(1);
  }
  const kind = rawKind as DecisionKind;

  // Require --text
  if (!args.single["text"]) {
    console.error("cockpit scribe: --text <body> is required");
    process.exit(1);
  }

  // Resolve session — explicit or live; error if unresolved
  const sessionId = args.single["session"] || findSession(provider, project);
  if (!sessionId) {
    console.error(
      "cockpit scribe: --session <id> is required (could not auto-resolve the current session)",
    );
    process.exit(1);
  }

  gateDiagram("scribe", args.single["diagram"]);

  const rec: DecisionRecord = {
    id: crypto.randomUUID(),
    type: "decision",
    kind,
    source: "scribe",
    decision: args.single["title"] || "",
    reason: args.single["text"] || "",
    tradeoff: "",
    facets: [],
    needs_your_call: false,
    options: [],
    files: args.repeated["file"] || [],
    ...(args.single["diagram"] ? { diagram: args.single["diagram"] } : {}),
    timestamp: new Date().toISOString(),
  };

  const logPath = logPathFor(project, sessionId);

  // Auto-register before write so the session becomes tracked:true in the dashboard.
  upsertSession({
    provider,
    project,
    sessionId,
    logPath,
    lastHeartbeat: new Date().toISOString(),
  });

  mkdirSync(join(projectCockpitDir(project), "logs"), { recursive: true });
  const line = JSON.stringify(rec);
  appendFileSync(logPath, line + "\n");

  // Concurrency-safe persistence guard: confirm the record by id anywhere in
  // the file — NOT a tail check. Background forks from /thoughtful can interleave
  // writes, so the tail may belong to a later writer; checking id-anywhere means
  // both writers confirm their own record correctly.
  const confirmed = readDecisionRecords(logPath).some((r) => r.id === rec.id);
  if (!confirmed) {
    console.error(`cockpit scribe: entry did not persist to ${logPath}`);
    process.exit(1);
  }

  // No trailing refreshHeartbeat — the upsertSession above already wrote a fresh
  // lastHeartbeat in the same invocation; a second registry read-write would be
  // pure redundant IO.

  console.log(`cockpit: scribed ${kind} for ${sessionId}`);
}

function cmdConfig(rest: string[]): void {
  const args = parseArgs(rest);
  const logLanguage = args.single["log-language"];

  if (logLanguage) {
    setLanguage(logLanguage);
    console.log(`cockpit: log_language = ${logLanguage}`);
    return;
  }

  if (positionals(rest)[0] === "get-language") {
    console.log(getLanguage());
    return;
  }

  console.error(
    "usage: cockpit config --log-language <lang> | cockpit config get-language",
  );
  process.exit(1);
}

// ---------- Daemon broker client (wait / send) ----------

type DaemonInfo = { pid: number; port: number; token: string };
const MAX_WAIT_CONNECTION_FAILURES = 3;

function readDaemon(): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(DAEMON_PATH, "utf8"));
    if (typeof raw?.port === "number" && typeof raw?.token === "string") {
      return raw as DaemonInfo;
    }
  } catch {
    // missing or corrupt → treat as not running
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function requireDaemon(): DaemonInfo {
  const d = readDaemon();
  if (!d || (typeof d.pid === "number" && !isAlive(d.pid))) {
    console.error("cockpit daemon not running — start the dashboard first");
    process.exit(1);
  }
  return d;
}

function positionals(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      i++; // skip this flag's value too
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

// The callId to bind a wait/send to: an explicit --call wins, otherwise resolve
// the session's currently open needs_your_call from its log (via the registry's
// recorded logPath). null when the session isn't registered or has no open call
// — in which case routing falls back to session-only (legacy) behavior.
function resolveCallId(
  sessionId: string,
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit;
  const logPath = readRegistry().sessions.find(
    (s) => s.sessionId === sessionId,
  )?.logPath;
  if (!logPath) return null;
  try {
    return latestOpenCallId(readFileSync(logPath, "utf8").split("\n"));
  } catch {
    return null;
  }
}

// `cockpit wait <sessionId>` — launched as a background task right after a
// `--needs-call` log. Long-polls /api/wait; on the re-pollable timeout sentinel
// it loops again, so a single connection drop doesn't lose the user's pending answer.
async function cmdWait(rest: string[]): Promise<void> {
  const sessionId = positionals(rest)[0];
  if (!sessionId) {
    console.error("cockpit wait: <sessionId> is required");
    process.exit(1);
  }
  const d = requireDaemon();
  // Bind this park to a specific call so an answer to a different (stale) card
  // can't wake it. Resolved from the log when --call isn't given explicitly.
  const callId = resolveCallId(sessionId, flagValue(rest, "call"));
  const maxMs = (() => {
    const v = parseInt(process.env.COCKPIT_WAIT_MAX_MS || "", 10);
    return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60 * 1000; // 6h ceiling
  })();
  const url =
    `http://127.0.0.1:${d.port}/api/wait` +
    `?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(d.token)}` +
    (callId ? `&call=${encodeURIComponent(callId)}` : "");

  const start = Date.now();
  let connectionFailures = 0;
  while (Date.now() - start < maxMs) {
    let res: Response;
    try {
      res = await fetch(url);
      connectionFailures = 0;
    } catch (err) {
      connectionFailures++;
      const fresh = readDaemon();
      if (
        !fresh ||
        (typeof fresh.pid === "number" && !isAlive(fresh.pid)) ||
        fresh.port !== d.port ||
        fresh.token !== d.token ||
        connectionFailures >= MAX_WAIT_CONNECTION_FAILURES
      ) {
        console.error(
          `cockpit wait: lost connection to daemon (${(err as Error).message})`,
        );
        process.exit(1);
      }
      await Bun.sleep(1000);
      continue;
    }
    // A non-2xx is a permanent error (bad token → 401, invalid session → 400).
    // Surface it and bail — do NOT spin retrying, and do NOT misreport it as a
    // timeout/"nobody listening".
    if (!res.ok) {
      console.error(`cockpit wait: ${await errorText(res)}`);
      process.exit(1);
    }
    let data: any;
    try {
      data = await res.json();
    } catch {
      await Bun.sleep(1000);
      continue;
    }
    // A real answer (including the empty string) is a string; the timeout
    // sentinel is { answer: null, timeout: true } → re-poll.
    if (data && typeof data.answer === "string") {
      console.log(data.answer);
      process.exit(0);
    }
    // This call is no longer open (answered elsewhere, or a newer needs_your_call
    // superseded it). Stop cleanly rather than re-poll a moot question — exit 3
    // so the caller can tell "no answer for this call" from a delivered answer.
    if (data && data.superseded === true) {
      console.error("cockpit wait: call is no longer open (superseded)");
      process.exit(3);
    }
  }
  console.error("cockpit wait: no answer received");
  process.exit(1);
}

// Best-effort human-readable error from a non-ok daemon response.
async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return `${body.error} (HTTP ${res.status})`;
  } catch {
    // fall through to bare status
  }
  return `HTTP ${res.status}`;
}

// `cockpit send <sessionId> <answer>` — the terminal twin of a UI option
// button. POSTs the answer; reports whether a parked session was woken.
async function cmdSend(rest: string[]): Promise<void> {
  const pos = positionals(rest);
  const sessionId = pos[0];
  const answer = pos.slice(1).join(" ");
  if (!sessionId) {
    console.error("cockpit send: <sessionId> <answer> is required");
    process.exit(1);
  }
  const d = requireDaemon();
  // Tag the answer with the call it resolves so the broker wakes the matching
  // parked wait (not a stale one). Auto-resolved from the log unless --call given.
  const callId = resolveCallId(sessionId, flagValue(rest, "call"));
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${d.port}/api/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: sessionId,
        answer,
        call: callId,
        token: d.token,
      }),
    });
  } catch (err) {
    console.error(
      `cockpit send: lost connection to daemon (${(err as Error).message})`,
    );
    process.exit(1);
  }
  // A non-2xx (bad token → 401, invalid session → 400) is a real failure — not
  // the same as a delivered:false. Surface it and exit non-zero so the caller
  // isn't told the answer was "logged" when it wasn't.
  if (!res.ok) {
    console.error(`cockpit send: ${await errorText(res)}`);
    process.exit(1);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (data?.delivered) {
    console.log("delivered: true");
  } else {
    console.log("delivered: false");
    console.log(
      "  (answer logged, but the session isn't parked/listening right now)",
    );
  }
}

// ---------- Restart ----------

// The cockpit daemon this install launches. Sibling of this CLI, so a restart
// always serves the same version as the `cockpit.ts` you invoked — run it from
// the freshly-updated plugin cache (or a dev checkout) and that's what binds.
const COCKPIT_SERVER = join(import.meta.dir, "cockpit-server.ts");
const MY_ROOT = import.meta.dir;

// daemon.json carries the launcher's root (see daemon-lifecycle.ts); readDaemon()
// only surfaces port/token, so read the root separately for the ownership check.
function readDaemonRoot(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(DAEMON_PATH, "utf8"));
    return typeof raw?.root === "string" ? raw.root : undefined;
  } catch {
    return undefined;
  }
}

function daemonPid(): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(DAEMON_PATH, "utf8"));
    return typeof raw?.pid === "number" ? raw.pid : undefined;
  } catch {
    return undefined;
  }
}

// Confirm the bound daemon actually answers HTTP (daemon.json can be written a
// beat before the socket is listening).
async function portAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/token`, {
      signal: AbortSignal.timeout(800),
    });
    return r.ok || r.status === 503;
  } catch {
    return false;
  }
}

function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  for (let i = 0; i < 30 && isAlive(pid); i++) Bun.sleepSync(50); // ≤1.5s graceful
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && isAlive(pid); i++) Bun.sleepSync(50); // ≤1s
  }
}

// `cockpit restart [--port N] [--no-open]` — bounce the daemon onto this install's
// code. Kills the running daemon (a same-root relaunch would otherwise "reuse" and
// never pick up new code), then spawns a fresh one and confirms OUR root won the
// port — retrying past any concurrent MCP respawn from another install.
async function cmdRestart(rest: string[]): Promise<void> {
  const portFlag = flagValue(rest, "port");
  const noOpen = rest.includes("--no-open");

  const oldPid = daemonPid();
  if (oldPid && isAlive(oldPid)) stopPid(oldPid);

  const ATTEMPTS = 4;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const args = [COCKPIT_SERVER];
    if (portFlag) args.push("--port", portFlag);
    // Only the first attempt opens a tab; retries stay headless so a contended
    // restart can't fan out into a pile of browser windows.
    if (noOpen || attempt > 1) args.push("--no-open");
    spawn("bun", args, { detached: true, stdio: "ignore" }).unref();

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const kind = classifyDaemon(
        { pid: daemonPid(), root: readDaemonRoot() },
        MY_ROOT,
        isAlive,
      );
      if (kind === "ours") {
        const d = readDaemon();
        if (d && (await portAnswers(d.port))) {
          console.log(
            `cockpit: daemon restarted → http://localhost:${d.port} (pid ${daemonPid()})`,
          );
          console.log(`  serving: ${MY_ROOT}`);
          return;
        }
      } else if (kind === "foreign") {
        // Another install (e.g. an MCP respawn from the old plugin cache) grabbed
        // the port — supersede it and spawn ours again.
        const p = daemonPid();
        if (p) stopPid(p);
        break;
      }
      await Bun.sleep(100);
    }
  }
  console.error(
    "cockpit restart: could not confirm a fresh daemon from this install — a respawn from another install may be contending for the port. Retry, or restart the Claude session so its channel uses the updated plugin.",
  );
  process.exit(1);
}

// ---------- Nudge toggle ----------

const NUDGE_USAGE =
  "usage: cockpit nudge <on|off|toggle|clear|status> [--scope session|project|user]";

function fmtScope(state: "on" | "off" | undefined): string {
  return state === undefined ? "default" : state.toUpperCase();
}

/**
 * `cockpit nudge <on|off|toggle|clear|status> [--scope ...]` — flip the scribe
 * Stop-hook reminders at one of three scopes (session / project / user). The
 * most-specific defined scope wins; status prints the effective result plus the
 * per-scope breakdown. Session lives in a TTL-pruned file; project + user live
 * in the global config (nudge-toggle.ts / config.ts).
 */
function cmdNudge(rest: string[]): void {
  let action = "status";
  let scope: NudgeScope = "session";
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--scope") {
      const v = rest[++i];
      if (v !== "session" && v !== "project" && v !== "user") {
        console.error(`cockpit nudge: invalid scope "${v ?? ""}"`);
        console.error(NUDGE_USAGE);
        process.exit(1);
      }
      scope = v;
    } else {
      action = tok.toLowerCase();
    }
  }
  if (!["on", "off", "toggle", "clear", "status"].includes(action)) {
    console.error(`cockpit nudge: unknown action "${action}"`);
    console.error(NUDGE_USAGE);
    process.exit(1);
  }

  const cwd = process.cwd();
  const now = Date.now();
  // Session id is required only to mutate the session scope; status and the
  // project/user scopes tolerate its absence (the session column shows default).
  const sessionId = findSession("claude", cwd);
  if (action !== "status" && scope === "session" && !sessionId) {
    console.error(
      "cockpit nudge: could not resolve the current session id (no CLAUDE_CODE_SESSION_ID and no transcript). Run inside a Claude session, or target --scope project|user.",
    );
    process.exit(1);
  }

  if (action !== "status") {
    setScope(scope, action as ToggleAction, {
      sessionId: sessionId ?? "",
      cwd,
      now,
    });
  }

  const scopes = readScopes(sessionId, cwd, now);
  const enabled = resolveNudgeEnabled(
    scopes.session,
    scopes.project,
    scopes.user,
  );
  const verb =
    action === "status" ? "" : ` — ${scope} set to ${fmtScope(scopes[scope])}`;
  console.log(`scribe nudges: ${enabled ? "ON" : "OFF"} (effective)${verb}`);
  console.log(
    `  session: ${fmtScope(scopes.session)} · project: ${fmtScope(scopes.project)} · user: ${fmtScope(scopes.user)}`,
  );
}

// ---------- Main ----------

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "log":
      cmdLog(parseArgs(rest));
      break;
    case "scribe":
      cmdScribe(parseArgs(rest));
      break;
    case "prep":
      cmdPrep(parseArgs(rest));
      break;
    case "config":
      cmdConfig(rest);
      break;
    case "wait":
      await cmdWait(rest);
      break;
    case "send":
      await cmdSend(rest);
      break;
    case "restart":
      await cmdRestart(rest);
      break;
    case "nudge":
      cmdNudge(rest);
      break;
    default:
      console.error(`cockpit: unknown subcommand "${sub ?? ""}"`);
      console.error(
        "usage: cockpit <log|scribe|prep|config|wait|send|restart|nudge> [args]",
      );
      process.exit(1);
  }
}

main();

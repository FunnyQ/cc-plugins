#!/usr/bin/env bun
// cockpit CLI — produces the kernel data: session goal + decision trail,
// plus the control-loop client (wait/send) that talks to the daemon broker.
//   cockpit start --session <id> --session-goal X --project-goal Y [--owner user]
//   cockpit log   --session <id> --decision D --reason R [--tradeoff T]
//                 [--file p ...] [--option o ...] [--needs-call]
//   cockpit wait  <sessionId>            # park (long-poll) until the user answers; prints the answer
//   cockpit send  <sessionId> <answer>   # answer a parked session (CLI twin of a UI button)
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- Types ----------

type GoalRecord = { type: "goal"; session_goal: string; ts: string };

type DecisionRecord = {
  id: string;
  type: "decision";
  decision: string;
  reason: string;
  tradeoff: string;
  needs_your_call: boolean;
  options: string[];
  files: string[];
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
type Provider = "claude" | "codex";

// ---------- Paths ----------

const COCKPIT_HOME = process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
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
  "session-goal",
  "project-goal",
  "owner",
  "log-language",
  "decision",
  "reason",
  "tradeoff",
]);
const REPEATED_FLAGS = new Set(["file", "option"]);
const BOOL_FLAGS = new Set(["needs-call"]);

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

function parseProvider(value: string | undefined): Provider {
  if (!value || value === "claude") return "claude";
  if (value === "codex") return "codex";
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
          provider: s?.provider === "codex" ? "codex" : "claude",
        })),
      };
    }
  } catch {
    // missing or corrupt → start fresh
  }
  return { sessions: [] };
}

function upsertSession(entry: RegistryEntry): void {
  mkdirSync(COCKPIT_HOME, { recursive: true });
  const reg = readRegistry();
  const idx = reg.sessions.findIndex((s) => s.sessionId === entry.sessionId);
  if (idx >= 0) reg.sessions[idx] = entry;
  else reg.sessions.push(entry);
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
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
    mkdirSync(COCKPIT_HOME, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
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

// ---------- project-meta.md ----------

function readMetaField(metaPath: string, field: string): string | undefined {
  if (!existsSync(metaPath)) return undefined;
  const re = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m");
  const m = readFileSync(metaPath, "utf8").match(re);
  return m?.[1];
}

function writeProjectMeta(
  project: string,
  projectGoal: string,
  owner: string,
  logLanguage: string,
): void {
  const metaPath = join(projectCockpitDir(project), "project-meta.md");
  const created =
    readMetaField(metaPath, "created") || new Date().toISOString();
  // log_language steers the language of decision-log entries. Persist it per
  // project: keep the existing value when start is re-run without an explicit
  // --log-language, and default to English when nothing has ever been set.
  const logLang =
    logLanguage || readMetaField(metaPath, "log_language") || "English";
  const body = [
    "---",
    `project_goal: ${projectGoal}`,
    `created: ${created}`,
    `owner: ${owner}`,
    `log_language: ${logLang}`,
    "---",
    "",
    "Longer prose describing the project's purpose, constraints, north star.",
    "Free-form — hand-edit or regenerate as the project evolves.",
    "",
  ].join("\n");
  writeFileSync(metaPath, body);
}

// Write the goal as line 1 of the log, preserving any records already there.
// `start` may be re-run on an existing session (e.g. to refresh the goal or set
// log_language) — it must NOT truncate the decision trail, so we replace only a
// leading goal record and keep everything appended after it.
function writeGoalRecord(logPath: string, goal: GoalRecord): void {
  let rest: string[] = [];
  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    if (existing.length) {
      let from = 0;
      try {
        if (JSON.parse(existing[0])?.type === "goal") from = 1;
      } catch {
        // line 1 isn't valid JSON — keep all existing lines below the new goal
      }
      rest = existing.slice(from);
    }
  }
  writeFileSync(logPath, [JSON.stringify(goal), ...rest].join("\n") + "\n");
}

// ---------- Subcommands ----------

function cmdStart(args: Args): void {
  const project = process.cwd();
  const provider = parseProvider(args.single["provider"]);
  const sessionId = args.single["session"] || crypto.randomUUID();
  const sessionGoal = args.single["session-goal"] || "";
  const projectGoal = args.single["project-goal"] || "";
  const owner = args.single["owner"] || "user";
  const logLanguage = args.single["log-language"] || "";

  mkdirSync(join(projectCockpitDir(project), "logs"), { recursive: true });
  writeProjectMeta(project, projectGoal, owner, logLanguage);

  const logPath = logPathFor(project, sessionId);
  const goal: GoalRecord = {
    type: "goal",
    session_goal: sessionGoal,
    ts: new Date().toISOString(),
  };
  writeGoalRecord(logPath, goal);

  upsertSession({
    provider,
    project,
    sessionId,
    logPath,
    lastHeartbeat: new Date().toISOString(),
  });

  console.log(`cockpit: started session ${sessionId}`);
  console.log(
    `  meta:  ${join(projectCockpitDir(project), "project-meta.md")}`,
  );
  console.log(`  log:   ${logPath}`);
}

function cmdLog(args: Args): void {
  const project = process.cwd();
  const provider = parseProvider(args.single["provider"]);
  const sessionId = args.single["session"];
  if (!sessionId) {
    console.error("cockpit log: --session <id> is required");
    process.exit(1);
  }
  const rec: DecisionRecord = {
    id: crypto.randomUUID(),
    type: "decision",
    decision: args.single["decision"] || "",
    reason: args.single["reason"] || "",
    tradeoff: args.single["tradeoff"] || "",
    needs_your_call: args.flags.has("needs-call"),
    options: args.repeated["option"] || [],
    files: args.repeated["file"] || [],
    timestamp: new Date().toISOString(),
  };

  const logPath = logPathFor(project, sessionId);
  mkdirSync(join(projectCockpitDir(project), "logs"), { recursive: true });
  appendFileSync(logPath, JSON.stringify(rec) + "\n");
  refreshHeartbeat(project, sessionId, provider);

  console.log(`cockpit: logged decision for ${sessionId}`);
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
  return rest.filter((t) => !t.startsWith("--"));
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
  const maxMs = (() => {
    const v = parseInt(process.env.COCKPIT_WAIT_MAX_MS || "", 10);
    return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60 * 1000; // 6h ceiling
  })();
  const url =
    `http://127.0.0.1:${d.port}/api/wait` +
    `?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(d.token)}`;

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
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${d.port}/api/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionId, answer, token: d.token }),
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

// ---------- Main ----------

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "start":
      cmdStart(parseArgs(rest));
      break;
    case "log":
      cmdLog(parseArgs(rest));
      break;
    case "wait":
      await cmdWait(rest);
      break;
    case "send":
      await cmdSend(rest);
      break;
    default:
      console.error(`cockpit: unknown subcommand "${sub ?? ""}"`);
      console.error("usage: cockpit <start|log|wait|send> [args]");
      process.exit(1);
  }
}

main();

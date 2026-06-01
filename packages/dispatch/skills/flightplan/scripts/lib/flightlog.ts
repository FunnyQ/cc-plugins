/**
 * Flightlog — the append-only audit trail for an autopilot run.
 *
 * Two kinds of entry land in one JSONL file under `docs/<slug>/.flightlog/`:
 *
 *   - `score` — a deterministic verdict appended by `score-task.ts --log`.
 *   - `note`  — agent narrative appended by `flightlog.ts log`.
 *
 * The orchestrator script can't touch the filesystem, so logging always comes
 * from a bundled script run by a tool-capable agent. Every entry records an
 * `agentLabel` so a verdict can be traced back to the raw `agent-<id>.jsonl`.
 *
 * The whole `.flightlog/` tree is gitignored via a self-ignoring `.gitignore`
 * (`*`) so users need no manual setup.
 *
 * Pure functions (format/parse/render) take entries with `ts` already set so
 * they stay deterministic under test; only the CLIs stamp the wall clock.
 */
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  access,
} from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export type ScoreEntry = {
  kind: "score";
  /** ISO timestamp. */
  ts: string;
  /** Task ref, e.g. "ui/03". */
  task: string;
  /** Which retry attempt produced this verdict (1-based). */
  attempt: number;
  /** Label of the judge agent — links to the raw `agent-<id>.jsonl`. */
  agentLabel?: string;
  /** Weighted average on the rubric's scale. */
  weighted: number;
  passed: boolean;
  hardFailed: boolean;
  /** Dimensions the rubric declared but the scores omitted. */
  missing: string[];
  threshold: number;
  passOp: ">" | ">=";
  breakdown: { name: string; weight: number; score: number }[];
};

export type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  /** Pipeline role: dev / verify / judge / final-review (free-form). */
  role: string;
  attempt?: number;
  agentLabel?: string;
  message: string;
};

export type FlightlogEntry = ScoreEntry | NoteEntry;

const FLIGHTLOG_DIRNAME = ".flightlog";

/** Serialize one entry to a single newline-free JSONL line. */
export function formatEntry(entry: FlightlogEntry): string {
  return JSON.stringify(entry);
}

/**
 * Parse a JSONL log into entries. Tolerant: blank lines are skipped and a
 * malformed line is dropped rather than aborting the whole trail (a partial
 * log is more useful than none when an agent died mid-write).
 */
export function parseLog(content: string): FlightlogEntry[] {
  const entries: FlightlogEntry[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && (parsed.kind === "score" || parsed.kind === "note")) {
        entries.push(parsed as FlightlogEntry);
      }
    } catch {
      // Drop the malformed line, keep the rest.
    }
  }
  return entries;
}

/** Render the trail to a human-readable RUNLOG.md, grouped by task. */
export function renderRunlog(
  entries: FlightlogEntry[],
  opts: { slug: string },
): string {
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));

  // Preserve first-seen order of tasks for stable headings.
  const order: string[] = [];
  const byTask = new Map<string, FlightlogEntry[]>();
  for (const e of sorted) {
    if (!byTask.has(e.task)) {
      byTask.set(e.task, []);
      order.push(e.task);
    }
    byTask.get(e.task)!.push(e);
  }

  const out: string[] = [`# Run log — ${opts.slug}`, ""];
  for (const task of order) {
    out.push(`## ${task}`, "");
    for (const e of byTask.get(task)!) {
      out.push(renderLine(e));
    }
    out.push("");
  }
  return out.join("\n");
}

function renderLine(e: FlightlogEntry): string {
  const attempt = e.attempt ? `attempt ${e.attempt} · ` : "";
  const agent = e.agentLabel ? ` _(agent: ${e.agentLabel})_` : "";
  if (e.kind === "note") {
    return `- ${attempt}${e.role} — ${e.message}${agent}`;
  }
  const verdict = e.passed ? "PASS ✅" : "FAIL ❌";
  const veto = e.hardFailed ? " · hard-fail veto (一票否決)" : "";
  const miss = e.missing.length ? ` · missing: ${e.missing.join(", ")}` : "";
  return `- ${attempt}judge — score ${e.weighted.toFixed(2)} ${e.passOp} ${e.threshold} → ${verdict}${veto}${miss}${agent}`;
}

/**
 * Ensure `<dir>/.flightlog/` exists with a self-ignoring `.gitignore` (`*`).
 * Idempotent — never clobbers an existing `.gitignore`. Returns the flightlog
 * dir path.
 */
export async function ensureFlightlogDir(planDir: string): Promise<string> {
  const dir = join(planDir, FLIGHTLOG_DIRNAME);
  await mkdir(dir, { recursive: true });
  const gitignore = join(dir, ".gitignore");
  if (!(await exists(gitignore))) {
    await writeFile(gitignore, "*\n");
  }
  return dir;
}

/**
 * Append one entry to a JSONL log file, creating the parent dir on first
 * write. When the parent dir is `.flightlog`, also drop the self-ignore so the
 * trail never gets committed by accident.
 */
export async function appendEntry(
  logFile: string,
  entry: FlightlogEntry,
): Promise<void> {
  const dir = dirname(logFile);
  await mkdir(dir, { recursive: true });
  if (basename(dir) === FLIGHTLOG_DIRNAME) {
    const gitignore = join(dir, ".gitignore");
    if (!(await exists(gitignore))) {
      await writeFile(gitignore, "*\n");
    }
  }
  await appendFile(logFile, formatEntry(entry) + "\n");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read + parse a log file; returns [] if the file is absent. */
export async function readLog(logFile: string): Promise<FlightlogEntry[]> {
  try {
    return parseLog(await readFile(logFile, "utf-8"));
  } catch {
    return [];
  }
}

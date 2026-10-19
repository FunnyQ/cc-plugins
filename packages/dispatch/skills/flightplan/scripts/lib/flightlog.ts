/**
 * Flightlog — the append-only audit trail for an autopilot run.
 *
 * Three kinds of entry land in one JSONL file under `docs/<slug>/.flightlog/`:
 *
 *   - `score` — a deterministic verdict appended by `score-task.ts --log`.
 *   - `note`  — agent narrative appended by `flightlog.ts log`.
 *   - `state` — node declaration appended by `flightlog.ts state`.
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
  ts: string;
  task: string;
  attempt: number;
  agentLabel?: string;
  weighted: number;
  passed: boolean;
  hardFailed: boolean;
  missing: string[];
  threshold: number;
  passOp: ">" | ">=";
  breakdown: { name: string; weight: number; score: number }[];
  /**
   * The judge's prose justification for the scores. Optional because every
   * entry written before this field existed has none — an old trail stays
   * valid and re-renders identically.
   */
  rationale?: string;
};

export type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  role: string;
  attempt?: number;
  agentLabel?: string;
  phase?: "start" | "end";
  message: string;
};

export type StateFields = {
  ts: string;
  /** Node ref, in the declared graph's `<lane>/<NN>` shape. */
  task: string;
  agentLabel?: string;
} & (
  | { state: "done"; message?: string }
  | { state: "blocked" | "failed"; message: string }
);

export type StateEntry = { kind: "state" } & StateFields;

export type FlightlogEntry = ScoreEntry | NoteEntry | StateEntry;

export const FLIGHTLOG_DIRNAME = ".flightlog";

export function runLogPath(planDir: string): string {
  return join(planDir, FLIGHTLOG_DIRNAME, "run.jsonl");
}

export function formatEntry(entry: FlightlogEntry): string {
  return JSON.stringify(entry);
}

export function parseLog(content: string): FlightlogEntry[] {
  return parseLines(content.split("\n"));
}

export function parseLines(lines: string[]): FlightlogEntry[] {
  const entries: FlightlogEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed &&
        (parsed.kind === "score" ||
          parsed.kind === "note" ||
          parsed.kind === "state")
      ) {
        entries.push(parsed);
      }
    } catch {}
  }
  return entries;
}

export function renderRunlog(
  entries: FlightlogEntry[],
  opts: { slug: string },
): string {
  const sorted = [...entries]
    .filter((e) => !(e.kind === "note" && e.phase === "start"))
    .sort((a, b) => a.ts.localeCompare(b.ts));

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
  const agent = e.agentLabel ? ` _(agent: ${e.agentLabel})_` : "";
  if (e.kind === "state") {
    const message = e.message ? `: ${e.message}` : "";
    return `- state — ${e.state}${message}${agent}`;
  }
  const attempt = e.attempt ? `attempt ${e.attempt} · ` : "";
  if (e.kind === "note") {
    return `- ${attempt}${e.role} — ${e.message}${agent}`;
  }
  const verdict = e.passed ? "PASS ✅" : "FAIL ❌";
  const veto = e.hardFailed ? " · hard-fail veto" : "";
  const miss = e.missing.length ? ` · missing: ${e.missing.join(", ")}` : "";
  const line = `- ${attempt}judge — score ${e.weighted.toFixed(2)} ${e.passOp} ${e.threshold} → ${verdict}${veto}${miss}${agent}`;
  const rationale = e.rationale?.trim();
  if (!rationale) return line;
  // Collapsed and unindented on purpose. A rationale runs to hundreds of words
  // and would bury the verdict lines; nesting the block inside the list item
  // would need every line re-indented, which rewrites the judge's own markdown.
  return `${line}\n\n<details><summary>judge rationale</summary>\n\n${rationale}\n\n</details>\n`;
}

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

export async function readLog(logFile: string): Promise<FlightlogEntry[]> {
  try {
    return parseLog(await readFile(logFile, "utf-8"));
  } catch {
    return [];
  }
}

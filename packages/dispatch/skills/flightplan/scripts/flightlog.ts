#!/usr/bin/env bun
/**
 * flightlog — append agent narrative to an autopilot run's audit trail and
 * render it to RUNLOG.md.
 *
 * The orchestrator script has no filesystem access, so narrative entries are
 * written by the tool-capable Dev / Review / Final-review agents calling this
 * CLI. Score verdicts are written separately by `score-task.ts --log`; both
 * land in the same JSONL trail under `docs/<slug>/.flightlog/`.
 *
 * Usage:
 *   bun flightlog.ts log <logfile> --task <ref> --role <role> [--attempt N] \
 *       [--agent <label>] --message "<text>"
 *   bun flightlog.ts report <logfile> [--slug <slug>] [--out <RUNLOG.md>]
 *
 * `report` parses the JSONL trail and writes a grouped, human-readable
 * RUNLOG.md (default: sibling of the log file).
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import {
  appendEntry,
  readLog,
  renderRunlog,
  type NoteEntry,
} from "./lib/flightlog";

/** Build a flightlog note entry from narrative metadata (pure). */
export function buildNoteEntry(meta: {
  task: string;
  role: string;
  message: string;
  ts: string;
  attempt?: number;
  agentLabel?: string;
}): NoteEntry {
  return {
    kind: "note",
    ts: meta.ts,
    task: meta.task,
    role: meta.role,
    attempt: meta.attempt,
    agentLabel: meta.agentLabel,
    message: meta.message,
  };
}

/**
 * Derive a display slug from a log file path: the dir that contains
 * `.flightlog/`, e.g. `docs/my-plan/.flightlog/run.jsonl` → `my-plan`.
 */
export function slugFromLogPath(logFile: string): string {
  const dir = dirname(logFile);
  if (basename(dir) === ".flightlog") {
    return basename(dirname(dir)) || "run";
  }
  return basename(dir) || "run";
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main() {
  const [cmd, logFile, ...rest] = process.argv.slice(2);

  if (cmd === "log") {
    if (!logFile) usage();
    const task = flagValue(rest, "--task");
    const role = flagValue(rest, "--role");
    const message = flagValue(rest, "--message");
    if (!task || !role || !message) {
      console.error("flightlog log requires --task, --role and --message");
      process.exit(2);
    }
    const attemptRaw = flagValue(rest, "--attempt");
    const entry = buildNoteEntry({
      task,
      role,
      message,
      ts: new Date().toISOString(),
      attempt: attemptRaw ? parseInt(attemptRaw, 10) : undefined,
      agentLabel: flagValue(rest, "--agent"),
    });
    await appendEntry(logFile, entry);
    return;
  }

  if (cmd === "report") {
    if (!logFile) usage();
    const entries = await readLog(logFile);
    const slug = flagValue(rest, "--slug") ?? slugFromLogPath(logFile);
    const out = flagValue(rest, "--out") ?? join(dirname(logFile), "RUNLOG.md");
    await writeFile(out, renderRunlog(entries, { slug }));
    console.log(out);
    return;
  }

  usage();
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun flightlog.ts log <logfile> --task <ref> --role <role> [--attempt N] [--agent <label>] --message <text>",
      "  bun flightlog.ts report <logfile> [--slug <slug>] [--out <RUNLOG.md>]",
    ].join("\n"),
  );
  process.exit(2);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("flightlog error:", err.message);
    process.exit(2);
  });
}

#!/usr/bin/env bun
/**
 * flightlog — append agent narrative or node state to an autopilot run's
 * audit trail and render it to RUNLOG.md.
 *
 * The orchestrator script has no filesystem access, so narrative entries are
 * written by the tool-capable Dev / Review / Final-review agents calling this
 * CLI. Node declarations use `state`; score verdicts use `score-task.ts --log`. All
 * land in the same JSONL trail under `docs/<slug>/.flightlog/`.
 *
 * Usage:
 *   bun flightlog.ts log <logfile> --task <ref> --role <role> [--attempt N] \
 *       [--agent <label>] [--phase <start|end>] [--message "<text>"]
 *   bun flightlog.ts state <logfile> --task <ref> --state done|blocked|failed \
 *       [--agent <label>] [--message "<why>"]
 *   bun flightlog.ts report <logfile> [--slug <slug>] [--out <RUNLOG.md>]
 *
 * `report` parses the JSONL trail and writes a grouped, human-readable
 * RUNLOG.md (default: sibling of the log file).
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { flagValue } from "./lib/args";
import {
  FLIGHTLOG_DIRNAME,
  appendEntry,
  readLog,
  renderRunlog,
  type NoteEntry,
  type StateEntry,
} from "./lib/flightlog";
import { resumePoint, tasksIn } from "./lib/resume-point";

/** Build a flightlog note entry from narrative metadata (pure). */
export function buildNoteEntry(meta: {
  task: string;
  role: string;
  message: string;
  ts: string;
  attempt?: number;
  agentLabel?: string;
  phase?: "start" | "end";
}): NoteEntry {
  return {
    kind: "note",
    ts: meta.ts,
    task: meta.task,
    role: meta.role,
    attempt: meta.attempt,
    agentLabel: meta.agentLabel,
    ...(meta.phase === undefined ? {} : { phase: meta.phase }),
    message: meta.message,
  };
}

/** Build a node declaration from caller-stamped metadata (pure). */
export function buildStateEntry(meta: {
  task: string;
  state: "done" | "blocked" | "failed";
  ts: string;
  agentLabel?: string;
  message?: string;
}): StateEntry {
  return {
    kind: "state",
    ts: meta.ts,
    task: meta.task,
    state: meta.state,
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
  if (basename(dir) === FLIGHTLOG_DIRNAME) {
    return basename(dirname(dir)) || "run";
  }
  return basename(dir) || "run";
}

async function main() {
  const [cmd, logFile, ...rest] = process.argv.slice(2);

  if (cmd === "log") {
    if (!logFile) usage();
    const task = flagValue(rest, "--task");
    const role = flagValue(rest, "--role");
    // Free text — a note may legitimately open with `--`.
    const message = flagValue(rest, "--message", { allowDashValue: true });
    const phase = flagValue(rest, "--phase");
    if (phase !== undefined && phase !== "start" && phase !== "end") {
      fail("flightlog --phase must be start or end");
    }
    if (!task || !role || (!message && phase !== "start")) {
      fail("flightlog log requires --task, --role and --message");
    }
    const attemptRaw = flagValue(rest, "--attempt");
    const entry = buildNoteEntry({
      task,
      role,
      message: message ?? "",
      ts: new Date().toISOString(),
      attempt: attemptRaw ? parseInt(attemptRaw, 10) : undefined,
      agentLabel: flagValue(rest, "--agent"),
      phase,
    });
    await appendEntry(logFile, entry);
    return;
  }

  if (cmd === "state") {
    if (!logFile) usage();
    const task = flagValue(rest, "--task");
    const state = flagValue(rest, "--state");
    const message = flagValue(rest, "--message", { allowDashValue: true });
    if (!task) {
      fail("flightlog state requires --task");
    }
    if (!state) {
      fail("flightlog state requires --state");
    }
    if (state !== "done" && state !== "blocked" && state !== "failed") {
      fail("flightlog --state must be done, blocked or failed");
    }
    if (state !== "done" && !message) {
      fail("flightlog state requires --message for blocked or failed");
    }
    await appendEntry(
      logFile,
      buildStateEntry({
        task,
        state,
        ts: new Date().toISOString(),
        agentLabel: flagValue(rest, "--agent"),
        message,
      }),
    );
    return;
  }

  if (cmd === "progress") {
    if (!logFile) usage();
    const entries = await readLog(logFile);
    const task = flagValue(rest, "--task");
    const json = rest.includes("--json");

    if (!task) {
      const points = tasksIn(entries)
        .map((ref) => resumePoint(entries, ref))
        .filter((point): point is NonNullable<typeof point> => point !== null);
      if (json) {
        console.log(JSON.stringify(points, null, 2));
        return;
      }
      if (points.length === 0) {
        console.log("no attempts recorded in this trail");
        return;
      }
      const width = Math.max(...points.map((point) => point.task.length));
      for (const point of points) {
        console.log(
          `${point.task.padEnd(width)}  last attempt ${point.last.attempt} · resume --from ${point.from} --attempt ${point.attempt}${point.gateRejected ? " (gate rejected the work)" : ""}`,
        );
      }
      return;
    }

    const point = resumePoint(entries, task);
    if (!point) {
      // Not an error: a task that never ran has nothing to resume from, and the
      // caller needs to tell that apart from a trail it failed to read.
      console.log(`no attempts recorded for ${task}`);
      return;
    }
    if (json) {
      console.log(JSON.stringify(point, null, 2));
      return;
    }
    const steps = point.last.steps
      .map((step) => `${step.role}${step.completed ? " ✓" : " …"}`)
      .join(" · ");
    const verdict = point.last.verdict
      ? `${point.last.verdict.weighted.toFixed(2)} ${point.last.verdict.passed ? "PASS" : "FAIL"}`
      : "none recorded";
    console.log(`task       ${point.task}`);
    console.log(`attempts   ${point.attempts.join(", ")}`);
    console.log(
      `last       attempt ${point.last.attempt} — ${steps || "no pipeline steps recorded"}`,
    );
    console.log(`verdict    ${verdict}`);
    console.log(`resume     --from ${point.from} --attempt ${point.attempt}`);
    console.log(`reason     ${point.reason}`);
    if (point.gateRejected) {
      console.log(
        `note       a gate REJECTED this work, so the trail cannot support a later restart. ` +
          `Only a person who has since satisfied the failing items may override with --from verify --attest <file>.`,
      );
    }
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

/** Every CLI rejection leaves through here, so all of them exit 2. */
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function usage(): never {
  fail(
    [
      "Usage:",
      "  bun flightlog.ts log <logfile> --task <ref> --role <role> [--attempt N] [--agent <label>] [--phase <start|end>] [--message <text>]",
      "  bun flightlog.ts state <logfile> --task <ref> --state done|blocked|failed [--agent <label>] [--message <why>]",
      "  bun flightlog.ts progress <logfile> [--task <ref>] [--json]",
      "  bun flightlog.ts report <logfile> [--slug <slug>] [--out <RUNLOG.md>]",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("flightlog error:", err.message);
    process.exit(2);
  });
}

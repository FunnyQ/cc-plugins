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
 *
 * Goal mode (budget, status, guard and report all count from the latest
 * `flight` entry):
 *   bun flightlog.ts flight-start <logfile> --plan <PLAN.md> [--tasks <dir>]
 *   bun flightlog.ts escalations <logfile> --payload <uri-encoded JSON>
 *   bun flightlog.ts guard <logfile> --plan <PLAN.md> --tasks <dir> \
 *       --verdict fix|defer --justified <json file> --kept <ref,ref|"">
 *   bun flightlog.ts repair <logfile> --task <ref>|--flight --verdict <v> \
 *       --reason-file <f> [--verdict-file <json>] [--reentry <json>] \
 *       [--diff-file <f>]
 *   bun flightlog.ts repairs <logfile> --tasks <dir> --status|--json
 *   bun flightlog.ts report <logfile> --flight [--deferred <DEFERRED.md>]
 *
 * `report --flight` writes FLIGHTREPORT.md beside the log instead of RUNLOG.md.
 * `flight-start` adopts every task already `blocked` (tasks dir defaults to
 * the plan's sibling `tasks/`) as an escalation of the new flight, and prints
 * the adopted escalations as a JSON array.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, basename, relative, resolve, sep } from "node:path";
import { legOf, parseDeferred } from "../../waypoints/scripts/deferred";
import { loadAllTasks } from "./next-ready";
import { flagValue } from "./lib/args";
import {
  FLIGHTLOG_DIRNAME,
  appendEntry,
  readLog,
  renderRunlog,
  type EscalationClass,
  type EscalationEntry,
  type FlightlogEntry,
  type NoteEntry,
  type RepairEntry,
  type RepairVerdict,
  type RunEndEntry,
  type StateEntry,
  type StateFields,
} from "./lib/flightlog";
import {
  admitRepair,
  currentFlight,
  flightStatus,
  goalHash,
  type FlightStatus,
  guardRepair,
  renderFlightReport,
  repairCounts,
} from "./lib/goal-mode";
import { parseTask, refToString } from "./lib/parse-task";
import { resumePoint, tasksIn } from "./lib/resume-point";

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

export function buildStateEntry(meta: StateFields): StateEntry {
  return { kind: "state", ...meta };
}

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
    const ts = new Date().toISOString();
    const agentLabel = flagValue(rest, "--agent");
    const fields: StateFields =
      state === "done"
        ? { ts, task, state, agentLabel, message }
        : message
          ? { ts, task, state, agentLabel, message }
          : fail("flightlog state requires --message for blocked or failed");
    await appendEntry(logFile, buildStateEntry(fields));
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

  if (cmd === "flight-start") {
    if (!logFile) usage();
    const plan = flagValue(rest, "--plan");
    if (!plan) fail("flightlog flight-start requires --plan");
    const tasksDir = flagValue(rest, "--tasks") ?? join(dirname(plan), "tasks");
    const planAbs = await realpath(dirname(plan));
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: planAbs,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (top.exitCode === 0) {
      const repoRoot = top.stdout.toString().trim();
      const flightlogDir = join(planAbs, ".flightlog") + sep;
      const dirty = changedPaths(repoRoot).filter(
        (path) => !path.startsWith(flightlogDir),
      );
      if (dirty.length > 0) {
        fail(
          `flight-start needs a clean working tree; uncommitted changes outside ${relative(repoRoot, flightlogDir) || ".flightlog"}:\n` +
            dirty.map((path) => `  ${relative(repoRoot, path)}`).join("\n") +
            "\nCommit or stash them first, then start the flight again.",
        );
      }
    }
    const earlier = await readLog(logFile);
    const { byRef } = await loadAllTasks(tasksDir);
    const ts = new Date().toISOString();
    await appendEntry(logFile, {
      kind: "flight",
      ts,
      task: "(flight)",
      goalHash: goalHash(await readFile(plan, "utf-8")),
      planPath: plan,
    });
    const adopted: EscalationEntry[] = Object.keys(byRef)
      .filter((ref) => byRef[ref].status === "blocked")
      .sort()
      .map((ref) => {
        const last = earlier.findLast(
          (e): e is EscalationEntry => e.kind === "escalation" && e.task === ref,
        );
        return {
          kind: "escalation",
          ts,
          task: ref,
          attempt: last?.attempt ?? 0,
          class:
            last?.class === "capped" || last?.class === "plan-defect"
              ? last.class
              : "plan-defect",
          infrastructure: false,
          parked: true,
          reason:
            last?.reason ??
            "parked before this goal-mode flight; no reason in the trail",
        };
      });
    for (const entry of adopted) await appendEntry(logFile, entry);
    console.log(JSON.stringify(adopted.map(({ kind, ts, ...e }) => e)));
    return;
  }

  if (cmd === "escalations") {
    if (!logFile) usage();
    const raw = flagValue(rest, "--payload");
    if (!raw) fail("flightlog escalations requires --payload");
    const payload = decodePayload(raw);
    const ts = new Date().toISOString();
    for (const e of payload.escalations) {
      await appendEntry(logFile, {
        kind: "escalation",
        ts,
        task: e.task,
        attempt: e.attempt,
        class: e.class,
        infrastructure: e.infrastructure,
        parked: e.parked,
        reason: e.reason,
      });
    }
    for (const c of payload.cleanupFailures) {
      await appendEntry(logFile, {
        kind: "escalation",
        ts,
        task: c.ref,
        attempt: 0,
        class: "cleanup-failure",
        infrastructure: true,
        parked: false,
        reason: `worktree removal could not be confirmed: ${c.path}`,
      });
    }
    await appendEntry(logFile, {
      kind: "run-end",
      ts,
      task: "(flight)",
      aborted: Boolean(payload.aborted),
      completed: payload.completed,
      drained: payload.drained,
      needsHuman: payload.needsHuman,
    });
    return;
  }

  if (cmd === "guard") {
    if (!logFile) usage();
    const plan = flagValue(rest, "--plan");
    const tasksDir = flagValue(rest, "--tasks");
    const verdict = flagValue(rest, "--verdict");
    const justifiedFile = flagValue(rest, "--justified");
    const keptAt = rest.indexOf("--kept");
    const keptRaw = keptAt === -1 ? undefined : rest[keptAt + 1];
    if (
      !plan ||
      !tasksDir ||
      !justifiedFile ||
      keptRaw === undefined ||
      keptRaw.startsWith("--")
    ) {
      fail(
        "flightlog guard requires --plan, --tasks, --verdict, --justified and --kept",
      );
    }
    if (verdict !== "fix" && verdict !== "defer") {
      fail("flightlog guard --verdict must be fix or defer");
    }
    const entries = await readLog(logFile);
    const flight = requireFlight(entries);
    const justifiedJson = JSON.parse(await readFile(justifiedFile, "utf-8"));
    const planDir = await realpath(dirname(plan));
    const tasksAbs = await realpath(tasksDir);
    const repoRoot = git(planDir, "rev-parse", "--show-toplevel").trim();

    const before: Record<string, string> = {};
    const beforePath: Record<string, string> = {};
    const doneRefs = doneInFlight(flight.entries);
    const tracked = git(
      repoRoot,
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      "HEAD",
      "--",
      relative(repoRoot, tasksAbs),
    )
      .split("\0")
      .filter((path) => isTaskPath(join(repoRoot, path), tasksAbs));
    for (const path of tracked) {
      const content = git(repoRoot, "show", `HEAD:${path}`);
      const parsed = parseTask(content);
      if (!parsed.ok) continue;
      const ref = refToString(parsed.task);
      before[ref] = content;
      beforePath[ref] = join(repoRoot, path);
      if (parsed.task.status === "done") doneRefs.add(ref);
    }

    const loaded = await loadAllTasks(tasksAbs);
    const unreadable = new Set(loaded.errors.map((e) => e.file));
    const after: Record<string, string> = {};
    for (const [ref, path] of Object.entries(loaded.pathByRef)) {
      after[ref] = await readFile(path, "utf-8");
    }

    const refs = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const workedRefs = refs.filter((ref) =>
      resumePoint(entries, ref)?.last.steps.some(
        (s) => s.role === "dev" && s.completed,
      ),
    );
    const devReportedDefect = refs.filter(
      (ref) =>
        flight.entries.findLast(
          (e): e is EscalationEntry =>
            e.kind === "escalation" && e.task === ref,
        )?.class === "plan-defect",
    );

    const result = guardRepair({
      verdict,
      isLeg: legOf(resolve(plan)) !== null,
      flightGoalHash: flight.flight.goalHash,
      planMd: await readFile(plan, "utf-8"),
      before,
      after,
      doneRefs: [...doneRefs],
      justified: Array.isArray(justifiedJson)
        ? justifiedJson
        : (justifiedJson.justified ?? []),
      kept: keptRaw.split(",").filter(Boolean),
      devReportedDefect,
      workedRefs,
      deferred: Array.isArray(justifiedJson) ? [] : (justifiedJson.defer ?? []),
    });

    const deferredPath = join(planDir, "DEFERRED.md");
    const flightlogDir = join(planDir, FLIGHTLOG_DIRNAME);
    const unexpected = changedPaths(repoRoot)
      .filter(
        (path) =>
          !isTaskPath(path, tasksAbs) &&
          !(verdict === "defer" && path === deferredPath) &&
          !path.startsWith(flightlogDir + sep),
      )
      .map((path) => `unexpected file ${relative(repoRoot, path)}`);
    const misreadAsDeleted = new Set(
      Object.keys(beforePath)
        .filter((ref) => unreadable.has(beforePath[ref]))
        .map((ref) => `deleted task ${ref}`),
    );
    const violations = [
      ...(result.ok ? [] : result.violations).filter(
        (v) => !misreadAsDeleted.has(v),
      ),
      ...loaded.errors.map(
        (e) => `unparseable task ${relative(repoRoot, e.file)}: ${e.reason}`,
      ),
      ...unexpected,
    ];
    const outcome = violations.length > 0 ? { ok: false, violations } : result;
    console.log(JSON.stringify(outcome));
    if (!outcome.ok) process.exit(1);
    return;
  }

  if (cmd === "repair") {
    if (!logFile) usage();
    const task = flagValue(rest, "--task");
    const wholeFlight = rest.includes("--flight");
    const verdict = flagValue(rest, "--verdict");
    const reasonFile = flagValue(rest, "--reason-file");
    if (task !== undefined && wholeFlight) {
      fail("flightlog repair takes --task or --flight, not both");
    }
    if (task === undefined && !wholeFlight) {
      fail("flightlog repair requires --task <ref> or --flight");
    }
    if (!verdict || !isRepairVerdict(verdict)) {
      fail(
        `flightlog repair --verdict must be one of ${REPAIR_VERDICTS.join(", ")}`,
      );
    }
    if (!reasonFile) fail("flightlog repair requires --reason-file");
    const ref = task ?? "(flight)";
    const flight = requireFlight(await readLog(logFile));
    const admitted = admitRepair(flight.entries, ref, verdict);
    if (!admitted.ok) {
      console.error(admitted.error);
      process.exit(1);
    }
    const verdictFile = flagValue(rest, "--verdict-file");
    const reviewed: { pattern?: unknown; changed?: unknown } =
      verdictFile === undefined
        ? {}
        : JSON.parse(await readFile(verdictFile, "utf-8"));
    const pattern =
      typeof reviewed.pattern === "string" && reviewed.pattern !== ""
        ? reviewed.pattern
        : undefined;
    const changed = Array.isArray(reviewed.changed)
      ? reviewed.changed.filter((ref): ref is string => typeof ref === "string")
      : undefined;
    const reentry = flagValue(rest, "--reentry");
    const diffFile = flagValue(rest, "--diff-file");
    const entry: RepairEntry = {
      kind: "repair",
      ts: new Date().toISOString(),
      task: ref,
      verdict,
      reason: await readFile(reasonFile, "utf-8"),
      ...(pattern === undefined ? {} : { pattern }),
      ...(changed === undefined ? {} : { changed }),
      ...(reentry === undefined ? {} : { reentry: JSON.parse(reentry) }),
      ...(diffFile === undefined
        ? {}
        : { diff: await readFile(diffFile, "utf-8") }),
    };
    await appendEntry(logFile, entry);
    return;
  }

  if (cmd === "repairs") {
    if (!logFile) usage();
    const tasksDir = flagValue(rest, "--tasks");
    const status = rest.includes("--status");
    const json = rest.includes("--json");
    if (!tasksDir || status === json) {
      fail("flightlog repairs requires --tasks and one of --status or --json");
    }
    const flight = requireFlight(await readLog(logFile));
    const result = await treeStatus(flight.entries, tasksDir);
    console.log(
      status
        ? result
        : JSON.stringify({ ...repairCounts(flight.entries), status: result }),
    );
    return;
  }

  if (cmd === "report" && rest.includes("--flight")) {
    if (!logFile) usage();
    const flight = requireFlight(await readLog(logFile));
    const tasksDir =
      flagValue(rest, "--tasks") ?? join(dirname(dirname(logFile)), "tasks");
    const deferredFile = flagValue(rest, "--deferred");
    const deferredMd =
      deferredFile === undefined
        ? null
        : await readFile(deferredFile, "utf-8").catch(() => null);
    const loaded = await loadAllTasks(tasksDir);
    const tasks = loaded.byRef;
    const unreadable = loaded.errors.map((e) => `- ${e.file}: ${e.reason}`);
    const out = join(dirname(logFile), "FLIGHTREPORT.md");
    const report = renderFlightReport(flight.entries, {
      slug: flagValue(rest, "--slug") ?? slugFromLogPath(logFile),
      status: await treeStatus(flight.entries, tasksDir),
      deferredMd:
        deferredMd !== null && parseDeferred(deferredMd).length > 0
          ? deferredMd
          : null,
      tasks,
    });
    await writeFile(
      out,
      unreadable.length > 0
        ? `${report}\n## Unreadable tasks\n\n${unreadable.join("\n")}\n`
        : report,
    );
    console.log(out);
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

const REPAIR_VERDICTS = [
  "fix",
  "defer",
  "not-plan",
  "refuse",
  "infra-retry",
  "halt",
] as const satisfies readonly RepairVerdict[];

const ESCALATION_CLASSES: readonly EscalationClass[] = [
  "plan-defect",
  "capped",
  "infrastructure",
  "divergence",
  "stall",
  "leak",
  "budget-floor",
  "cleanup-failure",
];

const isRepairVerdict = (v: string): v is RepairVerdict =>
  (REPAIR_VERDICTS as readonly string[]).includes(v);

type EscalationPayload = {
  escalations: Omit<EscalationEntry, "kind" | "ts">[];
  cleanupFailures: { ref: string; path: string }[];
  drained: string[];
  aborted: unknown;
  completed: string[];
  needsHuman: RunEndEntry["needsHuman"];
};

function decodePayload(raw: string): EscalationPayload {
  let payload: EscalationPayload;
  try {
    payload = JSON.parse(decodeURIComponent(raw));
  } catch (err) {
    fail(`flightlog escalations --payload is not URI-encoded JSON: ${err}`);
  }
  const arrays = [
    "escalations",
    "cleanupFailures",
    "drained",
    "completed",
    "needsHuman",
  ] as const;
  const missing = arrays.filter((key) => !Array.isArray(payload?.[key]));
  if (missing.length > 0) {
    fail(`flightlog escalations payload lacks arrays: ${missing.join(", ")}`);
  }
  for (const e of payload.escalations) {
    if (!ESCALATION_CLASSES.includes(e.class)) {
      fail(
        `flightlog escalations: ${e.task} has class ${JSON.stringify(e.class)}, expected one of ${ESCALATION_CLASSES.join(", ")}`,
      );
    }
  }
  return payload;
}

// A tree with an unparseable or invalid task cannot be trusted to read
// `complete`, and no repair round can run over it, so it ends the flight.
async function treeStatus(
  flightEntries: FlightlogEntry[],
  tasksDir: string,
): Promise<FlightStatus> {
  const loaded = await loadAllTasks(tasksDir);
  const problems = [
    ...loaded.errors.map((e) => `${e.file}: ${e.reason}`),
    ...loaded.invalid.map((i) => `${i.ref} (${i.file}): ${i.reason}`),
  ];
  if (problems.length === 0) return flightStatus(flightEntries, loaded.byRef);
  console.error(problems.join("\n"));
  return "exhausted";
}

function doneInFlight(flightEntries: FlightlogEntry[]): Set<string> {
  const latest = new Map<string, string>();
  for (const e of flightEntries) {
    if (e.kind === "state") latest.set(e.task, e.state);
  }
  const done = new Set(
    [...latest].filter(([, state]) => state === "done").map(([ref]) => ref),
  );
  const lastEnd = flightEntries.findLast(
    (e): e is RunEndEntry => e.kind === "run-end",
  );
  for (const ref of lastEnd?.completed ?? []) done.add(ref);
  return done;
}

function requireFlight(
  entries: FlightlogEntry[],
): NonNullable<ReturnType<typeof currentFlight>> {
  return currentFlight(entries) ?? fail("no goal-mode flight started");
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args[0]}: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

function isTaskPath(path: string, tasksDir: string): boolean {
  const parts = relative(tasksDir, path).split(sep);
  return (
    parts.length === 2 &&
    parts[0] !== ".." &&
    parts[0] !== "_context" &&
    parts[1].endsWith(".md") &&
    parts[1] !== "README.md"
  );
}

function changedPaths(repoRoot: string): string[] {
  const records = git(
    repoRoot,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ).split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    paths.push(join(repoRoot, record.slice(3)));
    if (record[0] === "R" || record[0] === "C") {
      paths.push(join(repoRoot, records[++i]));
    }
  }
  return paths;
}

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
      "  bun flightlog.ts report <logfile> --flight [--deferred <DEFERRED.md>] [--tasks <dir>] [--slug <slug>]",
      "  bun flightlog.ts flight-start <logfile> --plan <PLAN.md> [--tasks <dir>]",
      "  bun flightlog.ts escalations <logfile> --payload <uri-encoded JSON>",
      '  bun flightlog.ts guard <logfile> --plan <PLAN.md> --tasks <dir> --verdict fix|defer --justified <json file> --kept <ref,ref|"">',
      "  bun flightlog.ts repair <logfile> --task <ref>|--flight --verdict <verdict> --reason-file <f> [--verdict-file <json>] [--reentry <json>] [--diff-file <f>]",
      "  bun flightlog.ts repairs <logfile> --tasks <dir> --status|--json",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("flightlog error:", err.message);
    process.exit(2);
  });
}

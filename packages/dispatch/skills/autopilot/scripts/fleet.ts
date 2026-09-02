import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import {
  refToString,
  taskValidity,
} from "../../flightplan/scripts/lib/parse-task";
import { unmetDependencies } from "../../flightplan/scripts/next-ready";
import type {
  FlightlogEntry,
  ScoreEntry,
} from "../../flightplan/scripts/lib/flightlog";
import type { TokenCounts } from "./usage-types";

/** Every role the orchestrator logs. The type is derived so the two never drift. */
const KNOWN_ROLES = [
  "scout",
  "dev",
  "verify",
  "requalify",
  "judge",
  "review",
  "fix",
  "done",
  "block",
  "commit",
] as const;

export type AgentRole = (typeof KNOWN_ROLES)[number] | "unknown";

export type ParsedLabel = {
  role: AgentRole;
  ref?: string;
  attempt?: number;
  lens?: string;
  wave?: number;
  raw: string;
};

export type TaskState =
  | "done"
  | "in-progress"
  | "ready"
  | "blocked"
  | "invalid";

export type TaskView = {
  ref: string;
  bucket: string;
  nn: string;
  title: string;
  status: string | null;
  state: TaskState;
  /** Why the task is `invalid`, straight from `taskValidity`. Null otherwise. */
  invalidReason: string | null;
  blockedBy: string[];
  dependsOn: string[];
  blocks: string[];
  finalReview: boolean;
  attempts: number;
  latestScore: {
    weighted: number;
    threshold: number;
    passOp: ">" | ">=";
    passed: boolean;
    hardFailed: boolean;
    breakdown: { name: string; weight: number; score: number }[];
    /** The judge's prose. Absent on a verdict logged before `--rationale-file`. */
    rationale?: string;
  } | null;
};

/**
 * `abandoned` is a row that logged `start` and never logged `end`, while the run
 * moved on past it. Agents write their own lifecycle notes over Bash, so an agent
 * that dies mid-flight simply never writes the `end` — and the Workflow script
 * driving them has no filesystem access to write it on their behalf. Without this
 * the row reads in-flight forever and sorts to the top of the fleet panel.
 */
export type FleetStatus = "in-flight" | "abandoned" | "finished";

/** Whether a gate role let the attempt through. Absent for every other role. */
export type GateOutcome = "passed" | "failed";

export type FleetRow = {
  /**
   * `fleetIdentity` over the raw logged `task`/`role`/`attempt`. Exported because the
   * transcript reader parses those same three flags off an agent's announce prompt and
   * pairs on this string — `ref`/`attempt` below are label-parse-preferred display
   * fields and diverge from it whenever an agent's free-text label parses.
   */
  identity: string;
  key: string;
  label: string;
  role: AgentRole;
  ref?: string;
  attempt?: number;
  lens?: string;
  status: FleetStatus;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  message?: string;
  score?: ScoreEntry;
  outcome?: GateOutcome;
  /** Tokens burned. Absent (never 0) when no transcript paired — render as unavailable. */
  usage?: TokenCounts;
  /**
   * Tokens the external codex CLI burned for this row, kept apart from `usage` so the
   * cheap driver and the expensive delegate stay separately readable. Absent when the
   * row drove no external engine.
   */
  codexUsage?: TokenCounts;
};

/** `dev:<ref>#<attempt>`, plus the external-engine form `dev-codex:<ref>#<attempt>`. */
const DEV = /^dev(?:-[a-z]+)?:(.+)#(\d+)$/;
const REF_ATTEMPT = /^(verify|requalify|judge|fix):(.+)#(\d+)$/;
const REVIEW = /^review:([^#]+)#(\d+)$/;
const TERMINAL = /^(done|block):(.+)$/;
const SCOUT = /^scout-wave-(\d+)$/;

export function parseAgentLabel(label: string): ParsedLabel {
  let match = DEV.exec(label);
  if (match) {
    return {
      role: "dev",
      ref: match[1],
      attempt: Number(match[2]),
      raw: label,
    };
  }
  match = REF_ATTEMPT.exec(label);
  if (match) {
    return {
      role: match[1] as "verify" | "requalify" | "judge" | "fix",
      ref: match[2],
      attempt: Number(match[3]),
      raw: label,
    };
  }
  match = REVIEW.exec(label);
  if (match) {
    return {
      role: "review",
      lens: match[1],
      attempt: Number(match[2]),
      raw: label,
    };
  }
  match = TERMINAL.exec(label);
  if (match) {
    return { role: match[1] as "done" | "block", ref: match[2], raw: label };
  }
  match = SCOUT.exec(label);
  if (match) {
    return { role: "scout", wave: Number(match[1]), raw: label };
  }
  if (label === "commit-post-loop") {
    return { role: "commit", raw: label };
  }
  return { role: "unknown", raw: label };
}

/** The one place the fleet identity string is built. */
export function fleetIdentity(
  task: string,
  role: string,
  attempt: number | undefined,
): string {
  return `${task}|${role}|${attempt ?? "-"}`;
}

type TaskAggregate = {
  /** Open start count per identity — never a set. See `aggregateByTask`. */
  openStarts: Map<string, number>;
  attempts: number;
  latestScore: ScoreEntry | null;
};

/**
 * One pass over the whole trail, grouped by task.
 *
 * Parallel agents share a `(task, role, attempt)` identity — the five closing review
 * lenses all log as `review` on the same attempt — so open starts are counted, not
 * set-tracked. One end cancels exactly one start; otherwise the first lens to finish
 * would take the task out of `in-progress` while four agents were still flying.
 */
function aggregateByTask(
  entries: FlightlogEntry[],
): Map<string, TaskAggregate> {
  const byTask = new Map<string, TaskAggregate>();

  for (const entry of entries) {
    let aggregate = byTask.get(entry.task);
    if (aggregate === undefined) {
      aggregate = { openStarts: new Map(), attempts: 0, latestScore: null };
      byTask.set(entry.task, aggregate);
    }

    aggregate.attempts = Math.max(aggregate.attempts, entry.attempt ?? 0);

    if (entry.kind === "score") {
      if (
        !aggregate.latestScore ||
        entry.attempt > aggregate.latestScore.attempt
      ) {
        aggregate.latestScore = entry;
      }
      continue;
    }

    const identity = fleetIdentity(entry.task, entry.role, entry.attempt);
    const open = aggregate.openStarts.get(identity) ?? 0;
    if (entry.phase === "start") aggregate.openStarts.set(identity, open + 1);
    else if (open > 0) aggregate.openStarts.set(identity, open - 1);
  }

  return byTask;
}

function hasOpenStart(aggregate: TaskAggregate | undefined): boolean {
  if (aggregate === undefined) return false;
  for (const count of aggregate.openStarts.values()) {
    if (count > 0) return true;
  }
  return false;
}

export function deriveTaskViews(
  byRef: Record<string, ParsedTask>,
  entries: FlightlogEntry[],
): TaskView[] {
  const byTask = aggregateByTask(entries);

  return Object.entries(byRef).map(([ref, task]) => {
    const aggregate = byTask.get(ref);
    const dependsOn = task.dependsOn.map(refToString);
    const blocks = task.blocks.map(refToString);
    // The readiness rule lives in next-ready.ts alone, so the dashboard and the
    // scout can never disagree about which task is blocked.
    const blockedBy = unmetDependencies(task, byRef);
    const validity = taskValidity(task);
    let state: TaskState;
    // Validity outranks the raw Status: a task claiming `done` over an unticked
    // gate box must read as invalid, never as done, or the dashboard would show
    // the tree as complete while the gate result is missing.
    if (validity.kind === "invalid") state = "invalid";
    else if (task.status === "done") state = "done";
    else if (task.status === "blocked") state = "blocked";
    else if (task.status === "in-progress") state = "in-progress";
    else if (task.status === "todo" && hasOpenStart(aggregate)) {
      state = "in-progress";
    } else if (task.status === "todo" && blockedBy.length === 0)
      state = "ready";
    else state = "blocked";

    const attempts = aggregate?.attempts ?? 0;
    const latestScore = aggregate?.latestScore ?? null;

    return {
      ref,
      bucket: task.bucket,
      nn: task.nn,
      title: task.title,
      status: task.status,
      state,
      invalidReason: validity.kind === "invalid" ? validity.reason : null,
      blockedBy: state === "blocked" ? blockedBy : [],
      dependsOn,
      blocks,
      finalReview: task.finalReview,
      attempts,
      latestScore: latestScore
        ? {
            weighted: latestScore.weighted,
            threshold: latestScore.threshold,
            passOp: latestScore.passOp,
            passed: latestScore.passed,
            hardFailed: latestScore.hardFailed,
            breakdown: latestScore.breakdown,
            ...(latestScore.rationale
              ? { rationale: latestScore.rationale }
              : {}),
          }
        : null,
    };
  });
}

type IndexedRow = FleetRow & {
  order: number;
  agentLabel?: string;
};

function roleFromEntry(entry: FlightlogEntry, parsed: ParsedLabel): AgentRole {
  if (parsed.role !== "unknown") return parsed.role;
  if (entry.kind === "score") return "judge";
  return (KNOWN_ROLES as readonly string[]).includes(entry.role)
    ? (entry.role as AgentRole)
    : "unknown";
}

/**
 * The two gate roles carry a pass/fail the dashboard should colour differently.
 *
 * A judge always has a verdict object, so read that. A verifier has only prose,
 * and the orchestrator requires it to lead with PASS or FAIL — so read that word
 * and stop. Only an off-contract message (older logs, an agent that ignored the
 * convention) falls through to scanning the prose, failure first. A message that
 * says neither stays unjudged rather than being guessed into a colour.
 */
function gateOutcome(row: FleetRow): GateOutcome | undefined {
  if (row.role === "judge") {
    if (!row.score) return undefined;
    return row.score.passed ? "passed" : "failed";
  }
  if (row.role !== "verify" && row.role !== "requalify") return undefined;

  const message = row.message?.trim();
  if (!message) return undefined;

  // The leading verdict is authoritative and settles the row on its own. It has
  // to win outright: a verifier quoting its test summary writes "PASS — bun test
  // (7 pass, 0 fail)", and scanning the whole message finds `fail` there and
  // paints a green run red. That is the normal shape of a passing message, not
  // an edge case.
  const verdict = /^(PASS|FAIL)\b/i.exec(message);
  if (verdict) return verdict[1].toUpperCase() === "FAIL" ? "failed" : "passed";

  // Off-contract message. Scan it, failure first — "3 passed, 1 failed" is a
  // failure, and reading a real failure as uncoloured is the worse mistake.
  if (/\bfail(ed|ure|s|ing)?\b/i.test(message)) return "failed";
  if (/\bpass(ed|es|ing)?\b/i.test(message)) return "passed";
  return undefined;
}

/**
 * How far through one attempt a role sits. The per-task loop is strictly
 * dev → review → fix → verify → judge, so a role starting proves every lower
 * role of that attempt is over. Review shares one rank on purpose: the
 * final-review fan-out runs its lenses concurrently at the same identity, and
 * they must never close each other.
 */
const ROLE_PROGRESS: Partial<Record<AgentRole, number>> = {
  dev: 0,
  review: 1,
  fix: 2,
  verify: 3,
  requalify: 4, // The second gate check runs after verify and before judge.
  judge: 5,
};

/** Ordinal of (attempt, role) within one ref. Monotonic as the run advances. */
function progressOf(row: IndexedRow): number | undefined {
  const rank = ROLE_PROGRESS[row.role];
  if (rank === undefined) return undefined;
  return (row.attempt ?? 0) * 10 + rank;
}

/**
 * Roles the orchestrator awaits one at a time and never places inside
 * `parallel()`: the wave scout, and the per-wave and post-loop commit agents.
 * They share one ref and carry no attempt, so `progressOf` cannot rank them —
 * but because they never overlap, a later `start` of the same role is itself
 * proof that every earlier open row of that role is over.
 */
const SEQUENTIAL_ROLES: ReadonlySet<AgentRole> = new Set(["commit", "scout"]);

/**
 * Close rows the run has moved past. A row still open at the end of the log is
 * only genuinely running if nothing for its ref got further — the newest agent
 * of a live run must keep ticking.
 *
 * Two passes, because the roles order themselves two different ways: everything
 * in `ROLE_PROGRESS` reaps on (attempt, role) within one ref, and everything in
 * `SEQUENTIAL_ROLES` reaps on start order within one role. A role in neither is
 * left alone.
 */
function reapAbandoned(rows: IndexedRow[], open: IndexedRow[]): void {
  if (open.length === 0) return;

  // Scanned over every row, not just the open ones: the row proving the run
  // moved on has usually closed itself already.
  const furthest = new Map<string, number>();
  for (const row of rows) {
    if (row.ref === undefined) continue;
    const progress = progressOf(row);
    if (progress === undefined) continue;
    furthest.set(
      row.ref,
      Math.max(furthest.get(row.ref) ?? progress, progress),
    );
  }

  for (const row of open) {
    if (row.ref === undefined) continue;
    const progress = progressOf(row);
    if (progress === undefined) continue;
    if (progress < (furthest.get(row.ref) ?? progress))
      row.status = "abandoned";
  }

  // Scanned over every row for the same reason as above: the commit agent that
  // proves an earlier one is over has almost always closed itself already.
  const newestStart = new Map<AgentRole, number>();
  for (const row of rows) {
    if (!SEQUENTIAL_ROLES.has(row.role)) continue;
    newestStart.set(
      row.role,
      Math.max(newestStart.get(row.role) ?? row.order, row.order),
    );
  }

  for (const row of open) {
    if (!SEQUENTIAL_ROLES.has(row.role)) continue;
    if (row.order < (newestStart.get(row.role) ?? row.order))
      row.status = "abandoned";
  }
}

export function aggregateFleet(entries: FlightlogEntry[]): FleetRow[] {
  const rows: IndexedRow[] = [];
  // Only an in-flight row can be closed, so pairing scans the open rows, not every row.
  const open: IndexedRow[] = [];
  // Judge rows still waiting for a verdict, oldest first, keyed by ref and attempt.
  const unscoredJudges = new Map<string, IndexedRow[]>();
  const scoreByAttempt = new Map<string, ScoreEntry>();

  const trackJudge = (row: IndexedRow): void => {
    if (
      row.role !== "judge" ||
      row.ref === undefined ||
      row.score !== undefined
    )
      return;
    const judgeKey = `${row.ref}|${row.attempt ?? "-"}`;
    const waiting = unscoredJudges.get(judgeKey);
    if (waiting) waiting.push(row);
    else unscoredJudges.set(judgeKey, [row]);
  };

  entries.forEach((entry, order) => {
    const parsed = parseAgentLabel(entry.agentLabel ?? "");
    const identity =
      entry.kind === "note"
        ? fleetIdentity(entry.task, entry.role, entry.attempt)
        : fleetIdentity(entry.task, "judge", entry.attempt);
    const key = entry.agentLabel ?? identity;
    const base = {
      key,
      identity,
      agentLabel: entry.agentLabel,
      order,
      label: key,
      role: roleFromEntry(entry, parsed),
      ref: parsed.ref ?? entry.task,
      attempt: parsed.attempt ?? entry.attempt,
      lens: parsed.lens,
    };

    // A verdict is not the end of the judge's work — its own end note closes the row.
    // Closing here would leave that end note to open a second, duplicate row.
    if (entry.kind === "score") {
      const scoreKey = `${entry.task}|${entry.attempt}`;
      if (!scoreByAttempt.has(scoreKey)) scoreByAttempt.set(scoreKey, entry);

      const judgeKey = `${base.ref}|${base.attempt ?? "-"}`;
      const judged = unscoredJudges.get(judgeKey)?.shift();
      if (judged) {
        judged.score = entry;
        return;
      }

      rows.push({
        ...base,
        status: "finished",
        endedAt: entry.ts,
        score: entry,
      });
      return;
    }

    if (entry.phase === "start") {
      const row: IndexedRow = {
        ...base,
        status: "in-flight",
        startedAt: entry.ts,
      };
      rows.push(row);
      open.push(row);
      trackJudge(row);
      return;
    }

    // A label alone is not an identity — parallel external delegates share one
    // label — so an end event must match the task, role, and attempt it closes.
    let index =
      entry.agentLabel === undefined
        ? -1
        : open.findIndex(
            (row) =>
              row.identity === identity && row.agentLabel === entry.agentLabel,
          );
    if (index === -1) {
      index = open.findIndex((row) => row.identity === identity);
    }
    if (index !== -1) {
      const [started] = open.splice(index, 1);
      started!.status = "finished";
      started!.endedAt = entry.ts;
      started!.elapsedMs =
        new Date(entry.ts).getTime() - new Date(started!.startedAt!).getTime();
      started!.message = entry.message;
      return;
    }

    const orphan: IndexedRow = {
      ...base,
      status: "finished",
      endedAt: entry.ts,
      message: entry.message,
    };
    rows.push(orphan);
    trackJudge(orphan);
  });

  for (const row of rows) {
    if (row.score || row.ref === undefined || row.attempt === undefined)
      continue;
    row.score = scoreByAttempt.get(`${row.ref}|${row.attempt}`);
  }

  reapAbandoned(rows, open);

  for (const row of rows) {
    const outcome = gateOutcome(row);
    if (outcome) row.outcome = outcome;
  }

  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const count = (keyCounts.get(row.key) ?? 0) + 1;
    keyCounts.set(row.key, count);
    if (count > 1) row.key = `${row.key}#${count}`;
  }

  // Ranked, not a two-way test: with three statuses `x === "in-flight" ? -1 : 1`
  // answers 1 in both directions for the other two, which is not a valid
  // comparator. Live work first, then rows that died without reporting.
  const statusRank: Record<FleetStatus, number> = {
    "in-flight": 0,
    abandoned: 1,
    finished: 2,
  };

  rows.sort((a, b) => {
    if (a.status !== b.status)
      return statusRank[a.status] - statusRank[b.status];
    if (a.status === "finished") {
      const time = (b.endedAt ?? "").localeCompare(a.endedAt ?? "");
      if (time !== 0) return time;
    }
    return a.order - b.order;
  });

  return rows.map(({ order: _order, agentLabel: _agentLabel, ...row }) => row);
}

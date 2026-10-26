import {
  type GraphNode,
  unmetNodeDependencies,
} from "../../flightplan/scripts/lib/graph-node";
import type {
  FlightlogEntry,
  ScoreEntry,
} from "../../flightplan/scripts/lib/flightlog";
import type { TokenCounts } from "./usage-types";

const KNOWN_ROLES = [
  "scout",
  "dev",
  "verify",
  "requalify",
  "reverify",
  "judge",
  "land",
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
  "done" | "in-progress" | "ready" | "blocked" | "invalid";

export type TaskView = {
  ref: string;
  bucket: string;
  nn: string;
  title: string;
  status: string | null;
  state: TaskState;
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

export type GateOutcome = "passed" | "failed";

export type FleetRow = {
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
  usage?: TokenCounts;
  codexUsage?: TokenCounts;
  models?: string[];
  codexModels?: string[];
};

const DEV = /^dev(?:-[a-z]+)?:(.+)#(\d+)$/;
const REF_ATTEMPT = /^(verify|requalify|reverify|judge|land|fix):(.+)#(\d+)$/;
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
      role: match[1] as
        "verify" | "requalify" | "reverify" | "judge" | "land" | "fix",
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

export function fleetIdentity(
  task: string,
  role: string,
  attempt: number | undefined,
): string {
  return `${task}|${role}|${attempt ?? "-"}`;
}

type TaskAggregate = {
  openStarts: Map<string, number>;
  attempts: number;
  latestScore: ScoreEntry | null;
};

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

    if (entry.kind === "state") continue;

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
  byRef: Record<string, GraphNode>,
  entries: FlightlogEntry[],
): TaskView[] {
  const byTask = aggregateByTask(entries);

  return Object.entries(byRef).map(([ref, task]) => {
    const aggregate = byTask.get(ref);
    const dependsOn = task.dependsOn;
    const blocks = task.blocks;
    const blockedBy = unmetNodeDependencies(task, byRef);
    const validity = task.validity;
    let state: TaskState;
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
  if (entry.kind === "state") return "unknown";
  if (parsed.role !== "unknown") return parsed.role;
  if (entry.kind === "score") return "judge";
  return (KNOWN_ROLES as readonly string[]).includes(entry.role)
    ? (entry.role as AgentRole)
    : "unknown";
}

function gateOutcome(row: FleetRow): GateOutcome | undefined {
  if (row.role === "judge") {
    if (!row.score) return undefined;
    return row.score.passed ? "passed" : "failed";
  }
  if (
    row.role !== "verify" &&
    row.role !== "requalify" &&
    row.role !== "reverify"
  )
    return undefined;

  const message = row.message?.trim();
  if (!message) return undefined;

  const verdict = /^(PASS|FAIL)\b/i.exec(message);
  if (verdict) return verdict[1].toUpperCase() === "FAIL" ? "failed" : "passed";

  if (/\bfail(ed|ure|s|ing)?\b/i.test(message)) return "failed";
  if (/\bpass(ed|es|ing)?\b/i.test(message)) return "passed";
  return undefined;
}

const ROLE_PROGRESS: Partial<Record<AgentRole, number>> = {
  dev: 0,
  review: 1,
  fix: 2,
  verify: 3,
  requalify: 4, // The second gate check runs after verify and before judge.
  judge: 5,
  land: 6,
  reverify: 7,
};

function progressOf(row: IndexedRow): number | undefined {
  const rank = ROLE_PROGRESS[row.role];
  if (rank === undefined) return undefined;
  return (row.attempt ?? 0) * 10 + rank;
}

const SEQUENTIAL_ROLES: ReadonlySet<AgentRole> = new Set(["commit", "scout"]);

function reapAbandoned(rows: IndexedRow[], open: IndexedRow[]): void {
  if (open.length === 0) return;

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
  const open: IndexedRow[] = [];
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
    if (entry.kind === "state") return;
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

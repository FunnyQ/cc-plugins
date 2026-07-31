import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import { refToString } from "../../flightplan/scripts/lib/parse-task";
import type {
  FlightlogEntry,
  ScoreEntry,
} from "../../flightplan/scripts/lib/flightlog";

export type AgentRole =
  | "scout"
  | "dev"
  | "verify"
  | "judge"
  | "review"
  | "fix"
  | "done"
  | "block"
  | "commit"
  | "unknown";

export type ParsedLabel = {
  role: AgentRole;
  ref?: string;
  attempt?: number;
  lens?: string;
  wave?: number;
  raw: string;
};

export type TaskState = "done" | "in-progress" | "ready" | "blocked";

export type TaskView = {
  ref: string;
  bucket: string;
  nn: string;
  title: string;
  status: string | null;
  state: TaskState;
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
  } | null;
};

export type FleetStatus = "in-flight" | "finished";

export type FleetRow = {
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
};

const DEV_ENGINE = /^dev-([a-z]+):(.+)#(\d+)$/;
const DEV = /^dev:(.+)#(\d+)$/;
const REF_ATTEMPT = /^(verify|judge|fix):(.+)#(\d+)$/;
const REVIEW = /^review:([^#]+)#(\d+)$/;
const TERMINAL = /^(done|block):(.+)$/;
const SCOUT = /^scout-wave-(\d+)$/;

export function parseAgentLabel(label: string): ParsedLabel {
  let match = DEV_ENGINE.exec(label);
  if (match) {
    return {
      role: "dev",
      ref: match[2],
      attempt: Number(match[3]),
      raw: label,
    };
  }
  match = DEV.exec(label);
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
      role: match[1] as "verify" | "judge" | "fix",
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
function fleetIdentity(
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
    const blockedBy = dependsOn.filter(
      (dependency) => byRef[dependency]?.status !== "done",
    );
    let state: TaskState;
    if (task.status === "done") state = "done";
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
          }
        : null,
    };
  });
}

type IndexedRow = FleetRow & {
  order: number;
  identity: string;
  agentLabel?: string;
};

const KNOWN_ROLES: AgentRole[] = [
  "scout",
  "dev",
  "verify",
  "judge",
  "review",
  "fix",
  "done",
  "block",
  "commit",
];

function roleFromEntry(entry: FlightlogEntry, parsed: ParsedLabel): AgentRole {
  if (parsed.role !== "unknown") return parsed.role;
  if (entry.kind === "score") return "judge";
  return KNOWN_ROLES.includes(entry.role as AgentRole)
    ? (entry.role as AgentRole)
    : "unknown";
}

export function aggregateFleet(entries: FlightlogEntry[]): FleetRow[] {
  const rows: IndexedRow[] = [];
  // Only an in-flight row can be closed, so pairing scans the open rows, not every row.
  const open: IndexedRow[] = [];

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
      const judged = rows.find(
        (row) =>
          row.role === "judge" &&
          row.ref === base.ref &&
          row.attempt === base.attempt &&
          row.score === undefined,
      );
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
      return;
    }

    const index = open.findIndex((row) =>
      row.agentLabel && entry.agentLabel
        ? row.agentLabel === entry.agentLabel
        : row.identity === identity,
    );
    if (index !== -1) {
      const [started] = open.splice(index, 1);
      started!.status = "finished";
      started!.endedAt = entry.ts;
      started!.elapsedMs =
        new Date(entry.ts).getTime() - new Date(started!.startedAt!).getTime();
      started!.message = entry.message;
      return;
    }

    rows.push({
      ...base,
      status: "finished",
      endedAt: entry.ts,
      message: entry.message,
    });
  });

  const scoreByAttempt = new Map<string, ScoreEntry>();
  for (const entry of entries) {
    if (entry.kind !== "score") continue;
    const scoreKey = `${entry.task}|${entry.attempt}`;
    if (!scoreByAttempt.has(scoreKey)) scoreByAttempt.set(scoreKey, entry);
  }
  for (const row of rows) {
    if (row.score || row.ref === undefined || row.attempt === undefined)
      continue;
    row.score = scoreByAttempt.get(`${row.ref}|${row.attempt}`);
  }

  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const count = (keyCounts.get(row.key) ?? 0) + 1;
    keyCounts.set(row.key, count);
    if (count > 1) row.key = `${row.key}#${count}`;
  }

  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "in-flight" ? -1 : 1;
    if (a.status === "finished") {
      const time = (b.endedAt ?? "").localeCompare(a.endedAt ?? "");
      if (time !== 0) return time;
    }
    return a.order - b.order;
  });

  return rows.map(
    ({ order: _order, identity: _identity, agentLabel: _agentLabel, ...row }) =>
      row,
  );
}

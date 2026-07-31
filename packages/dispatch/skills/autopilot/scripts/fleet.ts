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
    return { role: "dev", ref: match[2], attempt: Number(match[3]), raw: label };
  }
  match = DEV.exec(label);
  if (match) {
    return { role: "dev", ref: match[1], attempt: Number(match[2]), raw: label };
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

function entryIdentity(entry: FlightlogEntry): string | null {
  if (entry.kind !== "note") return null;
  return `${entry.task}|${entry.role}|${entry.attempt ?? "-"}`;
}

function hasUnmatchedStart(ref: string, entries: FlightlogEntry[]): boolean {
  const open = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "note" || entry.task !== ref) continue;
    const identity = entryIdentity(entry)!;
    if (entry.phase === "start") open.add(identity);
    else open.delete(identity);
  }
  return open.size > 0;
}

export function deriveTaskViews(
  byRef: Record<string, ParsedTask>,
  entries: FlightlogEntry[],
): TaskView[] {
  return Object.entries(byRef).map(([ref, task]) => {
    const dependsOn = task.dependsOn.map(refToString);
    const blocks = task.blocks.map(refToString);
    const blockedBy = dependsOn.filter(
      (dependency) => byRef[dependency]?.status !== "done",
    );
    let state: TaskState;
    if (task.status === "done") state = "done";
    else if (task.status === "blocked") state = "blocked";
    else if (task.status === "in-progress") state = "in-progress";
    else if (task.status === "todo" && hasUnmatchedStart(ref, entries)) {
      state = "in-progress";
    } else if (task.status === "todo" && blockedBy.length === 0) state = "ready";
    else state = "blocked";

    let attempts = 0;
    let latestScore: ScoreEntry | null = null;
    for (const entry of entries) {
      if (entry.task !== ref) continue;
      attempts = Math.max(attempts, entry.attempt ?? 0);
      if (
        entry.kind === "score" &&
        (!latestScore || entry.attempt > latestScore.attempt)
      ) {
        latestScore = entry;
      }
    }

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

function roleFromEntry(entry: FlightlogEntry, parsed: ParsedLabel): AgentRole {
  if (parsed.role !== "unknown") return parsed.role;
  if (entry.kind === "score") return "judge";
  const roles: AgentRole[] = [
    "scout", "dev", "verify", "judge", "review",
    "fix", "done", "block", "commit",
  ];
  return roles.includes(entry.role as AgentRole)
    ? (entry.role as AgentRole)
    : "unknown";
}

export function aggregateFleet(entries: FlightlogEntry[]): FleetRow[] {
  const rows: IndexedRow[] = [];

  entries.forEach((entry, order) => {
    const parsed = parseAgentLabel(entry.agentLabel ?? "");
    const fallbackIdentity = entry.kind === "note"
      ? `${entry.task}|${entry.role}|${entry.attempt ?? "-"}`
      : `${entry.task}|judge|${entry.attempt}`;
    const identity = entry.agentLabel ?? fallbackIdentity;
    const ref = parsed.ref ?? entry.task;
    const attempt = parsed.attempt ?? entry.attempt;
    const role = roleFromEntry(entry, parsed);
    const label = entry.agentLabel ?? identity;

    if (entry.kind === "note" && entry.phase === "start") {
      const row: IndexedRow = {
        key: identity,
        identity: fallbackIdentity,
        agentLabel: entry.agentLabel,
        order,
        label,
        role,
        ref,
        attempt,
        lens: parsed.lens,
        status: "in-flight",
        startedAt: entry.ts,
      };
      rows.push(row);
      return;
    }

    const started = rows.find((row) => {
      if (row.status !== "in-flight") return false;
      if (row.agentLabel && entry.agentLabel) {
        return row.agentLabel === entry.agentLabel;
      }
      return row.identity === fallbackIdentity;
    });
    if (started) {
      started.status = "finished";
      started.endedAt = entry.ts;
      started.elapsedMs =
        new Date(entry.ts).getTime() - new Date(started.startedAt!).getTime();
      started.message = entry.kind === "note" ? entry.message : undefined;
      if (entry.kind === "score") started.score = entry;
      return;
    }

    rows.push({
      key: identity,
      identity: fallbackIdentity,
      agentLabel: entry.agentLabel,
      order,
      label,
      role,
      ref,
      attempt,
      lens: parsed.lens,
      status: "finished",
      endedAt: entry.ts,
      message: entry.kind === "note" ? entry.message : undefined,
      score: entry.kind === "score" ? entry : undefined,
    });
  });

  const scores = entries.filter((entry): entry is ScoreEntry => entry.kind === "score");
  for (const row of rows) {
    if (row.score || row.ref === undefined || row.attempt === undefined) continue;
    row.score = scores.find(
      (score) => score.task === row.ref && score.attempt === row.attempt,
    );
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

  return rows.map(({
    order: _order,
    identity: _identity,
    agentLabel: _agentLabel,
    ...row
  }) => row);
}

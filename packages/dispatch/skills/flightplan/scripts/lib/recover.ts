import type { FlightlogEntry, NoteEntry, ScoreEntry } from "./flightlog";
import type { TaskStatus } from "./parse-task";
import { resumePoint } from "./resume-point";

export type Reentry = Record<
  string,
  { from: "dev" | "verify"; attempt: number }
>;

export type Recovery =
  | { state: "clean"; stranded: string[] }
  | { state: "live"; lastActivity: string; idleMinutes: number }
  | {
      state: "interrupted";
      lastActivity: string;
      reset: string[];
      reentry: Reentry;
    };

const isAttemptRow = (e: FlightlogEntry): e is NoteEntry | ScoreEntry =>
  (e.kind === "note" || e.kind === "score") && typeof e.attempt === "number";

export function planRecovery(
  entries: FlightlogEntry[],
  statusByRef: Record<string, TaskStatus | null>,
  nowMs: number,
  staleMs: number,
): Recovery {
  const inProgress = Object.keys(statusByRef)
    .filter((ref) => statusByRef[ref] === "in-progress")
    .sort();
  const lastEnd = entries.findLastIndex((e) => e.kind === "run-end");
  const open = entries.slice(lastEnd + 1).filter(isAttemptRow);
  if (open.length === 0) return { state: "clean", stranded: inProgress };

  const lastActivity = open.reduce(
    (max, e) => (e.ts > max ? e.ts : max),
    open[0].ts,
  );
  const idleMs = nowMs - Date.parse(lastActivity);
  // idle time is the only liveness signal; a step silent past staleMs reads as dead, so the caller asks first
  if (idleMs < staleMs) {
    return {
      state: "live",
      lastActivity,
      idleMinutes: Math.floor(idleMs / 60_000),
    };
  }

  const reentry: Reentry = {};
  for (const ref of inProgress) {
    const attempts = entries
      .filter((e) => e.task === ref && isAttemptRow(e))
      .map((e) => (e as NoteEntry | ScoreEntry).attempt as number);
    if (attempts.length === 0) continue;
    const point = resumePoint(open, ref);
    reentry[ref] = {
      from: point?.from ?? "dev",
      attempt: Math.max(...attempts) + 1,
    };
  }
  return { state: "interrupted", lastActivity, reset: inProgress, reentry };
}

/**
 * Where a parked task actually stopped, derived from its flightlog trail.
 *
 * Autopilot's resume takes a step (`--from dev|verify|judge`) and an attempt
 * number. Both used to be read off the JSONL by eye, and the two ways to get
 * that wrong are not symmetric: picking a step too EARLY re-pays for work that
 * already landed, while picking one too LATE takes unfinished work as
 * satisfied. The second is silent, so the choice belongs in a tested function.
 *
 * The derivation never suggests skipping the binary gate. Two reasons, and both
 * are load-bearing rather than caution: `--from judge` means a person performed
 * that gate and signed for it, which is a human decision no trail can make; and
 * the judge grounds correctness in the verifier's RAW evidence, which lives only
 * in the orchestrator's memory and dies with the run. The trail keeps the
 * verifier's one-line message, not its output. So `verify` is the earliest
 * honest resume point whenever a machine gate is needed at all.
 */
import type { FlightlogEntry, NoteEntry, ScoreEntry } from "./flightlog";

/** Roles whose completion proves the attempt's write step finished. */
const WRITE_ROLES = new Set(["dev", "fix"]);

/** Roles that are the binary gate. `requalify` is a verify re-run after quiet. */
const GATE_ROLES = new Set(["verify", "requalify"]);

/**
 * Roles that are bookkeeping, not pipeline steps. `resume` is the note a
 * resumed attempt writes about itself, and counting it as progress would let a
 * resume derive its next step from its own announcement.
 */
const BOOKKEEPING_ROLES = new Set(["resume", "scout", "commit"]);

export type StepOutcome = {
  role: string;
  /** True when a `phase: "end"` note exists — or a phase-less one, the legacy shape. */
  completed: boolean;
  /** The completing note's message, or null when the role only ever started. */
  message: string | null;
};

export type AttemptProgress = {
  attempt: number;
  /** Every non-bookkeeping role seen in this attempt, in first-seen order. */
  steps: StepOutcome[];
  /** The `score-task.ts --log` verdict for this attempt, when one was written. */
  verdict: { passed: boolean; weighted: number } | null;
};

export type ResumePoint = {
  task: string;
  /** Every attempt number the trail holds for this ref, ascending. */
  attempts: number[];
  last: AttemptProgress;
  /** The step a resume should start at. Never `judge` — see the module comment. */
  from: "dev" | "verify";
  /** The attempt a resume should start counting at: always one past the last. */
  attempt: number;
  /** One line naming the evidence that chose `from`. */
  reason: string;
  /**
   * True when a gate or judge RAN and rejected the work, rather than the run
   * dying before it could. The two look identical in a bare attempt count and
   * call for opposite resumes, so the distinction rides out of here rather than
   * being re-derived by every reader.
   */
  gateRejected: boolean;
};

const isNote = (e: FlightlogEntry): e is NoteEntry => e.kind === "note";
const isScore = (e: FlightlogEntry): e is ScoreEntry => e.kind === "score";

/** A note with no `phase` predates the field and means completion. */
const completes = (note: NoteEntry): boolean => note.phase !== "start";

/**
 * Collapse one attempt's notes into one outcome per role. A role that both
 * started and ended is completed; the LAST completing note wins, because a
 * `resilient()` retry writes a second pair of rows for the same role and the
 * retry's verdict is the one that counts.
 */
function stepsOf(notes: NoteEntry[]): StepOutcome[] {
  const order: string[] = [];
  const byRole = new Map<string, StepOutcome>();
  for (const note of notes) {
    if (BOOKKEEPING_ROLES.has(note.role)) continue;
    if (!byRole.has(note.role)) {
      order.push(note.role);
      byRole.set(note.role, {
        role: note.role,
        completed: false,
        message: null,
      });
    }
    if (completes(note)) {
      const step = byRole.get(note.role)!;
      step.completed = true;
      step.message = note.message;
    }
  }
  return order.map((role) => byRole.get(role)!);
}

/**
 * Derive where `task` stopped, or null when the trail holds nothing for it.
 *
 * Entries without an `attempt` are ignored: a resume has to name a number, and
 * a row that carries none cannot tell it which one.
 */
export function resumePoint(
  entries: FlightlogEntry[],
  task: string,
): ResumePoint | null {
  const mine = entries.filter((e) => e.task === task);
  const numbered = mine.filter(
    (e): e is NoteEntry | ScoreEntry =>
      (isNote(e) || isScore(e)) && typeof e.attempt === "number",
  );
  if (numbered.length === 0) return null;

  const attempts = [...new Set(numbered.map((e) => e.attempt as number))].sort(
    (a, b) => a - b,
  );
  const lastAttempt = attempts[attempts.length - 1];
  const inLast = numbered.filter((e) => e.attempt === lastAttempt);
  const steps = stepsOf(inLast.filter(isNote));
  const scored = inLast.filter(isScore);
  // The last score row wins for the same reason the last note does.
  const scoreRow = scored.length > 0 ? scored[scored.length - 1] : null;
  const verdict = scoreRow
    ? { passed: scoreRow.passed, weighted: scoreRow.weighted }
    : null;

  const last: AttemptProgress = { attempt: lastAttempt, steps, verdict };
  const at = (predicate: (step: StepOutcome) => boolean) =>
    steps.filter((step) => predicate(step) && step.completed).pop() ?? null;
  const wrote = at((step) => WRITE_ROLES.has(step.role));
  const gate = at((step) => GATE_ROLES.has(step.role));

  // Ordered latest-evidence-first: a verdict supersedes the gate that fed it,
  // and the gate supersedes the write step it judged.
  const decide = (): Pick<ResumePoint, "from" | "reason" | "gateRejected"> => {
    if (verdict && !verdict.passed) {
      return {
        from: "dev",
        gateRejected: true,
        reason: `the rubric judge scored attempt ${lastAttempt} at ${verdict.weighted.toFixed(2)} and rejected it, so the work itself is what failed`,
      };
    }
    if (verdict) {
      return {
        from: "verify",
        gateRejected: false,
        reason: `attempt ${lastAttempt} passed its rubric but the task is not done, so the run died after the judge — re-running the cheap binary gate is the earliest honest restart, because the trail keeps the verifier's one-line message and not the raw evidence the judge needs`,
      };
    }
    if (gate && /^FAIL\b/.test(gate.message ?? "")) {
      return {
        from: "dev",
        gateRejected: true,
        reason: `the binary gate ran on attempt ${lastAttempt} and rejected the work: ${gate.message}`,
      };
    }
    if (gate) {
      return {
        from: "verify",
        gateRejected: false,
        reason: `the binary gate finished attempt ${lastAttempt} but no rubric verdict was recorded, so the run died at or after the judge`,
      };
    }
    if (wrote) {
      return {
        from: "verify",
        gateRejected: false,
        reason: `the ${wrote.role} step completed on attempt ${lastAttempt} and nothing verified it, so the work is on disk and only the gate is owed`,
      };
    }
    return {
      from: "dev",
      gateRejected: false,
      reason: `no write step recorded completion on attempt ${lastAttempt}, so whatever it left behind is unfinished`,
    };
  };

  return { task, attempts, last, attempt: lastAttempt + 1, ...decide() };
}

/** Every task ref the trail mentions, in first-seen order. */
export function tasksIn(entries: FlightlogEntry[]): string[] {
  const seen: string[] = [];
  for (const entry of entries) {
    if (BOOKKEEPING_ROLES.has(entry.task)) continue;
    if (!seen.includes(entry.task)) seen.push(entry.task);
  }
  return seen;
}

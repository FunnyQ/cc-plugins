/**
 * The two ways to derive a resume point wrong are not symmetric: too EARLY
 * re-pays for work that landed, too LATE takes unfinished work as satisfied.
 * Every case below pins which side of that line a given trail falls on.
 */
import { describe, expect, test } from "bun:test";
import { resumePoint, tasksIn } from "./resume-point";
import type { FlightlogEntry } from "./flightlog";

let clock = 0;
/** Monotonic timestamps, so ordering in a fixture is the order it is written. */
const ts = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

const note = (
  task: string,
  role: string,
  attempt: number,
  phase: "start" | "end",
  message = "",
): FlightlogEntry => ({
  kind: "note",
  ts: ts(),
  task,
  role,
  attempt,
  phase,
  message,
});

/** A role that ran start-to-finish. */
const ran = (
  task: string,
  role: string,
  attempt: number,
  message = "",
): FlightlogEntry[] => [
  note(task, role, attempt, "start"),
  note(task, role, attempt, "end", message),
];

const score = (
  task: string,
  attempt: number,
  passed: boolean,
  weighted: number,
): FlightlogEntry => ({
  kind: "score",
  ts: ts(),
  task,
  attempt,
  weighted,
  passed,
  hardFailed: false,
  missing: [],
  threshold: 4,
  passOp: ">",
  breakdown: [],
});

const REF = "review/01";

describe("resumePoint", () => {
  test("a trail with nothing for the ref returns null", () => {
    expect(resumePoint([...ran("ui/01", "dev", 1)], REF)).toBeNull();
  });

  test("a write step that finished with nothing after it owes only the gate", () => {
    // The case the whole feature exists for: the four lenses and the Opus fixer
    // landed, and the run died before anything verified them.
    const point = resumePoint(
      [...ran(REF, "review", 2), ...ran(REF, "fix", 2, "applied 9 findings")],
      REF,
    )!;

    expect(point.from).toBe("verify");
    expect(point.attempt).toBe(3);
    expect(point.gateRejected).toBe(false);
    expect(point.reason).toContain("only the gate is owed");
  });

  test("a write step that only started is unfinished and restarts at dev", () => {
    const point = resumePoint([note(REF, "fix", 2, "start")], REF)!;

    expect(point.from).toBe("dev");
    expect(point.attempt).toBe(3);
    expect(point.reason).toContain("no write step recorded completion");
  });

  test("a gate that FAILED rejects the work, so the resume runs dev again", () => {
    // Too-late protection: the gate saw the work and said no. Restarting above
    // it would take rejected code as satisfied.
    const point = resumePoint(
      [
        ...ran(REF, "fix", 2),
        ...ran(REF, "verify", 2, "FAIL — criterion 6 unmet"),
      ],
      REF,
    )!;

    expect(point.from).toBe("dev");
    expect(point.gateRejected).toBe(true);
    expect(point.reason).toContain("criterion 6 unmet");
  });

  test("a gate that PASSED with no verdict restarts at verify, not judge", () => {
    // The judge needs the verifier's RAW evidence and the trail keeps only its
    // one-line message, so `judge` is not reconstructable from disk.
    const point = resumePoint(
      [
        ...ran(REF, "fix", 2),
        ...ran(REF, "verify", 2, "PASS — all commands green"),
      ],
      REF,
    )!;

    expect(point.from).toBe("verify");
    expect(point.gateRejected).toBe(false);
    expect(point.reason).toContain("no rubric verdict was recorded");
  });

  test("a rubric verdict supersedes the gate that fed it", () => {
    const point = resumePoint(
      [
        ...ran(REF, "dev", 2),
        ...ran(REF, "verify", 2, "PASS — green"),
        ...ran(REF, "judge", 2),
        score(REF, 2, false, 2.1),
      ],
      REF,
    )!;

    expect(point.from).toBe("dev");
    expect(point.gateRejected).toBe(true);
    expect(point.reason).toContain("2.10");
  });

  test("a passing verdict on a task that never finished restarts at verify", () => {
    // The rubric passed and mark-done did not confirm, so the run died after the
    // judge. Nothing below the gate needs redoing and the gate is the cheap step.
    const point = resumePoint(
      [
        ...ran(REF, "dev", 1),
        ...ran(REF, "verify", 1, "PASS — green"),
        ...ran(REF, "judge", 1),
        score(REF, 1, true, 4.6),
      ],
      REF,
    )!;

    expect(point.from).toBe("verify");
    expect(point.gateRejected).toBe(false);
    expect(point.reason).toContain(
      "passed its rubric but the task is not done",
    );
  });

  test("a failed drift re-verify supersedes a passing verdict", () => {
    const point = resumePoint([
      score(REF, 2, true, 4.6),
      ...ran(REF, "reverify", 2, "FAIL — merged tests are red"),
    ], REF)!;
    expect(point.from).toBe("dev");
    expect(point.gateRejected).toBe(true);
    expect(point.attempt).toBe(3);
    expect(point.reason).toContain("drift re-verify");
    expect(point.reason).toContain("attempt 2");
    expect(point.reason).toContain("FAIL — merged tests are red");
  });

  test.each(["PASS — merged tests are green", null])(
    "a passing or unfinished re-verify leaves the verdict intact: %s", (message) => {
      const point = resumePoint([
        score(REF, 2, true, 4.6),
        ...(message === null
          ? [note(REF, "reverify", 2, "start", "FAIL is not a completed result")]
          : ran(REF, "reverify", 2, message)),
      ], REF)!;
      expect(point.from).toBe("verify");
      expect(point.gateRejected).toBe(false);
      expect(point.attempt).toBe(3);
    },
  );

  test("only the LAST attempt decides, and the attempt list keeps the rest", () => {
    const point = resumePoint(
      [
        ...ran(REF, "dev", 1),
        ...ran(REF, "verify", 1, "FAIL — red"),
        ...ran(REF, "fix", 2),
      ],
      REF,
    )!;

    expect(point.attempts).toEqual([1, 2]);
    expect(point.last.attempt).toBe(2);
    expect(point.from).toBe("verify");
    expect(point.gateRejected).toBe(false);
  });

  test("a retried role is judged by its LAST outcome", () => {
    // `resilient()` re-runs a schema'd call, writing a second pair of rows for
    // the same role. The retry's verdict is the one that counts.
    const point = resumePoint(
      [
        ...ran(REF, "dev", 1),
        ...ran(REF, "verify", 1, "FAIL — red"),
        ...ran(REF, "verify", 1, "PASS — green on the retry"),
      ],
      REF,
    )!;

    expect(point.from).toBe("verify");
    expect(point.gateRejected).toBe(false);
  });

  test("a resumed attempt's own announcement is not progress", () => {
    // Counting the `resume` note as a step would let a resume derive its next
    // move from the fact that it resumed.
    const point = resumePoint(
      [note(REF, "resume", 3, "end", "resumed at the verify step")],
      REF,
    )!;

    expect(point.from).toBe("dev");
    expect(point.last.steps).toEqual([]);
    expect(point.attempt).toBe(4);
  });

  test("rows with no attempt number cannot place a resume and are ignored", () => {
    const orphan: FlightlogEntry = {
      kind: "note",
      ts: ts(),
      task: REF,
      role: "dev",
      phase: "end",
      message: "no attempt recorded",
    };
    expect(resumePoint([orphan], REF)).toBeNull();
    // A numbered row beside it still decides.
    const point = resumePoint([orphan, ...ran(REF, "fix", 1)], REF)!;
    expect(point.attempt).toBe(2);
  });

  test("a phase-less note counts as completion, so an old trail still resolves", () => {
    const legacy: FlightlogEntry = {
      kind: "note",
      ts: ts(),
      task: REF,
      role: "dev",
      attempt: 1,
      message: "implemented",
    };
    const point = resumePoint([legacy], REF)!;

    expect(point.from).toBe("verify");
    expect(point.last.steps[0].completed).toBe(true);
  });
});

describe("tasksIn", () => {
  test("lists refs in first-seen order and drops the synthetic ones", () => {
    const entries = [
      note("scout", "scout", 1, "end"),
      ...ran("ui/02", "dev", 1),
      ...ran("ui/01", "dev", 1),
      note("commit", "commit", 1, "end"),
    ];
    expect(tasksIn(entries)).toEqual(["ui/02", "ui/01"]);
  });
});

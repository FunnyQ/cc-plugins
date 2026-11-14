import { describe, expect, test } from "bun:test";
import type { FlightlogEntry } from "./flightlog";
import { planRecovery } from "./recover";

const MIN = 60_000;
const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

const note = (
  task: string,
  role: string,
  attempt: number,
  phase: "start" | "end",
  minutes: number,
  message = "",
): FlightlogEntry => ({
  kind: "note",
  ts: at(minutes),
  task,
  role,
  attempt,
  phase,
  message,
});

const runEnd = (minutes: number): FlightlogEntry => ({
  kind: "run-end",
  ts: at(minutes),
  task: "(flight)",
  aborted: false,
  completed: [],
  drained: [],
  needsHuman: [],
});

const STALE = 15 * MIN;

describe("planRecovery", () => {
  test("a trail whose last run closed is clean", () => {
    const entries = [note("a/01", "dev", 1, "start", 0), runEnd(5)];
    expect(
      planRecovery(entries, { "a/01": "done" }, T0 + 60 * MIN, STALE),
    ).toEqual({
      state: "clean",
      stranded: [],
    });
  });

  test("an empty trail is clean", () => {
    expect(planRecovery([], {}, T0, STALE)).toEqual({
      state: "clean",
      stranded: [],
    });
  });

  test("a goal-mode flight entry alone opens no run", () => {
    const entries: FlightlogEntry[] = [
      runEnd(0),
      {
        kind: "flight",
        ts: at(1),
        task: "(flight)",
        goalHash: "h",
        planPath: "/p",
      },
    ];
    expect(planRecovery(entries, {}, T0 + 60 * MIN, STALE).state).toBe("clean");
  });

  test("an open run with recent activity may still be running", () => {
    const entries = [note("a/01", "dev", 1, "start", 0)];
    const result = planRecovery(
      entries,
      { "a/01": "in-progress" },
      T0 + 10 * MIN,
      STALE,
    );
    expect(result).toEqual({
      state: "live",
      lastActivity: at(0),
      idleMinutes: 10,
    });
  });

  test("an idle open run resets in-progress tasks and re-enters them where they stopped", () => {
    const entries = [
      runEnd(-100),
      note("a/01", "dev", 1, "start", 0),
      note("a/01", "dev", 1, "end", 5, "wrote it"),
      note("a/02", "dev", 2, "start", 6),
      note("a/03", "dev", 1, "start", 7),
      note("a/03", "dev", 1, "end", 8),
    ];
    const statuses = {
      "a/01": "in-progress",
      "a/02": "in-progress",
      "a/03": "done",
      "a/04": "in-progress",
      "a/05": "todo",
    } as const;
    const result = planRecovery(entries, statuses, T0 + 60 * MIN, STALE);
    expect(result.state).toBe("interrupted");
    if (result.state !== "interrupted") return;
    expect(result.lastActivity).toBe(at(8));
    expect(result.reset).toEqual(["a/01", "a/02", "a/04"]);
    expect(result.reentry["a/01"].from).toBe("verify");
    expect(result.reentry["a/02"].from).toBe("dev");
    expect(result.reentry["a/01"].attempt).toBe(2);
    expect(result.reentry["a/02"].attempt).toBe(3);
    expect(result.reentry).not.toHaveProperty("a/04");
  });

  test("a task the trail shows before the open run still counts its attempts", () => {
    const entries = [
      note("a/01", "dev", 1, "start", -50),
      runEnd(-40),
      note("a/01", "dev", 2, "start", 0),
    ];
    const result = planRecovery(
      entries,
      { "a/01": "in-progress" },
      T0 + 60 * MIN,
      STALE,
    );
    if (result.state !== "interrupted") throw new Error(result.state);
    expect(result.reentry["a/01"]).toEqual({ from: "dev", attempt: 3 });
  });

  test("an attempt number reused across runs takes its step from the open run only", () => {
    const entries = [
      note("a/01", "dev", 1, "start", -60),
      note("a/01", "dev", 1, "end", -55),
      note("a/01", "verify", 1, "end", -50, "PASS — bun test"),
      runEnd(-40),
      note("a/01", "dev", 1, "start", 0),
    ];
    const result = planRecovery(
      entries,
      { "a/01": "in-progress" },
      T0 + 60 * MIN,
      STALE,
    );
    if (result.state !== "interrupted") throw new Error(result.state);
    expect(result.reentry["a/01"]).toEqual({ from: "dev", attempt: 2 });
  });

  test("a run that wrote only bookkeeping after its run-end opens nothing", () => {
    const entries: FlightlogEntry[] = [
      runEnd(0),
      {
        kind: "escalation",
        ts: at(1),
        task: "a/01",
        attempt: 1,
        class: "capped",
        infrastructure: false,
        parked: true,
        reason: "adopted",
      },
    ];
    expect(planRecovery(entries, {}, T0 + 2 * MIN, STALE).state).toBe("clean");
  });

  test("a closed run still names in-progress tasks it stranded", () => {
    const result = planRecovery(
      [note("a/01", "dev", 1, "start", 0), runEnd(5)],
      { "a/01": "in-progress" },
      T0 + 60 * MIN,
      STALE,
    );
    expect(result).toEqual({ state: "clean", stranded: ["a/01"] });
  });
});

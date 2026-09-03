import { describe, expect, test } from "bun:test";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import type { TaskState, TaskView } from "./fleet";
import { currentWave, remainingWaves, summarizeWaves } from "./waves";

function view(
  ref: string,
  state: TaskState = "ready",
  dependsOn: string[] = [],
): TaskView {
  const [bucket, nn] = ref.split("/");
  return {
    ref,
    bucket: bucket!,
    nn: nn!,
    title: `Task ${ref}`,
    status: state === "done" ? "done" : "todo",
    state,
    invalidReason: null,
    blockedBy: [],
    dependsOn,
    blocks: [],
    finalReview: false,
    attempts: 0,
    latestScore: null,
  };
}

function note(agentLabel: string): FlightlogEntry {
  return {
    kind: "note",
    ts: "2026-01-01T00:00:00.000Z",
    task: "-",
    role: "scout",
    agentLabel,
    phase: "start",
    message: "scouting",
  };
}

describe("remainingWaves", () => {
  test("peels the tree into dependency waves", () => {
    expect(
      remainingWaves([
        view("api/01"),
        view("api/02"),
        view("ui/01", "blocked", ["api/01", "api/02"]),
        view("ui/02", "blocked", ["ui/01"]),
      ]),
    ).toEqual({ remaining: 3, sizes: [2, 1, 1], unschedulable: [] });
  });

  test("done tasks cost no wave and unblock the next one", () => {
    expect(
      remainingWaves([
        view("api/01", "done"),
        view("ui/01", "ready", ["api/01"]),
      ]),
    ).toEqual({ remaining: 1, sizes: [1], unschedulable: [] });
  });

  test("a finished tree has nothing left", () => {
    expect(remainingWaves([view("api/01", "done")])).toEqual({
      remaining: 0,
      sizes: [],
      unschedulable: [],
    });
  });

  test("the wave in flight is still counted", () => {
    expect(
      remainingWaves([
        view("api/01", "in-progress"),
        view("ui/01", "blocked", ["api/01"]),
      ]).sizes,
    ).toEqual([1, 1]);
  });

  // An invalid task is not complete, so it blocks — the header must not read as
  // one wave from done while a gate result is missing.
  test("an invalid task keeps its dependents waiting", () => {
    expect(
      remainingWaves([
        view("api/01", "invalid"),
        view("ui/01", "blocked", ["api/01"]),
      ]),
    ).toEqual({ remaining: 2, sizes: [1, 1], unschedulable: [] });
  });

  test("a cycle and a dangling dep can never fly", () => {
    expect(
      remainingWaves([
        view("api/01", "blocked", ["api/02"]),
        view("api/02", "blocked", ["api/01"]),
        view("ui/01", "blocked", ["ghost/09"]),
        view("ui/02"),
      ]),
    ).toEqual({
      remaining: 1,
      sizes: [1],
      unschedulable: ["api/01", "api/02", "ui/01"],
    });
  });
});

describe("currentWave", () => {
  test("reads the newest scout label", () => {
    expect(
      currentWave([
        note("scout-wave-1"),
        note("scout-wave-2"),
        note("dev:a/1#1"),
      ]),
    ).toBe(2);
  });

  test("is 0 before any scout has run", () => {
    expect(currentWave([])).toBe(0);
    expect(currentWave([note("dev:a/1#1")])).toBe(0);
  });
});

describe("summarizeWaves", () => {
  test("joins the flown wave to the remaining ones", () => {
    expect(
      summarizeWaves(
        [view("api/01", "done"), view("ui/01", "in-progress", ["api/01"])],
        [note("scout-wave-2")],
      ),
    ).toEqual({
      current: 2,
      remaining: 1,
      sizes: [1],
      unschedulable: [],
    });
  });
});

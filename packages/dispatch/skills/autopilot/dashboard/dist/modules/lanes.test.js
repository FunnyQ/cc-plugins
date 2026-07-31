import { describe, expect, test } from "bun:test";
import { buildLanes, Lanes } from "./lanes.js";

// `buckets` arrives already ordered from /api/tree, which owns that rule.
const tree = {
  buckets: ["api", "empty", "ui"],
  tasks: [
    { ref: "ui/10", bucket: "ui", nn: "10", state: "blocked" },
    { ref: "api/01", bucket: "api", nn: "01", state: "done" },
    { ref: "ui/02", bucket: "ui", nn: "02", state: "ready" },
  ],
};

describe("buildLanes", () => {
  test("keeps the server bucket order and sorts task sequence", () => {
    const lanes = buildLanes(tree);

    expect(lanes.map((lane) => lane.bucket)).toEqual(["api", "empty", "ui"]);
    expect(lanes[1].tasks).toEqual([]);
    expect(lanes[2].tasks.map((task) => task.ref)).toEqual(["ui/02", "ui/10"]);
    expect(lanes[0].done).toBe(1);
  });

  test("does not re-sort the buckets the server sent", () => {
    const lanes = buildLanes({ ...tree, buckets: ["ui", "api", "empty"] });

    expect(lanes.map((lane) => lane.bucket)).toEqual(["ui", "api", "empty"]);
  });
});

describe("Lanes", () => {
  test("keeps expansion state locally and maps score outcomes", () => {
    const component = Lanes({ tree });

    expect(component.isExpanded("ui/02")).toBe(false);
    component.toggle("ui/02");
    expect(component.isExpanded("ui/02")).toBe(true);
    expect(component.scoreClass({ passed: true, hardFailed: false })).toBe(
      "-passed",
    );
    expect(component.scoreClass({ passed: true, hardFailed: true })).toBe(
      "-failed",
    );
    expect(component.scoreClass({ passed: false, hardFailed: false })).toBe(
      "-pending",
    );
  });

  test("scales score, threshold, rubric score, and dimension weight", () => {
    const component = Lanes({ tree });
    const breakdown = [
      { name: "Correctness", weight: 3, score: 5 },
      { name: "Clarity", weight: 1, score: 4 },
    ];

    expect(component.percent(4.1)).toBe("82%");
    expect(component.percent(4)).toBe("80%");
    expect(component.renderDimensions(breakdown)).toContain(
      "inline-size: 33.33333333333333%",
    );
  });

  test("reuses the built lanes until the task payload is replaced", () => {
    const component = Lanes({ tree });

    expect(component.lanes()).toBe(component.lanes());
  });
});

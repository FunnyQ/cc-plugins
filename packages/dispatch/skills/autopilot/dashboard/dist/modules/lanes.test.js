import { describe, expect, test } from "bun:test";
import { buildLanes, Lanes } from "./lanes.js";

const tree = {
  buckets: ["ui", "api", "empty"],
  tasks: [
    { ref: "ui/10", bucket: "ui", nn: "10", state: "blocked" },
    { ref: "api/01", bucket: "api", nn: "01", state: "done" },
    { ref: "ui/02", bucket: "ui", nn: "02", state: "ready" },
  ],
};

describe("buildLanes", () => {
  test("sorts buckets and task sequence while preserving empty buckets", () => {
    const lanes = buildLanes(tree);

    expect(lanes.map((lane) => lane.bucket)).toEqual(["api", "empty", "ui"]);
    expect(lanes[1].tasks).toEqual([]);
    expect(lanes[2].tasks.map((task) => task.ref)).toEqual(["ui/02", "ui/10"]);
    expect(lanes[0].done).toBe(1);
  });
});

describe("Lanes", () => {
  test("keeps expansion state locally and maps score outcomes", () => {
    const component = Lanes({ tree });

    expect(component.isExpanded("ui/02")).toBe(false);
    component.toggle("ui/02");
    expect(component.isExpanded("ui/02")).toBe(true);
    expect(component.scoreClass({ passed: true, hardFailed: false })).toBe("-passed");
    expect(component.scoreClass({ passed: true, hardFailed: true })).toBe("-failed");
    expect(component.scoreClass({ passed: false, hardFailed: false })).toBe("-pending");
  });

  test("scales score, threshold, rubric score, and dimension weight", () => {
    const component = Lanes({ tree });
    const breakdown = [
      { weight: 3 },
      { weight: 1 },
    ];

    expect(component.scorePosition(4.1)).toBe("82%");
    expect(component.rubricScoreWidth(4)).toBe("80%");
    expect(Number.parseFloat(component.weightWidth(1, breakdown))).toBeCloseTo(100 / 3);
  });
});

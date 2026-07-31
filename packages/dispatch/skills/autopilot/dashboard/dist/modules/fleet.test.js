import { afterEach, describe, expect, test } from "bun:test";
import { formatElapsed, isInFlight, renderFleet, toggleRubric } from "./fleet.js";

const expandedKeys = new Set();

function isExpanded(rowKey) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        addEventListener() {},
        className: "",
        innerHTML: "",
      };
    },
  };

  try {
    const root = renderFleet([
      {
        key: rowKey,
        role: "dev",
        ref: "ui/01",
        status: "finished",
        score: { breakdown: [{ name: "Correctness", score: 5, weight: 1 }] },
      },
    ], 1, true, "connected");
    return root.innerHTML.includes('aria-expanded="true"');
  } finally {
    globalThis.document = originalDocument;
  }
}

function expand(rowKey) {
  toggleRubric(rowKey);
  expandedKeys.add(rowKey);
}

afterEach(() => {
  for (const rowKey of expandedKeys) toggleRubric(rowKey);
  expandedKeys.clear();
});

describe("formatElapsed", () => {
  test("formats sub-minute ticking durations with one decimal place", () => {
    expect(formatElapsed(0, undefined, 5_432)).toBe("5.4s");
    expect(formatElapsed(0, undefined, 45_000)).toBe("45.0s");
  });

  test("formats durations at and above one minute", () => {
    expect(formatElapsed(0, 60_000)).toBe("1m 0s");
    expect(formatElapsed(0, 200_000)).toBe("3m 20s");
  });

  test("uses the end time for finished rows instead of the current time", () => {
    expect(formatElapsed(100_000, 130_000, 900_000)).toBe("30.0s");
    expect(formatElapsed(100_000, undefined, 140_000)).toBe("40.0s");
  });

  test("clamps negative durations to zero", () => {
    expect(formatElapsed(0, undefined, -1_000)).toBe("0.0s");
  });
});

describe("isInFlight", () => {
  test("returns true only for an in-flight row", () => {
    expect(isInFlight({ status: "in-flight" })).toBe(true);
    expect(isInFlight({ status: "finished" })).toBe(false);
  });
});

describe("toggleRubric", () => {
  test("adds a missing row key", () => {
    expand("add-row");

    expect(isExpanded("add-row")).toBe(true);
  });

  test("removes an existing row key", () => {
    toggleRubric("remove-row");
    toggleRubric("remove-row");

    expect(isExpanded("remove-row")).toBe(false);
  });

  test("toggles the same row key on every call", () => {
    toggleRubric("toggle-row");
    expect(isExpanded("toggle-row")).toBe(true);

    toggleRubric("toggle-row");
    expect(isExpanded("toggle-row")).toBe(false);

    expand("toggle-row");
    expect(isExpanded("toggle-row")).toBe(true);
  });
});

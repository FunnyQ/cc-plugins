import { afterEach, describe, expect, test } from "bun:test";
import {
  elapsedText,
  formatDuration,
  isInFlight,
  renderFleet,
  tickElapsed,
  toggleRubric,
} from "./fleet.js";

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
    const root = renderFleet(
      [
        {
          key: rowKey,
          role: "dev",
          ref: "ui/01",
          status: "finished",
          score: { breakdown: [{ name: "Correctness", score: 5, weight: 1 }] },
        },
      ],
      1,
      true,
      "connected",
    );
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

describe("formatDuration", () => {
  test("formats sub-minute durations with one decimal place", () => {
    expect(formatDuration(5_432)).toBe("5.4s");
    expect(formatDuration(45_000)).toBe("45.0s");
  });

  test("formats durations at and above one minute", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(200_000)).toBe("3m 20s");
  });

  test("clamps negative durations to zero", () => {
    expect(formatDuration(-1_000)).toBe("0.0s");
  });
});

describe("elapsedText", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const now = Date.parse("2026-01-01T00:00:40.000Z");

  test("ticks an in-flight row against the current time", () => {
    expect(elapsedText({ status: "in-flight", startedAt }, now)).toBe("40.0s");
  });

  test("prints the recorded duration of a finished row as given", () => {
    expect(
      elapsedText({ status: "finished", startedAt, elapsedMs: 30_000 }, now),
    ).toBe("30.0s");
  });

  test("prints nothing without a start time or a duration", () => {
    expect(elapsedText({ status: "finished" }, now)).toBe("");
    expect(elapsedText({ status: "finished", startedAt }, now)).toBe("");
  });
});

describe("tickElapsed", () => {
  function stubRow(startedAt) {
    const cell = { className: "-elapsed", textContent: "" };
    return {
      cell,
      dataset: { startedAt },
      querySelector: () => cell,
    };
  }

  test("updates only the elapsed cell of a ticking row", () => {
    const row = stubRow("2026-01-01T00:00:00.000Z");
    const root = { querySelectorAll: () => [row] };

    tickElapsed(root, Date.parse("2026-01-01T00:00:12.000Z"));

    expect(row.cell.textContent).toBe("12.0s");
  });

  test("tolerates a missing mount and a row without an elapsed cell", () => {
    expect(() => tickElapsed(null)).not.toThrow();
    expect(() =>
      tickElapsed({
        querySelectorAll: () => [{ dataset: {}, querySelector: () => null }],
      }),
    ).not.toThrow();
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

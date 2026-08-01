import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  elapsedText,
  formatDuration,
  isFleetCollapsed,
  isInFlight,
  renderFleet,
  runElapsed,
  tickElapsed,
  toggleFleet,
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
    // Scope past the heading: the panel's own collapse toggle carries an
    // aria-expanded too, and matching the whole string would always find it.
    const body = root.innerHTML.split("</header>")[1] ?? "";
    return body.includes('aria-expanded="true"');
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

describe("runElapsed", () => {
  const t0 = Date.parse("2026-08-01T12:00:00.000Z");
  const at = (offsetMs) => new Date(t0 + offsetMs).toISOString();

  test("returns null when no row has started", () => {
    expect(runElapsed([], t0)).toBeNull();
    expect(runElapsed([{ key: "a", status: "finished" }], t0)).toBeNull();
  });

  test("ticks against the clock while any row is in flight", () => {
    const rows = [
      { key: "a", status: "finished", startedAt: at(0), elapsedMs: 5_000 },
      { key: "b", status: "in-flight", startedAt: at(4_000) },
    ];

    expect(runElapsed(rows, t0 + 30_000)).toEqual({ ms: 30_000, live: true });
  });

  test("freezes at the last finish once nothing is in flight", () => {
    const rows = [
      { key: "a", status: "finished", startedAt: at(0), elapsedMs: 5_000 },
      { key: "b", status: "finished", startedAt: at(4_000), elapsedMs: 6_000 },
    ];

    expect(runElapsed(rows, t0 + 90_000)).toEqual({ ms: 10_000, live: false });
  });

  test("measures from the earliest start, whatever order rows arrive in", () => {
    const rows = [
      { key: "b", status: "in-flight", startedAt: at(9_000) },
      { key: "a", status: "in-flight", startedAt: at(1_000) },
    ];

    expect(runElapsed(rows, t0 + 11_000).ms).toBe(10_000);
  });
});

describe("fleet collapse", () => {
  const render = () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return { addEventListener() {}, className: "", innerHTML: "" };
      },
    };
    try {
      return renderFleet(
        [{ key: "a", role: "dev", ref: "ui/01", status: "in-flight" }],
        1,
        true,
        "connected",
      );
    } finally {
      globalThis.document = originalDocument;
    }
  };

  afterEach(() => {
    if (isFleetCollapsed()) toggleFleet();
  });

  test("renders expanded with a toggle that says so", () => {
    const root = render();

    expect(root.className).not.toContain("-collapsed");
    expect(root.innerHTML).toContain('class="fleet-toggle"');
    expect(root.innerHTML).toContain('aria-expanded="true"');
    expect(root.innerHTML).toContain("fleet-table");
  });

  test("drops the table but keeps the heading when collapsed", () => {
    toggleFleet();
    const root = render();

    expect(root.className).toContain("-collapsed");
    expect(root.innerHTML).toContain('aria-expanded="false"');
    expect(root.innerHTML).toContain("Agent fleet");
    expect(root.innerHTML).not.toContain("fleet-table");
  });

  test("keeps the collapsed choice across re-renders", () => {
    toggleFleet();
    render();
    const second = render();

    expect(second.className).toContain("-collapsed");
    expect(isFleetCollapsed()).toBe(true);
  });
});

describe("fleet sticky offsets", () => {
  // The column header used to stick at a hardcoded 42px, guessed from the
  // heading's rendered height. Adding a control to the heading grew it past 42
  // and the ROLE bar slid over the panel title. Both offsets must now come from
  // the same declaration, so neither can drift again.
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf-8");
  // A selector can head more than one block (`.fleet-row, .fleet-columns` and
  // `.fleet-columns` alone), so read them all, not the first one found.
  const rule = (selector) =>
    (css.match(new RegExp(`\\${selector}[,\\s][^{]*\\{[^}]*\\}`, "g")) ?? []).join(
      "\n",
    );

  test("the heading declares its own height", () => {
    expect(rule(".fleet-heading")).toContain(
      "block-size: var(--fleet-heading-height)",
    );
    expect(rule(".fleet-heading")).toContain("box-sizing: border-box");
  });

  test("the column header sticks at exactly that height", () => {
    expect(rule(".fleet-columns")).toContain(
      "inset-block-start: var(--fleet-heading-height)",
    );
    expect(rule(".fleet-columns")).not.toMatch(/inset-block-start:\s*\d+px/);
  });

  test("the heading stacks above the column header", () => {
    const layer = (selector) =>
      Number(rule(selector).match(/z-index:\s*(\d+)/)?.[1] ?? 0);

    expect(layer(".fleet-heading")).toBeGreaterThan(layer(".fleet-columns"));
  });
});

describe("gate outcome colouring", () => {
  const rowHtml = (row) => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return { addEventListener() {}, className: "", innerHTML: "" };
      },
    };
    try {
      return renderFleet([row], 1, true, "connected").innerHTML;
    } finally {
      globalThis.document = originalDocument;
    }
  };

  test("marks a rejected verifier row", () => {
    const html = rowHtml({
      key: "verify:ui/01#1",
      role: "verify",
      ref: "ui/01",
      status: "finished",
      outcome: "failed",
    });

    expect(html).toContain("-rejected");
  });

  test("leaves a passing verifier row alone", () => {
    const html = rowHtml({
      key: "verify:ui/01#1",
      role: "verify",
      ref: "ui/01",
      status: "finished",
      outcome: "passed",
    });

    expect(html).not.toContain("-rejected");
    expect(html).toContain("-finished");
  });

  test("keeps the hard-fail state distinct from a plain rejection", () => {
    const html = rowHtml({
      key: "judge:ui/01#1",
      role: "judge",
      ref: "ui/01",
      status: "finished",
      outcome: "failed",
      score: { weighted: 1.2, passed: false, hardFailed: true, breakdown: [] },
    });

    expect(html).toContain("-failed");
    expect(html).not.toContain("-rejected");
  });
});

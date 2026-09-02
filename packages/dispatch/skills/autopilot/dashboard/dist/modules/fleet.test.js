import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  elapsedByTask,
  elapsedText,
  isFleetCollapsed,
  isInFlight,
  renderFleet,
  renderMessage,
  runElapsed,
  tickElapsed,
  tickGraphElapsed,
  toggleFleet,
  toggleRubric,
} from "./fleet.js";
import { formatDuration } from "./format.js";

const expandedKeys = new Set();

/**
 * Run `fn` with a minimal `document` in place. `renderFleet` builds a real element,
 * and this file has no DOM; every render test needs the same stub, so it is written
 * once here rather than re-declared inside each describe block.
 */
function withStubDocument(fn) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { addEventListener() {}, className: "", innerHTML: "" };
    },
  };
  try {
    return fn();
  } finally {
    globalThis.document = originalDocument;
  }
}

/** The rendered markup of a single row, the shape most render tests assert on. */
const rowHtml = (row) =>
  withStubDocument(() => renderFleet([row], 1, true, "connected").innerHTML);

function isExpanded(rowKey) {
  return withStubDocument(() => {
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
  });
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
    // No end was ever logged, so there is no duration to claim.
    expect(elapsedText({ status: "abandoned", startedAt }, now)).toBe("");
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
    expect(isInFlight({ status: "abandoned" })).toBe(false);
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

  test("an expanded row shows the judge rationale beneath its meters", () => {
    const row = {
      key: "quiet-row",
      role: "judge",
      ref: "core/01",
      status: "finished",
      score: {
        breakdown: [{ name: "Correctness", score: 5, weight: 3 }],
        rationale: "Grounded in the gate: `kind.rs:68` <exit 2>.",
      },
    };

    // Collapsed, the prose stays out of the DOM entirely.
    expect(rowHtml(row)).not.toContain('<p class="rationale">');
    expand("quiet-row");
    const html = rowHtml(row);
    expect(html).toContain('<p class="rationale">');
    expect(html).toContain("&lt;exit 2&gt;");
    // The meters still lead — the prose is the supporting evidence, not the verdict.
    expect(html.indexOf("Correctness")).toBeLessThan(html.indexOf("rationale"));
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

  test("freezes when the only unfinished row was abandoned", () => {
    // Before rows could be abandoned, a dead agent's row stayed in-flight and
    // the run timer ticked forever on a run that had already stopped.
    const rows = [
      { key: "a", status: "finished", startedAt: at(0), elapsedMs: 5_000 },
      { key: "b", status: "abandoned", startedAt: at(4_000) },
    ];

    expect(runElapsed(rows, t0 + 90_000)).toEqual({ ms: 5_000, live: false });
  });

  test("measures from the earliest start, whatever order rows arrive in", () => {
    const rows = [
      { key: "b", status: "in-flight", startedAt: at(9_000) },
      { key: "a", status: "in-flight", startedAt: at(1_000) },
    ];

    expect(runElapsed(rows, t0 + 11_000).ms).toBe(10_000);
  });
});

describe("elapsedByTask", () => {
  const t0 = Date.parse("2026-08-01T12:00:00.000Z");
  const at = (offsetMs) => new Date(t0 + offsetMs).toISOString();

  test("counts concurrent agents of one task once, not once each", () => {
    // The closing review fans five lenses out at the same moment. Summing their
    // elapsed would answer how much agent time the task burned — which is what
    // the berth's token figure already says — instead of how long it took.
    const rows = ["a", "b", "c", "d", "e"].map((key) => ({
      key,
      ref: "review/01",
      status: "finished",
      startedAt: at(0),
      elapsedMs: 60_000,
    }));

    expect(elapsedByTask(rows, t0 + 90_000)["review/01"].ms).toBe(60_000);
  });

  test("keeps each task on its own clock", () => {
    const rows = [
      {
        key: "a",
        ref: "ui/01",
        status: "finished",
        startedAt: at(0),
        elapsedMs: 5_000,
      },
      {
        key: "b",
        ref: "ui/02",
        status: "finished",
        startedAt: at(20_000),
        elapsedMs: 7_000,
      },
    ];
    const elapsed = elapsedByTask(rows, t0 + 90_000);

    expect(elapsed["ui/01"].ms).toBe(5_000);
    expect(elapsed["ui/02"].ms).toBe(7_000);
  });

  test("a running task stays live and reports the start to tick from", () => {
    const rows = [
      {
        key: "a",
        ref: "ui/01",
        status: "finished",
        startedAt: at(0),
        elapsedMs: 5_000,
      },
      { key: "b", ref: "ui/01", status: "in-flight", startedAt: at(6_000) },
    ];
    const elapsed = elapsedByTask(rows, t0 + 30_000)["ui/01"];

    expect(elapsed).toEqual({ ms: 30_000, live: true, startMs: t0 });
  });

  test("skips a row with no ref or no start", () => {
    const rows = [
      { key: "a", status: "in-flight", startedAt: at(0) },
      { key: "b", ref: "ui/01", status: "finished" },
    ];

    expect(elapsedByTask(rows, t0 + 30_000)).toEqual({});
  });
});

describe("tickGraphElapsed", () => {
  test("rewrites only the berths that stamped a start", () => {
    const live = { dataset: { elapsedSince: "1000" }, textContent: "0.0s" };
    const settled = { dataset: {}, textContent: "5.0s" };
    const root = {
      querySelectorAll: (selector) =>
        selector === "[data-elapsed-since]" ? [live] : [settled],
    };

    tickGraphElapsed(root, 46_000);

    expect(live.textContent).toBe("45.0s");
    expect(settled.textContent).toBe("5.0s");
  });

  test("does nothing without a root", () => {
    expect(() => tickGraphElapsed(null, 1_000)).not.toThrow();
  });
});

describe("fleet collapse", () => {
  // Asserts on the root element itself (className), not on markup, so it cannot
  // use `rowHtml`.
  const render = () =>
    withStubDocument(() =>
      renderFleet(
        [{ key: "a", role: "dev", ref: "ui/01", status: "in-flight" }],
        1,
        true,
        "connected",
      ),
    );

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
    (
      css.match(new RegExp(`\\${selector}[,\\s][^{]*\\{[^}]*\\}`, "g")) ?? []
    ).join("\n");

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

describe("renderMessage", () => {
  test("lifts a leading PASS into a chip and drops the dash after it", () => {
    expect(renderMessage("PASS — All verification commands succeeded")).toBe(
      '<span class="msg-verdict -pass">PASS</span>All verification commands succeeded',
    );
  });

  test("colours a FAIL chip as a failure, not as a pass", () => {
    expect(renderMessage("FAIL — nope")).toContain(
      '<span class="msg-verdict -fail">FAIL</span>',
    );
  });

  test("marks the bare identifiers agents write without backticks", () => {
    const html = renderMessage(
      "db:prepare fails with ActiveRecord::InvalidMigrationTimestampError because 20260901000100 is in the future",
    );

    expect(html).toContain("<code>db:prepare</code>");
    expect(html).toContain(
      "<code>ActiveRecord::InvalidMigrationTimestampError</code>",
    );
    expect(html).toContain("<code>20260901000100</code>");
  });

  test("marks snake_case but leaves ordinary prose alone", () => {
    const html = renderMessage(
      "the cms_kit installation is complete and green",
    );

    expect(html).toContain("<code>cms_kit</code>");
    expect(html).toContain("installation is complete and green");
    expect(html).not.toContain("<code>installation</code>");
  });

  test("does not match across the space in `shas: 32b4ea0`", () => {
    const html = renderMessage("committed shas: 32b4ea0");
    expect(html).toContain("committed shas: ");
    expect(html).toContain("<code>32b4ea0</code>");
  });

  // The reason escaping runs per token instead of once over the whole string: an
  // entity like `&#039;` contains a run the hex-sha branch would otherwise split.
  test("escapes the text and never breaks an entity apart", () => {
    const html = renderMessage("<script>alert('x')</script> & done");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<code>&");
  });

  test("renders an absent message as nothing at all", () => {
    expect(renderMessage(undefined)).toBe("");
    expect(renderMessage("")).toBe("");
  });
});

describe("Tokens under the role chip", () => {
  test("reads N/A, never 0, for a row with no matched transcript", () => {
    const html = rowHtml({
      key: "dev:ui/01#1",
      role: "dev",
      ref: "ui/01",
      status: "finished",
    });

    expect(html).toContain(
      '<span class="role-tokens" title="no transcript matched this agent">N/A</span>',
    );
  });

  test("renders fresh tokens, with the billed total and its parts in the title", () => {
    const html = rowHtml({
      key: "dev:ui/01#1",
      role: "dev",
      ref: "ui/01",
      status: "finished",
      usage: {
        input: 352,
        output: 3465,
        cacheRead: 120_000,
        cacheWrite: 8_000,
      },
    });

    expect(html).toContain(
      '<span class="role-tokens -normal" title="fresh 8000 · billed total 131817 (cache read 120000 · input 352 · output 3465)">8.0K</span>',
    );
  });

  test("carries the budget tier the fresh count falls in", () => {
    const tierOf = (cacheWrite) =>
      rowHtml({
        key: "dev:ui/01#1",
        role: "dev",
        ref: "ui/01",
        status: "finished",
        // Cache reads dwarf the fresh count and must not move the tier.
        usage: { input: 0, output: 0, cacheRead: 5_000_000, cacheWrite },
      }).match(/class="role-tokens ([^"]+)"/)[1];

    expect(tierOf(59_999)).toBe("-normal");
    expect(tierOf(60_000)).toBe("-warn");
    expect(tierOf(99_999)).toBe("-warn");
    expect(tierOf(100_000)).toBe("-danger");
  });

  test("prints the external engine's spend as its own figure, never merged in", () => {
    const html = rowHtml({
      key: "dev:ui/01#1",
      role: "dev",
      ref: "ui/01",
      status: "finished",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 35_100 },
      codexUsage: { input: 0, output: 500, cacheRead: 900, cacheWrite: 54_800 },
    });

    expect(html).toContain(">35.1K</span>");
    expect(html).toContain(">cdx 54.8K</span>");
    // Merged it would read 89.9K, which is a Claude agent that never existed.
    expect(html).not.toContain(">89.9K<");
  });

  test("tiers the codex figure on the same thresholds as the Claude one", () => {
    const tierOf = (cacheWrite) =>
      rowHtml({
        key: "dev:ui/01#1",
        role: "dev",
        ref: "ui/01",
        status: "finished",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        codexUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite },
      }).match(/class="role-tokens -codex ([^"]+)"/)[1];

    expect(tierOf(59_999)).toBe("-normal");
    expect(tierOf(60_000)).toBe("-warn");
    expect(tierOf(100_000)).toBe("-danger");
  });

  test("renders no codex figure for a row that drove no external engine", () => {
    const html = rowHtml({
      key: "dev:ui/01#1",
      role: "dev",
      ref: "ui/01",
      status: "finished",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 35_100 },
    });

    expect(html).not.toContain("-codex");
  });

  test("sits inside the role cell, not in a column of its own", () => {
    const html = rowHtml({
      key: "dev:ui/01#1",
      role: "dev",
      ref: "ui/01",
      status: "finished",
      usage: { input: 352, output: 3465, cacheRead: 0, cacheWrite: 0 },
    });

    expect(html).not.toContain("fleet-cell -tokens");
    expect(html).toContain(
      '<span class="role-badge">dev</span><span class="role-tokens',
    );
  });

  test("keeps the column header count in step with the row cell count", () => {
    const html = rowHtml({
      key: "dev:ui/01#1",
      role: "dev",
      ref: "ui/01",
      status: "finished",
    });
    const headerCount = (html.match(/role="columnheader"/g) ?? []).length;
    const cellCount = (html.match(/class="fleet-cell/g) ?? []).length;

    expect(headerCount).toBe(cellCount);
  });
});

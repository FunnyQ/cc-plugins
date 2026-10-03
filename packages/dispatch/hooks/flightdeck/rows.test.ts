import { describe, expect, test } from "bun:test";
import {
  agentLines,
  bucketBars,
  card,
  clip,
  COLOR,
  compactSummary,
  docked,
  endState,
  formatElapsed,
  GLYPH,
  inline,
  type Line,
  summary,
  waveRows,
} from "./rows.ts";
import type { DeckSnapshot, DeckState, DeckTask } from "./types.ts";

const task = (ref: string, state: DeckState, attempts = 1): DeckTask => ({
  ref,
  title: `title ${ref}`,
  state,
  attempts,
  score: null,
});

function snap(overrides: Partial<DeckSnapshot> = {}): DeckSnapshot {
  return {
    deckSource: "tasks",
    plan: "/tmp/plan",
    slug: "demo",
    planTitle: "Demo",
    counts: {
      total: 0,
      done: 0,
      inProgress: 0,
      ready: 0,
      blocked: 0,
      invalid: 0,
    },
    buckets: [],
    waves: [],
    unschedulable: [],
    currentWave: null,
    tasks: {},
    agents: [],
    errors: 0,
    ...overrides,
  };
}

const text = (line: Line) => line.map((s) => s.text).join("");
const cols = (line: Line) => text(line).length;

function tasksOf(list: DeckTask[]): Record<string, DeckTask> {
  return Object.fromEntries(list.map((t) => [t.ref, t]));
}

// 20 tasks, 3 buckets, 4 waves, 1 unschedulable, 2 in-flight agents.
function big(): DeckSnapshot {
  const states: DeckState[] = [
    "done",
    "in-progress",
    "ready",
    "blocked",
    "invalid",
  ];
  const list: DeckTask[] = [];
  const buckets = ["api", "frontend-longer-name", "db"];
  for (let i = 0; i < 20; i++) {
    const b = buckets[i % 3];
    list.push(
      task(`${b}/${String(i).padStart(2, "0")}`, states[i % 5], (i % 4) + 1),
    );
  }
  const refs = list.map((t) => t.ref);
  return snap({
    counts: {
      total: 20,
      done: 4,
      inProgress: 4,
      ready: 4,
      blocked: 4,
      invalid: 4,
    },
    buckets: [
      { name: "api", done: 2, total: 7 },
      { name: "frontend-longer-name", done: 1, total: 7 },
      { name: "db", done: 1, total: 6 },
    ],
    waves: [
      refs.slice(0, 6),
      refs.slice(6, 11),
      refs.slice(11, 16),
      refs.slice(16, 19),
    ],
    unschedulable: [refs[19]],
    currentWave: 2,
    tasks: tasksOf(list),
    agents: [
      {
        role: "dev",
        ref: refs[1],
        attempt: 2,
        label: "dev-a",
        startedAt: "2026-01-01T00:00:00Z",
      },
      {
        role: "verify",
        ref: null,
        attempt: null,
        label: "verifier-label",
        startedAt: null,
      },
    ],
    errors: 2,
  });
}

describe("card", () => {
  test("each state gets its glyph and colour; blocked is dim", () => {
    for (const state of Object.keys(GLYPH) as DeckState[]) {
      const seg = card(task("api/01", state));
      expect(seg.text).toBe(`api/01 ${GLYPH[state]}`);
      expect(seg.color).toBe(COLOR[state]);
      expect(seg.dim).toBe(state === "blocked" ? true : undefined);
      expect(seg.ref).toBe("api/01");
    }
    expect(GLYPH).toEqual({
      done: "✓",
      "in-progress": "●",
      ready: "○",
      blocked: "·",
      invalid: "✗",
    });
    expect(COLOR).toEqual({
      done: "#3fb950",
      "in-progress": "#d29922",
      ready: undefined,
      blocked: undefined,
      invalid: "#f85149",
    });
  });

  test("attempt count only above 1", () => {
    expect(card(task("api/01", "in-progress", 1)).text).toBe("api/01 ●");
    expect(card(task("api/01", "in-progress", 2)).text).toBe("api/01 ●2");
  });
});

describe("waveRows", () => {
  const six = Array.from({ length: 6 }, (_, i) =>
    task(`task-${i + 1}`, "done"),
  );

  test("wraps a wave with an indented continuation", () => {
    const s = snap({
      waves: [six.map((t) => t.ref)],
      tasks: tasksOf(six),
      currentWave: null,
    });
    expect(waveRows(s, 40).map(text)).toEqual([
      "W1 task-1 ✓  task-2 ✓  task-3 ✓",
      "   task-4 ✓  task-5 ✓  task-6 ✓",
    ]);
  });

  test("W? group holds exactly the unschedulable refs, none when empty", () => {
    const s = snap({
      waves: [["a"]],
      unschedulable: ["b", "c"],
      tasks: tasksOf([
        task("a", "done"),
        task("b", "blocked"),
        task("c", "ready"),
      ]),
    });
    expect(waveRows(s, 80).map(text)).toEqual(["W1 a ✓", "W? b ·  c ○"]);
    expect(waveRows({ ...s, unschedulable: [] }, 80).map(text)).toEqual([
      "W1 a ✓",
    ]);
  });

  test("labels pad to the longest label", () => {
    const refs = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const s = snap({
      waves: refs.map((r) => [r]),
      tasks: tasksOf(refs.map((r) => task(r, "ready"))),
    });
    const rows = waveRows(s, 80).map(text);
    expect(rows[0]).toBe("W1  t0 ○");
    expect(rows[9]).toBe("W10 t9 ○");
  });

  test("a card wider than a line goes on its own line", () => {
    const long = "x".repeat(50);
    const s = snap({
      waves: [["a", long]],
      tasks: tasksOf([task("a", "done"), task(long, "done")]),
    });
    expect(waveRows(s, 24).map(text)).toEqual(["W1 a ✓", `   ${long} ✓`]);
  });
});

describe("clip", () => {
  test("exact outputs", () => {
    expect(clip([{ text: "1234" }, { text: "x" }], 4)).toEqual([
      { text: "123…" },
    ]);
    expect(clip([{ text: "ab" }, { text: "cd" }], 3)).toEqual([
      { text: "ab…" },
    ]);
    const fits = [{ text: "ab" }, { text: "cd" }];
    expect(clip(fits, 4)).toBe(fits);
    expect(clip([{ text: "abc" }], 1)).toEqual([{ text: "…" }]);
    expect(clip([{ text: "abc" }], 0)).toEqual([]);
  });

  test("long slug and long graph ref clip to 24, card keeps ref", () => {
    const slug = clip([{ text: "s".repeat(60) }], 24);
    expect(cols(slug)).toBe(24);
    expect(text(slug).endsWith("…")).toBe(true);
    const ref = "g".repeat(50);
    const line = clip([{ text: "W1 " }, card(task(ref, "done"))], 24);
    expect(cols(line)).toBe(24);
    expect(text(line).endsWith("…")).toBe(true);
    expect(line[1].ref).toBe(ref);
    expect(line[1].color).toBe(COLOR.done);
  });
});

describe("summary / compactSummary / endState", () => {
  const stuck = () =>
    snap({
      counts: {
        total: 20,
        done: 19,
        inProgress: 0,
        ready: 0,
        blocked: 1,
        invalid: 0,
      },
      unschedulable: ["x/01"],
      tasks: tasksOf([task("x/01", "blocked")]),
      currentWave: null,
      errors: 2,
    });

  test("stuck fixture, stale with errors", () => {
    const s = stuck();
    expect(endState(s)).toBe("stuck");
    const [l1, l2] = summary(s, true);
    expect(text(l1)).toBe("19/20 done · stuck · 1 unschedulable");
    expect(l1[1].color).toBe("#f85149");
    expect(text(l2)).toBe("stale · 2 errors · ●0 ○0 ·1 ✗0");
    expect(l2.find((g) => g.text === "✗0")?.color).toBeUndefined();
    expect(text(compactSummary(s, true))).toBe(
      "stale · 2 errors · 19/20 · stuck · demo",
    );
    expect(cols(compactSummary(s, true))).toBe(39);
  });

  test("no stale, no errors", () => {
    const s = { ...stuck(), errors: 0 };
    const all = [...summary(s, false), compactSummary(s, false)]
      .map(text)
      .join("\n");
    expect(all).not.toContain("stale");
    expect(all).not.toContain("errors");
    expect(text(compactSummary(s, false))).toBe("19/20 · stuck · demo");
  });

  test("wave and done states", () => {
    const s = snap({
      counts: { ...big().counts },
      waves: [[], [], []],
      currentWave: 2,
    });
    expect(text(summary(s, false)[0])).toBe("4/20 done · wave 2 of 3");
    expect(text(compactSummary(s, false))).toBe("4/20 · W2/3 · demo");
    const done = snap({
      counts: {
        total: 2,
        done: 2,
        inProgress: 0,
        ready: 0,
        blocked: 0,
        invalid: 0,
      },
      unschedulable: ["a"],
      tasks: tasksOf([task("a", "done")]),
    });
    expect(endState(done)).toBe("done");
    expect(text(summary(done, false)[0])).toBe("2/2 done · all done");
    expect(text(compactSummary(done, false))).toBe("2/2 · all done · demo");
  });

  test("red invalid pair only when invalid > 0", () => {
    const s = snap({
      counts: {
        total: 1,
        done: 0,
        inProgress: 0,
        ready: 0,
        blocked: 0,
        invalid: 1,
      },
    });
    expect(summary(s, false)[1].find((g) => g.text === "✗1")?.color).toBe(
      "#f85149",
    );
  });
});

describe("bucketBars", () => {
  test("bars fill the remaining width", () => {
    const s = snap({
      buckets: [
        { name: "api", done: 1, total: 2 },
        { name: "web-ui", done: 0, total: 0 },
      ],
    });
    const [a, b] = bucketBars(s, 20);
    expect(text(a)).toBe("api    █████░░░░ 1/2");
    expect(cols(a)).toBe(20);
    expect(a[1].color).toBe("#3fb950");
    expect(text(b)).toBe("web-ui ░░░░░░░░░ 0/0");
  });

  test("bar never below 1 cell", () => {
    const s = snap({
      buckets: [{ name: "a-very-long-bucket", done: 1, total: 1 }],
    });
    expect(text(bucketBars(s, 5)[0])).toBe("a-very-long-bucket █ 1/1");
  });
});

describe("formatElapsed / agentLines", () => {
  test("boundaries", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(192_999)).toBe("3m12s");
    expect(formatElapsed(3_600_000)).toBe("1h00m");
    expect(formatElapsed(3_840_000)).toBe("1h04m");
    expect(formatElapsed(-5_000)).toBe("0s");
  });

  test("layout with ref/attempt and with label/null start", () => {
    const now = Date.parse("2026-01-01T00:03:12Z");
    expect(agentLines(big(), now).map(text)).toEqual([
      "dev    frontend-longer-name/01 #2  3m12s",
      "verify verifier-label  —",
    ]);
  });
});

describe("docked", () => {
  test("no line exceeds width at 24/40/80", () => {
    const s = big();
    for (const w of [24, 40, 80]) {
      for (const line of docked(
        s,
        w,
        Date.parse("2026-01-01T01:00:00Z"),
        true,
      )) {
        expect(cols(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  test("order: summary, bars, blank, waves, blank, agents", () => {
    const s = big();
    const lines = docked(s, 80, Date.parse("2026-01-01T00:00:00Z"), false);
    const waves = waveRows(s, 80).length;
    expect(lines.length).toBe(2 + 3 + 1 + waves + 1 + 2);
    expect(lines[5]).toEqual([]);
    expect(lines[6 + waves]).toEqual([]);
    expect(docked({ ...s, agents: [] }, 80, 0, false).length).toBe(
      2 + 3 + 1 + waves,
    );
  });
});

describe("inline", () => {
  const two = snap({
    counts: {
      total: 2,
      done: 1,
      inProgress: 0,
      ready: 1,
      blocked: 0,
      invalid: 0,
    },
    waves: [["task-1", "task-2"]],
    currentWave: 1,
    tasks: tasksOf([task("task-1", "done"), task("task-2", "ready")]),
  });

  test("line 2 exact outputs", () => {
    const at = (w: number) => text(inline(two, w, false)[1]);
    expect(inline(two, 40, false).length).toBe(2);
    expect(at(40)).toBe("W1 task-1 ✓  task-2 ○");
    expect(at(13)).toBe("W1 task-1 ✓ …");
    expect(at(2)).toBe("W…");
    expect(at(1)).toBe("…");
    expect(inline(two, 0, false)[1]).toEqual([]);
  });

  test("all done even with a done cycle in unschedulable", () => {
    const s = snap({
      counts: {
        total: 2,
        done: 2,
        inProgress: 0,
        ready: 0,
        blocked: 0,
        invalid: 0,
      },
      unschedulable: ["a", "b"],
      tasks: tasksOf([task("a", "done"), task("b", "done")]),
    });
    expect(inline(s, 40, false).map(text)).toEqual([
      "2/2 · all done · demo",
      "all done",
    ]);
  });

  test("stuck shows W? and only the not-done unschedulable cards", () => {
    const s = snap({
      counts: {
        total: 3,
        done: 2,
        inProgress: 0,
        ready: 0,
        blocked: 1,
        invalid: 0,
      },
      waves: [["a"]],
      unschedulable: ["b", "c"],
      tasks: tasksOf([
        task("a", "done"),
        task("b", "done"),
        task("c", "blocked"),
      ]),
    });
    expect(text(inline(s, 40, false)[1])).toBe("W? c ·");
  });
});

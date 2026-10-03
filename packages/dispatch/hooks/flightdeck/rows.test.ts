import { describe, expect, test } from "bun:test";
import {
  crewLines,
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
  waveCards,
} from "./rows.ts";
import type { DeckSnapshot, DeckState, DeckTask } from "./types.ts";

const task = (ref: string, state: DeckState, attempts = 1): DeckTask => ({
  ref,
  title: `title ${ref}`,
  state,
  attempts,
  score: null,
  time: null,
  tokens: null,
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
    crew: [],
    time: null,
    tokens: null,
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

describe("waveCards", () => {
  const six = Array.from({ length: 6 }, (_, i) =>
    task(`task-${i + 1}`, "done"),
  );

  test("one group per wave, each card carries glyph, ref, title and meta", () => {
    const s = snap({
      waves: [["a", "b"]],
      tasks: tasksOf([
        { ...task("a", "done"), score: { weighted: 4.56, threshold: 4, passed: true } },
        task("b", "in-progress", 2),
      ]),
    });
    const [g] = waveCards(s, 80, 0).groups;
    expect(g.label).toBe("W1 ");
    expect(g.cards.map((c) => [c.head, c.sub])).toEqual([
      ["✓ a", "title a       4.6"],
      ["● b", "title b        a2"],
    ]);
    expect(g.cards[0].color).toBe(COLOR.done);
    expect(g.cards[1].color).toBe(COLOR["in-progress"]);
  });

  test("every card in a snapshot shares one inner width, 4 columns past its longest ref", () => {
    const wide = snap({ waves: [["api/very-long-ref-01"]], tasks: tasksOf([task("api/very-long-ref-01", "ready")]) });
    expect(waveCards(wide, 80, 0).inner).toBe("api/very-long-ref-01".length + 6);
    const s = snap({ waves: [six.map((t) => t.ref)], tasks: tasksOf(six) });
    const { inner, groups } = waveCards(s, 80, 0);
    expect(inner).toBe(17);
    for (const c of groups[0].cards) {
      expect(c.head.length).toBeLessThanOrEqual(inner);
      expect(c.sub.length).toBe(inner);
    }
  });

  test("a long title clips to the card, and the card never outgrows the pane", () => {
    const long = "x".repeat(50);
    const s = snap({
      waves: [[long]],
      tasks: tasksOf([{ ...task(long, "blocked"), title: "y".repeat(80) }]),
    });
    const { inner, groups } = waveCards(s, 24, 0);
    expect(inner).toBe(24 - 3 - 2);
    expect(groups[0].cards[0].head).toBe(`· ${"x".repeat(inner - 3)}…`);
    expect(groups[0].cards[0].sub).toBe(`${"y".repeat(inner - 1)}…`);
    expect(groups[0].cards[0].dim).toBe(true);
  });

  test("time sits right on the first line; tokens sit bottom-right once done", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    const s = snap({
      waves: [["a", "b", "c"]],
      tasks: tasksOf([
        { ...task("a", "done"), time: { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:03:12Z" }, tokens: 1_234_567 },
        { ...task("b", "in-progress"), time: { startedAt: "2026-01-01T00:09:15Z", endedAt: null } },
        task("c", "ready"),
      ]),
    });
    const { inner, groups } = waveCards(s, 80, now);
    const [a, b, c] = groups[0].cards;
    expect([a.head, a.time, a.tokens]).toEqual(["✓ a", "3m12s", "1.2M tok".padStart(inner)]);
    expect([b.time, b.tokens]).toEqual(["45s", null]);
    expect([c.time, c.tokens]).toEqual([null, null]);
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
    const refs = (x: DeckSnapshot) =>
      waveCards(x, 80, 0).groups.map((g) => [g.label, g.cards.map((c) => c.ref)]);
    expect(refs(s)).toEqual([
      ["W1 ", ["a"]],
      ["W? ", ["b", "c"]],
    ]);
    expect(refs({ ...s, unschedulable: [] })).toEqual([["W1 ", ["a"]]]);
  });

  test("labels pad to the longest label", () => {
    const refs = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const s = snap({
      waves: refs.map((r) => [r]),
      tasks: tasksOf(refs.map((r) => task(r, "ready"))),
    });
    const groups = waveCards(s, 80, 0).groups;
    expect(groups[0].label).toBe("W1  ");
    expect(groups[9].label).toBe("W10 ");
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
    const [l1, l2, , l3] = summary(s, true, 40, 0);
    expect(text(l1)).toBe(`demo ${"─".repeat(11)} stuck · 1 unschedulable`);
    expect(l1.at(-1)!.color).toBe("#f85149");
    expect(text(l2)).toBe(`${"━".repeat(34)} 19/20`);
    expect(l2[0]).toMatchObject({ text: "━".repeat(32), color: COLOR.done });
    expect(l2[1]).toMatchObject({ text: "━━", dim: true });
    expect(text(l3)).toBe("stale · 2 errors · ● 0 running  ○ 0 ready  · 1 waiting  ✗ 0");
    expect(l3.find((g) => g.text === "✗ 0")?.color).toBeUndefined();
    expect(text(compactSummary(s, true))).toBe(
      "stale · 2 errors · 19/20 · stuck · demo",
    );
    expect(cols(compactSummary(s, true))).toBe(39);
  });

  test("no stale, no errors", () => {
    const s = { ...stuck(), errors: 0 };
    const all = [...summary(s, false, 40, 0), compactSummary(s, false)]
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
    expect(text(summary(s, false, 30, 0)[0])).toBe(`demo ${"─".repeat(16)} wave 2/3`);
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
    expect(text(summary(done, false, 20, 0)[0])).toBe(`demo ${"─".repeat(6)} all done`);
    expect(text(compactSummary(done, false))).toBe("2/2 · all done · demo");
  });

  test("the title's rule is the one fill segment; the run's wall time and tokens sit under the progress bar", () => {
    const now = Date.parse("2026-01-01T00:04:12Z");
    const s = snap({
      counts: { ...big().counts },
      waves: [[], [], []],
      currentWave: 2,
      time: { startedAt: "2026-01-01T00:00:00Z", endedAt: null },
    });
    const [title, , totals] = summary(s, false, 40, now);
    expect(title.filter((g) => g.fill)).toEqual([expect.objectContaining({ dim: true })]);
    expect(text(title).endsWith(" wave 2/3")).toBe(true);
    expect(cols(title)).toBe(40);
    expect(text(totals).trim()).toBe("4m12s");
    expect(totals[0]).toMatchObject({ fill: true });
    const ended = { ...s, time: { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:05Z" }, tokens: 12_345_678 };
    expect(text(summary(ended, false, 40, now)[2]).trim()).toBe("1m05s · 12.3M tok");
    expect(summary({ ...s, time: null }, false, 40, now)[2]).toEqual([]);
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
    expect(summary(s, false, 40, 0)[3].find((g) => g.text === "✗ 1")?.color).toBe(
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
    expect(text(a)).toBe("api    ━━━━━━━━━ 1/2");
    expect(cols(a)).toBe(20);
    expect(a[1]).toMatchObject({ text: "━━━━━", color: "#3fb950" });
    expect(a[2]).toMatchObject({ text: "━━━━", dim: true });
    expect(text(b)).toBe("web-ui ━━━━━━━━━ 0/0");
  });

  test("bar never below 1 cell", () => {
    const s = snap({
      buckets: [{ name: "a-very-long-bucket", done: 1, total: 1 }],
    });
    expect(text(bucketBars(s, 5)[0])).toBe("a-very-long-bucket ━ 1/1");
  });
});

describe("formatElapsed / agent rows", () => {
  test("boundaries", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(192_999)).toBe("3m12s");
    expect(formatElapsed(3_600_000)).toBe("1h00m");
    expect(formatElapsed(3_840_000)).toBe("1h04m");
    expect(formatElapsed(-5_000)).toBe("0s");
  });

  test("an agent on a task rides that task's card, one line each", () => {
    const now = Date.parse("2026-01-01T00:03:12Z");
    const s = big();
    const { inner, groups } = waveCards(s, 80, now);
    const host = groups[0].cards.find((c) => c.ref === s.agents[0].ref)!;
    expect(host.agents).toEqual([`${"dev #2".padEnd(inner - 6)} 3m12s`]);
    expect(groups[0].cards.filter((c) => c.agents.length > 0)).toHaveLength(1);
  });

  test("crew rows: in-flight amber with live elapsed, finished dim with its duration", () => {
    const now = Date.parse("2026-01-01T00:00:03Z");
    const s = snap({
      crew: [
        { role: "scout", label: "scout-wave-2", status: "in-flight", startedAt: "2026-01-01T00:00:00Z", elapsedMs: null },
        { role: "commit", label: "commit-wave-2", status: "finished", startedAt: null, elapsedMs: 12_000 },
        { role: "scout", label: "scout-wave-1", status: "abandoned", startedAt: null, elapsedMs: null },
      ],
    });
    const lines = crewLines(s, now);
    expect(lines.map(text)).toEqual([
      "● scout  scout-wave-2   3s",
      "✓ commit commit-wave-2  12s",
      "✗ scout  scout-wave-1   —",
    ]);
    expect(lines[0][0].color).toBe(COLOR["in-progress"]);
    expect(lines[1][0].dim).toBe(true);
  });
});

describe("docked", () => {
  test("no text line exceeds width at 24/40/80", () => {
    const s = big();
    for (const w of [24, 40, 80]) {
      const d = docked(s, w, Date.parse("2026-01-01T01:00:00Z"), true);
      for (const line of [...d.head, ...d.bars, d.states, ...d.crew])
        expect(cols(line)).toBeLessThanOrEqual(w);
      expect(d.cards.inner + 2 + d.cards.groups[0].label.length).toBeLessThanOrEqual(w);
    }
  });

  test("top is summary then bars; agents only when some are in flight", () => {
    const s = big();
    const d = docked(s, 80, Date.parse("2026-01-01T00:00:00Z"), false);
    expect(d.head).toHaveLength(2);
    expect(d.bars).toHaveLength(3);
    expect(text(d.states)).toContain("running");
    expect(d.cards.groups).toHaveLength(5);
    expect(d.crew).toEqual([]);
    const withCrew = { ...s, crew: [{ role: "scout", label: "s", status: "finished" as const, startedAt: null, elapsedMs: 1000 }] };
    expect(docked(withCrew, 80, 0, false).crew).toHaveLength(1);
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

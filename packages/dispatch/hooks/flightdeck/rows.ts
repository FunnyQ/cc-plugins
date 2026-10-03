import type { DeckAgent, DeckCrew, DeckSnapshot, DeckState, DeckTask } from "./types.ts";

// Width is text.length: every glyph used here (✓ ● ○ · ✗ █ ░ … —) is one BMP code unit drawn one column wide.

// `ref` is set only on card segments; the mod makes those pressable
export type Seg = { text: string; color?: string; dim?: boolean; ref?: string };
export type Line = Seg[];

export const GLYPH: Record<DeckState, string> = {
  done: "✓",
  "in-progress": "●",
  ready: "○",
  blocked: "·",
  invalid: "✗",
};

export const COLOR: Record<DeckState, string | undefined> = {
  done: "#3fb950",
  "in-progress": "#d29922",
  ready: undefined,
  blocked: undefined,
  invalid: "#f85149",
};

const SEP = " · ";

const width = (line: Line) => line.reduce((n, seg) => n + seg.text.length, 0);

const styled = (state: DeckState, text: string): Seg => ({
  text,
  ...(COLOR[state] && { color: COLOR[state] }),
  ...(state === "blocked" && { dim: true }),
});

export function card(task: DeckTask): Seg {
  const attempts = task.attempts > 1 ? String(task.attempts) : "";
  return {
    ...styled(task.state, `${task.ref} ${GLYPH[task.state]}${attempts}`),
    ref: task.ref,
  };
}

export function endState(s: DeckSnapshot): "wave" | "done" | "stuck" {
  if (s.currentWave !== null) return "wave";
  return s.counts.done === s.counts.total ? "done" : "stuck";
}

function stuckRefs(s: DeckSnapshot): string[] {
  return s.unschedulable.filter((ref) => s.tasks[ref]?.state !== "done");
}

function diagnostics(s: DeckSnapshot, stale: boolean): Line {
  const line: Line = [];
  if (stale) line.push({ text: "stale", dim: true }, { text: SEP });
  if (s.errors > 0)
    line.push(
      { text: `${s.errors} errors`, color: COLOR.invalid },
      { text: SEP },
    );
  return line;
}

const BAR = "━";

// a bar of `cells` heavy-rule cells: the done share green, the rest dim
function bar(done: number, total: number, cells: number): Line {
  const filled = total > 0 ? Math.round((done / total) * cells) : 0;
  const line: Line = [];
  if (filled > 0) line.push({ text: BAR.repeat(filled), color: COLOR.done });
  if (cells - filled > 0) line.push({ text: BAR.repeat(cells - filled), dim: true });
  return line;
}

// the web header's pair: the run's wall time and its token rollup; null before any agent started
export function runTotals(s: DeckSnapshot, now: number): { time: string; tokens: string | null } | null {
  if (!s.time) return null;
  const end = s.time.endedAt === null ? now : Date.parse(s.time.endedAt);
  return {
    time: formatElapsed(end - Date.parse(s.time.startedAt)),
    tokens: s.tokens === null ? null : `${formatTokens(s.tokens)} tok`,
  };
}

export function summary(s: DeckSnapshot, stale: boolean): Line[] {
  const state = endState(s);
  const wave: Line = [
    state === "wave"
      ? { text: `wave ${s.currentWave}/${s.waves.length}` }
      : state === "done"
        ? { text: "all done" }
        : { text: `stuck · ${stuckRefs(s).length} unschedulable`, color: COLOR.invalid },
  ];

  const c = s.counts;
  const pair = (state: DeckState, n: number, word: string): Seg => {
    const text = `${GLYPH[state]} ${n}${word ? ` ${word}` : ""}`;
    return state === "invalid" && n === 0 ? { text } : styled(state, text);
  };
  const states: Line = [
    ...diagnostics(s, stale),
    pair("in-progress", c.inProgress, "running"),
    { text: "  " },
    pair("ready", c.ready, "ready"),
    { text: "  " },
    pair("blocked", c.blocked, "waiting"),
    { text: "  " },
    pair("invalid", c.invalid, ""),
  ];
  return [wave, states];
}

export function compactSummary(s: DeckSnapshot, stale: boolean): Line {
  const line: Line = [
    ...diagnostics(s, stale),
    { text: `${s.counts.done}/${s.counts.total}${SEP}` },
  ];
  const state = endState(s);
  if (state === "wave")
    line.push({ text: `W${s.currentWave}/${s.waves.length}` });
  else if (state === "done") line.push({ text: "all done" });
  else line.push({ text: "stuck", color: COLOR.invalid });
  line.push({ text: `${SEP}${s.slug}` });
  return line;
}

export function bucketBars(s: DeckSnapshot, w: number): Line[] {
  const nameW = Math.max(0, ...s.buckets.map((b) => b.name.length));
  return s.buckets.map((b) => {
    const count = `${b.done}/${b.total}`;
    const barW = Math.max(1, w - nameW - 2 - count.length);
    return [
      { text: `${b.name.padEnd(nameW)} ` },
      ...bar(b.done, b.total, barW),
      { text: ` ${count}` },
    ];
  });
}

// a card's inner width never drops below "Final review" plus a score and some slack, so short refs still show their title
const MIN_INNER = 17;
// columns past glyph + space + the longest ref, so the title line has room beside its score
const SLACK = 4;

export type CardModel = {
  ref: string;
  head: string; // glyph + ref
  sub: string; // title, then attempts/score right-aligned, padded to the inner width
  time: string | null; // time spent, right of the head; null before any agent started
  tokens: string | null; // billed tokens right-aligned to the inner width, done tasks only
  agents: string[]; // one line per in-flight agent on this task: role, attempt, elapsed
  color?: string;
  dim?: boolean;
};
export type WaveCards = {
  inner: number; // every card's width inside its border
  groups: { label: string; cards: CardModel[] }[];
};

const fit = (text: string, w: number) =>
  text.length <= w ? text : `${text.slice(0, Math.max(0, w - 1))}…`;

const elapsedOf = (a: DeckAgent, now: number) =>
  a.startedAt === null ? "—" : formatElapsed(now - Date.parse(a.startedAt));

// the label or text on the left, `right` flush to the inner width
const spread = (left: string, right: string, inner: number) => {
  const leftW = Math.max(0, inner - right.length - 1);
  return `${fit(left, leftW).padEnd(leftW)} ${right}`.slice(0, inner);
};

// the web fleet's token format, so the two views print one number the same way
export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.trunc(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function timeOf(t: DeckTask, now: number): string | null {
  if (!t.time) return null;
  const end = t.time.endedAt === null ? now : Date.parse(t.time.endedAt);
  return formatElapsed(end - Date.parse(t.time.startedAt));
}

export function waveCards(s: DeckSnapshot, w: number, now: number): WaveCards {
  const groups = s.waves.map((refs, i) => ({ label: `W${i + 1}`, refs }));
  if (s.unschedulable.length > 0)
    groups.push({ label: "W?", refs: s.unschedulable });
  const labelW = Math.max(0, ...groups.map((g) => g.label.length)) + 1;
  const longest = Math.max(0, ...groups.flatMap((g) => g.refs.map((r) => r.length)));
  const inner = Math.max(1, Math.min(Math.max(MIN_INNER, longest + 2 + SLACK), w - labelW - 2));

  const model = (t: DeckTask): CardModel => {
    const meta = [
      t.score ? t.score.weighted.toFixed(1) : "",
      t.attempts > 1 ? `a${t.attempts}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const { color, dim } = styled(t.state, "");
    const time = timeOf(t, now);
    return {
      ref: t.ref,
      head: fit(`${GLYPH[t.state]} ${t.ref}`, time ? inner - time.length - 1 : inner),
      time,
      tokens: t.tokens === null ? null : `${formatTokens(t.tokens)} tok`.padStart(inner),
      sub: meta ? spread(t.title, meta, inner) : fit(t.title, inner).padEnd(inner),
      agents: s.agents
        .filter((a) => a.ref === t.ref)
        .map((a) =>
          spread(`${a.role}${a.attempt === null ? "" : ` #${a.attempt}`}`, elapsedOf(a, now), inner),
        ),
      ...(color && { color }),
      ...(dim && { dim }),
    };
  };
  return {
    inner,
    groups: groups.map((g) => ({
      label: g.label.padEnd(labelW),
      cards: g.refs.map((ref) => model(s.tasks[ref]!)),
    })),
  };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const CREW_GLYPH = { "in-flight": GLYPH["in-progress"], finished: GLYPH.done, abandoned: GLYPH.invalid };

export function crewLines(s: DeckSnapshot, now: number): Line[] {
  const roleW = Math.max(0, ...s.crew.map((c) => c.role.length));
  const labelW = Math.max(0, ...s.crew.map((c) => c.label.length));
  return s.crew.map((c: DeckCrew) => {
    const elapsed =
      c.status === "in-flight"
        ? c.startedAt === null ? "—" : formatElapsed(now - Date.parse(c.startedAt))
        : c.elapsedMs === null ? "—" : formatElapsed(c.elapsedMs);
    const text = `${CREW_GLYPH[c.status]} ${c.role.padEnd(roleW)} ${c.label.padEnd(labelW)}  ${elapsed}`;
    return [c.status === "in-flight" ? { text, color: COLOR["in-progress"] } : { text, dim: true }];
  });
}

export function clip(line: Line, w: number): Line {
  if (width(line) <= w) return line;
  if (w < 1) return [];
  if (w === 1) return [{ ...line[0], text: "…" }];
  const out: Line = [];
  let left = w - 1;
  for (const seg of line) {
    if (left === 0) break;
    const text = seg.text.slice(0, left);
    left -= text.length;
    if (text.length > 0) out.push({ ...seg, text });
  }
  const last = out[out.length - 1];
  last.text += "…";
  return out;
}

export function docked(
  s: DeckSnapshot,
  w: number,
  now: number,
  stale: boolean,
): {
  title: string;
  totals: ReturnType<typeof runTotals>;
  bars: Line[];
  wave: Line;
  states: Line;
  cards: WaveCards;
  crew: Line[];
} {
  const [wave, states] = summary(s, stale);
  return {
    title: s.slug,
    wave: clip(wave, w),
    totals: runTotals(s, now),
    bars: bucketBars(s, w).map((l) => clip(l, w)),
    states: clip(states, w),
    cards: waveCards(s, w, now),
    // the crew box spends two columns on its border
    crew: crewLines(s, now).map((l) => clip(l, w - 2)),
  };
}

export function inline(s: DeckSnapshot, w: number, stale: boolean): Line[] {
  const state = endState(s);
  let second: Line;
  if (state === "done") second = [{ text: "all done" }];
  else {
    const label = state === "wave" ? `W${s.currentWave} ` : "W? ";
    const refs =
      state === "wave"
        ? (s.waves[(s.currentWave as number) - 1] ?? [])
        : stuckRefs(s);
    second = [{ text: label }];
    refs.forEach((ref, i) => {
      if (i > 0) second.push({ text: "  " });
      second.push(card(s.tasks[ref]!));
    });
  }
  return [clip(compactSummary(s, stale), w), clip(second, w)];
}

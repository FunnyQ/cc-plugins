import type { DeckAgent, DeckSnapshot, DeckState, DeckTask } from "./types.ts";

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

export function summary(s: DeckSnapshot, stale: boolean): Line[] {
  const first: Line = [
    { text: `${s.counts.done}/${s.counts.total} done${SEP}` },
  ];
  const state = endState(s);
  if (state === "wave")
    first.push({ text: `wave ${s.currentWave} of ${s.waves.length}` });
  else if (state === "done") first.push({ text: "all done" });
  else
    first.push({
      text: `stuck · ${stuckRefs(s).length} unschedulable`,
      color: COLOR.invalid,
    });

  const c = s.counts;
  const pair = (state: DeckState, n: number): Seg =>
    state === "invalid" && n === 0
      ? { text: `${GLYPH[state]}${n}` }
      : styled(state, `${GLYPH[state]}${n}`);
  const second: Line = [
    ...diagnostics(s, stale),
    pair("in-progress", c.inProgress),
    { text: " " },
    pair("ready", c.ready),
    { text: " " },
    pair("blocked", c.blocked),
    { text: " " },
    pair("invalid", c.invalid),
  ];
  return [first, second];
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
    const filled = b.total > 0 ? Math.round((b.done / b.total) * barW) : 0;
    const line: Line = [{ text: `${b.name.padEnd(nameW)} ` }];
    if (filled > 0) line.push({ text: "█".repeat(filled), color: COLOR.done });
    if (barW - filled > 0) line.push({ text: "░".repeat(barW - filled) });
    line.push({ text: ` ${count}` });
    return line;
  });
}

// a card's inner width never drops below "Final review" plus a score, so short refs still show their title
const MIN_INNER = 13;

export type CardModel = {
  ref: string;
  head: string; // glyph + ref
  sub: string; // title, then attempts/score right-aligned, padded to the inner width
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

export function waveCards(s: DeckSnapshot, w: number, now: number): WaveCards {
  const groups = s.waves.map((refs, i) => ({ label: `W${i + 1}`, refs }));
  if (s.unschedulable.length > 0)
    groups.push({ label: "W?", refs: s.unschedulable });
  const labelW = Math.max(0, ...groups.map((g) => g.label.length)) + 1;
  const longest = Math.max(0, ...groups.flatMap((g) => g.refs.map((r) => r.length)));
  const inner = Math.max(1, Math.min(Math.max(MIN_INNER, longest + 2), w - labelW - 2));

  const model = (t: DeckTask): CardModel => {
    const meta = [
      t.score ? t.score.weighted.toFixed(1) : "",
      t.attempts > 1 ? `a${t.attempts}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const { color, dim } = styled(t.state, "");
    return {
      ref: t.ref,
      head: fit(`${GLYPH[t.state]} ${t.ref}`, inner),
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

// agents with no task in the grid have no card to ride, so they keep a line under it
export function agentLines(s: DeckSnapshot, now: number): Line[] {
  const loose = s.agents.filter((a) => a.ref === null || !s.tasks[a.ref]);
  const roleW = Math.max(0, ...loose.map((a) => a.role.length));
  return loose.map((a) => {
    const who = a.ref ?? a.label;
    const attempt = a.attempt === null ? "" : ` #${a.attempt}`;
    return [{ text: `${a.role.padEnd(roleW)} ${who}${attempt}  ${elapsedOf(a, now)}` }];
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
): { top: Line[]; cards: WaveCards; agents: Line[] } {
  return {
    top: [...summary(s, stale), ...bucketBars(s, w)].map((l) => clip(l, w)),
    cards: waveCards(s, w, now),
    // the taskless agents' box spends two columns on its border
    agents: agentLines(s, now).map((l) => clip(l, w - 2)),
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

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

const RED = "#f85149";
const SEP = " · ";

const width = (line: Line) => line.reduce((n, seg) => n + seg.text.length, 0);

export function card(task: DeckTask): Seg {
  const attempts = task.attempts > 1 ? String(task.attempts) : "";
  const seg: Seg = {
    text: `${task.ref} ${GLYPH[task.state]}${attempts}`,
    ref: task.ref,
  };
  const color = COLOR[task.state];
  if (color) seg.color = color;
  if (task.state === "blocked") seg.dim = true;
  return seg;
}

function cardFor(s: DeckSnapshot, ref: string): Seg {
  const task = s.tasks[ref];
  return task ? card(task) : { text: `${ref} ?`, dim: true };
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
    line.push({ text: `${s.errors} errors`, color: RED }, { text: SEP });
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
      color: RED,
    });

  const c = s.counts;
  const pair = (state: DeckState, n: number): Seg => {
    const seg: Seg = { text: `${GLYPH[state]}${n}` };
    const color = state === "invalid" && n === 0 ? undefined : COLOR[state];
    if (color) seg.color = color;
    if (state === "blocked") seg.dim = true;
    return seg;
  };
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
  else line.push({ text: "stuck", color: RED });
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

export function waveRows(s: DeckSnapshot, w: number): Line[] {
  const groups = s.waves.map((refs, i) => ({ label: `W${i + 1}`, refs }));
  if (s.unschedulable.length > 0)
    groups.push({ label: "W?", refs: s.unschedulable });
  const labelW = Math.max(0, ...groups.map((g) => g.label.length));
  const indent = " ".repeat(labelW + 1);

  const lines: Line[] = [];
  for (const g of groups) {
    let line: Line = [{ text: `${g.label.padEnd(labelW)} ` }];
    let used = labelW + 1;
    let empty = true;
    for (const ref of g.refs) {
      const seg = cardFor(s, ref);
      if (!empty && used + 2 + seg.text.length > w) {
        lines.push(line);
        line = [{ text: indent }];
        used = indent.length;
        empty = true;
      }
      if (!empty) {
        line.push({ text: "  " });
        used += 2;
      }
      line.push(seg);
      used += seg.text.length;
      empty = false;
    }
    lines.push(line);
  }
  return lines;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function agentLines(s: DeckSnapshot, now: number): Line[] {
  const roleW = Math.max(0, ...s.agents.map((a) => a.role.length));
  return s.agents.map((a: DeckAgent) => {
    const who = a.ref ?? a.label;
    const attempt = a.attempt === null ? "" : ` #${a.attempt}`;
    const elapsed =
      a.startedAt === null ? "—" : formatElapsed(now - Date.parse(a.startedAt));
    return [{ text: `${a.role.padEnd(roleW)} ${who}${attempt}  ${elapsed}` }];
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
): Line[] {
  const lines = [
    ...summary(s, stale),
    ...bucketBars(s, w),
    [],
    ...waveRows(s, w),
  ];
  if (s.agents.length > 0) lines.push([], ...agentLines(s, now));
  return lines.map((line) => clip(line, w));
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
      second.push(cardFor(s, ref));
    });
  }
  return [clip(compactSummary(s, stale), w), clip(second, w)];
}

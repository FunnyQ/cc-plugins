// the minimap's rows, read from the session transcript, and how they pack into the pane's lines

export type Row = { id: string; kind: string; size: number };
export type Line = {
  target: string;
  isHere: boolean;
  segments: { kind: string; cells: number }[];
};

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};
type Entry = {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: Block[] | string };
};

// a tool row takes its runes bubble's colour; any other tool is `tool`
const TOOL_KIND: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Agent: "agent",
  Skill: "skill",
};

const rowsOfLine = (raw: string): Row[] => {
  const rows: Row[] = [];
  if (!raw) return rows;
  let e: Entry;
  try {
    e = JSON.parse(raw);
  } catch {
    return rows;
  }
  if (e.isSidechain || e.isMeta || !e.uuid) return rows;
  const content = e.message?.content;
  // a string starting with `<` is a slash command or a notice, not something the person typed
  if (
    e.type === "user" &&
    typeof content === "string" &&
    !content.startsWith("<")
  )
    rows.push({ id: e.uuid, kind: "prompt", size: content.length });
  if (e.type === "assistant" && Array.isArray(content))
    for (const b of content) {
      if (b.type === "text" && b.text?.trim())
        rows.push({ id: e.uuid, kind: "reply", size: b.text.length });
      if (b.type === "tool_use" && b.id)
        rows.push({
          id: b.id,
          kind: TOOL_KIND[b.name ?? ""] ?? "tool",
          size: JSON.stringify(b.input ?? {}).length,
        });
    }
  return rows;
};

export const rowsOf = (jsonl: string): Row[] =>
  jsonl.split("\n").flatMap(rowsOfLine);

// the same rows read one line at a time, so memory stays near one line rather than 5x the file
export const rowsOfStream = async (
  texts: AsyncIterable<string>,
): Promise<Row[]> => {
  const rows: Row[] = [];
  let tail = "";
  for await (const text of texts) {
    const lines = (tail + text).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) rows.push(...rowsOfLine(line));
  }
  rows.push(...rowsOfLine(tail));
  return rows;
};

// an assistant row's requestId is its uuid with the last group zeroed (…-b80d-000000000000), so ids match on the rest
export const stem = (id: string) => id.slice(0, 23);

// each line is one bucket of consecutive rows, so the whole session fits `height` lines without scrolling
export const lines = (
  rows: Row[],
  onScreen: Set<string>,
  height: number,
  bar: number,
): Line[] => {
  if (!rows.length) return [];
  const per = Math.ceil(
    rows.length / Math.max(1, Math.min(rows.length, height)),
  );
  const out: Line[] = [];
  for (let at = 0; at < rows.length; at += per) {
    const bucket = rows.slice(at, at + per);
    const target = (
      bucket.find((r) => r.kind === "prompt") ??
      bucket.find((r) => r.kind === "reply") ??
      bucket[0]!
    ).id;
    // the full bar is split by sqrt(size); rounding drift lands on the last segment, and a crowded bucket drops its tail
    const weights = bucket.map((r) => Math.sqrt(r.size) || 1);
    const total = weights.reduce((n, w) => n + w, 0);
    let left = bar;
    const segments = bucket
      .map((r, j) => {
        const cells =
          j === bucket.length - 1
            ? left
            : Math.min(
                left,
                Math.max(1, Math.round((weights[j]! / total) * bar)),
              );
        left -= cells;
        return { kind: r.kind, cells };
      })
      .filter((s) => s.cells > 0);
    out.push({
      target,
      isHere: bucket.some((r) => onScreen.has(stem(r.id))),
      segments,
    });
  }
  return out;
};

// the kind drawn at one cell of a line's strip, for the sideways map that draws each line as a column
export const kindAt = (line: Line, cell: number): string | undefined => {
  let at = 0;
  for (const s of line.segments) {
    at += s.cells;
    if (cell < at) return s.kind;
  }
  return undefined;
};

export type Run = {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
};

type Style = Omit<Run, "text">;

const BASIC = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (...rgb: number[]) =>
  `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export const xterm256 = (n: number): string => {
  if (n < 16) return BASIC[n];
  if (n >= 232) return hex(...Array(3).fill(8 + (n - 232) * 10));
  const i = n - 16;
  return hex(
    CUBE[Math.floor(i / 36)],
    CUBE[Math.floor(i / 6) % 6],
    CUBE[i % 6],
  );
};

// an extended colour (38/48) consumes its own parameters, so it returns how many it ate
const extended = (
  codes: number[],
  at: number,
): [string | undefined, number] => {
  if (codes[at + 1] === 5) return [xterm256(codes[at + 2] ?? 0), 3];
  if (codes[at + 1] === 2)
    return [hex(codes[at + 2] ?? 0, codes[at + 3] ?? 0, codes[at + 4] ?? 0), 5];
  return [undefined, 1];
};

const apply = (style: Style, params: string): Style => {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let s: Style = { ...style };
  for (let i = 0; i < codes.length; ) {
    const c = codes[i];
    if (c === 38 || c === 48) {
      const [color, used] = extended(codes, i);
      s = c === 38 ? { ...s, color } : { ...s, backgroundColor: color };
      i += used;
      continue;
    }
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 9) s.strikethrough = true;
    else if (c === 22) delete s.bold;
    else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c === 29) delete s.strikethrough;
    else if (c === 39) delete s.color;
    else if (c === 49) delete s.backgroundColor;
    else if (c >= 30 && c <= 37) s.color = BASIC[c - 30];
    else if (c >= 90 && c <= 97) s.color = BASIC[c - 82];
    else if (c >= 40 && c <= 47) s.backgroundColor = BASIC[c - 40];
    else if (c >= 100 && c <= 107) s.backgroundColor = BASIC[c - 92];
    i++;
  }
  for (const k of Object.keys(s) as (keyof Style)[])
    if (s[k] === undefined) delete s[k];
  return s;
};

// key order differs with the order the codes came in, so compare field by field
const same = (a: Style, b: Style) =>
  (["color", "backgroundColor", "bold", "italic", "underline", "strikethrough"] as const).every((k) => a[k] === b[k]);

// one terminal line of SGR-styled text to runs; other escapes (OSC 8 links) are dropped
export const parseAnsi = (line: string): Run[] => {
  const runs: Run[] = [];
  let style: Style = {};
  const re =
    /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = runs.at(-1);
    if (prev && same(prev, style)) prev.text += text;
    else runs.push({ text, ...style });
  };
  for (const m of line.matchAll(re)) {
    push(line.slice(last, m.index));
    if (m[1] !== undefined) style = apply(style, m[1]);
    last = m.index + m[0].length;
  }
  push(line.slice(last));
  return runs;
};

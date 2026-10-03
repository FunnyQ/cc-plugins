import { parseAnsi, type Run } from "./ansi";

// glow's dark style indents every line by this much
const GLOW_MARGIN = 2;
// a reply re-renders on every streamed chunk, so finished renders are kept; oldest dropped past this
const CACHE_SIZE = 200;

// the hooks run glow themselves, since $ may not leave the hook that holds it
export const glowArgv = (width: number) => [
  "glow",
  "-s",
  "dark",
  "-w",
  String(width + GLOW_MARGIN),
  "-",
];

// a mod's child gets no HOME, so glow wrote its config and log under a literal ~ in the session's cwd
export const GLOW_INIT = { env: { HOME: "/tmp/q-lab/runes/glow" } };

// module state shared by both bubbles, so a hot reload renders everything again
export const glow = {
  // glow could not start, so stop paying a spawn per render
  missing: false,
  rendered: new Map<string, Run[][] | null>(),
  remember(key: string, lines: Run[][] | null) {
    this.rendered.set(key, lines);
    if (this.rendered.size > CACHE_SIZE)
      this.rendered.delete(this.rendered.keys().next().value!);
  },
};

const isBlank = (runs: Run[]) => runs.every((r) => !r.text.trim());

// glow pads every line to its width and indents it; both go, so each row is the text alone
const tidy = (runs: Run[]): Run[] => {
  const out = runs.map((r) => ({ ...r }));
  let cut = GLOW_MARGIN;
  while (cut > 0 && out.length) {
    const lead = out[0].text.length - out[0].text.trimStart().length;
    const n = Math.min(cut, lead);
    if (n === 0) break;
    out[0].text = out[0].text.slice(n);
    cut -= n;
    if (!out[0].text) out.shift();
  }
  while (out.length && !out.at(-1)!.backgroundColor && !out.at(-1)!.text.trim())
    out.pop();
  if (out.length && !out.at(-1)!.backgroundColor)
    out.at(-1)!.text = out.at(-1)!.text.trimEnd();
  return out;
};

// glow's blank first and last lines go, and each line is tidied to its text
export const toLines = (stdout: string): Run[][] => {
  const lines = stdout.split("\n").map(parseAnsi);
  while (lines.length && isBlank(lines[0])) lines.shift();
  while (lines.length && isBlank(lines.at(-1)!)) lines.pop();
  return lines.map(tidy);
};

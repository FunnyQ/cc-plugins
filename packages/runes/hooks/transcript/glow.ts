import { parseAnsi, type Run } from "./ansi";

// glow's dark style indents every line by this much
const GLOW_MARGIN = 2;
// renders kept across redraws; the least recently drawn goes past this
const CACHE_SIZE = 200;

const glowArgv = (width: number) => [
  "glow",
  "-s",
  "dark",
  "-w",
  String(width + GLOW_MARGIN),
  "-",
];

// a mod's child gets no HOME, so glow wrote its config and log under a literal ~ in the session's cwd
const GLOW_INIT = { env: { HOME: "/tmp/q-lab/runes/glow" } };

// $ may not leave its hook, so each hook hands in a closure that runs the command for it
type RunCommand = (
  argv: string[],
  init: typeof GLOW_INIT & { stdin: string },
) => Promise<{ exitCode: number; stdout: string }>;

// module state shared by both bubbles, so a hot reload renders everything again
const rendered = new Map<string, Promise<Run[][] | null>>();
const latest = new Map<string, string>();

const keep = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_SIZE) map.delete(map.keys().next().value!);
};

// a run is aborted with the redraw that started it, so only this many rejections in a row mean glow is gone
const GIVE_UP_AFTER = 3;
let failures = 0;

export const INSTALL_HINT = "runes: install glow for markdown bubbles — brew install glow";
let hinted = false;

export const glow = {
  // glow could not start, so stop paying a spawn per render
  missing: false,
  // true once, on the first draw after glow is found missing, so the install hint shows a single time
  hintDue() {
    if (!glow.missing || hinted) return false;
    hinted = true;
    return true;
  },
  // the promise is cached, so a redraw landing while glow runs joins it instead of spawning again
  render(
    run: RunCommand,
    width: number,
    text: string,
    owner?: string,
  ): Promise<Run[][] | null> {
    const key = `${width}\0${text}`;
    if (owner !== undefined) {
      // a streamed reply leaves a partial per chunk; only its latest text is worth a slot
      const prev = latest.get(owner);
      if (prev !== undefined && prev !== key) rendered.delete(prev);
      keep(latest, owner, key);
    }
    const lines =
      rendered.get(key) ??
      run(glowArgv(width), { ...GLOW_INIT, stdin: text }).then(
        ({ exitCode, stdout }) => {
          failures = 0;
          return exitCode === 0 ? toLines(stdout) : null;
        },
        () => {
          // a rejection is not a rendering, so the next redraw runs glow again
          rendered.delete(key);
          glow.missing = ++failures >= GIVE_UP_AFTER;
          return null;
        },
      );
    keep(rendered, key, lines);
    return lines;
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
const toLines = (stdout: string): Run[][] => {
  const lines = stdout.split("\n").map(parseAnsi);
  while (lines.length && isBlank(lines[0])) lines.shift();
  while (lines.length && isBlank(lines.at(-1)!)) lines.pop();
  return lines.map(tidy);
};

import { config } from "../config";
import { parseAnsi, type Run } from "./ansi";

// glow's dark style indents every line by this much
const GLOW_MARGIN = 2;
// renders kept across redraws; the least recently drawn goes past this
const CACHE_SIZE = 200;

const glowArgv = (width: number, style: string) => [
  "glow",
  "-s",
  style,
  "-w",
  String(width + GLOW_MARGIN),
  "-",
];

// a mod's child gets no HOME, so glow wrote its config and log under a literal ~ in the session's cwd
const GLOW_INIT = { env: { HOME: "/tmp/q-lab/runes/glow" } };

// $ may not leave its hook, so session.start hands the worker closures that use it
type RunCommand = (
  argv: string[],
  init: typeof GLOW_INIT & { stdin: string },
) => Promise<{ exitCode: number; stdout: string }>;

type Job = { key: string; width: number; text: string; style: string };

// module state shared by both bubbles, so a hot reload renders everything again
const rendered = new Map<string, Run[][] | null>();
// a streamed reply's last formatted text, drawn while its next chunk is still in glow
const lastGood = new Map<string, Run[][]>();
// keyed by owner, so a reply streaming faster than glow queues only its newest text
const queue = new Map<string, Job>();
let transport: { run: RunCommand; redraw: () => void } | undefined;
let working = false;
let wake: (() => void) | undefined;

const keep = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_SIZE) map.delete(map.keys().next().value!);
};

export const INSTALL_HINT = "runes: install glow for markdown bubbles — brew install glow";
let hinted = false;

export const glow = {
  // glow could not start, so stop queueing work for it
  missing: false,
  // true once, on the first draw after glow is found missing, so the install hint shows a single time
  hintDue() {
    if (!glow.missing || hinted) return false;
    hinted = true;
    return true;
  },
  // a draw never waits on glow: it takes what is rendered, or the owner's last, or null for raw text
  view(width: number, text: string, owner?: string): Run[][] | null {
    const { style } = config.glow;
    // the style is in the key, so a /runes reload that changes it renders everything again
    const key = `${style}\0${width}\0${text}`;
    if (rendered.has(key)) {
      const lines = rendered.get(key)!;
      keep(rendered, key, lines);
      if (owner !== undefined && lines?.length) keep(lastGood, owner, lines);
      return lines;
    }
    if (!transport || glow.missing) return null;
    queue.set(owner ?? key, { key, width, text, style });
    wake?.();
    return owner === undefined ? null : (lastGood.get(owner) ?? null);
  },
  // glow ran inside the render dispatch and died with it when a redraw superseded that draw;
  // run from session.start, it outlives every draw and only a real failure to start stops it
  work(run: RunCommand, redraw: () => void) {
    transport = { run, redraw };
    glow.missing = false;
    hinted = false;
    if (working) return;
    working = true;
    void (async () => {
      for (;;) {
        const next = queue.entries().next();
        if (next.done) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
          continue;
        }
        const [slot, job] = next.value;
        queue.delete(slot);
        if (rendered.has(job.key)) continue;
        const t = transport!;
        try {
          const { exitCode, stdout } = await t.run(glowArgv(job.width, job.style), { ...GLOW_INIT, stdin: job.text });
          keep(rendered, job.key, exitCode === 0 ? toLines(stdout) : null);
        } catch {
          glow.missing = true;
          queue.clear();
        }
        t.redraw();
      }
    })();
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

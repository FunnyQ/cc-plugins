import { config } from "../config";
import { childEnv, runtime, scratchRoot } from "../platform";
import { dropLead, leadingSpaces, parseAnsi, type Run } from "./ansi";

// glow's dark style indents every line by this much
const GLOW_MARGIN = 2;
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
const glowInit = () => {
  const info = runtime.info;
  const home = `${info ? scratchRoot(info) : "/tmp/q-lab/runes"}/glow`;
  return { env: info ? childEnv({ ...info, home }) : { HOME: home } };
};

// $ may not leave its hook, so session.start hands the worker closures that use it
type RunCommand = (
  argv: string[],
  init: ReturnType<typeof glowInit> & { stdin: string },
) => Promise<{ exitCode: number; stdout: string }>;

type Job = { key: string; width: number; text: string; style: string };

const rendered = new Map<string, Run[][] | null>();
const lastGood = new Map<string, Run[][]>();
const queue = new Map<string, Job>();
let transport: { run: RunCommand; redraw: () => void } | undefined;
let working = false;
let wake: (() => void) | undefined;
let missing = false;
const landed = new Map<string, string>();

const keep = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_SIZE) map.delete(map.keys().next().value!);
};

const UNKNOWN_INSTALL_HINT =
  "runes: install glow for markdown bubbles — macOS: brew install glow; Windows: winget install charmbracelet.glow; Linux: https://github.com/charmbracelet/glow#installation";
export let INSTALL_HINT = UNKNOWN_INSTALL_HINT;
let hinted = false;

export const glow = {
  hintDue() {
    if (!missing || hinted) return false;
    hinted = true;
    return true;
  },
  view(width: number, text: string, owner?: string): Run[][] | null {
    const { style } = config.glow;
    const key = `${style}\0${width}\0${text}`;
    if (rendered.has(key)) {
      const lines = rendered.get(key)!;
      keep(rendered, key, lines);
      if (owner !== undefined && lines?.length) keep(lastGood, owner, lines);
      return lines;
    }
    if (!transport || missing) return null;
    queue.set(owner ?? key, { key, width, text, style });
    wake?.();
    return owner === undefined ? null : (lastGood.get(owner) ?? null);
  },
  // glow ran inside the render dispatch and died with it when a redraw superseded that draw;
  // run from session.start, it outlives every draw and only a real failure to start stops it
  work(run: RunCommand, redraw: () => void) {
    const platform = runtime.info?.platform;
    INSTALL_HINT = UNKNOWN_INSTALL_HINT;
    if (platform)
      INSTALL_HINT = `runes: install glow for markdown bubbles — ${
        platform === "darwin"
          ? "brew install glow"
          : platform === "win32"
            ? "winget install charmbracelet.glow"
            : "https://github.com/charmbracelet/glow#installation"
      }`;
    transport = { run, redraw };
    missing = false;
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
          const { exitCode, stdout } = await t.run(
            glowArgv(job.width, job.style),
            { ...glowInit(), stdin: job.text },
          );
          keep(rendered, job.key, exitCode === 0 ? toLines(stdout) : null);
          if (slot !== job.key) {
            const old = landed.get(slot);
            if (old !== undefined && old !== job.key) rendered.delete(old);
            keep(landed, slot, job.key);
          }
        } catch {
          missing = true;
          queue.clear();
        }
        t.redraw();
      }
    })();
  },
};

const isBlank = (runs: Run[]) => runs.every((r) => !r.text.trim());

const tidy = (runs: Run[]): Run[] => {
  const out = dropLead(runs, Math.min(GLOW_MARGIN, leadingSpaces(runs)));
  while (out.length && !out.at(-1)!.backgroundColor && !out.at(-1)!.text.trim())
    out.pop();
  if (out.length && !out.at(-1)!.backgroundColor)
    out.at(-1)!.text = out.at(-1)!.text.trimEnd();
  return out;
};

const toLines = (stdout: string): Run[][] => {
  const lines = stdout.split("\n").map(parseAnsi);
  while (lines.length && isBlank(lines[0])) lines.shift();
  while (lines.length && isBlank(lines.at(-1)!)) lines.pop();
  return lines.map(tidy);
};

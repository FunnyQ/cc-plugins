import { atom, update } from "claude-code";
import type { EngineInterface, Hook, On } from "claude-code";
import type { ExplainCheck, ExplainView } from "../../types";
import { where } from "../transcript/where";
import { explainRoot } from "./html";
import { patchEntry } from "./state";

export const CHECKER = "runes:explain-checker";
export const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CHECK_TIMEOUT_MS = 180_000;
const GEOMETRY_TIMEOUT_MS = 20_000;
export type CheckResult = { check: ExplainCheck; note?: string };

export const CHECKER_PROMPT = [
  "You check one HTML explainer page. The task message gives its absolute path and a check token.",
  `Screenshot it with exactly \`"${CHROME}" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,4000 --screenshot=<dir>/<name>.check.png file://<html>\`, and for the narrow pass use \`--window-size=420,7000\` with \`--screenshot=<dir>/<name>.check-narrow.png\`, where <dir> is the page's own directory and <name> its file name without .html. Keep the Chrome path in double quotes. Write no screenshot anywhere else. Then Read each PNG. Chrome captures the window, not the whole page, so the heights are tall on purpose: check that the colophon (\`Written by a fork of this session\`) is visible at the bottom of each shot. When it is not, the page is taller than the shot: answer \`FAILED page taller than the screenshot\` rather than \`OK\`. One round is one wide plus one narrow shot.`,
  "Fix only: overlapping or clipped labels, arrows pointing at the wrong box, text outside its box, illegible contrast. Fix by editing the HTML file with Edit, inside `<main>` only. Never rewrite prose, never add or remove a section, never touch `<head>`, the CSP meta, or the `#wash` filter.",
  "The drawing's rules, so a fix moves toward them: SVG elements use only the classes `ink`, `ink-accent`, `dash`, `wash-warm`, `wash-cool`, `wash-sage`, `label`, `label-soft`, `part`; no literal colours, no `style` attributes, no `width`/`height` on the `svg`; every `svg` keeps its `viewBox` and `<title>`; wash paths come before the ink they sit behind; labels sit at least 24 viewBox units apart and never on a line; a part's label starts with its capital letter (`A · the session`). Labels grow to 24px (label) and 21px (label-soft) at 420 wide, so leave room for that: prefer moving a label or widening the `viewBox` to shrinking text.",
  "Take at most 3 screenshot rounds in total.",
  "Do not hand back. Your final message is exactly one line: the token, a space, then `OK` (nothing needed fixing), `FIXED <n>` (n edits made), or `FAILED <reason>` (a screenshot would not render, or the page is still broken after 3 rounds). Example: `c3 FIXED 2`.",
]
  .map((line, i) => `${i + 1}. ${line}`)
  .join("\n");

export const parseVerdict = (
  answer: string,
): CheckResult & { token?: string } => {
  const last =
    answer
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const tokened = last.match(/^(c\d+) (.*)$/);
  const token = tokened?.[1];
  const rest = tokened ? tokened[2]! : last;
  const fixed = rest.match(/^FIXED ([1-9]\d*)$/);
  const failed = rest.match(/^FAILED (.*\S.*)$/);
  const result: CheckResult =
    rest === "OK"
      ? { check: "ok" }
      : fixed
        ? { check: "fixed", note: `${fixed[1]} fix(es)` }
        : failed
          ? { check: "failed", note: failed[1]!.trim() }
          : { check: "failed", note: "unreadable verdict" };
  return token ? { token, ...result } : result;
};

type Pending = {
  entryId: string;
  path: string;
  agentId?: string;
  startedAt: number;
};

// the engine's state scan reads only an atom made in this file, so each reader makes its own
const view = atom(
  { plugin: "runes", key: "explain" } as const,
  { entries: [], isRunning: false } as ExplainView,
);

let explainDir = "";
let checks = 0;
const pending = new Map<string, Pending>();

async function settle(
  $: EngineInterface,
  entryId: string,
  path: string,
  r: CheckResult,
) {
  await update($, view, (v) =>
    patchEntry(v, entryId, { check: r.check, note: r.note }),
  );
  await $.process.run(["open", path]);
  const shot = path.replace(/\.html$/, "");
  await $.process.run(["rm", "-f", `${shot}.check.png`, `${shot}.check-narrow.png`]);
}

async function expire($: EngineInterface) {
  if (pending.size === 0) return;
  const now = await $.clock.now();
  for (const [token, p] of pending) {
    if (now - p.startedAt < CHECK_TIMEOUT_MS) continue;
    pending.delete(token);
    await settle($, p.entryId, p.path, { check: "failed", note: "timed out" });
  }
}

async function isChecker($: EngineInterface, agentId: string | undefined) {
  // matched by type: the test kit strips a hook-made agentId, so the spawn's id alone never matches there
  return (
    !!agentId &&
    (await $.agent.list()).find((a) => a.id === agentId)?.type === CHECKER
  );
}

export async function registerChecker($: EngineInterface): Promise<void> {
  explainDir = where.home ? explainRoot(where.home) : "";
  await $.agent.register({
    name: "explain-checker",
    description:
      "Screenshots a runes explainer page and fixes broken diagram labels. Spawned by runes alone.",
    prompt: CHECKER_PROMPT,
    tools: ["Bash", "Read", "Edit"],
    model: "sonnet",
    effort: "medium",
    omitClaudeMd: true,
  });
}

// undefined when the check could not run (no bun, Chrome never answered): the checker then looks at the page unaided
async function measure(
  $: EngineInterface,
  path: string,
): Promise<string[] | undefined> {
  try {
    const run = await $.process.run(
      ["bun", `${$.plugin.root}/hooks/explain/geometry-cli.ts`, CHROME, path],
      { timeoutMs: GEOMETRY_TIMEOUT_MS },
    );
    const { faults } = JSON.parse(run.stdout) as { faults?: unknown };
    return run.exitCode === 0 && Array.isArray(faults)
      ? faults.map(String)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startCheck(
  $: EngineInterface,
  entryId: string,
  path: string,
): Promise<void> {
  await expire($);
  if (!(await $.fs.exists(CHROME))) {
    await settle($, entryId, path, { check: "skipped", note: "no Chrome" });
    return;
  }
  const found = await measure($, path);
  if (found?.length === 0) {
    await settle($, entryId, path, { check: "ok", note: "geometry clean" });
    return;
  }
  const token = `c${++checks}`;
  const spawned = await $.agent.spawn({
    subagentType: CHECKER,
    prompt:
      `Check this explainer page: ${path}\nYour check token is ${token}.` +
      (found
        ? `\nA geometry check found:\n${found.map((f) => `- ${f}`).join("\n")}`
        : ""),
    description: "check explainer layout",
  });
  if (spawned.deny !== undefined) {
    await settle($, entryId, path, { check: "failed", note: spawned.deny });
    return;
  }
  pending.set(token, {
    entryId,
    path,
    agentId: spawned.agentId,
    startedAt: await $.clock.now(),
  });
}

const inside = (path: string) =>
  explainDir !== "" &&
  path.startsWith(explainDir) &&
  !path.split("/").includes("..");

const FLAGS = new Set([
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=1280,4000",
  "--window-size=420,7000",
]);

// every argument is a known flag, one screenshot target or one page: any other flag (`--log-net-log=…`) or URL could write or fetch outside the root
const allowsBash = (command: string) => {
  if (explainDir === "" || explainDir.includes(" ")) return false;
  const prefix = `"${CHROME}" `;
  if (!command.startsWith(prefix)) return false;
  const args = command.slice(prefix.length);
  if (/[^\p{L}\p{N}\/._,=:-]/u.test(args.replaceAll(" ", ""))) return false;
  const files: string[] = [];
  const shots: string[] = [];
  for (const arg of args.split(" ").filter(Boolean)) {
    if (FLAGS.has(arg)) continue;
    if (arg.startsWith("file://")) files.push(arg.slice("file://".length));
    else if (arg.startsWith("--screenshot="))
      shots.push(arg.slice("--screenshot=".length));
    else return false;
  }
  return (
    files.length === 1 &&
    shots.length <= 1 &&
    [...files, ...shots].every(inside)
  );
};

type TurnComplete = Hook<"turn.complete">;

const complete: TurnComplete = async ($, e, next) => {
  const ran = await next(e);
  await expire($);
  if (!(await isChecker($, e.agentId))) return ran;
  const verdict = e.reason === "answer" ? parseVerdict(e.answer) : undefined;
  // a token or the spawn's own agentId only: arrival order or a lone-waiter fallback would let a timed-out check's late answer settle a newer one
  const token =
    verdict?.token ??
    [...pending].find(([, p]) => p.agentId === e.agentId)?.[0];
  const p = token === undefined ? undefined : pending.get(token);
  if (!p) return ran;
  pending.delete(token!);
  await settle(
    $,
    p.entryId,
    p.path,
    verdict ?? { check: "failed", note: e.reason },
  );
  return ran;
};

export function checker(on: On): void {
  on("agent.offer", { agent: CHECKER }, () => ({ isOffered: false })).catch(
    () => ({ isOffered: false }),
  );

  // auto mode's classifier otherwise judges a spawn nobody typed, and denies it outright when unavailable
  on("tool.check", { tool: "Agent" }, async ($, e, next) => {
    const own =
      next.origin.plugin === $.plugin.name &&
      (e.input as { subagent_type?: string }).subagent_type === CHECKER;
    return own ? { decision: "allow" } : next(e);
  });

  // kept beside the classifier: an unavailable classifier denies a subagent's call outright
  on("tool.check", { tool: "Bash" }, async ($, e, next) => {
    if (!(await isChecker($, e.agentId))) return next(e);
    const { command } = e.input as { command?: string };
    return allowsBash(command ?? "") ? { decision: "allow" } : next(e);
  });

  for (const tool of ["Read", "Edit"] as const)
    on("tool.check", { tool }, async ($, e, next) => {
      if (!(await isChecker($, e.agentId))) return next(e);
      const { file_path } = e.input as { file_path?: string };
      return inside(file_path ?? "") ? { decision: "allow" } : next(e);
    });

  // `as never`: the harness adds this tool to every subagent, so the types list no such name
  on("tool.call", { tool: "SubagentHandback" as never }, async ($, e, next) => {
    const { agentId } = e as { agentId?: string };
    if (!(await isChecker($, agentId))) return next(e);
    return {
      deny: "Do not hand back. Reply with your check token, then OK, FIXED <n>, or FAILED <reason>, as your final message.",
    };
  });

  on("turn.complete", { isAborted: false }, complete);
  on("turn.complete", { isAborted: true }, complete);
}

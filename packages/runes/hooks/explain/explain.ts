import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";
import type { ExplainEntry, ExplainView } from "../../types";
import { where } from "../transcript/where";
import { childEnv, platformCommand, runtime, type PlatformOperation } from "../platform";
import { hasDiagram } from "./blocks";
import { checker, startCheck } from "./checker";
import { config } from "../config";
import { pickTheme, writeExplainer } from "./html";
import { buildPrompt, drawBrief, parseReply, type Ask } from "./protocol";
import { themer } from "./theme-jev";
import { selectedOf, usageOf, withEntry } from "./state";

export const PANE = "runes-explain";
export const COLUMNS = 64;
const PELE_TIMEOUT_MS = 10_000;

// the engine's state scan reads only an atom made in this file, so each reader makes its own
const view = atom(
  { plugin: "runes", key: "explain" } as const,
  { entries: [], isRunning: false } as ExplainView,
);

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

async function platformAction(
  $: EngineInterface,
  operation: PlatformOperation,
): Promise<void> {
  const result = await $.process.run(platformCommand($.plugin.root), {
    stdin: JSON.stringify(operation),
    ...(runtime.info ? { env: childEnv(runtime.info) } : {}),
  });
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || `${operation.op} exited ${result.exitCode}`,
    );
}

async function openPane($: EngineInterface, focus = false): Promise<boolean> {
  const { isPlaced } = await $.ui.open({
    id: PANE,
    title: "Explain plz!",
    columns: COLUMNS,
    ...(focus ? { focus } : {}),
  });
  if (!isPlaced)
    $.ui.toast(
      "Explain plz! needs a wider terminal; the answer is in the pane once it fits",
    );
  return isPlaced;
}

async function run($: EngineInterface, ask: Ask): Promise<void> {
  let started = false;
  await update($, view, (v) => {
    started = !v.isRunning;
    if (!started) return v;
    const { error: _cleared, isAsking: _asked, ...rest } = v;
    return { ...rest, isRunning: true };
  });
  if (!started) return;
  let check: { id: string; path: string } | undefined;
  let diagrams = false;
  try {
    await openPane($);
    const { language } = (await $.settings.read()) as { language?: string };
    const r = await $.model.fork({
      prompt: buildPrompt(ask, language, drawBrief(Math.random)),
    });
    if (!r.isAnswered) {
      const status =
        "status" in r && r.status !== undefined ? ` ${r.status}` : "";
      const error =
        r.reason === "nothing-to-fork"
          ? "send a message first: after a resume or /clear there is nothing to explain yet"
          : `the fork failed: ${r.reason}${r.reason === "api-error" ? status : ""}`;
      await update($, view, (v) => ({ ...v, error }));
      return;
    }
    const reply = parseReply(r.text);
    const at = await $.clock.now();
    const usage = usageOf(r.usage);
    let error: string | undefined;
    let body: ExplainEntry extends infer E
      ? E extends { kind: infer K }
        ? K extends unknown
          ? Omit<
              Extract<ExplainEntry, { kind: K }>,
              "id" | "at" | "title" | "usage"
            >
          : never
        : never
      : never;
    if (reply.kind === "text") body = { kind: "text", body: reply.body };
    else if (reply.kind === "ask")
      body = { kind: "ask", question: reply.question, options: reply.options };
    else {
      try {
        const home = where.home;
        const git = await $.process
          .run(["git", "rev-parse", "--show-toplevel"], {
            cwd: where.cwd || undefined,
            env: runtime.info ? childEnv(runtime.info) : { HOME: home },
          })
          .catch(() => undefined);
        const project =
          git?.exitCode === 0
            ? basename(git.stdout.trim())
            : basename(where.cwd);
        const theme = pickTheme(
          config.explain.theme === "auto"
            ? ((await themer.pick(reply.title, reply.main)) ??
                reply.theme ??
                "random")
            : config.explain.theme,
          Math.random,
        );
        const path = await writeExplainer(
          {
            read: (p) => $.fs.read(p).then(String),
            write: (p, text) => $.fs.write(p, text),
            exists: (p) => $.fs.exists(p),
            mkdir: (directory) => platformAction($, { op: "mkdir", directory }),
          },
          $.plugin.root,
          home,
          await $.session.id(),
          { title: reply.title, main: reply.main, project, lang: language },
          new Date(at),
          theme,
        );
        diagrams = hasDiagram(reply.main);
        body = {
          kind: "html",
          summary: reply.summary,
          path,
          check: "pending",
          theme,
        };
      } catch (err) {
        error = `could not write the explainer: ${messageOf(err)}`;
        body = { kind: "text", body: reply.summary };
      }
    }
    await update($, view, (v) => {
      const taken = new Set(v.entries.map((e) => e.id));
      let id = `x${at}`;
      for (let n = 2; taken.has(id); n++) id = `x${at}-${n}`;
      if (body.kind === "html") check = { id, path: body.path };
      const entry = {
        id,
        at,
        title: reply.title,
        usage,
        ...body,
      } as ExplainEntry;
      return { ...withEntry(v, entry), ...(error ? { error } : {}) };
    });
  } catch (err) {
    const error = `the fork failed: ${messageOf(err)}`;
    await update($, view, (v) => ({ ...v, error }));
  } finally {
    await update($, view, (v) => ({ ...v, isRunning: false }));
  }
  if (!check) return;
  // a failed render leaves the source fallback the page was written with
  if (diagrams)
    await $.process
      .run(["bun", `${$.plugin.root}/hooks/explain/pele-cli.ts`, check.path], {
        timeoutMs: PELE_TIMEOUT_MS,
      })
      .catch(() => undefined);
  await startCheck($, check.id, check.path);
}

export async function explainPress($: EngineInterface): Promise<void> {
  await run($, { kind: "press" });
}

export async function explainOpen($: EngineInterface): Promise<void> {
  await update($, view, (v) => ({ ...v, isAsking: true }));
  if (await openPane($, true))
    await $.ui.focus({ requestId: PANE, key: "explain-ask" });
}

export async function explainShowHistory($: EngineInterface): Promise<void> {
  await update($, view, ({ isAsking: _asked, ...v }) => v);
}

export async function explainAsk(
  $: EngineInterface,
  text: string,
): Promise<void> {
  const question = text.trim();
  if (!question) return;
  const v = await read($, view);
  // ask mode hides the history, so a fresh question there never rides an answer the user cannot see
  const entry = v.isAsking ? undefined : selectedOf(v);
  if (!entry) return run($, { kind: "free", question });
  const previous =
    entry.kind === "text"
      ? entry.body
      : entry.kind === "html"
        ? entry.summary
        : [entry.question, ...entry.options].join("\n");
  await run($, {
    kind: "follow",
    previous: { title: entry.title, text: previous },
    question,
  });
}

export async function explainPick(
  $: EngineInterface,
  topic: string,
): Promise<void> {
  await run($, { kind: "pick", topic });
}

export async function explainSelect(
  $: EngineInterface,
  id: string,
): Promise<void> {
  await update($, view, (v) => ({ ...v, selected: id }));
}

export async function explainReopen(
  $: EngineInterface,
  id: string,
): Promise<void> {
  const entry = (await read($, view)).entries.find((e) => e.id === id);
  if (entry?.kind !== "html") return;
  try {
    await platformAction($, { op: "open", path: entry.path });
  } catch (err) {
    await update($, view, (v) => ({
      ...v,
      error: `could not open ${basename(entry.path)}: ${messageOf(err)}`,
    }));
  }
}

// trash, not rm: an explainer is the one artifact of a press that outlives the session, so a slip stays recoverable
async function trashPages(
  $: EngineInterface,
  entries: ExplainEntry[],
): Promise<string | undefined> {
  const paths = entries.flatMap((e) => (e.kind === "html" ? [e.path] : []));
  if (!paths.length) return undefined;
  try {
    await platformAction($, { op: "trash", paths });
    return undefined;
  } catch (err) {
    const what =
      paths.length === 1 ? basename(paths[0]!) : `${paths.length} pages`;
    return `could not move ${what} to the Trash: ${messageOf(err)}`;
  }
}

export async function explainDelete(
  $: EngineInterface,
  id: string,
): Promise<void> {
  const entry = (await read($, view)).entries.find((e) => e.id === id);
  if (!entry) return;
  const error = await trashPages($, [entry]);
  await update($, view, (v) =>
    error
      ? { ...v, error }
      : {
          ...v,
          error: undefined,
          entries: v.entries.filter((e) => e.id !== id),
          selected: v.selected === id ? undefined : v.selected,
        },
  );
}

export async function explainClear($: EngineInterface): Promise<void> {
  const error = await trashPages($, (await read($, view)).entries);
  await update($, view, (v) =>
    error
      ? { ...v, error }
      : { ...v, error: undefined, entries: [], selected: undefined },
  );
}

export function explainHooks(on: On): void {
  checker(on);

  // a spawn raised from a closure leaves out every runes hook, the checker's Agent allow too; from a hook, only that hook.
  // next runs first: the redraw a run starts drops the pressed element's handler
  on(
    "ui.press",
    { plugin: "runes", element: "explain" },
    async ($, e, next) => {
      const pressed = await next(e);
      await explainPress($);
      return pressed;
    },
  );

  on(
    "ui.press",
    { plugin: "runes", element: "explain-open" },
    async ($, e, next) => {
      const pressed = await next(e);
      await explainOpen($);
      return pressed;
    },
  );

  on("ui.press", { plugin: "runes", requestId: PANE }, async ($, e, next) => {
    const pressed = await next(e);
    const pick = e.element.match(/^explain-pick:(.+):(\d+)$/);
    const entry =
      pick && (await read($, view)).entries.find((x) => x.id === pick[1]);
    const option =
      entry?.kind === "ask" ? entry.options[Number(pick![2])] : undefined;
    if (option !== undefined) await explainPick($, option);
    return pressed;
  });

  on(
    "ui.input",
    { plugin: "runes", element: "explain-ask", kind: "change" },
    async ($, e, next) => {
      const changed = await next(e);
      await update($, view, (v) => ({ ...v, draft: e.value }));
      return changed;
    },
  );

  on(
    "ui.input",
    { plugin: "runes", element: "explain-ask", kind: "submit" },
    async ($, e, next) => {
      const submitted = await next(e);
      await update($, view, (v) => ({ ...v, draft: "" }));
      await explainAsk($, e.value);
      return submitted;
    },
  );
}

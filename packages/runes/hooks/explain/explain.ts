import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";
import type { ExplainEntry, ExplainView } from "../../types";
import { where } from "../transcript/where";
import { checker, startCheck } from "./checker";
import { writeExplainer } from "./html";
import { buildPrompt, parseReply, type Ask } from "./protocol";
import { selectedOf, usageOf, withEntry } from "./state";

export const PANE = "runes-explain";

// the engine's state scan reads only an atom made in this file, so state.ts's `view` cannot be imported here
const view = atom(
  { plugin: "runes", key: "explain" } as const,
  { entries: [], isRunning: false } as ExplainView,
);

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

async function run($: EngineInterface, ask: Ask): Promise<void> {
  let started = false;
  await update($, view, (v) => {
    started = !v.isRunning;
    if (!started) return v;
    const { error: _cleared, ...rest } = v;
    return { ...rest, isRunning: true };
  });
  if (!started) return;
  let check: { id: string; path: string } | undefined;
  try {
    const { isPlaced } = await $.ui.open({
      id: PANE,
      title: "hey mate",
      columns: 64,
    });
    if (!isPlaced)
      $.ui.toast(
        "hey mate needs a wider terminal; the answer is in the pane once it fits",
      );
    const r = await $.model.fork({ prompt: buildPrompt(ask) });
    if (!r.isAnswered) {
      const status =
        "status" in r && r.status !== undefined ? ` ${r.status}` : "";
      const error =
        r.reason === "nothing-to-fork"
          ? "nothing to explain yet"
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
        const home = (await $.env.get("HOME")) ?? "";
        const git = await $.process
          .run(["git", "rev-parse", "--show-toplevel"], {
            cwd: where.cwd || undefined,
            env: { HOME: home },
          })
          .catch(() => undefined);
        const project =
          git?.exitCode === 0
            ? basename(git.stdout.trim())
            : basename(where.cwd);
        const path = await writeExplainer(
          {
            read: (p) => $.fs.read(p).then(String),
            write: (p, text) => $.fs.write(p, text),
            exists: (p) => $.fs.exists(p),
            // the engine's $.fs has no mkdir
            mkdir: (d) => $.process.run(["mkdir", "-p", d]).then(() => {}),
          },
          $.plugin.root,
          home,
          { title: reply.title, main: reply.main, project },
          new Date(at),
        );
        body = { kind: "html", summary: reply.summary, path, check: "pending" };
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
  if (check) await startCheck($, check.id, check.path);
}

export async function explainPress($: EngineInterface): Promise<void> {
  await run($, { kind: "press" });
}

export async function explainAsk(
  $: EngineInterface,
  text: string,
): Promise<void> {
  const question = text.trim();
  if (!question) return;
  const entry = selectedOf(await read($, view));
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
  if (entry?.kind === "html") await $.process.run(["open", entry.path]);
}

export function explainHooks(on: On): void {
  checker(on);
}

/**
 * comment-guard as a Claude Code mod: the same check as comment-guard.ts, run
 * in-process on `tool.call` instead of spawning bun per Edit or Write. The
 * question rides back as the result's `context`, which the model reads the way
 * it read the command hook's exit-2 stderr. Codex and OpenCode keep spawning
 * comment-guard.ts, since neither has function hooks.
 */

import type { Register } from "claude-code";
import {
  addedCommentLines,
  ASK,
  baseName,
  flaggedBlocks,
  formatReason,
  isGuardedPath,
  resolveAdded,
  syntaxFor,
  type ToolResponse,
} from "./comment-core.ts";
import {
  screenBlocks,
  screenNote,
  TIMEOUT_MS,
  type Post,
} from "./jev-screen.ts";
import { DEFAULT_STATE_DIR, reportedFile, reportedLine } from "./ledger.ts";

export const register: Register = (on) => {
  on("tool.call", { tool: ["Edit", "Write"] }, async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny !== undefined || ran.isError) return ran;
    if (e.tool !== "Edit" && e.tool !== "Write") return ran;

    const filePath = e.file_path;
    if (!isGuardedPath(filePath)) return ran;
    const syntax = syntaxFor(filePath);
    if (!syntax) return ran;

    const response = ran.result as ToolResponse;
    if (response.staged) return ran;
    const patch = response.structuredPatch;
    // A Write that creates a file reports no hunks at all, so an empty patch means "nothing changed" only when the file already existed.
    if (response.type === "update" && patch?.length === 0) return ran;

    let fileText: string;
    try {
      fileText = await $.fs.read(filePath);
    } catch {
      return ran;
    }

    const added = patch?.length
      ? resolveAdded(
          patch,
          fileText.split("\n").map((l) => l.trim()),
        )
      : addedCommentLines(e.tool, e, syntax);
    if (added instanceof Set ? added.size === 0 : added.length === 0) {
      return ran;
    }

    const blocks = flaggedBlocks(fileText, syntax, added);
    if (blocks.length === 0) return ran;

    // Read-then-write, not an append: two parallel writes can drop one entry, which costs one re-asked block at Stop.
    const asked = blocks.flatMap((b) => b.lines.filter((_, k) => b.added[k]));
    const dir = (await $.env.get("GUARD_STATE_DIR")) ?? DEFAULT_STATE_DIR;
    const ledger = reportedFile(dir, await $.session.id());
    const prior = (await $.fs.exists(ledger)) ? await $.fs.read(ledger) : "";
    await $.fs.write(ledger, prior + reportedLine(filePath, asked));

    const post: Post = (url, init) =>
      new Promise((resolve, reject) => {
        // `$.http.fetch` takes no signal, so the timeout abandons the request rather than cancelling it.
        const timer = $.clock.after(TIMEOUT_MS, () =>
          reject(new Error("jev timeout")),
        );
        $.http.fetch(url, init).then((r) => {
          timer.cancel();
          resolve({ ok: r.ok, json: async () => JSON.parse(r.text) });
        }, reject);
      });

    const fileName = baseName(filePath);
    const screen = await screenBlocks(fileName, blocks, {
      apiKey: await $.env.get("TYPESAFE_API_KEY"),
      fetch: post,
    });
    const note = screenNote("💬 comment-guard", screen);
    if (screen.kept.length === 0) {
      if (note) $.ui.toast(note);
      return ran;
    }
    const reason = `${formatReason(fileName, screen.kept)}\n${ASK}`;
    return {
      ...ran,
      context: [...(ran.context ?? []), note ? `${reason}\n${note}` : reason],
    };
  });
};

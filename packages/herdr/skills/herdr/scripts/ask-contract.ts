/**
 * ask-contract.ts — the file contract `ask`/`collect` use to retrieve an
 * answer from another agent's pane. Pane text is not trustworthy on its own:
 * a TUI's own chrome and a mid-turn snapshot both look like "an answer" to a
 * naive reader. So the target writes its final answer to a file instead, and
 * the reader only accepts it once the file's last line is the sentinel below
 * — proof the write is complete, not partial.
 *
 * This mirrors relay's relay-prompt.ts contract in spirit only, not in code:
 * relay is a separately-versioned plugin, so nothing here imports from it.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ASK_RESULT_END_MARKER = "==== ASK RESULT END ====";

/** Appends the result-file instructions to a question. The target must write
 *  its COMPLETE final answer to `resultPath`, ending with the sentinel — the
 *  poller in herd.ts treats the file as final only once that line lands. */
export function appendFileContract(
  question: string,
  resultPath: string,
): string {
  return (
    question +
    "\n\n---\n\n" +
    "Result-file contract (IMPORTANT):\n" +
    `- When your answer is FINAL, write it — the complete final answer, as markdown — to: ${resultPath}\n` +
    `- The file's last line must be exactly: ${ASK_RESULT_END_MARKER}\n` +
    "- Do not write the file until the answer is final; write it once, in full.\n" +
    "- The file is how your answer is collected — the caller does not read your pane. Writing it is mandatory."
  );
}

/** The result file is final only when its last non-empty line is the
 *  sentinel. Marker absent means mid-write, or not started yet — keep polling. */
export function extractFinalText(content: string): string | null {
  const trimmed = content.trimEnd();
  const lines = trimmed.split("\n");
  if (lines.at(-1)?.trim() !== ASK_RESULT_END_MARKER) return null;
  return lines.slice(0, -1).join("\n").trimEnd();
}

/** A fresh scratch directory for one ask/collect run's question.md + result.md. */
export function createAskRunDir(
  base: string = join(tmpdir(), "herd-ask"),
): string {
  const dir = join(
    base,
    `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

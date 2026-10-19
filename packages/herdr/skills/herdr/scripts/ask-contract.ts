// Pane text is not trustworthy on its own:
// a TUI's own chrome and a mid-turn snapshot both look like "an answer" to a
// naive reader. So the target writes its final answer to a file instead.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ASK_RESULT_END_MARKER = "==== ASK RESULT END ====";

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

export function extractFinalText(content: string): string | null {
  const trimmed = content.trimEnd();
  const lines = trimmed.split("\n");
  if (lines.at(-1)?.trim() !== ASK_RESULT_END_MARKER) return null;
  return lines.slice(0, -1).join("\n").trimEnd();
}

export function createAskRunDir(exactDir?: string): string {
  const dir =
    exactDir ??
    join(
      "/tmp/q-lab/herdr/ask",
      `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
  mkdirSync(dir, { recursive: true });
  return dir;
}

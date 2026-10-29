// Pane text is not trustworthy on its own:
// a TUI's own chrome and a mid-turn snapshot both look like "an answer" to a
// naive reader. So the target writes its final answer to a file instead.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

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

export function askRunPath(
  exactDir: string | undefined,
  platform: NodeJS.Platform,
  tempRoot: string,
): string {
  if (exactDir !== undefined) return exactDir;
  const leaf = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  return platform === "win32"
    ? win32.join(tempRoot, "q-lab", "herdr", "ask", leaf)
    : posix.join("/tmp/q-lab/herdr/ask", leaf);
}

export function createAskRunDir(exactDir?: string): string {
  const dir = askRunPath(exactDir, process.platform, tmpdir());
  mkdirSync(dir, { recursive: true });
  return dir;
}

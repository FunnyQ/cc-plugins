/**
 * Where and how comment-guard records the lines it asked, so comment-sweep can
 * subtract them. Node-free because the Claude Code mod writes this ledger
 * through `$.fs` while the bun hooks write it through `node:fs`.
 */

export const DEFAULT_STATE_DIR = "/tmp/q-lab/guard";

export const fileNameSafeSessionId = (sessionId: string) => sessionId.replace(/[^\w.-]/g, "_");

export const reportedFile = (dir: string, sessionId: string) =>
  `${dir}/${fileNameSafeSessionId(sessionId)}.reported.jsonl`;

export const reportedLine = (file: string, texts: string[]) =>
  JSON.stringify({ file, texts }) + "\n";

/**
 * Per-session state shared by comment-guard (writer of what it asked) and
 * comment-sweep (the turn's baseline tree, and the reader of what was asked).
 *
 * It lives in the temp dir because losing it costs one skipped sweep, never a
 * wrong answer. Kept apart from both hooks so neither imports the other's
 * entry point.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Baseline = { root: string; tree: string };

function dir(): string {
  const path = process.env.GUARD_STATE_DIR ?? join(tmpdir(), "q-lab-guard");
  mkdirSync(path, { recursive: true });
  return path;
}

// Session ids come off stdin and become file names.
const safe = (sessionId: string) => sessionId.replace(/[^\w.-]/g, "_");
const baselinePath = (id: string) => join(dir(), `${safe(id)}.baseline.json`);
const reportedPath = (id: string) => join(dir(), `${safe(id)}.reported.jsonl`);

export function writeBaseline(sessionId: string, baseline: Baseline): void {
  writeFileSync(baselinePath(sessionId), JSON.stringify(baseline));
}

export function readBaseline(sessionId: string): Baseline | null {
  try {
    return JSON.parse(readFileSync(baselinePath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function clearBaseline(sessionId: string): void {
  rmSync(baselinePath(sessionId), { force: true });
}

export function clearReported(sessionId: string): void {
  rmSync(reportedPath(sessionId), { force: true });
}

export function recordReported(
  sessionId: string,
  file: string,
  texts: string[],
): void {
  appendFileSync(
    reportedPath(sessionId),
    JSON.stringify({ file, texts }) + "\n",
  );
}

/** Comment texts already put to the model this turn, as a multiset per file. */
export function readReported(
  sessionId: string,
): Map<string, Map<string, number>> {
  const byFile = new Map<string, Map<string, number>>();
  let raw = "";
  try {
    raw = readFileSync(reportedPath(sessionId), "utf8");
  } catch {
    return byFile;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const { file, texts } = JSON.parse(line) as {
      file: string;
      texts: string[];
    };
    const counts = byFile.get(file) ?? new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    byFile.set(file, counts);
  }
  return byFile;
}

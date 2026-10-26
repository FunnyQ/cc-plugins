import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_STATE_DIR,
  reportedFile,
  reportedLine,
  fileNameSafeSessionId,
} from "./ledger.ts";

export type Baseline = { root: string; tree: string };

function dir(): string {
  const path = process.env.GUARD_STATE_DIR ?? DEFAULT_STATE_DIR;
  mkdirSync(path, { recursive: true });
  return path;
}

const baselinePath = (id: string) =>
  join(dir(), `${fileNameSafeSessionId(id)}.baseline.json`);
const reportedPath = (id: string) => reportedFile(dir(), id);

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
  appendFileSync(reportedPath(sessionId), reportedLine(file, texts));
}

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

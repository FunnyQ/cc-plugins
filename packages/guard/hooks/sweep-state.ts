import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultStateDir,
  reportedFile,
  reportedLine,
  fileNameSafeSessionId,
} from "./ledger.ts";

export type Baseline = { root: string; tree: string };

function dir(platform = process.platform): string {
  const path =
    process.env.GUARD_STATE_DIR ?? defaultStateDir(platform, tmpdir());
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

export function ledgerKey(
  p: string,
  platform: string = process.platform,
): string {
  let head = resolve(p);
  const tail: string[] = [];
  let real = head;
  for (;;) {
    try {
      real = join(realpathSync.native(head), ...tail);
      break;
    } catch {
      const up = dirname(head);
      if (up === head) break;
      tail.unshift(basename(head));
      head = up;
    }
  }
  return platform === "win32" ? real.toLowerCase() : real;
}

export function recordReported(
  sessionId: string,
  file: string,
  texts: string[],
): void {
  appendFileSync(reportedPath(sessionId), reportedLine(ledgerKey(file), texts));
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
    const key = ledgerKey(file);
    const counts = byFile.get(key) ?? new Map<string, number>();
    for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
    byFile.set(key, counts);
  }
  return byFile;
}

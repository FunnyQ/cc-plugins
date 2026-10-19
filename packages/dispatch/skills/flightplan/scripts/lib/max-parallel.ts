import { readFile } from "node:fs/promises";

export async function readPlan(planPath: string): Promise<string | null> {
  try {
    return await readFile(planPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type MaxParallel =
  | { ok: true; declared: boolean; value: number | null }
  | { ok: false; reason: string };

const HEADER_REGEX = /^> \*\*Max parallel\*\*:[ \t]*(.*)$/m;

export function parseMaxParallel(plan: string): MaxParallel {
  const match = HEADER_REGEX.exec(plan);
  if (!match) return { ok: true, declared: false, value: null };
  const raw = match[1]!.trim();
  if (raw === "unlimited") return { ok: true, declared: true, value: null };
  if (/^[1-9]\d*$/.test(raw)) {
    return { ok: true, declared: true, value: Number(raw) };
  }
  return {
    ok: false,
    reason: `"> **Max parallel**:" must be a positive integer or \`unlimited\`, written bare — got "${raw}"`,
  };
}

const SERIAL_PROSE_REGEX =
  /execution is serial|serial execution|one task at a time|integration lock|mkdir\s+\S+\.lock\b|\btasks?\s+(?:must\s+)?run\s+(?:serially|sequentially|one at a time)/i;

export function serialProseHit(text: string): string | null {
  for (const line of text.split("\n")) {
    if (SERIAL_PROSE_REGEX.test(line)) return line.trim();
  }
  return null;
}

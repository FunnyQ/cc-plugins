// Transcript primitives shared by api.ts and rollup-update.ts. Imports nothing
// from the codebase, so neither side pays for the cycle a direct api.ts import
// would create. Anything whose two copies must agree byte-for-byte belongs here.
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

// Recursive file walk, filtered by extension. `withFileTypes` gives one syscall
// per directory instead of one stat per file.
export function walkFiles(
  dir: string,
  ext: string,
  out: string[] = [],
): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(path);
    }
  }
  return out;
}

export type DedupEntry = {
  requestId?: string;
  uuid?: string;
  message?: { id?: string };
};

export type DedupUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// Billing-dedup key for Claude Code transcript entries. Claude Code persists
// multiple snapshots for one API request (thinking / text / tool_use lines)
// that all carry identical billing usage — counting each would double-bill. The
// requestId:messageId pair identifies the request; we fall back to the entry
// uuid, then to a per-file running index so distinct unkeyed lines never
// collapse together. Pure so the keying rule is unit-testable on its own.

export function dedupKey(
  entry: DedupEntry,
  file: string,
  seenSize: number,
): string {
  return entry.requestId && entry.message?.id
    ? `${entry.requestId}:${entry.message.id}`
    : (entry.uuid ?? `${file}:${seenSize}`);
}

// The four billed token kinds.
export function usageTokenTotal(usage: DedupUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

// Tool calls in one assistant message's content — the ingest fills the ledger
// with it, api.ts counts Codex and OpenCode with it.
export function countClaudeToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "tool_use",
  ).length;
}

export type BilledTokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
};

// Add one entry's billed tokens onto a running row.
export function addBilledTokens(target: BilledTokens, usage: DedupUsage): void {
  target.input_tokens += usage.input_tokens ?? 0;
  target.output_tokens += usage.output_tokens ?? 0;
  target.cache_read += usage.cache_read_input_tokens ?? 0;
  target.cache_creation += usage.cache_creation_input_tokens ?? 0;
}

// Local hour-start in epoch ms. The rollup stores buckets under this exact
// value (see rollup-db.ts), so every producer must agree to the byte.
export function hourStartMs(timestampMs: number): number {
  if (!timestampMs) return 0;
  const d = new Date(timestampMs);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

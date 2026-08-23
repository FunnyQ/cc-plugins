// Transcript primitives shared by api.ts (the live walk) and rollup-update.ts
// (the incremental ingest). This module imports nothing from the codebase (only
// node builtins), so both sides can pull from it without the cycle that a direct
// api.ts import would create — the reason it exists. Anything whose two copies
// must agree byte-for-byte belongs here rather than duplicated with a "keep in
// lockstep" comment.
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

// Recursive file walk, filtered by extension. `withFileTypes` gives one syscall
// per directory instead of one stat per file. Shared so the rollup ingest and
// the live walk agree by construction on what counts as a file — they compare
// their results, and a drift here would look like missing tokens.
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

// Local hour-start in epoch ms. The rollup stores buckets under this exact
// value (see rollup-db.ts), so the live walk and the ingest must produce
// byte-identical keys — hence one implementation, not two.
export function hourStartMs(timestampMs: number): number {
  if (!timestampMs) return 0;
  const d = new Date(timestampMs);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

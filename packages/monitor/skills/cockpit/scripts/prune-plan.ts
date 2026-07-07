// Pure prune planner for cockpit decision logs. The registry self-reaps stale
// ENTRIES on every write (REGISTRY_TTL_MS), but the on-disk `.cockpit/logs/*.jsonl`
// FILES are never removed — so old logs (and orphans whose registry entry was
// already reaped) accumulate forever. Given the registry plus a scan of the
// on-disk log files across known project roots, decide which files to trash and
// which registry entries to drop. Side-effect-free — the caller scans and deletes.
import { basename } from "node:path";
import type { RegistryEntry } from "./registry";

// One on-disk decision log the caller found under a project's `.cockpit/logs/`.
export type LogFile = {
  path: string; // absolute path to the .jsonl
  mtimeMs: number; // file mtime; 0 if unknown/unreadable
};

export type PrunePlan = {
  trash: string[]; // log file paths to remove
  dropSessionIds: string[]; // registry sessionIds to drop
  keptFiles: number; // on-disk logs left in place
  keptEntries: number; // registry entries left in place
};

// Default cutoff — matches the registry's own reap window so `prune` and the
// automatic write-time reap agree on what "stale" means.
export const DEFAULT_PRUNE_DAYS = 14;

// A log/entry is prunable when its most-recent signal is at least `cutoffMs` old.
// The signal is max(registry heartbeat, file mtime): a session can stay live well
// past its last heartbeat write, so the file's mtime alone can keep it alive.
export function planPrune(
  entries: RegistryEntry[],
  logFiles: LogFile[],
  now: number,
  cutoffMs: number,
): PrunePlan {
  const entryBySession = new Map<string, RegistryEntry>();
  for (const e of entries) entryBySession.set(e.sessionId, e);

  const trash: string[] = [];
  const dropSessionIds = new Set<string>();
  let keptFiles = 0;

  // Pass 1: every on-disk log file — tracked (has a registry entry) or orphaned.
  const filesOnDisk = new Set<string>();
  for (const f of logFiles) {
    const sessionId = basename(f.path).replace(/\.jsonl$/, "");
    filesOnDisk.add(sessionId);
    const entry = entryBySession.get(sessionId);
    const hb = entry ? Date.parse(entry.lastHeartbeat) : NaN;
    const lastSignal = Math.max(Number.isNaN(hb) ? 0 : hb, f.mtimeMs);
    if (now - lastSignal >= cutoffMs) {
      trash.push(f.path);
      if (entry) dropSessionIds.add(sessionId);
    } else {
      keptFiles++;
    }
  }

  // Pass 2: dangling registry entries — the log file is already gone AND the
  // heartbeat is stale. Drop them so the registry stops stat()ing a dead path.
  for (const e of entries) {
    if (filesOnDisk.has(e.sessionId)) continue; // handled in pass 1
    const hb = Date.parse(e.lastHeartbeat);
    if (now - (Number.isNaN(hb) ? 0 : hb) >= cutoffMs) {
      dropSessionIds.add(e.sessionId);
    }
  }

  return {
    trash,
    dropSessionIds: [...dropSessionIds],
    keptFiles,
    keptEntries: entries.length - dropSessionIds.size,
  };
}

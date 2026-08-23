#!/usr/bin/env bun
// Incremental ingest for the usage rollup DB. On each run it tail-parses only the
// bytes appended to each transcript since last time (tracked by
// ingested_files.bytes_parsed), dedups billing per API request via seen_requests,
// and additively upserts token totals into usage_hourly. A file that shrank below
// its recorded bytes_parsed (truncated/rewritten) can't be reconciled additively,
// so any truncation triggers a full rebuild.
//
// Kept free of any api.ts import so api.ts can call updateRollup() without a
// cycle. The parse helpers and the transcript walk both sides need live in
// dedup.ts, which imports nothing from the codebase — sharing them there keeps
// the hour buckets identical by construction instead of by hand.

import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  dedupKey,
  hourStartMs,
  usageTokenTotal,
  walkFiles,
  type DedupUsage,
} from "./dedup";
import { PROJECTS_DIR } from "./paths";
import {
  addHourlyRow,
  clearIngestedFile,
  clearSeenRequestsForFile,
  getIngestedFile,
  hasSeenRequest,
  markSeenRequest,
  openRollupDb,
  resetRollup,
  upsertIngestedFile,
  type HourlyRow,
} from "./rollup-db";

type TranscriptEntry = {
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  type?: string;
  cwd?: string;
  message?: { id?: string; model?: string; usage?: DedupUsage };
};

type ParsedSlice = {
  rows: Map<string, HourlyRow>;
  requestKeys: string[];
};

// Parse a UTF-8 tail slice (already cut at \n byte boundaries) into per-bucket
// token sums. `seenRun` is the in-run dedup set; `dbSeen` checks the persistent
// seen_requests so a request already billed in a prior run is never re-counted.
function parseSlice(
  text: string,
  file: string,
  seenRun: Set<string>,
  dbSeen: (key: string) => boolean,
): ParsedSlice {
  const rows = new Map<string, HourlyRow>();
  const requestKeys: string[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const model = entry.message?.model;
    const usage = entry.message?.usage;
    if (entry.type !== "assistant" || !model || !usage) continue;
    if (model === "<synthetic>" || usageTokenTotal(usage) === 0) continue;

    const key = dedupKey(entry, file, seenRun.size);
    if (seenRun.has(key) || dbSeen(key)) continue;
    seenRun.add(key);
    requestKeys.push(key);

    const parsedTs = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    const timestampMs = Number.isFinite(parsedTs) ? parsedTs : 0;
    const hour_ms = hourStartMs(timestampMs);
    const project = entry.cwd ?? "";
    const bucketKey = JSON.stringify([hour_ms, project, model]);

    let row = rows.get(bucketKey);
    if (!row) {
      row = {
        hour_ms,
        project,
        model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 0,
        cache_creation: 0,
        reasoning: 0,
        message_count: 0,
      };
      rows.set(bucketKey, row);
    }
    row.input_tokens += usage.input_tokens ?? 0;
    row.output_tokens += usage.output_tokens ?? 0;
    row.cache_read += usage.cache_read_input_tokens ?? 0;
    row.cache_creation += usage.cache_creation_input_tokens ?? 0;
    row.message_count += 1;
  }

  return { rows, requestKeys };
}

// Ingest one file's newly-appended complete lines. Returns false to signal the
// caller that a truncation was detected and a full rebuild is required.
function ingestFile(db: Database, file: string, nowMs: number): boolean {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(file);
    size = st.size;
    mtimeMs = Math.floor(st.mtimeMs);
  } catch {
    return true;
  }

  const prior = getIngestedFile(db, file);
  const startByte = prior?.bytes_parsed ?? 0;

  // Shrunk below what we already consumed → can't reconcile additively.
  if (prior && size < prior.bytes_parsed) return false;
  // Nothing new since last complete-line boundary.
  if (size <= startByte) return true;

  // Read only the appended bytes. A live session transcript grows to tens of MB
  // while each run ingests a few KB, so reading the whole file to slice off the
  // tail is the single most wasteful thing this function could do.
  let tail: Buffer;
  try {
    const fd = openSync(file, "r");
    try {
      tail = Buffer.allocUnsafe(size - startByte);
      readSync(fd, tail, 0, tail.length, startByte);
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }

  // Only consume up to the last newline; a trailing partial line (file still
  // being written) waits for the next run. Slicing the Buffer at \n bytes is
  // UTF-8 safe — 0x0a never occurs inside a multibyte sequence.
  const lastNl = tail.lastIndexOf(0x0a);
  const boundary = lastNl < 0 ? startByte : startByte + lastNl + 1;
  if (boundary <= startByte) {
    // Grew, but no new *complete* line yet — leave bytes_parsed where it is.
    upsertIngestedFile(
      db,
      { path: file, bytes_parsed: startByte, mtime_ms: mtimeMs },
      nowMs,
    );
    return true;
  }

  const text = tail.subarray(0, boundary - startByte).toString("utf-8");
  const seenRun = new Set<string>();
  const { rows, requestKeys } = parseSlice(text, file, seenRun, (k) =>
    hasSeenRequest(db, k),
  );

  const apply = db.transaction(() => {
    for (const row of rows.values()) addHourlyRow(db, row);
    for (const k of requestKeys) markSeenRequest(db, k, file);
    upsertIngestedFile(
      db,
      { path: file, bytes_parsed: boundary, mtime_ms: mtimeMs },
      nowMs,
    );
  });
  apply();
  return true;
}

export type UpdateResult = {
  filesScanned: number;
  rebuilt: boolean;
};

// Incremental update entry point. `rebuild: true` (or a detected truncation)
// clears all rollup state and re-ingests every file from byte 0.
export function updateRollup(
  db: Database,
  opts: {
    rebuild?: boolean;
    nowMs?: number;
    projectsDir?: string;
    /** Transcript paths the caller already walked, to skip a second traversal. */
    files?: string[];
  } = {},
): UpdateResult {
  const nowMs = opts.nowMs ?? Date.now();
  const files =
    opts.files ?? walkFiles(opts.projectsDir ?? PROJECTS_DIR, ".jsonl");

  let rebuilt = false;
  if (opts.rebuild) {
    db.transaction(() => resetRollup(db))();
    rebuilt = true;
  }

  for (let i = 0; i < files.length; i++) {
    const ok = ingestFile(db, files[i], nowMs);
    if (!ok) {
      // Truncation → blow away and restart from a clean slate, once.
      db.transaction(() => resetRollup(db))();
      rebuilt = true;
      for (const f of files) ingestFile(db, f, nowMs);
      break;
    }
  }

  // Forget files that no longer exist on disk so ingested_files doesn't grow
  // unbounded. Their already-aggregated tokens stay in usage_hourly (that's the
  // whole point — history outlives the deleted transcript).
  pruneMissingFiles(db, new Set(files));

  return { filesScanned: files.length, rebuilt };
}

function pruneMissingFiles(db: Database, present: Set<string>): void {
  const known = db.query("SELECT path FROM ingested_files").all() as {
    path: string;
  }[];
  const remove = db.transaction(() => {
    for (const { path } of known) {
      if (!present.has(path)) {
        clearIngestedFile(db, path);
        // Drop the file's dedup keys too — usage_hourly keeps its tokens, but the
        // bookkeeping is no longer needed and would otherwise grow forever.
        clearSeenRequestsForFile(db, path);
      }
    }
  });
  remove();
}

// CLI: `bun rollup-update.ts [--rebuild] [--db <path>]`
if (import.meta.main) {
  const args = process.argv.slice(2);
  const rebuild = args.includes("--rebuild");
  const dbFlag = args.indexOf("--db");
  const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : undefined;
  const db = openRollupDb(dbPath);
  const result = updateRollup(db, { rebuild });
  const rows = db.query("SELECT COUNT(*) AS n FROM usage_hourly").get() as {
    n: number;
  };
  console.log(JSON.stringify({ ...result, usageHourlyRows: rows.n }, null, 2));
  db.close();
}

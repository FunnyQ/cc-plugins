#!/usr/bin/env bun
// Incremental ingest for the usage rollup DB. On each run it tail-parses only the
// bytes appended to each transcript since last time (tracked by
// ingested_files.bytes_parsed), dedups billing per API request via seen_requests,
// and additively upserts token totals into usage_hourly. Truncation replays
// transcripts with existing dedup keys so already-billed history survives.
//
// Kept free of any api.ts import so api.ts can call updateRollup() without a
// cycle. The parse helpers and the transcript walk both sides need live in
// dedup.ts, which imports nothing from the codebase — sharing them there keeps
// the hour buckets identical by construction instead of by hand.

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import {
  readJsonlLines,
  type LineCursor,
} from "../../shared/scripts/jsonl-lines";
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
  rewindRollup,
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

// Fold complete lines into per-bucket token sums. `seenRun` dedups within the
// run; `dbSeen` checks seen_requests so a prior run's billing never repeats.
function parseSlice(
  lines: Iterable<string>,
  file: string,
  seenRun: Set<string>,
  dbSeen: (key: string) => boolean,
): ParsedSlice {
  const rows = new Map<string, HourlyRow>();
  const requestKeys: string[] = [];

  for (const line of lines) {
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
    if (seenRun.has(key)) continue;
    seenRun.add(key);
    if (dbSeen(key)) continue;
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
// caller that a truncation was detected and a deduplicated replay is required.
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

  // Replay from byte zero when a rewrite invalidates the cursor.
  if (prior && size < prior.bytes_parsed) return false;
  // Nothing new since last complete-line boundary.
  if (size <= startByte) return true;

  // Streamed, not sliced whole: on a cold `startByte = 0` (fresh DB, --rebuild,
  // schema bump, detected truncation) the appended bytes are the entire file.
  // `emitPartial: false` leaves a half-written line for the next run; the cursor
  // reports the boundary the old `lastIndexOf(0x0a)` computed.
  const cursor: LineCursor = { bytesConsumed: startByte };
  const seenRun = new Set<string>();
  const { rows, requestKeys } = parseSlice(
    readJsonlLines(file, { start: startByte, emitPartial: false, cursor }),
    file,
    seenRun,
    (k) => hasSeenRequest(db, k),
  );

  const boundary = cursor.bytesConsumed;
  if (boundary <= startByte) {
    // Grew, but no new *complete* line yet — leave bytes_parsed where it is.
    // An unreadable file lands here too, and is likewise left for the next run.
    upsertIngestedFile(
      db,
      { path: file, bytes_parsed: startByte, mtime_ms: mtimeMs },
      nowMs,
    );
    return true;
  }

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
// replays every file from byte 0 while retaining totals and dedup keys.
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
    db.transaction(() => rewindRollup(db))();
    rebuilt = true;
  }

  for (let i = 0; i < files.length; i++) {
    const ok = ingestFile(db, files[i], nowMs);
    if (!ok) {
      // Keep billed history even when rewritten transcripts omit old requests.
      db.transaction(() => rewindRollup(db))();
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

// CLI: `bun rollup-update.ts [--rebuild] [--db <path>]` (--rebuild preserves history).
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

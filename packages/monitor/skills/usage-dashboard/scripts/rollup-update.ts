#!/usr/bin/env bun
// Incremental ingest for the usage rollup DB. On each run it tail-parses only the
// bytes appended to each transcript since last time (tracked by
// ingested_files.bytes_parsed), dedups billing per API request via seen_requests,
// and additively upserts token totals into usage_hourly. Truncation replays
// transcripts with existing dedup keys so already-billed history survives.
//
// Kept free of any api.ts import so api.ts can call updateRollup() without a
// cycle; the primitives both sides need live in dedup.ts.

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import {
  readJsonlLines,
  type LineCursor,
} from "../../shared/scripts/jsonl-lines";
import {
  addBilledTokens,
  countClaudeToolCalls,
  dedupKey,
  hourStartMs,
  usageTokenTotal,
  walkFiles,
  type DedupUsage,
} from "./dedup";
import { PROJECTS_DIR } from "./paths";
import {
  addHourlyRow,
  addLedgerModelRow,
  addLedgerRow,
  clearIngestedFile,
  clearLedgerForFile,
  clearSeenRequestsForFile,
  getIngestedFile,
  hasSeenRequest,
  getMeta,
  hasSeenToolCall,
  LEDGER_REBUILD_PENDING,
  markSeenRequest,
  markSeenToolCall,
  openRollupDb,
  rewindRollup,
  setMeta,
  pruneSeenToolCalls,
  upsertIngestedFile,
  type HourlyRow,
  type LedgerFileRow,
  type LedgerModelRow,
} from "./rollup-db";

type TranscriptEntry = {
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  type?: string;
  cwd?: string;
  isMeta?: boolean;
  sessionId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: DedupUsage;
    content?: unknown;
  };
};

type ParsedSlice = {
  rows: Map<string, HourlyRow>;
  requestKeys: string[];
  ledger: Map<string, LedgerFileRow>;
  ledgerModels: Map<string, LedgerModelRow>;
  toolKeys: Array<{ sessionKey: string; key: string }>;
};

// Folds complete lines into per-bucket token sums and per-session ledger rows.
// `ledgerDuplicate` is a second gate, separate from `dbSeen`: a file whose ledger
// rows were just cleared must ignore seen_requests to re-derive them, while every
// other read honours it — including the first read of a brand-new file, whose
// requests a sibling transcript may already have recorded.
function parseSlice(
  lines: Iterable<string>,
  file: string,
  seenRun: Set<string>,
  dbSeen: (key: string) => boolean,
  opts: {
    ledgerRebuild: boolean;
    ledgerSeen: Set<string>;
    toolSeen: (sessionKey: string, key: string) => boolean;
  },
): ParsedSlice {
  const rows = new Map<string, HourlyRow>();
  const requestKeys: string[] = [];
  const ledger = new Map<string, LedgerFileRow>();
  const ledgerModels = new Map<string, LedgerModelRow>();
  const toolKeys: Array<{ sessionKey: string; key: string }> = [];
  const fallbackSession = file.split("/").at(-1) ?? file;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Every line feeds the ledger, not just billed assistant turns.
    const sessionKey = entry.sessionId ?? fallbackSession;
    const parsedTs = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    const timestampMs = Number.isFinite(parsedTs) ? parsedTs : 0;
    let row = ledger.get(sessionKey);
    if (!row) {
      row = {
        path: file,
        session_key: sessionKey,
        project: "",
        project_ts_ms: 0,
        last_ts_ms: 0,
        interactions: 0,
        tool_calls: 0,
      };
      ledger.set(sessionKey, row);
    }
    if (timestampMs > row.last_ts_ms) row.last_ts_ms = timestampMs;
    // Earliest cwd wins within this file; addLedgerRow's upsert applies the same
    // rule across the files one session spans.
    if (
      entry.cwd &&
      (!row.project ||
        (timestampMs > 0 &&
          (row.project_ts_ms === 0 || timestampMs < row.project_ts_ms)))
    ) {
      row.project = entry.cwd;
      row.project_ts_ms = timestampMs;
    }
    if (entry.type === "user" && !entry.isMeta) row.interactions += 1;
    const contentToolCalls = countClaudeToolCalls(entry.message?.content);
    if (contentToolCalls > 0) {
      const toolKey =
        entry.message?.id ?? entry.uuid ?? `${file}:${timestampMs}`;
      if (!opts.toolSeen(sessionKey, toolKey)) {
        toolKeys.push({ sessionKey, key: toolKey });
        row.tool_calls += contentToolCalls;
      }
    }

    const model = entry.message?.model;
    const usage = entry.message?.usage;
    if (entry.type !== "assistant" || !model || !usage) continue;
    if (model === "<synthetic>" || usageTokenTotal(usage) === 0) continue;

    const key = dedupKey(entry, file, seenRun.size);
    if (seenRun.has(key)) continue;
    seenRun.add(key);
    const billedBefore = dbSeen(key);

    // One request can appear in both a parent transcript and its subagent's, so a
    // rebuild dedups across files against its own set, not seen_requests.
    const ledgerDuplicate = opts.ledgerRebuild
      ? opts.ledgerSeen.has(key)
      : billedBefore;
    if (opts.ledgerRebuild) opts.ledgerSeen.add(key);
    if (!ledgerDuplicate) {
      const modelKey = `${sessionKey}\u0000${model}`;
      let mrow = ledgerModels.get(modelKey);
      if (!mrow) {
        mrow = {
          path: file,
          session_key: sessionKey,
          model,
          input_tokens: 0,
          output_tokens: 0,
          cache_read: 0,
          cache_creation: 0,
        };
        ledgerModels.set(modelKey, mrow);
      }
      addBilledTokens(mrow, usage);
    }

    if (billedBefore) continue;
    requestKeys.push(key);

    const hour_ms = hourStartMs(timestampMs);
    const project = entry.cwd ?? "";
    const bucketKey = JSON.stringify([hour_ms, project, model]);

    let bucket = rows.get(bucketKey);
    if (!bucket) {
      bucket = {
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
      rows.set(bucketKey, bucket);
    }
    addBilledTokens(bucket, usage);
    bucket.message_count += 1;
  }

  return {
    rows,
    requestKeys,
    ledger,
    ledgerModels,
    toolKeys,
  };
}

// Ingest one file's newly-appended complete lines. Returns false to signal the
// caller that a truncation was detected and a deduplicated replay is required.
type IngestContext = {
  nowMs: number;
  /** Files whose ledger rows are being re-derived from scratch this run. */
  ledgerRebuild: Set<string>;
  /** Cross-file dedup, valid only across the files in `ledgerRebuild`. */
  ledgerSeen: Set<string>;
};

function ingestFile(db: Database, file: string, ctx: IngestContext): boolean {
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

  if (prior && size < prior.bytes_parsed) return false;

  // Not the same question as `startByte === 0`: a brand-new file also starts at
  // zero, but its requests may already sit in a sibling transcript's ledger rows,
  // so it must stay gated on seen_requests. Only a rebuild ignores that table.
  const ledgerRebuild = ctx.ledgerRebuild.has(file);
  // Every exit path has to drop the stale rows, not just the one that rewrites
  // them — a transcript truncated to empty never reaches the apply below.
  const dropStaleLedger = () => {
    if (ledgerRebuild) db.transaction(() => clearLedgerForFile(db, file))();
  };

  // Nothing new since last complete-line boundary.
  if (size <= startByte) {
    dropStaleLedger();
    return true;
  }

  // Streamed, not sliced whole: on a cold `startByte = 0` (fresh DB, --rebuild,
  // schema bump, detected truncation) the appended bytes are the entire file.
  // `emitPartial: false` leaves a half-written line for the next run; the cursor
  // reports the boundary the old `lastIndexOf(0x0a)` computed.
  const toolSeenRun = new Set<string>();
  const cursor: LineCursor = { bytesConsumed: startByte };
  const seenRun = new Set<string>();
  const { rows, requestKeys, ledger, ledgerModels, toolKeys } = parseSlice(
    readJsonlLines(file, { start: startByte, emitPartial: false, cursor }),
    file,
    seenRun,
    (k) => hasSeenRequest(db, k),
    {
      ledgerRebuild,
      ledgerSeen: ctx.ledgerSeen,
      // In-run set first — the table is only written at the end of the slice.
      toolSeen: (sessionKey, k) => {
        const scoped = `${sessionKey}\u0000${k}`;
        if (toolSeenRun.has(scoped)) return true;
        toolSeenRun.add(scoped);
        return hasSeenToolCall(db, sessionKey, k);
      },
    },
  );

  const boundary = cursor.bytesConsumed;
  if (boundary <= startByte) {
    // Grew, but no new *complete* line yet — leave bytes_parsed where it is.
    // An unreadable file lands here too, and is likewise left for the next run.
    dropStaleLedger();
    upsertIngestedFile(
      db,
      { path: file, bytes_parsed: startByte, mtime_ms: mtimeMs },
      ctx.nowMs,
    );
    return true;
  }

  const apply = db.transaction(() => {
    for (const row of rows.values()) addHourlyRow(db, row);
    for (const k of requestKeys) markSeenRequest(db, k, file);
    // Without the clear, a rebuild would double interactions and tool_calls.
    if (ledgerRebuild) clearLedgerForFile(db, file);
    for (const row of ledger.values()) addLedgerRow(db, row);
    for (const row of ledgerModels.values()) addLedgerModelRow(db, row);
    for (const t of toolKeys) markSeenToolCall(db, t.sessionKey, t.key);
    upsertIngestedFile(
      db,
      { path: file, bytes_parsed: boundary, mtime_ms: mtimeMs },
      ctx.nowMs,
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
// replays every file from byte 0.
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

  // Prune before ingesting, not after: a departing file can take counts its
  // session's surviving files still provide, and those survivors have to be
  // re-derived in this same run rather than the next one.
  const ledgerRebuild = pruneMissingFiles(db, new Set(files));

  let rebuilt = false;
  const markAll = () => {
    for (const f of files) ledgerRebuild.add(f);
  };
  if (opts.rebuild) {
    db.transaction(() => rewindRollup(db))();
    rebuilt = true;
    markAll();
  } else if (getMeta(db, LEDGER_REBUILD_PENDING) === "1") {
    // A migration already rewound the cursors; it could not mark the files.
    rebuilt = true;
    markAll();
  }

  const ctx: IngestContext = { nowMs, ledgerRebuild, ledgerSeen: new Set() };
  for (let i = 0; i < files.length; i++) {
    if (ingestFile(db, files[i], ctx)) continue;
    db.transaction(() => rewindRollup(db))();
    rebuilt = true;
    markAll();
    ctx.ledgerSeen.clear();
    for (const f of files) ingestFile(db, f, ctx);
    break;
  }

  setMeta(db, LEDGER_REBUILD_PENDING, "0");
  return { filesScanned: files.length, rebuilt };
}

// Forgets files that no longer exist so ingested_files does not grow unbounded.
// Their aggregated tokens stay in usage_hourly — history outlives the transcript.
//
// Returns the surviving files whose ledger rows must be re-derived. Cross-file
// dedup credits a shared request or tool call to whichever file was read first;
// when that file leaves, the copy that survives it would otherwise never re-add
// the counts, because its cursor never moved.
function pruneMissingFiles(db: Database, present: Set<string>): Set<string> {
  const known = db.query("SELECT path FROM ingested_files").all() as {
    path: string;
  }[];
  const missing = known.map((k) => k.path).filter((p) => !present.has(p));
  if (missing.length === 0) return new Set();

  const sessionsOf = db.query(
    "SELECT DISTINCT session_key FROM session_ledger WHERE path = ?",
  );
  const sessionsByPath = new Map<string, string[]>();
  const disturbed = new Set<string>();
  for (const path of missing) {
    const keys = (sessionsOf.all(path) as { session_key: string }[]).map(
      (r) => r.session_key,
    );
    sessionsByPath.set(path, keys);
    for (const k of keys) disturbed.add(k);
  }

  db.transaction(() => {
    for (const path of missing) {
      clearIngestedFile(db, path);
      clearLedgerForFile(db, path);
    }
  })();

  const filesOf = db.query(
    "SELECT DISTINCT path FROM session_ledger WHERE session_key = ?",
  );
  const survivors = new Set<string>();
  const livingSessions = new Set<string>();
  for (const session of disturbed) {
    const paths = filesOf.all(session) as { path: string }[];
    if (paths.length === 0) continue;
    livingSessions.add(session);
    for (const r of paths) survivors.add(r.path);
  }

  const finish = db.transaction(() => {
    // A departing file's billing keys are dropped only once nothing else holds
    // them. Dropping them while a sibling transcript still carries the same
    // request would let the rewind below bill usage_hourly for it a second time.
    for (const path of missing) {
      const shared = sessionsByPath
        .get(path)!
        .some((k) => livingSessions.has(k));
      if (!shared) clearSeenRequestsForFile(db, path);
    }
    const dropTools = db.query(
      "DELETE FROM seen_tool_calls WHERE session_key = ?",
    );
    for (const session of livingSessions) dropTools.run(session);
    const rewind = db.query(
      "UPDATE ingested_files SET bytes_parsed = 0 WHERE path = ?",
    );
    for (const path of survivors) {
      clearLedgerForFile(db, path);
      rewind.run(path);
    }
  });
  finish();

  // After the ledger rows go, so a fully-deleted session drops its tool keys too.
  pruneSeenToolCalls(db);
  return survivors;
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

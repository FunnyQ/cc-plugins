#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeTempPayload } from "../../../shared/scripts/temp-payload";
import {
  gitRootOf,
  logRoot,
  readDecisionLog,
  type DecisionRecord,
} from "../../../shared/scripts/cockpit-trail";

export type Bucket = "inbox" | "watch" | "done";

export type SessionFile = {
  sessionId: string;
  path: string;
  bucket: Bucket;
  mtimeMs: number;
  entryCount: number;
};

/** Pass 1 output. Deliberately omits reason, tradeoff, facets, options, diagram. */
export type EntrySkeleton = {
  id: string;
  sessionId: string;
  kind: DecisionRecord["kind"];
  decision: string;
  timestamp: string;
  files: string[];
};

export type AdrContext = {
  trailRoot: string;
  hasTrail: boolean;
  sessions: SessionFile[];
  skeletons: EntrySkeleton[];
  adrDir: string;
  error?: string;
};

/** A full record plus the session it came from. `DecisionRecord` alone has no session field. */
export type EntryBody = DecisionRecord & { sessionId: string };

type SessionRecords = {
  session: SessionFile;
  records: DecisionRecord[];
};

/** Trail root and record directory, resolved from ONE `git rev-parse`. */
type Roots = { trailRoot: string; adrDir: string };

export function toSkeleton(
  record: DecisionRecord,
  sessionId: string,
): EntrySkeleton {
  return {
    id: record.id,
    sessionId,
    kind: record.kind,
    decision: record.decision,
    timestamp: record.timestamp,
    files: record.files,
  };
}

// Both roots come from the same `git rev-parse`. Resolving them separately spawned
// git up to three times per run and let the two answers drift under a symlinked cwd.
function resolveRoots(cwd: string): Roots {
  const gitRoot = gitRootOf(cwd);
  return {
    trailRoot: logRoot(cwd, { gitRoot: () => gitRoot }),
    adrDir: join(gitRoot ?? cwd, "docs", "adr"),
  };
}

async function globPaths(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];

  const paths: string[] = [];
  const glob = new Bun.Glob("*.jsonl");
  for await (const path of glob.scan({ cwd: directory, absolute: true })) {
    paths.push(path);
  }
  return paths.sort();
}

async function readSession(
  path: string,
  bucket: Bucket,
): Promise<SessionRecords | null> {
  try {
    // readDecisionLog already drops every line that fails isDecisionRecord.
    const [metadata, records] = await Promise.all([
      stat(path),
      readDecisionLog(path),
    ]);
    const sessionId = basename(path, ".jsonl");

    return {
      session: {
        sessionId,
        path,
        bucket,
        mtimeMs: metadata.mtimeMs,
        entryCount: records.length,
      },
      records,
    };
  } catch {
    return null;
  }
}

async function readBucket(
  trailRoot: string,
  relativeDirectory: string,
  bucket: Bucket,
): Promise<SessionRecords[]> {
  const paths = await globPaths(join(trailRoot, ".cockpit", relativeDirectory));
  const sessions = await Promise.all(
    paths.map((path) => readSession(path, bucket)),
  );
  return sessions.filter(
    (session): session is SessionRecords => session !== null,
  );
}

// Always read inbox and watched sessions. Only optionally read the done archive,
// because pulling the whole archive into a triage run defeats the point of an inbox.
// Sessions come from .cockpit/logs/ and .cockpit/archive/watch/, not the cockpit
// registry, because the registry reaps entries older than 14 days on every write.
// This repo measured 63 log files in `.cockpit/logs/` against 27 matching registry
// entries. Reading the directories instead preserves the full session history.
async function readBuckets(
  trailRoot: string,
  includeDone: boolean,
): Promise<SessionRecords[]> {
  const buckets = [
    readBucket(trailRoot, "logs", "inbox"),
    readBucket(trailRoot, "archive/watch", "watch"),
  ];
  if (includeDone) {
    buckets.push(readBucket(trailRoot, "archive/done", "done"));
  }
  return (await Promise.all(buckets)).flat();
}

export async function collectContext(
  cwd: string,
  opts: { includeDone?: boolean } = {},
): Promise<AdrContext> {
  const { trailRoot, adrDir } = resolveRoots(cwd);
  if (!existsSync(join(trailRoot, ".cockpit"))) {
    return {
      trailRoot: "",
      hasTrail: false,
      sessions: [],
      skeletons: [],
      adrDir,
    };
  }

  const collected = await readBuckets(trailRoot, opts.includeDone === true);

  return {
    trailRoot,
    hasTrail: true,
    sessions: collected.map(({ session }) => session),
    skeletons: collected.flatMap(({ session, records }) =>
      records.map((record) => toSkeleton(record, session.sessionId)),
    ),
    adrDir,
  };
}

export async function fetchBodies(
  cwd: string,
  ids: string[],
): Promise<EntryBody[]> {
  if (ids.length === 0) return [];

  const { trailRoot } = resolveRoots(cwd);
  if (!existsSync(join(trailRoot, ".cockpit"))) return [];

  const requested = new Set(ids);
  // Bodies are fetched for an already-shortlisted set, so the done archive is in
  // scope here even when the skeleton pass excluded it.
  const collected = await readBuckets(trailRoot, true);

  return collected.flatMap(({ session, records }) =>
    records
      .filter((record) => requested.has(record.id))
      .map((record) => ({ ...record, sessionId: session.sessionId })),
  );
}

export function parseCliArgs(argv: string[]): {
  includeDone: boolean;
  bodyIds: string[] | null;
} {
  let includeDone = false;
  let bodyIds: string[] | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-done") {
      includeDone = true;
    } else if (argument === "--bodies") {
      // Reject rather than ignore. An agent file that drifted to `--ids` or
      // `--include-archived` used to be silently downgraded to a skeleton run,
      // and the caller only noticed by the missing evidence three steps later.
      const value = argv[index + 1];
      if (value === undefined) throw new Error(usage());
      bodyIds = value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      index += 1;
    } else {
      throw new Error(usage());
    }
  }

  return { includeDone, bodyIds };
}

function usage(): string {
  return "Usage: bun collect-adr-context.ts [--include-done] [--bodies <id,id,...>]";
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const { includeDone, bodyIds } = parseCliArgs(process.argv.slice(2));
  const { trailRoot, adrDir } = resolveRoots(cwd);
  const hasTrail = existsSync(join(trailRoot, ".cockpit"));

  // Bodies mode skips the skeleton pass entirely: running both read every session
  // log twice per invocation for two fields main already has.
  const payload =
    bodyIds === null
      ? await collectContext(cwd, { includeDone })
      : await fetchBodies(cwd, bodyIds);
  const outputPath = await writeTempPayload("adr", "context", payload);

  const sessionCount = Array.isArray(payload)
    ? new Set(payload.map(({ sessionId }) => sessionId)).size
    : payload.sessions.length;
  const entryCount = Array.isArray(payload)
    ? payload.length
    : payload.skeletons.length;

  console.log(
    JSON.stringify({ outputPath, hasTrail, sessionCount, entryCount, adrDir }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

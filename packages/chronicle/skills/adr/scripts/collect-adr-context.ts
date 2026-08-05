#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  gitRootOf,
  isDecisionRecord,
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
    const [metadata, parsed] = await Promise.all([
      stat(path),
      readDecisionLog(path),
    ]);
    const records = parsed.filter(isDecisionRecord);
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

function emptyContext(cwd: string): AdrContext {
  return {
    trailRoot: "",
    hasTrail: false,
    sessions: [],
    skeletons: [],
    adrDir: join(gitRootOf(cwd) ?? cwd, "docs", "adr"),
  };
}

export async function collectContext(
  cwd: string,
  opts: { includeDone?: boolean } = {},
): Promise<AdrContext> {
  const resolvedTrailRoot = logRoot(cwd);
  const cockpitDir = join(resolvedTrailRoot, ".cockpit");
  if (!existsSync(cockpitDir)) return emptyContext(cwd);

  // Always read inbox and watched sessions. Only optionally read the done archive,
  // because pulling the whole archive into a triage run defeats the point of an inbox.
  // Sessions come from .cockpit/logs/ and .cockpit/archive/watch/, not the cockpit
  // registry, because the registry reaps entries older than 14 days on every write.
  // This repo measured 63 log files in `.cockpit/logs/` against 27 matching registry
  // entries. Reading the directories instead preserves the full session history.
  const buckets = [
    readBucket(resolvedTrailRoot, "logs", "inbox"),
    readBucket(resolvedTrailRoot, "archive/watch", "watch"),
  ];
  if (opts.includeDone) {
    buckets.push(readBucket(resolvedTrailRoot, "archive/done", "done"));
  }
  const collected = (await Promise.all(buckets)).flat();

  return {
    trailRoot: resolvedTrailRoot,
    hasTrail: true,
    sessions: collected.map(({ session }) => session),
    skeletons: collected.flatMap(({ session, records }) =>
      records.map((record) => toSkeleton(record, session.sessionId)),
    ),
    adrDir: join(gitRootOf(cwd) ?? cwd, "docs", "adr"),
  };
}

export async function fetchBodies(
  cwd: string,
  ids: string[],
): Promise<EntryBody[]> {
  if (ids.length === 0) return [];

  const resolvedTrailRoot = logRoot(cwd);
  if (!existsSync(join(resolvedTrailRoot, ".cockpit"))) return [];

  const requested = new Set(ids);
  const buckets = await Promise.all([
    readBucket(resolvedTrailRoot, "logs", "inbox"),
    readBucket(resolvedTrailRoot, "archive/watch", "watch"),
    readBucket(resolvedTrailRoot, "archive/done", "done"),
  ]);

  return buckets
    .flat()
    .flatMap(({ session, records }) =>
      records
        .filter((record) => requested.has(record.id))
        .map((record) => ({ ...record, sessionId: session.sessionId })),
    );
}

function parseCliArgs(argv: string[]): {
  includeDone: boolean;
  bodyIds: string[] | null;
} {
  const bodiesIndex = argv.indexOf("--bodies");
  const bodyIds =
    bodiesIndex === -1
      ? null
      : (argv[bodiesIndex + 1] ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);

  return { includeDone: argv.includes("--include-done"), bodyIds };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const { includeDone, bodyIds } = parseCliArgs(process.argv.slice(2));
  const context = await collectContext(cwd, { includeDone });
  const payload = bodyIds === null ? context : await fetchBodies(cwd, bodyIds);
  const outputDir = "/tmp/chronicle/adr";
  const outputPath = join(
    outputDir,
    `context-${Date.now()}-${process.pid}.json`,
  );

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  const sessionCount =
    bodyIds === null
      ? context.sessions.length
      : new Set(payload.map(({ sessionId }) => sessionId)).size;
  const entryCount =
    bodyIds === null ? context.skeletons.length : payload.length;
  console.log(
    JSON.stringify({
      outputPath,
      hasTrail: context.hasTrail,
      sessionCount,
      entryCount,
      adrDir: context.adrDir,
    }),
  );
}

if (import.meta.main) {
  await main();
}

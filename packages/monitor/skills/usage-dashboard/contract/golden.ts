// Helpers for golden.contract.test.ts. The golden files were recorded from the TS
// through these same helpers, so recording and comparing could not drift apart.
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  FIXTURE_IDS,
  FIXTURE_NOW_MS,
  FIXTURE_PROJECTS,
  makeFixtureHome,
} from "./fixtures";
import { atlasCommand, type AtlasSub } from "./launcher";

export const GOLDEN_DIR = join(import.meta.dir, "golden");

// contracts.md §6, in payload order.
export const STATS_KEYS = [
  "period",
  "summary",
  "byModel",
  "pricingMeta",
  "budget",
  "usageLimits",
  "codexUsageLimits",
  "dataHealth",
  "daily",
  "ledger",
  "hourlyUsage",
  "activityDays",
  "hourlyDistribution",
  "weekHourMatrix",
  "dailyHourCounts",
  "projects",
  "sessions",
  "insights",
  "meta",
] as const;

export const SOURCES = ["claude", "codex", "opencode", "pricing"] as const;
export type SourceName = (typeof SOURCES)[number];

// Each table's primary key, which is also its dump order.
const TABLE_KEYS = {
  meta: "key",
  ingested_files: "path",
  seen_requests: "request_key",
  usage_hourly: "hour_ms, project, model",
  seen_tool_calls: "session_key, tool_key",
  session_ledger: "path, session_key",
  session_model_usage: "path, session_key, model",
} as const;
export type RollupTable = keyof typeof TABLE_KEYS;
export const ROLLUP_TABLES = Object.keys(TABLE_KEYS) as RollupTable[];

export const SCENARIOS = {
  "incremental append": "incremental-append",
  "transcript deleted": "transcript-deleted",
  rebuild: "rebuild",
  "migrate v2": "migrate-v2",
  "refuse newer": "refuse-newer",
} as const;
export type Scenario = keyof typeof SCENARIOS;

export type Row = Record<string, unknown>;
export type Dump = Record<RollupTable, Row[]>;
export type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;
export type Run = { code: number; out: string; err: string };

export const goldenPath = (...parts: string[]) => join(GOLDEN_DIR, ...parts);

export async function readGolden<T = unknown>(...parts: string[]): Promise<T> {
  return (await Bun.file(goldenPath(...parts)).json()) as T;
}

// Async on purpose: the stub lives in this process, so a sync spawn would deadlock it.
export async function runAtlas(
  f: Fixture,
  sub: AtlasSub,
  args: string[] = [],
): Promise<Run> {
  const proc = Bun.spawn(atlasCommand(sub, args), {
    env: { ...f.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function runJson(
  f: Fixture,
  sub: AtlasSub,
  args: string[] = [],
): Promise<unknown> {
  const run = await runAtlas(f, sub, args);
  if (run.code !== 0) {
    throw new Error(
      `atlas ${sub} ${args.join(" ")} exited ${run.code}: ${run.err}`,
    );
  }
  return JSON.parse(run.out);
}

export async function withFixture<T>(
  body: (f: Fixture) => Promise<T>,
): Promise<T> {
  const f = await makeFixtureHome();
  try {
    return await body(f);
  } finally {
    await f.cleanup();
  }
}

// makeFixtureHome puts home, data, config and cockpit dirs under one mkdtemp root.
export const fixtureRoot = (f: Fixture) => dirname(f.home);

// Every fixture root is a fresh mkdtemp, so no two runs compare equal until it is
// replaced — in values and in keys, since several maps are keyed by absolute path.
export function normalizeFixturePaths<T>(value: T, root: string): T {
  const fix = (s: string) => s.replaceAll(root, "<FIXTURE>");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, child]) => [fix(k), walk(child)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

// Deletes each dotted path in place; `*` matches any one key or array index, and a
// path that matches nothing is ignored.
export function stripVolatile<T>(value: T, paths: string[]): T {
  const strip = (node: unknown, segments: string[]): void => {
    if (!node || typeof node !== "object") return;
    const [head, ...rest] = segments;
    const keys = head === "*" ? Object.keys(node) : [head];
    for (const key of keys) {
      if (!(key in node)) continue;
      if (rest.length === 0) delete (node as Record<string, unknown>)[key];
      else strip((node as Record<string, unknown>)[key], rest);
    }
  };
  for (const path of paths) strip(value, path.split("."));
  return value;
}

export const loadVolatileKeys = () =>
  readGolden<string[]>("volatile-keys.json");

export function dumpRollup(dbPath: string, root: string): Dump {
  const db = new Database(dbPath, { readonly: true });
  try {
    const dump = {} as Dump;
    for (const table of ROLLUP_TABLES) {
      let rows = db
        .query(`SELECT * FROM ${table} ORDER BY ${TABLE_KEYS[table]}`)
        .all() as Row[];
      // updated_at is the ingest's own Date.now(), not derived from any input.
      if (table === "ingested_files") {
        rows = rows.map(({ updated_at: _, ...rest }) => rest);
      }
      // The Rust writer marks the DB it owns; TS never writes it, and the two must compare equal.
      if (table === "meta") rows = rows.filter((r) => r.key !== "writer");
      dump[table] = normalizeFixturePaths(rows, root);
    }
    return dump;
  } finally {
    db.close();
  }
}

export const readMeta = (dbPath: string, key: string): string | null => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
};

export const rollupDbPath = (f: Fixture) => join(f.home, "rollup.db");

export const rollupUpdate = (f: Fixture, db: string, ...args: string[]) =>
  runAtlas(f, "rollup-update", ["--db", db, ...args]);

async function ingest(
  f: Fixture,
  db: string,
  ...args: string[]
): Promise<void> {
  const run = await rollupUpdate(f, db, ...args);
  if (run.code !== 0)
    throw new Error(`rollup-update exited ${run.code}: ${run.err}`);
}

export async function recordStats(): Promise<Record<string, unknown>> {
  const volatile = await loadVolatileKeys();
  return withFixture(async (f) => {
    const stats = normalizeFixturePaths(
      (await runJson(f, "stats")) as Record<string, unknown>,
      fixtureRoot(f),
    );
    return stripVolatile(stats, volatile);
  });
}

export const recordSource = (name: SourceName) =>
  withFixture(async (f) =>
    normalizeFixturePaths(
      await runJson(f, "stats", ["--source", name]),
      fixtureRoot(f),
    ),
  );

export const recordRollupTables = () =>
  withFixture(async (f) => {
    const db = rollupDbPath(f);
    await ingest(f, db);
    return dumpRollup(db, fixtureRoot(f));
  });

export const transcriptPaths = (f: Fixture) => {
  const projects = join(f.home, ".claude", "projects");
  const A = FIXTURE_IDS.claudeSessionA;
  return {
    a: join(projects, "-work-proj-a", `${A}.jsonl`),
    subagent: join(
      projects,
      "-work-proj-a",
      A,
      "subagents",
      `${FIXTURE_IDS.claudeSubagent}.jsonl`,
    ),
    b: join(projects, "-work-proj-b", `${FIXTURE_IDS.claudeSessionB}.jsonl`),
  };
};

// Later than the fixture's own mtime, and whole seconds, so mtime_ms is exact.
export const SCENARIO_MTIME_MS = FIXTURE_NOW_MS;

// The one way a scenario edits a transcript: the utimes keeps ingested_files.mtime_ms deterministic.
export function appendTranscript(path: string, rows: unknown[]): void {
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s = SCENARIO_MTIME_MS / 1000;
  utimesSync(path, s, s);
}

const localIso = (iso: string) =>
  new Date(Date.parse(`${iso}+08:00`)).toISOString();

// Appended to session B: a new user turn, a repeat of the already-billed
// req_B1:msg_B1, and one new sonnet request that also makes a tool call.
export const APPENDED_LINES = (() => {
  const sessionId = FIXTURE_IDS.claudeSessionB;
  const cwd = FIXTURE_PROJECTS.b;
  return [
    {
      type: "user",
      sessionId,
      cwd,
      uuid: "u-append-1",
      timestamp: localIso("2026-09-28T23:10:00"),
      message: { role: "user", content: "One more thing" },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      requestId: "req_B1",
      uuid: "a-msg_B1-repeat",
      timestamp: localIso("2026-09-28T23:10:05"),
      message: {
        id: "msg_B1",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 300,
          output_tokens: 600,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 800,
        },
      },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      requestId: "req_B3",
      uuid: "a-msg_B3",
      timestamp: localIso("2026-09-28T23:11:00"),
      message: {
        id: "msg_B3",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: "toolu_B3",
            name: "Read",
            input: { file_path: "/work/file.ts" },
          },
        ],
        usage: {
          input_tokens: 60,
          output_tokens: 120,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 0,
        },
      },
    },
  ];
})();

export type AppendResult = {
  before: Dump;
  after: Dump;
  path: string;
  size: number;
};

export const incrementalAppend = () =>
  withFixture<AppendResult>(async (f) => {
    const db = rollupDbPath(f);
    const root = fixtureRoot(f);
    const { b } = transcriptPaths(f);
    await ingest(f, db);
    const before = dumpRollup(db, root);
    appendTranscript(b, APPENDED_LINES);
    await ingest(f, db);
    return {
      before,
      after: dumpRollup(db, root),
      path: normalizeFixturePaths(b, root),
      size: statSync(b).size,
    };
  });

export type DeleteResult = { before: Dump; after: Dump; path: string };

// Session A's main transcript: its subagent file keeps session A alive, so the
// delete also exercises the survivor rewind and the shared-request rule.
export const transcriptDeleted = () =>
  withFixture<DeleteResult>(async (f) => {
    const db = rollupDbPath(f);
    const root = fixtureRoot(f);
    const { a } = transcriptPaths(f);
    await ingest(f, db);
    const before = dumpRollup(db, root);
    rmSync(a);
    await ingest(f, db);
    return {
      before,
      after: dumpRollup(db, root),
      path: normalizeFixturePaths(a, root),
    };
  });

export type RebuildResult = { before: Dump; after: Dump };

export const rebuild = () =>
  withFixture<RebuildResult>(async (f) => {
    const db = rollupDbPath(f);
    const root = fixtureRoot(f);
    await ingest(f, db);
    const before = dumpRollup(db, root);
    await ingest(f, db, "--rebuild");
    return { before, after: dumpRollup(db, root) };
  });

// rollup-db.ts at schema v2: v3 minus seen_tool_calls, session_ledger, session_model_usage.
const V2_DDL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE ingested_files (
    path TEXT PRIMARY KEY, bytes_parsed INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE seen_requests (request_key TEXT PRIMARY KEY, path TEXT NOT NULL);
  CREATE INDEX idx_seen_requests_path ON seen_requests (path);
  CREATE TABLE usage_hourly (
    hour_ms INTEGER NOT NULL, project TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0, cache_creation INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_ms, project, model)
  );
  INSERT INTO meta VALUES ('schema_version', '2');
`;

const hourRow = (
  iso: string,
  project: string,
  model: string,
  [input, output, cacheRead, cacheCreation]: number[],
): Row => ({
  hour_ms: Date.parse(`${iso}+08:00`),
  project,
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read: cacheRead,
  cache_creation: cacheCreation,
  reasoning: 0,
  message_count: 1,
});

// A v2 DB that already billed session B's transcript, plus history for a
// project whose transcripts are long gone. Same column order as the v3 dump.
export const V2_SEED_HOURLY: Row[] = [
  hourRow(
    "2026-08-01T10:00:00",
    "/work/proj-gone",
    "claude-opus-4-7",
    [900, 90, 9000, 0],
  ),
  hourRow(
    "2026-09-28T14:00:00",
    FIXTURE_PROJECTS.b,
    "claude-opus-4-7",
    [300, 600, 5000, 800],
  ),
  hourRow(
    "2026-09-28T22:00:00",
    FIXTURE_PROJECTS.b,
    "claude-sonnet-4-6",
    [40, 80, 2000, 0],
  ),
];

export type MigrateResult = {
  after: Dump;
  run: Run;
  backupExists: boolean;
  schemaVersion: string | null;
};

export const migrateV2 = () =>
  withFixture<MigrateResult>(async (f) => {
    const db = rollupDbPath(f);
    const { b } = transcriptPaths(f);
    const seed = new Database(db, { create: true });
    seed.exec(V2_DDL);
    const st = statSync(b);
    seed
      .query("INSERT INTO ingested_files VALUES (?, ?, ?, 0)")
      .run(b, st.size, Math.floor(st.mtimeMs));
    for (const key of ["req_B1:msg_B1", "req_B2:msg_B2"]) {
      seed.query("INSERT INTO seen_requests VALUES (?, ?)").run(key, b);
    }
    const insert = seed.query(
      "INSERT INTO usage_hourly VALUES ($hour_ms, $project, $model, $input_tokens, $output_tokens, $cache_read, $cache_creation, $reasoning, $message_count)",
    );
    for (const row of V2_SEED_HOURLY) {
      insert.run(
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [`$${k}`, v]),
        ) as Record<string, string | number>,
      );
    }
    seed.close();

    const run = await rollupUpdate(f, db);
    return {
      after: dumpRollup(db, fixtureRoot(f)),
      run,
      backupExists: existsSync(`${db}.v2.bak`),
      schemaVersion: readMeta(db, "schema_version"),
    };
  });

export type RefuseResult = {
  before: Dump;
  after: Dump;
  run: Run;
  backupExists: boolean;
};

// Built from a real ingest and relabelled, so the refusal has actual rows to leave alone.
export const refuseNewer = () =>
  withFixture<RefuseResult>(async (f) => {
    const db = rollupDbPath(f);
    const root = fixtureRoot(f);
    await ingest(f, db);
    const edit = new Database(db);
    edit
      .query("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
      .run();
    edit.close();
    const before = dumpRollup(db, root);
    const run = await rollupUpdate(f, db);
    return {
      before,
      after: dumpRollup(db, root),
      run,
      backupExists: existsSync(`${db}.v99.bak`),
    };
  });

// The dump each scenario's golden file holds.
export async function recordScenario(name: Scenario): Promise<Dump> {
  switch (name) {
    case "incremental append":
      return (await incrementalAppend()).after;
    case "transcript deleted":
      return (await transcriptDeleted()).after;
    case "rebuild":
      return (await rebuild()).after;
    case "migrate v2":
      return (await migrateV2()).after;
    case "refuse newer":
      return (await refuseNewer()).after;
  }
}

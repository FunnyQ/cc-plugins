// Deterministic fixture HOME for the atlas contract suite. Every item below is
// named for the engine rule it exercises; shapes follow how the engine parses them
// (cockpit-rs/src/atlas/), not a published schema.
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type StubRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};
export type StubServer = {
  url: string;
  requests: StubRequest[];
  // Overrides every later response on `path` until called again; lets tests force 500s.
  respondWith(path: string, status: number, body: string): void;
  stop(): void;
};

// Asia/Taipei is UTC+8 with no DST, so a UTC-vs-local hour or date bug shows.
export const FIXTURE_TZ = "Asia/Taipei";
const local = (iso: string) => Date.parse(`${iso}+08:00`);
const utc = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => Math.floor(ms / 1000);

// Newest usage entry is 2026-09-28 22:40 local; "now" is past local midnight, so
// "today" differs from the newest entry's date in local time but not in UTC.
export const FIXTURE_NEWEST_MS = local("2026-09-28T22:40:00");
export const FIXTURE_NOW_MS = local("2026-09-29T02:00:00");
// Every fixture file and dir gets this atime/mtime, so fingerprints and cache keys repeat.
const FIXTURE_MTIME_S = seconds(local("2026-09-29T00:00:00"));

export const STUB_PATHS = {
  openRouter: "/openrouter/models",
  codexUsage: "/codex/usage",
  codexToken: "/oauth/token",
  ingest: "/ingest",
} as const;

export const FIXTURE_IDS = {
  claudeSessionA: "11111111-1111-4111-8111-111111111111",
  claudeSessionB: "22222222-2222-4222-8222-222222222222",
  claudeSubagent: "agent-a1b2c3",
  claudePidLive: 90001,
  claudePidStale: 90002,
  codexThreadRollout: "019a0000-0000-7000-8000-000000000001",
  codexThreadModelFromRollout: "019a0000-0000-7000-8000-000000000002",
  codexThreadNoRollout: "019a0000-0000-7000-8000-000000000003",
  openCodeSession: "ses_fixture_db_1",
  openCodeLegacySession: "ses_fixture_legacy_1",
  staleCodexAccessToken: "stale-access-token",
  freshCodexAccessToken: "fresh-access-token",
} as const;

export const FIXTURE_PROJECTS = {
  a: "/work/proj-a",
  b: "/work/proj-b",
  c: "/work/proj-c",
  legacy: "/work/proj-legacy",
} as const;

export async function freePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port === 5938 ? freePort() : port;
}

// OpenRouter prices per token as strings; one model omits cache prices so the
// 0.1x / 1.25x fallback runs, and one model is used by nothing.
const OPENROUTER_MODELS = {
  data: [
    {
      id: "anthropic/claude-opus-4.7",
      pricing: {
        prompt: "0.000005",
        completion: "0.000025",
        input_cache_read: "0.0000005",
        input_cache_write: "0.00000625",
      },
    },
    {
      id: "openai/gpt-5.1-codex",
      pricing: {
        prompt: "0.00000125",
        completion: "0.00001",
        input_cache_read: "0.000000125",
      },
    },
    {
      id: "openai/gpt-5.1-codex-mini",
      pricing: { prompt: "0.00000025", completion: "0.000002" },
    },
    {
      id: "moonshotai/kimi-k2",
      pricing: { prompt: "0.0000006", completion: "0.0000025" },
    },
    {
      id: "mistralai/mistral-large-unused",
      pricing: { prompt: "0.000002", completion: "0.000006" },
    },
  ],
};

// Primary is a 5-hour window, secondary a weekly one (buildCodexUsageLimits slots by length).
const CODEX_USAGE = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_at: seconds(FIXTURE_NOW_MS + 2 * 3_600_000),
    },
    secondary_window: {
      used_percent: 17,
      limit_window_seconds: 604_800,
      reset_at: seconds(FIXTURE_NOW_MS + 3 * 86_400_000),
    },
  },
};

const CODEX_TOKEN_REFRESH = {
  access_token: FIXTURE_IDS.freshCodexAccessToken,
  refresh_token: "fresh-refresh-token",
  id_token: "fixture-id-token",
};

function startStub(): StubServer {
  const requests: StubRequest[] = [];
  const overrides = new Map<string, { status: number; body: string }>();
  const json = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({
        path,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
      const override = overrides.get(path);
      if (override) return json(override.status, override.body);
      switch (path) {
        case STUB_PATHS.openRouter:
          return json(200, OPENROUTER_MODELS);
        case STUB_PATHS.codexUsage:
          // 401 to the stale token is what drives the TS into its refresh path.
          return req.headers.get("authorization") ===
            `Bearer ${FIXTURE_IDS.freshCodexAccessToken}`
            ? json(200, CODEX_USAGE)
            : json(401, { detail: "token expired" });
        case STUB_PATHS.codexToken:
          return json(200, CODEX_TOKEN_REFRESH);
        default:
          return json(200, {});
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    respondWith(path, status, body) {
      overrides.set(path, { status, body });
    },
    stop() {
      server.stop(true);
    },
  };
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const jsonl = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};
const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
});

function claudeUser(
  sessionId: string,
  cwd: string,
  ts: number | null,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "user",
    sessionId,
    cwd,
    uuid: `u-${sessionId.slice(0, 4)}-${ts ?? "none"}`,
    ...(ts === null ? {} : { timestamp: utc(ts) }),
    message: { role: "user", content },
    ...extra,
  };
}

function claudeAssistant(
  sessionId: string,
  cwd: string,
  ts: number | null,
  requestId: string,
  messageId: string,
  model: string,
  u: Usage,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "assistant",
    sessionId,
    cwd,
    requestId,
    uuid: `a-${messageId}-${ts ?? "none"}`,
    ...(ts === null ? {} : { timestamp: utc(ts) }),
    message: {
      id: messageId,
      role: "assistant",
      model,
      content,
      usage: u,
    },
    ...extra,
  };
}

const toolUse = (id: string) => ({
  type: "tool_use",
  id,
  name: "Read",
  input: { file_path: "/work/file.ts" },
});

function writeClaude(home: string): void {
  const { claudeSessionA: A, claudeSessionB: B } = FIXTURE_IDS;
  const { a, b } = FIXTURE_PROJECTS;
  const projects = join(home, ".claude", "projects");
  const dirA = join(projects, "-work-proj-a");
  const dirB = join(projects, "-work-proj-b");
  const reqA2 = usage(50, 400, 3000, 0);

  writeText(
    join(dirA, `${A}.jsonl`),
    jsonl([
      claudeUser(A, a, local("2026-09-26T09:14:00"), "Plan the fixture"),
      // Repeated usage snapshots of one request: the ingest bills the first only.
      claudeAssistant(
        A,
        a,
        local("2026-09-26T09:15:00"),
        "req_A1",
        "msg_A1",
        "claude-opus-4-7",
        usage(100, 10, 1000, 200),
        [{ type: "thinking", thinking: "…" }],
      ),
      claudeAssistant(
        A,
        a,
        local("2026-09-26T09:15:05"),
        "req_A1",
        "msg_A1",
        "claude-opus-4-7",
        usage(100, 250, 1000, 200),
        [toolUse("toolu_A1")],
      ),
      claudeUser(A, a, local("2026-09-26T09:15:10"), [
        { type: "tool_result", tool_use_id: "toolu_A1", content: "ok" },
      ]),
      // isMeta user lines are not interactions.
      claudeUser(A, a, local("2026-09-26T09:16:00"), "<meta>", {
        isMeta: true,
      }),
      // 01:30 local is the previous UTC day: a UTC date bucket lands on 09-26.
      claudeAssistant(
        A,
        a,
        local("2026-09-27T01:30:00"),
        "req_A2",
        "msg_A2",
        "claude-sonnet-4-6",
        reqA2,
        [{ type: "text", text: "done" }],
      ),
      // No timestamp: billed into usage_hourly hour_ms = 0.
      claudeAssistant(
        A,
        a,
        null,
        "req_A3",
        "msg_A3",
        "claude-opus-4-7",
        usage(7, 3, 0, 0),
        [{ type: "text", text: "timeless" }],
      ),
    ]),
  );

  // Subagent transcript carries its parent's sessionId, and repeats req_A2,
  // which must be billed once across the two files.
  writeText(
    join(dirA, A, "subagents", `${FIXTURE_IDS.claudeSubagent}.jsonl`),
    jsonl([
      claudeUser(A, a, local("2026-09-27T01:29:00"), "subtask", {
        isSidechain: true,
      }),
      claudeAssistant(
        A,
        a,
        local("2026-09-27T01:30:00"),
        "req_A2",
        "msg_A2",
        "claude-sonnet-4-6",
        reqA2,
        [{ type: "text", text: "done" }],
        { isSidechain: true },
      ),
      claudeAssistant(
        A,
        a,
        local("2026-09-27T01:31:00"),
        "req_S1",
        "msg_S1",
        "claude-haiku-4-5",
        usage(20, 30, 500, 100),
        [toolUse("toolu_S1"), toolUse("toolu_S2")],
        { isSidechain: true },
      ),
    ]),
  );

  writeText(
    join(dirB, `${B}.jsonl`),
    jsonl([
      claudeUser(B, b, local("2026-09-28T14:00:00"), "Second project"),
      claudeAssistant(
        B,
        b,
        local("2026-09-28T14:05:00"),
        "req_B1",
        "msg_B1",
        "claude-opus-4-7",
        usage(300, 600, 5000, 800),
        [{ type: "text", text: "ok" }],
      ),
      claudeUser(B, b, local("2026-09-28T22:39:00"), "Late night"),
      claudeAssistant(
        B,
        b,
        FIXTURE_NEWEST_MS,
        "req_B2",
        "msg_B2",
        "claude-sonnet-4-6",
        usage(40, 80, 2000, 0),
        [{ type: "text", text: "ok" }],
      ),
    ]),
  );

  // Shape read by parseStatsCache; lastComputedDate precedes 09-28 so history
  // supplements that day (mergeDailyActivity).
  writeText(
    join(home, ".claude", "stats-cache.json"),
    JSON.stringify(
      {
        version: 2,
        lastComputedDate: "2026-09-27",
        dailyActivity: [
          {
            date: "2026-09-26",
            messageCount: 6,
            sessionCount: 1,
            toolCallCount: 1,
          },
          {
            date: "2026-09-27",
            messageCount: 4,
            sessionCount: 1,
            toolCallCount: 2,
          },
        ],
        dailyModelTokens: [
          { date: "2026-09-26", tokensByModel: { "claude-opus-4-7": 1310 } },
          {
            date: "2026-09-27",
            tokensByModel: {
              "claude-sonnet-4-6": 3450,
              "claude-haiku-4-5": 650,
            },
          },
        ],
        modelUsage: {
          "claude-opus-4-7": {
            inputTokens: 107,
            outputTokens: 13,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 200,
            webSearchRequests: 0,
            costUSD: 0,
          },
        },
        hourCounts: { "1": 2, "9": 4, "14": 1, "22": 1 },
        totalSessions: 2,
        totalMessages: 10,
        longestSession: {
          sessionId: A,
          duration: 3_600_000,
          messageCount: 6,
          timestamp: utc(local("2026-09-26T09:14:00")),
        },
        firstSessionDate: utc(local("2026-09-26T09:14:00")),
      },
      null,
      2,
    ),
  );

  // parseHistory: timestamps in ms; one entry lacks a sessionId.
  writeText(
    join(home, ".claude", "history.jsonl"),
    jsonl([
      {
        display: "Plan the fixture",
        pastedContents: {},
        timestamp: local("2026-09-26T09:14:00"),
        project: a,
        sessionId: A,
      },
      {
        display: "subtask",
        pastedContents: {},
        timestamp: local("2026-09-27T01:29:00"),
        project: a,
        sessionId: A,
      },
      {
        display: "Second project",
        pastedContents: {},
        timestamp: local("2026-09-28T14:00:00"),
        project: b,
        sessionId: B,
      },
      {
        display: "no session id",
        pastedContents: {},
        timestamp: local("2026-09-28T22:30:00"),
        project: b,
      },
      {
        display: "Late night",
        pastedContents: {},
        timestamp: local("2026-09-28T22:39:00"),
        project: b,
        sessionId: B,
      },
    ]),
  );

  // session-files.ts: one live (updated 2 min before now), one stale.
  const sessions = join(home, ".claude", "sessions");
  writeText(
    join(sessions, `${FIXTURE_IDS.claudePidLive}.json`),
    JSON.stringify({
      pid: FIXTURE_IDS.claudePidLive,
      sessionId: B,
      cwd: b,
      startedAt: FIXTURE_NOW_MS - 3 * 3_600_000,
      updatedAt: FIXTURE_NOW_MS - 120_000,
      status: "busy",
      version: "2.1.300",
      kind: "interactive",
      entrypoint: "cli",
      nameSource: "fixture",
      peerFeatures: { messaging: true, protocols: [1, 2] },
    }),
  );
  writeText(
    join(sessions, `${FIXTURE_IDS.claudePidStale}.json`),
    JSON.stringify({
      pid: FIXTURE_IDS.claudePidStale,
      sessionId: A,
      cwd: a,
      startedAt: local("2026-09-26T09:14:00"),
      updatedAt: local("2026-09-27T01:31:00"),
      status: "idle",
      version: "2.1.300",
      kind: "interactive",
      entrypoint: "cli",
      nameSource: "fixture",
      peerFeatures: { messaging: true, protocols: [1, 2] },
    }),
  );
}

type CodexTotals = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};
const codexTotals = (
  input: number,
  cached: number,
  output: number,
  reasoning: number,
): CodexTotals => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

// readCodexSession: first timestamp, session_meta/turn_context for cwd+model,
// user messages, function_call tool calls, cumulative token_count events.
function codexRollout(
  id: string,
  cwd: string,
  model: string,
  startMs: number,
  tokenEvents: Array<[number, CodexTotals]>,
): string {
  const rows: unknown[] = [
    {
      timestamp: utc(startMs),
      type: "session_meta",
      payload: { id, timestamp: utc(startMs), cwd, originator: "codex_cli_rs" },
    },
    { timestamp: utc(startMs), type: "turn_context", payload: { cwd, model } },
    {
      timestamp: utc(startMs + 1000),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "go" }],
      },
    },
    {
      timestamp: utc(startMs + 1000),
      type: "event_msg",
      payload: { type: "user_message", message: "go" },
    },
  ];
  let previous: CodexTotals | null = null;
  for (const [ts, totals] of tokenEvents) {
    rows.push({
      timestamp: utc(ts - 1000),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: "{}",
        call_id: `call-${ts}`,
      },
    });
    rows.push({
      timestamp: utc(ts),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: totals,
          last_token_usage: previous ?? totals,
        },
      },
    });
    previous = totals;
  }
  return jsonl(rows);
}

function writeCodex(home: string): void {
  const ids = FIXTURE_IDS;
  const codex = join(home, ".codex");
  const t1Start = local("2026-09-27T10:00:00");
  const t1End = local("2026-09-27T11:20:00");
  const t2Start = local("2026-09-28T16:00:00");
  const t2End = local("2026-09-28T16:10:00");
  const t3Start = local("2026-09-26T20:00:00");
  const t3End = local("2026-09-26T20:30:00");

  const t1Path = join(
    codex,
    "sessions",
    "2026",
    "09",
    "27",
    `rollout-2026-09-27T10-00-00-${ids.codexThreadRollout}.jsonl`,
  );
  writeText(
    t1Path,
    codexRollout(
      ids.codexThreadRollout,
      FIXTURE_PROJECTS.a,
      "gpt-5.1-codex",
      t1Start,
      [
        [local("2026-09-27T10:05:00"), codexTotals(8000, 5000, 900, 300)],
        [t1End, codexTotals(15000, 11000, 2100, 700)],
      ],
    ),
  );
  const t2Path = join(
    codex,
    "sessions",
    "2026",
    "09",
    "28",
    `rollout-2026-09-28T16-00-00-${ids.codexThreadModelFromRollout}.jsonl`,
  );
  writeText(
    t2Path,
    codexRollout(
      ids.codexThreadModelFromRollout,
      FIXTURE_PROJECTS.c,
      "gpt-5.1-codex-mini",
      t2Start,
      [[t2End, codexTotals(4000, 1000, 500, 120)]],
    ),
  );

  // Every column either query selects (api.ts parseCodexUsage, live.ts readCodexThreadRows).
  const db = new Database(join(codex, "state_5.sqlite"), { create: true });
  db.exec(`create table threads (
    id text primary key, rollout_path text not null default '',
    created_at integer not null, updated_at integer not null,
    created_at_ms integer, updated_at_ms integer,
    cwd text not null default '', title text not null default '',
    model text, tokens_used integer not null default 0,
    archived integer not null default 0
  )`);
  const insert = db.query(
    "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    ids.codexThreadRollout,
    t1Path,
    seconds(t1Start),
    seconds(t1End),
    t1Start,
    t1End,
    FIXTURE_PROJECTS.a,
    "Rollout thread",
    "gpt-5.1-codex",
    17100,
    0,
  );
  // model null → the engine falls back to the rollout's turn_context model.
  // updated_at_ms sits 30 s before now so the live panel sees it; the engine reads
  // only the seconds columns, which stay at the rollout's own times.
  insert.run(
    ids.codexThreadModelFromRollout,
    t2Path,
    seconds(t2Start),
    seconds(t2End),
    t2Start,
    FIXTURE_NOW_MS - 30_000,
    FIXTURE_PROJECTS.c,
    "Model from rollout",
    null,
    4500,
    0,
  );
  // tokens_used > 0 with no rollout: billed from the thread row alone.
  insert.run(
    ids.codexThreadNoRollout,
    "",
    seconds(t3Start),
    seconds(t3End),
    t3Start,
    t3End,
    FIXTURE_PROJECTS.b,
    "No rollout",
    "gpt-5.1-codex",
    5000,
    0,
  );
  db.close();

  writeText(
    join(codex, "auth.json"),
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          access_token: ids.staleCodexAccessToken,
          refresh_token: "fixture-refresh-token",
          id_token: "fixture-id-token",
          account_id: "acct-fixture",
        },
        last_refresh: utc(local("2026-09-20T00:00:00")),
      },
      null,
      2,
    ),
  );
}

function writeOpenCode(home: string): void {
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  const ses = FIXTURE_IDS.openCodeSession;
  const cwd = FIXTURE_PROJECTS.c;

  // Rows parseOpenCodeUsage reads: session, message (JSON data), part (tool count).
  const db = new Database(join(dir, "opencode.db"), { create: true });
  db.exec(`create table session (
      id text primary key, directory text not null, title text,
      time_created integer not null, time_updated integer not null
    );
    create table message (
      id text primary key, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, data text not null
    );`);
  // time_updated near now keeps the session live; engine times come from message rows.
  db.query("insert into session values (?, ?, ?, ?, ?)").run(
    ses,
    cwd,
    "Fixture session",
    local("2026-09-28T09:00:00"),
    FIXTURE_NOW_MS - 300_000,
  );

  const message = db.query("insert into message values (?, ?, ?, ?, ?)");
  const part = db.query("insert into part values (?, ?, ?, ?, ?)");
  const u1 = local("2026-09-28T09:00:10");
  message.run(
    "msg_oc_u1",
    ses,
    u1,
    u1,
    JSON.stringify({ role: "user", time: { created: u1 } }),
  );
  const a1 = local("2026-09-28T09:00:12");
  const a1Done = local("2026-09-28T09:01:00");
  message.run(
    "msg_oc_a1",
    ses,
    a1,
    a1Done,
    JSON.stringify({
      role: "assistant",
      modelID: "kimi-k2",
      providerID: "moonshotai",
      cost: 0,
      tokens: {
        input: 1200,
        output: 340,
        reasoning: 60,
        cache: { read: 4000, write: 0 },
      },
      time: { created: a1, completed: a1Done },
      path: { cwd, root: cwd },
    }),
  );
  part.run(
    "prt_1",
    "msg_oc_a1",
    ses,
    a1,
    JSON.stringify({ type: "tool", tool: "read" }),
  );
  part.run(
    "prt_2",
    "msg_oc_a1",
    ses,
    a1,
    JSON.stringify({ type: "tool", tool: "edit" }),
  );
  part.run(
    "prt_3",
    "msg_oc_a1",
    ses,
    a1,
    JSON.stringify({ type: "text", text: "done" }),
  );
  const u2 = local("2026-09-28T11:00:00");
  message.run(
    "msg_oc_u2",
    ses,
    u2,
    u2,
    JSON.stringify({ role: "user", time: { created: u2 } }),
  );
  // A positive stored cost wins over computed pricing (usageCost).
  const a2 = local("2026-09-28T11:00:05");
  const a2Done = local("2026-09-28T11:02:00");
  message.run(
    "msg_oc_a2",
    ses,
    a2,
    a2Done,
    JSON.stringify({
      role: "assistant",
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      cost: 0.0123,
      tokens: {
        input: 800,
        output: 150,
        reasoning: 0,
        cache: { read: 2500, write: 300 },
      },
      time: { created: a2, completed: a2Done },
      path: { cwd, root: cwd },
    }),
  );
  db.close();

  // Legacy JSON storage next to the DB. With DB rows present the engine only
  // counts these (dataHealth) and fingerprints them; it parses them when the DB is empty.
  const legacy = FIXTURE_IDS.openCodeLegacySession;
  const created = local("2026-09-27T15:00:00");
  writeText(
    join(dir, "storage", "session", "proj_legacy", `${legacy}.json`),
    JSON.stringify({
      id: legacy,
      directory: FIXTURE_PROJECTS.legacy,
      title: "Legacy",
      time: { created, updated: created + 60_000 },
    }),
  );
  writeText(
    join(dir, "storage", "message", legacy, "msg_legacy_1.json"),
    JSON.stringify({
      id: "msg_legacy_1",
      sessionID: legacy,
      role: "assistant",
      modelID: "kimi-k2",
      tokens: {
        input: 300,
        output: 90,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created, completed: created + 30_000 },
      path: { cwd: FIXTURE_PROJECTS.legacy, root: FIXTURE_PROJECTS.legacy },
    }),
  );
}

function writeConfigAndCache(home: string): void {
  // User override replaces one model's price (last in pricing resolution order).
  writeText(
    join(home, ".config", "cc-dashboard", "pricing.json"),
    `${JSON.stringify({ models: { "claude-sonnet-4-6": { input: 2.5, output: 12, cacheRead: 0.25, cacheWrite: 3 } } }, null, 2)}\n`,
  );
  writeText(
    join(home, ".config", "cc-dashboard", "budget.json"),
    JSON.stringify({ monthlyBudgetUSD: 200 }, null, 2),
  );
  // buildRateLimitsRecord's shape, written the way `cockpit atlas statusline` writes
  // it; captured a minute before now, so readUsageLimits reports it fresh.
  const captured = FIXTURE_NOW_MS - 60_000;
  writeText(
    join(home, ".cache", "token-atlas", "rate-limits.json"),
    JSON.stringify(
      {
        capturedAt: utc(captured),
        capturedAtEpochMs: captured,
        rate_limits: {
          five_hour: {
            used_percentage: 37,
            resets_at: seconds(FIXTURE_NOW_MS + 2 * 3_600_000),
          },
          seven_day: {
            used_percentage: 12.5,
            resets_at: seconds(FIXTURE_NOW_MS + 3 * 86_400_000),
          },
        },
      },
      null,
      2,
    ),
  );
}

// Post-order, so creating a child never bumps a dir's mtime after it was pinned.
function pinTimes(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) pinTimes(child);
    else utimesSync(child, FIXTURE_MTIME_S, FIXTURE_MTIME_S);
  }
  utimesSync(path, FIXTURE_MTIME_S, FIXTURE_MTIME_S);
}

export async function makeFixtureHome(): Promise<{
  home: string;
  env: Record<string, string>;
  stub: StubServer;
  cleanup(): Promise<void>;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atlas-fixture-")));
  const home = join(root, "home");
  const dirs = {
    data: join(root, "data"),
    config: join(root, "config"),
    cockpit: join(root, "cockpit"),
  };
  for (const dir of [home, ...Object.values(dirs)]) mkdirSync(dir);

  writeClaude(home);
  writeCodex(home);
  writeOpenCode(home);
  writeConfigAndCache(home);
  pinTimes(home);

  const stub = startStub();
  // The whole child environment: spreading process.env could let an outer
  // TOKEN_ATLAS_ROLLUP_DB or COCKPIT_OPENCODE_DB point a test at real data.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: dirs.data,
    XDG_CONFIG_HOME: dirs.config,
    COCKPIT_HOME: dirs.cockpit,
    TZ: FIXTURE_TZ,
    TOKEN_ATLAS_NOW_MS: String(FIXTURE_NOW_MS),
    TOKEN_ATLAS_OPENROUTER_URL: stub.url + STUB_PATHS.openRouter,
    TOKEN_ATLAS_CODEX_USAGE_URL: stub.url + STUB_PATHS.codexUsage,
    TOKEN_ATLAS_CODEX_TOKEN_URL: stub.url + STUB_PATHS.codexToken,
  };

  return {
    home,
    env,
    stub,
    async cleanup() {
      stub.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

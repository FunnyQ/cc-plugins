// Run: bun test packages/monitor/skills/usage-dashboard/scripts/live-sessions.test.ts
import { describe, expect, test } from "bun:test";
import {
  buildClaudeLiveSessions,
  buildCodexLiveSessions,
  buildOpenCodeLiveSessions,
  codexUpdatedAtMs,
  parseCockpitKeys,
  projectNameFor,
  sortLiveSessions,
  statusRank,
  STALE_CUTOFF_MS,
  CODEX_BUSY_CUTOFF_MS,
  type CodexRowInput,
  type LiveSession,
  type OpenCodeRowInput,
} from "./live-sessions";

const NOW = 1_700_000_000_000;

describe("projectNameFor", () => {
  test("takes the last path segment", () => {
    expect(projectNameFor("/Users/q/Projects/cc-plugins")).toBe("cc-plugins");
  });
  test("ignores trailing slashes", () => {
    expect(projectNameFor("/Users/q/foo/")).toBe("foo");
  });
  test("falls back to the input when there is no segment", () => {
    expect(projectNameFor("")).toBe("");
  });
});

describe("statusRank", () => {
  test("orders busy/active first, unknown last", () => {
    const order = [
      "busy",
      "active-inferred",
      "waiting",
      "recent",
      "idle",
      "?",
    ].map(statusRank);
    expect(order).toEqual([0, 0, 1, 2, 3, 4]);
  });
});

describe("codexUpdatedAtMs", () => {
  const base = {
    id: "x",
    cwd: "/p",
    rollout_path: "/r",
    model: null,
  } as const;
  test("prefers updated_at_ms", () => {
    expect(
      codexUpdatedAtMs({
        ...base,
        updated_at_ms: 5,
        updated_at: 1,
        created_at: 0,
      }),
    ).toBe(5);
  });
  test("falls back to updated_at seconds → ms", () => {
    expect(codexUpdatedAtMs({ ...base, updated_at: 2, created_at: 0 })).toBe(
      2000,
    );
  });
  test("falls back to created_at when nothing else", () => {
    expect(codexUpdatedAtMs({ ...base, updated_at: 0, created_at: 3 })).toBe(
      3000,
    );
  });
});

describe("parseCockpitKeys", () => {
  test("builds provider:sessionId keys, defaulting provider to claude", () => {
    const raw = JSON.stringify({
      sessions: [
        { sessionId: "a", provider: "codex" },
        { sessionId: "o", provider: "opencode" },
        { sessionId: "b" }, // no provider → claude
        { provider: "codex" }, // no sessionId → dropped
      ],
    });
    const keys = parseCockpitKeys(raw);
    expect([...keys].sort()).toEqual(["claude:b", "codex:a", "opencode:o"]);
  });
  test("returns an empty set on corrupt / non-array input", () => {
    expect(parseCockpitKeys("not json").size).toBe(0);
    expect(parseCockpitKeys(JSON.stringify({ sessions: "nope" })).size).toBe(0);
  });
});

describe("buildClaudeLiveSessions", () => {
  const file = (over = {}) => ({
    sessionId: "s1",
    cwd: "/Users/q/proj",
    status: "busy",
    startedAt: NOW - 1000,
    ...over,
  });

  test("maps a fresh session and tags cockpit membership + transcript", () => {
    const out = buildClaudeLiveSessions(
      [file()],
      new Set(["claude:s1"]),
      new Map([["s1", "/path/s1.jsonl"]]),
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      provider: "claude",
      id: "s1",
      projectName: "proj",
      status: "busy",
      transcriptPath: "/path/s1.jsonl",
      cockpit: true,
      isStale: false,
    });
  });

  test("prefers updatedAt over startedAt for age", () => {
    const out = buildClaudeLiveSessions(
      [file({ updatedAt: NOW - 2000 })],
      new Set(),
      new Map(),
      NOW,
    );
    expect(out[0].ageMs).toBe(2000);
  });

  test("drops stale sessions past the cutoff", () => {
    const out = buildClaudeLiveSessions(
      [file({ startedAt: NOW - STALE_CUTOFF_MS - 1 })],
      new Set(),
      new Map(),
      NOW,
    );
    expect(out).toHaveLength(0);
  });
});

describe("buildCodexLiveSessions", () => {
  const row = (over: Partial<CodexRowInput> = {}): CodexRowInput => ({
    id: "c1",
    cwd: "/Users/q/proj",
    rollout_path: "/roll/c1.jsonl",
    model: "o3",
    updated_at: 0,
    created_at: 0,
    updated_at_ms: NOW - 1000,
    ...over,
  });

  test("infers active when recent, requires an existing transcript", () => {
    const out = buildCodexLiveSessions(
      [row()],
      new Set(["codex:c1"]),
      NOW,
      () => true,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      provider: "codex",
      status: "active-inferred",
      model: "o3",
      cockpit: true,
    });
  });

  test("marks older-but-fresh sessions as recent", () => {
    const out = buildCodexLiveSessions(
      [row({ updated_at_ms: NOW - CODEX_BUSY_CUTOFF_MS - 1000 })],
      new Set(),
      NOW,
      () => true,
    );
    expect(out[0].status).toBe("recent");
  });

  test("drops a session whose transcript does not exist", () => {
    const out = buildCodexLiveSessions([row()], new Set(), NOW, () => false);
    expect(out).toHaveLength(0);
  });

  test("drops a session with no rollout path", () => {
    const out = buildCodexLiveSessions(
      [row({ rollout_path: "" })],
      new Set(),
      NOW,
      () => true,
    );
    expect(out).toHaveLength(0);
  });
});

describe("buildOpenCodeLiveSessions", () => {
  const row = (over: Partial<OpenCodeRowInput> = {}): OpenCodeRowInput => ({
    id: "o1",
    directory: "/Users/q/proj",
    time_created: NOW - 2000,
    time_updated: NOW - 1000,
    ...over,
  });

  test("maps a fresh OpenCode session", () => {
    const out = buildOpenCodeLiveSessions(
      [row()],
      new Set(["opencode:o1"]),
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      provider: "opencode",
      id: "o1",
      projectName: "proj",
      status: "active-inferred",
      statusSource: "opencode-sqlite-session",
      cockpit: true,
      isStale: false,
    });
  });

  test("marks older-but-fresh sessions as recent", () => {
    const out = buildOpenCodeLiveSessions(
      [row({ time_updated: NOW - CODEX_BUSY_CUTOFF_MS - 1000 })],
      new Set(),
      NOW,
    );
    expect(out[0].status).toBe("recent");
  });

  test("normalizes second-based timestamps", () => {
    const out = buildOpenCodeLiveSessions(
      [
        row({
          time_created: Math.floor((NOW - 2000) / 1000),
          time_updated: Math.floor((NOW - 1000) / 1000),
        }),
      ],
      new Set(),
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].ageMs).toBe(1000);
  });

  test("drops stale sessions past the cutoff", () => {
    const out = buildOpenCodeLiveSessions(
      [row({ time_updated: NOW - STALE_CUTOFF_MS - 1 })],
      new Set(),
      NOW,
    );
    expect(out).toHaveLength(0);
  });
});

describe("sortLiveSessions", () => {
  const s = (status: string, updatedAt: string): LiveSession => ({
    provider: "claude",
    id: status + updatedAt,
    projectName: "p",
    cwd: "/p",
    status,
    statusSource: "claude-session-file",
    updatedAt,
    ageMs: 0,
    isStale: false,
  });

  test("orders by status bucket, then most-recent within a bucket", () => {
    const sorted = sortLiveSessions([
      s("idle", "2026-01-01T00:00:00Z"),
      s("busy", "2026-01-01T00:00:00Z"),
      s("busy", "2026-01-02T00:00:00Z"),
    ]);
    expect(sorted.map((x) => [x.status, x.updatedAt])).toEqual([
      ["busy", "2026-01-02T00:00:00Z"],
      ["busy", "2026-01-01T00:00:00Z"],
      ["idle", "2026-01-01T00:00:00Z"],
    ]);
  });
});

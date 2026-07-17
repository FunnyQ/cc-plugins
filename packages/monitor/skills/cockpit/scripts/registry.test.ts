// Tests for registry status derivation + payload building (server/02).
// Run: bun test packages/monitor/skills/cockpit/scripts/registry.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { handleInbox, handleSendMessage } from "./inbox";

let homeDir: string;
let projectsRoot: string;

function setEnv() {
  process.env.COCKPIT_HOME = homeDir;
  // Neutralise live-session detection so buildSessions/buildProjects depend only
  // on the fixture registry — point at paths that don't exist → no live merge.
  process.env.COCKPIT_CLAUDE_SESSIONS_DIR = join(homeDir, "no-sessions");
  process.env.COCKPIT_CLAUDE_PROJECTS_DIR = join(homeDir, "no-projects");
  process.env.COCKPIT_CODEX_STATE_DB = join(homeDir, "no-state.sqlite");
  process.env.COCKPIT_OPENCODE_DB = join(homeDir, "no-opencode.sqlite");
}

function writeDaemonToken(token: string) {
  writeFileSync(
    join(homeDir, "daemon.json"),
    JSON.stringify({ pid: process.pid, port: 5858, token }),
  );
}

function start(project: string, sid: string) {
  const logDir = join(project, ".cockpit", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${sid}.jsonl`);
  writeFileSync(logPath, "");
  let sessions: any[] = [];
  try {
    sessions = JSON.parse(
      readFileSync(join(homeDir, "registry.json"), "utf8"),
    ).sessions;
  } catch {
    sessions = [];
  }
  sessions.push({
    project,
    sessionId: sid,
    logPath,
    lastHeartbeat: new Date().toISOString(),
  });
  writeFileSync(join(homeDir, "registry.json"), JSON.stringify({ sessions }));
}

function mkProject(name: string): string {
  const dir = realpathSync(mkdtempSync(join(projectsRoot, name + "-")));
  return dir;
}

// fresh per test; modules read env at call-time so this is safe.
let mod: typeof import("./registry");

beforeEach(async () => {
  homeDir = realpathSync(mkdtempSync(join(tmpdir(), "ck-home-")));
  projectsRoot = realpathSync(mkdtempSync(join(tmpdir(), "ck-projs-")));
  setEnv();
  mod = await import("./registry");
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectsRoot, { recursive: true, force: true });
  delete process.env.COCKPIT_HOME;
  delete process.env.COCKPIT_CLAUDE_SESSIONS_DIR;
  delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
  delete process.env.COCKPIT_CODEX_STATE_DB;
  delete process.env.COCKPIT_OPENCODE_DB;
});

describe("deriveLiveStatus", () => {
  test("stale session → ended, regardless of harness/openCall", () => {
    expect(
      mod.deriveLiveStatus({
        active: false,
        openCall: true,
        harnessStatus: "busy",
      }),
    ).toBe("ended");
  });

  test("open needs_your_call outranks the harness working state", () => {
    expect(
      mod.deriveLiveStatus({
        active: true,
        openCall: true,
        harnessStatus: "busy",
      }),
    ).toBe("your-call");
  });

  test("maps harness statuses onto the vocabulary", () => {
    const map = {
      busy: "working",
      waiting: "waiting",
      shell: "shell",
    } as const;
    for (const [harness, expected] of Object.entries(map)) {
      expect(
        mod.deriveLiveStatus({
          active: true,
          openCall: false,
          harnessStatus: harness,
        }),
      ).toBe(expected);
    }
  });

  test("active but no/unknown harness status → idle (no invented activity)", () => {
    expect(mod.deriveLiveStatus({ active: true, openCall: false })).toBe(
      "idle",
    );
    expect(
      mod.deriveLiveStatus({
        active: true,
        openCall: false,
        harnessStatus: "something-new",
      }),
    ).toBe("idle");
  });
});

describe("readRegistry", () => {
  test("missing registry → []", () => {
    expect(mod.readRegistry()).toEqual([]);
  });

  test("corrupt registry → []", () => {
    writeFileSync(join(homeDir, "registry.json"), "{not json");
    expect(mod.readRegistry()).toEqual([]);
  });

  test("legacy entries without provider default to claude", () => {
    writeFileSync(
      join(homeDir, "registry.json"),
      JSON.stringify({
        sessions: [
          {
            project: "/tmp/p",
            sessionId: "88888888-8888-8888-8888-888888888888",
            logPath:
              "/tmp/p/.cockpit/logs/88888888-8888-8888-8888-888888888888.jsonl",
            lastHeartbeat: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(mod.readRegistry()[0].provider).toBe("claude");
  });

  test("preserves OpenCode provider entries", () => {
    writeFileSync(
      join(homeDir, "registry.json"),
      JSON.stringify({
        sessions: [
          {
            provider: "opencode",
            project: "/tmp/p",
            sessionId: "ses_test",
            logPath: "/tmp/p/.cockpit/logs/ses_test.jsonl",
            lastHeartbeat: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(mod.readRegistry()[0].provider).toBe("opencode");
  });
});

describe("statusOf", () => {
  test("fresh heartbeat → active", () => {
    const p = mkProject("a");
    start(p, "11111111-1111-1111-1111-111111111111");
    const [e] = mod.readRegistry();
    expect(mod.statusOf(e)).toBe("active");
  });

  test("stale heartbeat AND stale log mtime → ended", () => {
    const p = mkProject("b");
    const sid = "22222222-2222-2222-2222-222222222222";
    start(p, sid);
    // age the heartbeat in the registry
    const regPath = join(homeDir, "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    reg.sessions[0].lastHeartbeat = old;
    writeFileSync(regPath, JSON.stringify(reg));
    // age the log file mtime too
    const past = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(reg.sessions[0].logPath, past, past);
    const [e] = mod.readRegistry();
    expect(mod.statusOf(e)).toBe("ended");
  });
});

describe("buildSessions", () => {
  test("sorted active-first", () => {
    const pa = mkProject("active");
    const pe = mkProject("ended");
    const sidActive = "44444444-4444-4444-4444-444444444444";
    const sidEnded = "55555555-5555-5555-5555-555555555555";
    start(pe, sidEnded);
    start(pa, sidActive);
    // age the ended one
    const regPath = join(homeDir, "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    const endedEntry = reg.sessions.find((s: any) => s.sessionId === sidEnded);
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    endedEntry.lastHeartbeat = old;
    writeFileSync(regPath, JSON.stringify(reg));
    const past = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(endedEntry.logPath, past, past);

    const sessions = mod.buildSessions();
    expect(sessions[0].status).toBe("active");
    expect(sessions[0].sessionId).toBe(sidActive);
    expect(sessions[1].status).toBe("ended");
  });

  test("includes channel flag when an inbox poll is parked", async () => {
    const p = mkProject("channel");
    const sid = "12121212-1212-1212-1212-121212121212";
    const token = "channel-token";
    start(p, sid);
    writeDaemonToken(token);
    process.env.COCKPIT_WAIT_TIMEOUT_MS = "1000";
    process.env.COCKPIT_CHANNEL_TTL_MS = "60";
    const wait = handleInbox(
      new Request(`http://127.0.0.1/api/inbox?session=${sid}&token=${token}`),
    );
    await Bun.sleep(10);
    try {
      const session = mod.buildSessions().find((s) => s.sessionId === sid)!;
      expect(session.channel).toBe(true);
    } finally {
      await handleSendMessage(
        new Request("http://127.0.0.1/api/send-message", {
          method: "POST",
          body: JSON.stringify({ session: sid, text: "done", token }),
        }),
      );
      await wait;
      delete process.env.COCKPIT_WAIT_TIMEOUT_MS;
    }
    // Presence persists through the re-park gap (within TTL)...
    expect(mod.buildSessions().find((s) => s.sessionId === sid)!.channel).toBe(
      true,
    );
    // ...and only drops once the channel stops polling past the TTL.
    await Bun.sleep(80);
    expect(mod.buildSessions().find((s) => s.sessionId === sid)!.channel).toBe(
      false,
    );
    delete process.env.COCKPIT_CHANNEL_TTL_MS;
  });
});

describe("buildProjects", () => {
  test("groups by project with activeCount/sessionCount", () => {
    const p = mkProject("multi");
    start(p, "66666666-6666-6666-6666-666666666666");
    start(p, "77777777-7777-7777-7777-777777777777");
    const { projects } = mod.projectsPayload();
    const entry = projects.find((x) => x.project === p)!;
    expect(entry).toBeTruthy();
    expect(entry.sessionCount).toBe(2);
    expect(entry.activeCount).toBe(2);
  });
});

describe("buildSessions live merge", () => {
  // Point live-session detection at a temp ~/.claude/sessions and drop a session
  // file in it. Returns the dir so the test can clean up.
  function liveClaudeSession(
    sid: string,
    cwd: string,
    updatedAtMs = Date.now(),
    name = "",
  ) {
    const sessDir = realpathSync(mkdtempSync(join(tmpdir(), "ck-sess-")));
    process.env.COCKPIT_CLAUDE_SESSIONS_DIR = sessDir;
    writeFileSync(
      join(sessDir, `${sid}.json`),
      JSON.stringify({
        sessionId: sid,
        cwd,
        startedAt: updatedAtMs,
        updatedAt: updatedAtMs,
        name,
      }),
    );
    return sessDir;
  }

  test("a running session with no registry entry appears as untracked + active", () => {
    const sid = "88888888-8888-8888-8888-888888888888";
    const sessDir = liveClaudeSession(sid, "/Users/q/Projects/other");
    try {
      const s = mod.buildSessions().find((x) => x.sessionId === sid)!;
      expect(s).toBeTruthy();
      expect(s.tracked).toBe(false);
      expect(s.status).toBe("active");
      expect(s.project).toBe("/Users/q/Projects/other");
    } finally {
      rmSync(sessDir, { recursive: true, force: true });
    }
  });

  test("surfaces the live harness session title", () => {
    const sid = "89898989-8989-8989-8989-898989898989";
    const project = mkProject("titled");
    start(project, sid);
    const registryPath = join(homeDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.sessions[0].titleResolved = true;
    writeFileSync(registryPath, JSON.stringify(registry));
    const sessDir = liveClaudeSession(
      sid,
      project,
      Date.now(),
      "Refine cockpit session rail",
    );
    try {
      expect(mod.buildSessions().find((x) => x.sessionId === sid)?.title).toBe(
        "Refine cockpit session rail",
      );
      const stored = JSON.parse(
        readFileSync(join(homeDir, "registry.json"), "utf8"),
      ).sessions.find((x: any) => x.sessionId === sid);
      expect(stored.title).toBe("Refine cockpit session rail");
      expect(stored.titleResolved).toBe(true);
    } finally {
      rmSync(sessDir, { recursive: true, force: true });
    }
  });

  test("backfills and persists a historical Claude transcript title once", () => {
    const p = mkProject("historical-title");
    const sid = "87878787-8787-8787-8787-878787878787";
    start(p, sid);
    const transcriptDir = join(homeDir, "claude-projects", "fixture");
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR = join(homeDir, "claude-projects");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, `${sid}.jsonl`),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Recover this historical title" },
      }),
    );

    expect(mod.buildSessions().find((x) => x.sessionId === sid)?.title).toBe(
      "Recover this historical title",
    );
    const stored = JSON.parse(
      readFileSync(join(homeDir, "registry.json"), "utf8"),
    ).sessions.find((x: any) => x.sessionId === sid);
    expect(stored.title).toBe("Recover this historical title");
    expect(stored.titleResolved).toBe(true);
  });

  test("marks an empty historical lookup as resolved", () => {
    const p = mkProject("missing-title");
    const sid = "86868686-8686-8686-8686-868686868686";
    start(p, sid);
    const transcriptRoot = join(homeDir, "claude-projects");
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR = transcriptRoot;

    expect(mod.buildSessions().find((x) => x.sessionId === sid)?.title).toBe(
      "",
    );
    const stored = JSON.parse(
      readFileSync(join(homeDir, "registry.json"), "utf8"),
    ).sessions.find((x: any) => x.sessionId === sid);
    expect(stored.title).toBeUndefined();
    expect(stored.titleResolved).toBe(true);

    const transcriptDir = join(transcriptRoot, "late-fixture");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, `${sid}.jsonl`),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "This arrived too late" },
      }),
    );
    expect(mod.buildSessions().find((x) => x.sessionId === sid)?.title).toBe(
      "",
    );
  });

  test("a registered session that is live shows active even with a stale log, no duplicate", () => {
    const p = mkProject("livereg");
    const sid = "99999999-9999-9999-9999-999999999999";
    start(p, sid);
    // Age heartbeat + log so statusOf() alone would report "ended".
    const regPath = join(homeDir, "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    const entry = reg.sessions.find((s: any) => s.sessionId === sid);
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    entry.lastHeartbeat = old;
    writeFileSync(regPath, JSON.stringify(reg));
    const past = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(entry.logPath, past, past);
    const sessDir = liveClaudeSession(sid, p);
    try {
      const matches = mod.buildSessions().filter((x) => x.sessionId === sid);
      expect(matches).toHaveLength(1); // not duplicated as untracked
      expect(matches[0].tracked).toBe(true);
      expect(matches[0].status).toBe("active");
    } finally {
      rmSync(sessDir, { recursive: true, force: true });
    }
  });

  test("a stale session file is not surfaced", () => {
    const sid = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
    const sessDir = liveClaudeSession(
      sid,
      "/Users/q/Projects/stale",
      Date.now() - 20 * 60 * 1000,
    );
    try {
      expect(
        mod.buildSessions().find((x) => x.sessionId === sid),
      ).toBeUndefined();
    } finally {
      rmSync(sessDir, { recursive: true, force: true });
    }
  });

  test("Codex spawned child threads are counted as subagents, not sessions", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ck-codex-live-")));
    const dbPath = join(dir, "state_5.sqlite");
    process.env.COCKPIT_CODEX_STATE_DB = dbPath;
    const parent = "019e6361-1d58-7f03-8fe3-34a525cbde31";
    const child = "019e63b0-83f5-7c03-a024-3e30d9144c3a";
    const parentRollout = join(dir, "parent.jsonl");
    const childRollout = join(dir, "child.jsonl");
    writeFileSync(parentRollout, JSON.stringify({ type: "response_item" }));
    writeFileSync(childRollout, JSON.stringify({ type: "response_item" }));
    const now = Date.now();
    const db = new Database(dbPath);
    try {
      db.run(
        `create table threads (
          id text primary key,
          cwd text not null,
          title text not null,
          rollout_path text not null,
          updated_at integer not null,
          updated_at_ms integer,
          archived integer not null default 0
        )`,
      );
      db.run(
        `create table thread_spawn_edges (
          parent_thread_id text not null,
          child_thread_id text not null primary key,
          status text not null
        )`,
      );
      const insertThread = db.query(
        `insert into threads
         (id, cwd, title, rollout_path, updated_at, updated_at_ms, archived)
         values (?, ?, ?, ?, ?, ?, 0)`,
      );
      insertThread.run(
        parent,
        "/Users/q/Projects/app",
        "Parent flight",
        parentRollout,
        now / 1000,
        now,
      );
      insertThread.run(
        child,
        "/Users/q/Projects/app",
        "Child flight",
        childRollout,
        now / 1000,
        now,
      );
      db.query(
        `insert into thread_spawn_edges
         (parent_thread_id, child_thread_id, status)
         values (?, ?, 'open')`,
      ).run(parent, child);
    } finally {
      db.close();
    }

    try {
      const sessions = mod.buildSessions(now);
      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain(parent);
      expect(ids).not.toContain(child);
      expect(sessions.find((s) => s.sessionId === parent)?.subagents).toBe(1);
      expect(sessions.find((s) => s.sessionId === parent)?.title).toBe(
        "Parent flight",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

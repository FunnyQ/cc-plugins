// Extends a makeFixtureHome() home so every live-panel status and filter shows up
// relative to FIXTURE_NOW_MS. Shared with the golden recording, so keep it deterministic.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIXTURE_IDS, FIXTURE_NOW_MS, FIXTURE_PROJECTS } from "./fixtures";

export const LIVE_IDS = {
  claudeIdle: "33333333-3333-4333-8333-333333333333",
  claudeWaiting: "44444444-4444-4444-8444-444444444444",
  claudeStale: "55555555-5555-4555-8555-555555555555",
  codexRecent: "019a0000-0000-7000-8000-0000000000a1",
  codexOld: "019a0000-0000-7000-8000-0000000000a2",
  codexArchived: "019a0000-0000-7000-8000-0000000000a3",
  codexMissingRollout: "019a0000-0000-7000-8000-0000000000a4",
  openCodeActive: "ses_fixture_live_active",
} as const;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

export async function extendLiveFixture(home: string): Promise<void> {
  const now = FIXTURE_NOW_MS;
  const sessions = join(home, ".claude", "sessions");
  const claude = (
    pid: number,
    sessionId: string,
    status: string,
    updatedAt: number,
  ) =>
    writeJson(join(sessions, `${pid}.json`), {
      pid,
      sessionId,
      cwd: FIXTURE_PROJECTS.c,
      startedAt: now - 3_600_000,
      updatedAt,
      status,
      version: "2.1.300",
      kind: "interactive",
      entrypoint: "cli",
    });
  // The base fixture already has a busy session (2 min) and one stale for days.
  claude(90003, LIVE_IDS.claudeIdle, "idle", now - 180_000);
  claude(90004, LIVE_IDS.claudeWaiting, "waiting", now - 45_000);
  claude(90005, LIVE_IDS.claudeStale, "busy", now - 600_001);

  // Rollouts live outside ~/.codex/sessions so the usage engine never ingests them.
  const rollouts = join(home, "live-rollouts");
  const rollout = (id: string) => {
    const path = join(rollouts, `rollout-${id}.jsonl`);
    mkdirSync(rollouts, { recursive: true });
    writeFileSync(path, "");
    return path;
  };
  const db = new Database(join(home, ".codex", "state_5.sqlite"));
  const insert = db.query(
    "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const thread = (
    id: string,
    path: string,
    updatedMs: number,
    archived: number,
  ) =>
    insert.run(
      id,
      path,
      Math.floor((updatedMs - 60_000) / 1000),
      Math.floor(updatedMs / 1000),
      null,
      // Null ms columns: the time comes from updated_at seconds.
      null,
      FIXTURE_PROJECTS.b,
      "Live thread",
      "gpt-5.1-codex",
      0,
      archived,
    );
  // The base fixture's model-from-rollout thread sits at 30 s: active-inferred.
  thread(LIVE_IDS.codexRecent, rollout(LIVE_IDS.codexRecent), now - 240_000, 0);
  thread(LIVE_IDS.codexOld, rollout(LIVE_IDS.codexOld), now - 900_000, 0);
  thread(
    LIVE_IDS.codexArchived,
    rollout(LIVE_IDS.codexArchived),
    now - 10_000,
    1,
  );
  thread(
    LIVE_IDS.codexMissingRollout,
    join(rollouts, "missing.jsonl"),
    now - 20_000,
    0,
  );
  db.close();

  // The base fixture's OpenCode session is 5 min old (recent); this one is active,
  // stored in seconds to exercise the ms normalization.
  const oc = new Database(
    join(home, ".local", "share", "opencode", "opencode.db"),
  );
  oc.query("insert into session values (?, ?, ?, ?, ?)").run(
    LIVE_IDS.openCodeActive,
    FIXTURE_PROJECTS.a,
    "Live session",
    Math.floor((now - 120_000) / 1000),
    Math.floor((now - 20_000) / 1000),
  );
  oc.close();

  // makeFixtureHome's COCKPIT_HOME is the home's sibling "cockpit" dir. One registered
  // session per provider; the daemon pid is this runner's so it reads as alive.
  const cockpitHome = join(dirname(home), "cockpit");
  writeJson(join(cockpitHome, "registry.json"), {
    sessions: [
      { sessionId: FIXTURE_IDS.claudeSessionB },
      { sessionId: FIXTURE_IDS.codexThreadModelFromRollout, provider: "codex" },
      { sessionId: FIXTURE_IDS.openCodeSession, provider: "opencode" },
    ],
  });
  writeJson(join(cockpitHome, "daemon.json"), { pid: process.pid, port: 5999 });
}

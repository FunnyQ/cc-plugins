// Tests for the cockpit broker (bridge/01): GET /api/wait long-poll +
// POST /api/respond, keyed per-session so concurrent sessions never cross-talk.
// Run: bun test cockpit/skills/cockpit/scripts/broker.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cockpit.ts");
const DAEMON = join(import.meta.dir, "serve-dashboard.ts");
const SID_A = "aaaaaaaa-1111-1111-1111-111111111111";
const SID_B = "bbbbbbbb-2222-2222-2222-222222222222";
const PORT = 6000 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

let cockpitHome: string;
let projA: string;
let projB: string;
let daemon: Subprocess;
let token: string;

function seed(projectDir: string, sid: string) {
  const r = Bun.spawnSync(
    [
      "bun",
      CLI,
      "start",
      "--session",
      sid,
      "--session-goal",
      "g",
      "--project-goal",
      "p",
    ],
    { cwd: projectDir, env: { ...process.env, COCKPIT_HOME: cockpitHome } },
  );
  if (r.exitCode !== 0) throw new Error("seed failed: " + r.stderr.toString());
}

function logLines(projectDir: string, sid: string): any[] {
  return readFileSync(join(projectDir, ".cockpit/logs", `${sid}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function waitForReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/sessions`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon never became ready");
}

beforeAll(async () => {
  cockpitHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-home-")));
  projA = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-projA-")));
  projB = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-projB-")));
  seed(projA, SID_A);
  seed(projB, SID_B);
  daemon = Bun.spawn(["bun", DAEMON, "--no-open", "--port", String(PORT)], {
    env: {
      ...process.env,
      COCKPIT_HOME: cockpitHome,
      COCKPIT_WAIT_TIMEOUT_MS: "1500", // keep the timeout test fast
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForReady();
  token = JSON.parse(
    readFileSync(join(cockpitHome, "daemon.json"), "utf8"),
  ).token;
});

afterAll(() => {
  daemon?.kill();
  rmSync(cockpitHome, { recursive: true, force: true });
  rmSync(projA, { recursive: true, force: true });
  rmSync(projB, { recursive: true, force: true });
});

describe("wait + respond round-trip", () => {
  test("respond wakes a parked wait and appends a response record", async () => {
    const waitP = fetch(
      `${BASE}/api/wait?session=${SID_A}&token=${token}`,
    ).then((r) => r.json());
    await Bun.sleep(150); // let the wait register
    const respP = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_A, answer: "yes", token }),
    }).then((r) => r.json());
    expect(respP).toEqual({ delivered: true });
    const woken = await waitP;
    expect(woken).toEqual({ answer: "yes" });

    const last = logLines(projA, SID_A).at(-1);
    expect(last.type).toBe("response");
    expect(last.answer).toBe("yes");
    expect(last.ts).toBeTruthy();
  });
});

describe("concurrency", () => {
  test("two sessions waiting each receive only their own answer", async () => {
    const wA = fetch(`${BASE}/api/wait?session=${SID_A}&token=${token}`).then(
      (r) => r.json(),
    );
    const wB = fetch(`${BASE}/api/wait?session=${SID_B}&token=${token}`).then(
      (r) => r.json(),
    );
    await Bun.sleep(150);
    await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_B, answer: "for-B", token }),
    });
    await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_A, answer: "for-A", token }),
    });
    expect(await wA).toEqual({ answer: "for-A" });
    expect(await wB).toEqual({ answer: "for-B" });
  });
});

describe("unparked respond", () => {
  test("appends the record and returns delivered:false when nobody is waiting", async () => {
    const before = logLines(projB, SID_B).length;
    const res = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_B, answer: "nobody-home", token }),
    }).then((r) => r.json());
    expect(res).toEqual({ delivered: false });
    const lines = logLines(projB, SID_B);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toMatchObject({
      type: "response",
      answer: "nobody-home",
    });
  });
});

describe("auth + validation", () => {
  test("wrong token is rejected on both endpoints", async () => {
    const w = await fetch(`${BASE}/api/wait?session=${SID_A}&token=nope`);
    expect(w.status).toBe(401);
    const r = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_A, answer: "x", token: "nope" }),
    });
    expect(r.status).toBe(401);
  });

  test("invalid session uuid is rejected", async () => {
    const w = await fetch(`${BASE}/api/wait?session=not-a-uuid&token=${token}`);
    expect(w.status).toBe(400);
    const r = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: "not-a-uuid", answer: "x", token }),
    });
    expect(r.status).toBe(400);
  });
});

describe("timeout sentinel", () => {
  test("an unanswered wait resolves to a re-pollable timeout sentinel", async () => {
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_A}&token=${token}`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: null, timeout: true });
  }, 5000);
});

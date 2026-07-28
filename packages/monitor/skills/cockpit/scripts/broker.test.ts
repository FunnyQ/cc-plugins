// Tests for the cockpit broker (bridge/01): GET /api/wait long-poll +
// POST /api/respond, keyed per-session so concurrent sessions never cross-talk.
// Run: bun test packages/monitor/skills/cockpit/scripts/broker.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cockpit.ts");
const DAEMON = join(import.meta.dir, "cockpit-server.ts");
const SID_A = "aaaaaaaa-1111-1111-1111-111111111111";
const SID_B = "bbbbbbbb-2222-2222-2222-222222222222";
const SID_C = "cccccccc-3333-3333-3333-333333333333";
const SID_D = "dddddddd-4444-4444-4444-444444444444";
const PORT = 6000 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

let cockpitHome: string;
let projA: string;
let projB: string;
let projC: string;
let projD: string;
let configHome: string;
let daemon: Subprocess;
let token: string;

function seed(projectDir: string, sid: string) {
  const r = Bun.spawnSync(
    [
      "bun",
      CLI,
      "log",
      "--session",
      sid,
      "--decision",
      "seed",
      "--reason",
      "seed",
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
  projC = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-projC-")));
  projD = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-projD-")));
  seed(projA, SID_A);
  seed(projB, SID_B);
  seed(projC, SID_C);
  seed(projD, SID_D);
  configHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-config-")));
  daemon = Bun.spawn(["bun", DAEMON, "--no-open", "--port", String(PORT)], {
    env: {
      ...process.env,
      COCKPIT_HOME: cockpitHome,
      // The answer-here switch lives in the global XDG config — point the
      // daemon at a temp one so the suite never touches the real user's.
      XDG_CONFIG_HOME: configHome,
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
  rmSync(projC, { recursive: true, force: true });
  rmSync(projD, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
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
    expect(last.id).toMatch(/^[0-9a-f-]{36}$/);
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
    expect(lines.at(-1).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("respond before wait (cold-start race)", () => {
  test("an answer that arrives before any wait is parked is delivered to the next wait", async () => {
    // Only an open needs_your_call earns a stash — log one first.
    const log = Bun.spawnSync(
      [
        "bun",
        CLI,
        "log",
        "--session",
        SID_C,
        "--decision",
        "pick a path",
        "--needs-call",
        "--option",
        "early",
      ],
      { cwd: projC, env: { ...process.env, COCKPIT_HOME: cockpitHome } },
    );
    if (log.exitCode !== 0)
      throw new Error("log failed: " + log.stderr.toString());

    // The user answers in the dashboard before `cockpit wait` has registered its
    // long-poll. The respond can't wake anyone yet — but it must not be lost.
    const resp = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_C, answer: "early", token }),
    }).then((r) => r.json());
    expect(resp).toEqual({ delivered: false });
    // still durably logged
    expect(logLines(projC, SID_C).at(-1)).toMatchObject({
      type: "response",
      answer: "early",
    });

    // The wait parks moments later — and drains the stash immediately instead of
    // hanging until its long-poll ceiling.
    const woken = await fetch(
      `${BASE}/api/wait?session=${SID_C}&token=${token}`,
    ).then((r) => r.json());
    expect(woken).toEqual({ answer: "early" });
  });

  test("the stash is single-use — a later wait no longer sees the stale answer", async () => {
    // stash already drained above → this wait parks and resolves to the sentinel
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_C}&token=${token}`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: null, timeout: true });
  }, 5000);
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

// Bind a wait to a specific callId so an answer to one card can never wake a
// wait parked on a different (stale) card — the cross-talk bug this fixes.
describe("callId binding", () => {
  // Log a needs_your_call and return its callId (printed by `cockpit log`).
  function logCall(decision: string): string {
    const r = Bun.spawnSync(
      [
        "bun",
        CLI,
        "log",
        "--session",
        SID_A,
        "--decision",
        decision,
        "--needs-call",
        "--option",
        "x",
      ],
      { cwd: projA, env: { ...process.env, COCKPIT_HOME: cockpitHome } },
    );
    if (r.exitCode !== 0) throw new Error("log failed: " + r.stderr.toString());
    const m = r.stdout.toString().match(/call:\s+([0-9a-f-]{36})/);
    if (!m) throw new Error("no call id in: " + r.stdout.toString());
    return m[1];
  }

  test("the response record carries the callId it answers", async () => {
    const callId = logCall("pick A");
    await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({
        session: SID_A,
        answer: "a",
        call: callId,
        token,
      }),
    });
    const last = logLines(projA, SID_A).at(-1);
    expect(last.type).toBe("response");
    expect(last.call).toBe(callId);
  });

  test("an answer to a different call does NOT wake a wait parked on this call", async () => {
    const callId = logCall("real question");
    const waitP = fetch(
      `${BASE}/api/wait?session=${SID_A}&call=${callId}&token=${token}`,
    ).then((r) => r.json());
    await Bun.sleep(150); // register the park

    // A stray answer tagged with a different call must not wake our wait.
    const stray = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({
        session: SID_A,
        answer: "wrong",
        call: "ffffffff-0000-0000-0000-000000000000",
        token,
      }),
    }).then((r) => r.json());
    expect(stray).toEqual({ delivered: false });

    // The correct answer wakes it.
    const right = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({
        session: SID_A,
        answer: "right",
        call: callId,
        token,
      }),
    }).then((r) => r.json());
    expect(right).toEqual({ delivered: true });
    expect(await waitP).toEqual({ answer: "right" });
  });

  test("a wait whose call was superseded by a newer call gets the superseded sentinel", async () => {
    const stale = logCall("old question"); // opens, then…
    logCall("new question"); // …a newer call supersedes it as the open one.
    // A wait that arrives for the stale call is told to stop, not parked — no
    // answer was ever stashed for it, so it can't be a cold-start delivery.
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_A}&call=${stale}&token=${token}`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: null, superseded: true });
  }, 5000);
});

// The cockpit is the exception, not the default: park an agent on a dashboard
// answer only when BOTH factors hold — the user's explicit answer-here switch
// (intent) and a live permission-stream subscriber (liveness, see
// permission.ts). Opt-in via require_watcher=1 so a daemon serving an older
// `cockpit wait` keeps the legacy always-park behavior.
describe("presence gate on /api/wait", () => {
  async function setAnswerHere(on: boolean): Promise<void> {
    const r = await fetch(`${BASE}/api/answer-here`, {
      method: "POST",
      body: JSON.stringify({ on, token }),
    }).then((x) => x.json());
    expect(r).toEqual({ answer_here: on });
  }

  // A visible cockpit tab on this session = an open permission-stream SSE.
  async function watch(sid: string): Promise<() => Promise<void>> {
    const ctrl = new AbortController();
    const res = await fetch(
      `${BASE}/api/permission-stream?session=${sid}&token=${token}`,
      { signal: ctrl.signal },
    );
    const reader = res.body!.getReader();
    await reader.read(); // ": connected" — the subscriber is registered now
    return async () => {
      ctrl.abort();
      await Bun.sleep(150); // let the daemon observe the hang-up
    };
  }

  function logCallD(decision: string): string {
    const r = Bun.spawnSync(
      [
        "bun",
        CLI,
        "log",
        "--session",
        SID_D,
        "--decision",
        decision,
        "--needs-call",
        "--option",
        "x",
      ],
      { cwd: projD, env: { ...process.env, COCKPIT_HOME: cockpitHome } },
    );
    if (r.exitCode !== 0) throw new Error("log failed: " + r.stderr.toString());
    const m = r.stdout.toString().match(/call:\s+([0-9a-f-]{36})/);
    if (!m) throw new Error("no call id in: " + r.stdout.toString());
    return m[1];
  }

  test("switch on but no tab → refused immediately, not parked", async () => {
    await setAnswerHere(true);
    const started = Date.now();
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_D}&token=${token}&require_watcher=1`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: null, not_watching: true, reason: "no_tab" });
    // The daemon's single-hop budget is 1500ms here — returning fast proves it
    // never parked.
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("a watching tab is not enough while the switch is off", async () => {
    await setAnswerHere(false);
    const stop = await watch(SID_D);
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_D}&token=${token}&require_watcher=1`,
    ).then((r) => r.json());
    expect(res).toEqual({
      answer: null,
      not_watching: true,
      reason: "toggle_off",
    });
    await stop();
  });

  test("without require_watcher the legacy park still happens", async () => {
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_D}&token=${token}`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: null, timeout: true });
  }, 5000);

  test("switch on AND a watching tab lets the wait park and be woken", async () => {
    await setAnswerHere(true);
    const stop = await watch(SID_D);
    const waitP = fetch(
      `${BASE}/api/wait?session=${SID_D}&token=${token}&require_watcher=1`,
    ).then((r) => r.json());
    await Bun.sleep(150); // let the wait register
    const resp = await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({ session: SID_D, answer: "from-ui", token }),
    }).then((r) => r.json());
    expect(resp).toEqual({ delivered: true });
    expect(await waitP).toEqual({ answer: "from-ui" });
    await stop();
  }, 5000);

  test("a stashed answer is delivered even when nobody is watching", async () => {
    // Ordering guard: the gate must sit AFTER the stash drain, or an answer the
    // user already gave would be thrown away.
    await setAnswerHere(false);
    const callId = logCallD("pick a path");
    await fetch(`${BASE}/api/respond`, {
      method: "POST",
      body: JSON.stringify({
        session: SID_D,
        answer: "early",
        call: callId,
        token,
      }),
    });
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_D}&call=${callId}&token=${token}&require_watcher=1`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: "early" });
  });

  test("a superseded call reports superseded, not not_watching", async () => {
    // Ordering guard: the gate must sit AFTER the superseded check, so the
    // caller gets the precise reason.
    const stale = logCallD("old question");
    logCallD("new question");
    const res = await fetch(
      `${BASE}/api/wait?session=${SID_D}&call=${stale}&token=${token}&require_watcher=1`,
    ).then((r) => r.json());
    expect(res).toEqual({ answer: null, superseded: true });
  });

  test("`cockpit wait` opts in and exits 4 when nobody is watching", () => {
    const r = Bun.spawnSync(["bun", CLI, "wait", SID_D], {
      cwd: projD,
      env: { ...process.env, COCKPIT_HOME: cockpitHome },
    });
    expect(r.exitCode).toBe(4);
    expect(r.stderr.toString()).toContain("nobody is watching");
  }, 10000);
});

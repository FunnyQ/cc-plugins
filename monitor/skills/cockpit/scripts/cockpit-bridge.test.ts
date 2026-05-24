// Tests for the `cockpit` control-loop CLIs (bridge/02): wait + send,
// driven against a real daemon broker. Run:
//   bun test monitor/skills/cockpit/scripts/cockpit-bridge.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cockpit.ts");
const DAEMON = join(import.meta.dir, "cockpit-server.ts");
const SID = "22222222-2222-2222-2222-222222222222";
// Short single-hop timeout so the re-poll path is exercised in ~seconds.
const WAIT_TIMEOUT_MS = "1500";

let projectDir: string;
let cockpitHome: string;
let port: number;
let daemon: Subprocess;

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  return p;
}

function runCli(
  args: string[],
  home = cockpitHome,
  cwd = projectDir,
  extraEnv: Record<string, string> = {},
) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: { ...process.env, COCKPIT_HOME: home, ...extraEnv },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// A COCKPIT_HOME whose daemon.json points at the real daemon port but carries a
// bogus token — so the CLI talks to the live daemon and gets a 401.
function badTokenHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-badtok-")));
  writeFileSync(
    join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, port, token: "deadbeefbadtoken" }),
  );
  return home;
}

function staleDaemonHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-stale-")));
  writeFileSync(
    join(home, "daemon.json"),
    JSON.stringify({
      pid: process.pid,
      port: freePort(),
      token: "stale-token",
    }),
  );
  return home;
}

async function waitForDaemon(p: number, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(80);
  }
  throw new Error("daemon did not start in time");
}

beforeAll(async () => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-bproj-")));
  cockpitHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-bhome-")));
  // Seed a session so the registry has a logPath for SID.
  runCli([
    "start",
    "--session",
    SID,
    "--session-goal",
    "bridge",
    "--project-goal",
    "p",
  ]);
  port = freePort();
  daemon = Bun.spawn(["bun", DAEMON, "--no-open", "--port", String(port)], {
    env: {
      ...process.env,
      COCKPIT_HOME: cockpitHome,
      COCKPIT_WAIT_TIMEOUT_MS: WAIT_TIMEOUT_MS,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForDaemon(port);
});

afterAll(() => {
  try {
    daemon?.kill();
  } catch {
    // already gone
  }
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("cockpit send", () => {
  test("with nothing parked → delivered: false (still logged)", () => {
    const r = runCli(["send", SID, "no one home"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("delivered: false");
  });
});

describe("cockpit wait + send round-trip", () => {
  test("send wakes a parked wait and wait prints the answer", async () => {
    const w = Bun.spawn(["bun", CLI, "wait", SID], {
      cwd: projectDir,
      env: { ...process.env, COCKPIT_HOME: cockpitHome },
      stdout: "pipe",
    });
    // Let `wait` park (open its long-poll) before answering.
    await Bun.sleep(500);
    const s = runCli(["send", SID, "go with B"]);
    expect(s.stdout).toContain("delivered: true");
    const exitCode = await w.exited;
    const out = await new Response(w.stdout).text();
    expect(exitCode).toBe(0);
    expect(out.trim()).toBe("go with B");
  });

  test("wait survives a long-poll timeout cycle and still catches a later answer", async () => {
    const w = Bun.spawn(["bun", CLI, "wait", SID], {
      cwd: projectDir,
      env: { ...process.env, COCKPIT_HOME: cockpitHome },
      stdout: "pipe",
    });
    // Wait past one full single-hop timeout so the client must re-poll.
    await Bun.sleep(Number(WAIT_TIMEOUT_MS) + 700);
    const s = runCli(["send", SID, "after timeout"]);
    expect(s.stdout).toContain("delivered: true");
    const exitCode = await w.exited;
    const out = await new Response(w.stdout).text();
    expect(exitCode).toBe(0);
    expect(out.trim()).toBe("after timeout");
  }, 15000);
});

describe("auth / validation errors (non-2xx must not be misreported)", () => {
  test("wait with a wrong token exits non-zero immediately (no spin)", () => {
    const home = badTokenHome();
    try {
      const t0 = Date.now();
      // Cap the wall clock so a regression (treating 401 as re-pollable) can't
      // hang the suite — a correct impl exits on the 401 long before this.
      const r = runCli(["wait", SID], home, projectDir, {
        COCKPIT_WAIT_MAX_MS: "6000",
      });
      const elapsed = Date.now() - t0;
      expect(r.code).not.toBe(0);
      expect(r.stderr.toLowerCase()).toContain("unauthorized");
      expect(elapsed).toBeLessThan(4000); // didn't loop to the ceiling
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);

  test("send with a wrong token exits non-zero, not delivered:false", () => {
    const home = badTokenHome();
    try {
      const r = runCli(["send", SID, "x"], home);
      expect(r.code).not.toBe(0);
      expect(r.stderr.toLowerCase()).toContain("unauthorized");
      expect(r.stdout).not.toContain("delivered");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("send with an invalid (non-uuid) session exits non-zero", () => {
    const r = runCli(["send", "not-a-uuid", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("invalid session");
    expect(r.stdout).not.toContain("delivered");
  });

  test("wait with a stale daemon port exits quickly instead of waiting to the ceiling", () => {
    const home = staleDaemonHome();
    try {
      const t0 = Date.now();
      const r = runCli(["wait", SID], home, projectDir, {
        COCKPIT_WAIT_MAX_MS: "8000",
      });
      const elapsed = Date.now() - t0;
      expect(r.code).not.toBe(0);
      expect(r.stderr.toLowerCase()).toContain("lost connection");
      expect(elapsed).toBeLessThan(5000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);
});

describe("daemon down", () => {
  test("wait errors clearly and exits non-zero", () => {
    const emptyHome = realpathSync(
      mkdtempSync(join(tmpdir(), "cockpit-empty-")),
    );
    try {
      const r = runCli(["wait", SID], emptyHome);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("daemon not running");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("send errors clearly and exits non-zero", () => {
    const emptyHome = realpathSync(
      mkdtempSync(join(tmpdir(), "cockpit-empty-")),
    );
    try {
      const r = runCli(["send", SID, "x"], emptyHome);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("daemon not running");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

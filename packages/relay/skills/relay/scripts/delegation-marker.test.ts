import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ARM_WINDOW_MS,
  buildMarker,
  clearDelegationMarker,
  delegationHome,
  needsDelegationMarker,
  writeDelegationMarker,
  type DelegationMarker,
} from "./delegation-marker";

const NOW = 1_700_000_000_000;

describe("needsDelegationMarker", () => {
  it("marks only codex live panes", () => {
    expect(needsDelegationMarker("codex", true)).toBe(true);
  });

  it("leaves headless codex to RELAY_DELEGATED", () => {
    // `codex exec` runs the session in-process, so the env var reaches the hook.
    expect(needsDelegationMarker("codex", false)).toBe(false);
  });

  it("leaves claude and opencode alone entirely", () => {
    expect(needsDelegationMarker("claude", true)).toBe(false);
    expect(needsDelegationMarker("opencode", true)).toBe(false);
  });
});

describe("buildMarker", () => {
  it("arms a cwd-match window", () => {
    const marker = buildMarker({
      cwd: "/repo",
      backend: "codex",
      now: NOW,
      waitTimeoutMs: 480_000,
    });
    expect(marker.armUntil).toBe(NOW + ARM_WINDOW_MS);
    expect(marker.sessionIds).toEqual([]);
    expect(marker.cwd).toBe("/repo");
  });

  it("outlives the wait, because collect rounds reattach after it expires", () => {
    const marker = buildMarker({
      cwd: "/repo",
      backend: "codex",
      now: NOW,
      waitTimeoutMs: 480_000,
    });
    expect(marker.expiresAt - NOW).toBe(480_000 * 4);
  });

  it("floors a tiny wait so a fast timeout still covers the session", () => {
    const marker = buildMarker({
      cwd: "/repo",
      backend: "codex",
      now: NOW,
      waitTimeoutMs: 1_000,
    });
    expect(marker.expiresAt - NOW).toBe(10 * 60_000);
  });

  it("caps an absurd wait so a leaked marker cannot silence a repo for a day", () => {
    const marker = buildMarker({
      cwd: "/repo",
      backend: "codex",
      now: NOW,
      waitTimeoutMs: 10 * 60 * 60_000,
    });
    expect(marker.expiresAt - NOW).toBe(2 * 60 * 60_000);
  });
});

describe("delegationHome", () => {
  it("honors the override the reader uses too", () => {
    expect(delegationHome({ Q_DELEGATION_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("falls back to the XDG data dir", () => {
    expect(delegationHome({})).toContain(
      join(".local", "share", "q-lab", "delegation"),
    );
  });
});

describe("writeDelegationMarker", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "relay-delegation-"));
    dirs.push(dir);
    return dir;
  }

  it("writes a marker the reader's shape can parse", () => {
    const dir = home();
    const marker = buildMarker({
      cwd: "/repo",
      backend: "codex",
      now: NOW,
      waitTimeoutMs: 480_000,
    });
    const path = writeDelegationMarker(marker, { Q_DELEGATION_HOME: dir });
    expect(path).not.toBe(null);

    const round = JSON.parse(readFileSync(path!, "utf8")) as DelegationMarker;
    expect(round).toEqual(marker);
  });

  it("creates the store directory on first use", () => {
    const dir = join(home(), "nested", "deeper");
    const path = writeDelegationMarker(
      buildMarker({
        cwd: "/repo",
        backend: "codex",
        now: NOW,
        waitTimeoutMs: 480_000,
      }),
      { Q_DELEGATION_HOME: dir },
    );
    expect(existsSync(path!)).toBe(true);
  });

  it("returns null instead of throwing when the store is unwritable", () => {
    const path = writeDelegationMarker(
      buildMarker({
        cwd: "/repo",
        backend: "codex",
        now: NOW,
        waitTimeoutMs: 480_000,
      }),
      { Q_DELEGATION_HOME: "/dev/null/nope" },
    );
    expect(path).toBe(null);
  });

  it("gives concurrent delegates distinct files", () => {
    const dir = home();
    const marker = buildMarker({
      cwd: "/repo",
      backend: "codex",
      now: NOW,
      waitTimeoutMs: 480_000,
    });
    const a = writeDelegationMarker(marker, { Q_DELEGATION_HOME: dir });
    const b = writeDelegationMarker(marker, { Q_DELEGATION_HOME: dir });
    expect(a).not.toBe(b);
    expect(existsSync(a!)).toBe(true);
    expect(existsSync(b!)).toBe(true);
  });
});

describe("clearDelegationMarker", () => {
  it("removes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-delegation-"));
    const path = writeDelegationMarker(
      buildMarker({
        cwd: "/repo",
        backend: "codex",
        now: NOW,
        waitTimeoutMs: 480_000,
      }),
      { Q_DELEGATION_HOME: dir },
    );
    clearDelegationMarker(path);
    expect(existsSync(path!)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tolerates a null path and a missing file", () => {
    expect(() => clearDelegationMarker(null)).not.toThrow();
    expect(() =>
      clearDelegationMarker(join(tmpdir(), "not-a-real-marker.json")),
    ).not.toThrow();
  });
});

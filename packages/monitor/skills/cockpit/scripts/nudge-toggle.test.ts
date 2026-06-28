import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NUDGE_TOGGLE_TTL_MS,
  applyAction,
  getSessionNudge,
  nudgeEnabledFor,
  pruneSessions,
  readScopes,
  resolveNudgeEnabled,
  setScope,
} from "./nudge-toggle";

describe("resolveNudgeEnabled", () => {
  it("all unset → enabled (default on)", () => {
    expect(resolveNudgeEnabled(undefined, undefined, undefined)).toBe(true);
  });

  it("most-specific defined scope wins", () => {
    // session on overrides project/user off
    expect(resolveNudgeEnabled("on", "off", "off")).toBe(true);
    // project decides when session unset
    expect(resolveNudgeEnabled(undefined, "off", "on")).toBe(false);
    // user decides when session+project unset
    expect(resolveNudgeEnabled(undefined, undefined, "off")).toBe(false);
    expect(resolveNudgeEnabled(undefined, undefined, "on")).toBe(true);
  });
});

describe("applyAction", () => {
  it("on/off/clear are absolute", () => {
    expect(applyAction("on", undefined)).toBe("on");
    expect(applyAction("off", "on")).toBe("off");
    expect(applyAction("clear", "off")).toBe(undefined);
  });

  it("toggle: off → on, anything else → off", () => {
    expect(applyAction("toggle", "off")).toBe("on");
    expect(applyAction("toggle", "on")).toBe("off");
    expect(applyAction("toggle", undefined)).toBe("off");
  });
});

describe("pruneSessions", () => {
  it("keeps fresh entries and drops stale ones", () => {
    const now = 1_000_000_000_000;
    const out = pruneSessions(
      {
        fresh: { state: "off", ts: now - 1000 },
        stale: { state: "off", ts: now - NUDGE_TOGGLE_TTL_MS - 1 },
      },
      now,
    );
    expect(Object.keys(out)).toEqual(["fresh"]);
  });
});

describe("scopes round-trip (file + config via temp homes)", () => {
  let dataHome: string;
  let configHome: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    dataHome = mkdtempSync(join(tmpdir(), "cockpit-data-"));
    configHome = mkdtempSync(join(tmpdir(), "cockpit-cfg-"));
    prev = {
      COCKPIT_HOME: process.env.COCKPIT_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.COCKPIT_HOME = dataHome;
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  });

  const ctx = (sessionId: string) => ({
    sessionId,
    cwd: "/tmp",
    now: Date.now(),
  });

  it("defaults to enabled for a clean slate", () => {
    expect(nudgeEnabledFor("s1", "/tmp", Date.now())).toBe(true);
  });

  it("session scope is per-session and re-enables over a user off", () => {
    setScope("user", "off", ctx("s1"));
    expect(nudgeEnabledFor("s1", "/tmp", Date.now())).toBe(false);
    // a different session inherits the user-off too
    expect(nudgeEnabledFor("s2", "/tmp", Date.now())).toBe(false);
    // but s1 can re-enable itself
    setScope("session", "on", ctx("s1"));
    expect(nudgeEnabledFor("s1", "/tmp", Date.now())).toBe(true);
    expect(nudgeEnabledFor("s2", "/tmp", Date.now())).toBe(false);
  });

  it("clear drops a scope's opinion so it defers again", () => {
    setScope("session", "off", ctx("s1"));
    expect(getSessionNudge("s1", Date.now())).toBe("off");
    setScope("session", "clear", ctx("s1"));
    expect(getSessionNudge("s1", Date.now())).toBe(undefined);
  });

  it("readScopes reflects each layer", () => {
    setScope("user", "off", ctx("s1"));
    setScope("session", "on", ctx("s1"));
    const scopes = readScopes("s1", "/tmp", Date.now());
    expect(scopes.session).toBe("on");
    expect(scopes.user).toBe("off");
    expect(scopes.project).toBe(undefined);
  });
});

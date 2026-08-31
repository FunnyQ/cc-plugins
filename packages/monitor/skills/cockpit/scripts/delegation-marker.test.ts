import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMarkers,
  delegationHome,
  isDelegatedSession,
  type DelegationMarker,
  type MarkerFile,
} from "./delegation-marker";

const NOW = 1_700_000_000_000;

function marker(over: Partial<DelegationMarker> = {}): DelegationMarker {
  return {
    cwd: "/repo",
    backend: "codex",
    startedAt: NOW,
    armUntil: NOW + 90_000,
    expiresAt: NOW + 600_000,
    sessionIds: [],
    ...over,
  };
}

function file(name: string, over: Partial<DelegationMarker> = {}): MarkerFile {
  return { name, marker: marker(over) };
}

describe("classifyMarkers", () => {
  it("says no when nothing is on disk", () => {
    expect(
      classifyMarkers([], { cwd: "/repo", sessionId: "s", now: NOW }),
    ).toEqual({ delegated: false, bindTo: null, expired: [] });
  });

  it("binds a session that lands in the arm window on a matching cwd", () => {
    const verdict = classifyMarkers([file("a.json")], {
      cwd: "/repo",
      sessionId: "s1",
      now: NOW + 1_000,
    });
    expect(verdict.delegated).toBe(true);
    expect(verdict.bindTo).toBe("a.json");
  });

  it("keeps matching a bound session long after the arm window closes", () => {
    const verdict = classifyMarkers([file("a.json", { sessionIds: ["s1"] })], {
      cwd: "/repo",
      sessionId: "s1",
      now: NOW + 500_000,
    });
    expect(verdict.delegated).toBe(true);
    expect(verdict.bindTo).toBe(null); // already bound, nothing to write
  });

  it("ignores an unbound session once the arm window closed", () => {
    const verdict = classifyMarkers([file("a.json")], {
      cwd: "/repo",
      sessionId: "s2",
      now: NOW + 120_000,
    });
    expect(verdict.delegated).toBe(false);
  });

  it("ignores a different cwd", () => {
    const verdict = classifyMarkers([file("a.json")], {
      cwd: "/other",
      sessionId: "s1",
      now: NOW + 1_000,
    });
    expect(verdict.delegated).toBe(false);
  });

  it("reports expired markers and does not match them", () => {
    const verdict = classifyMarkers(
      [file("old.json", { expiresAt: NOW - 1, sessionIds: ["s1"] })],
      { cwd: "/repo", sessionId: "s1", now: NOW },
    );
    expect(verdict.delegated).toBe(false);
    expect(verdict.expired).toEqual(["old.json"]);
  });

  it("pairs parallel delegates off 1:1 instead of piling onto one marker", () => {
    const files = [file("a.json", { sessionIds: ["s1"] }), file("b.json")];
    const verdict = classifyMarkers(files, {
      cwd: "/repo",
      sessionId: "s2",
      now: NOW + 1_000,
    });
    expect(verdict.bindTo).toBe("b.json");
  });

  it("still matches on cwd when the harness sent no session id", () => {
    const verdict = classifyMarkers([file("a.json")], {
      cwd: "/repo",
      now: NOW + 1_000,
    });
    expect(verdict.delegated).toBe(true);
    expect(verdict.bindTo).toBe(null);
  });
});

describe("delegationHome", () => {
  it("honors the override used by tests and by relay", () => {
    expect(delegationHome({ Q_DELEGATION_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("falls back to the XDG data dir", () => {
    expect(delegationHome({})).toContain(
      join(".local", "share", "q-lab", "delegation"),
    );
  });
});

describe("isDelegatedSession", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function store(entries: Record<string, DelegationMarker>): string {
    const dir = mkdtempSync(join(tmpdir(), "delegation-"));
    dirs.push(dir);
    for (const [name, value] of Object.entries(entries)) {
      writeFileSync(join(dir, name), JSON.stringify(value));
    }
    return dir;
  }

  it("answers no when the store does not exist", () => {
    expect(
      isDelegatedSession(
        { Q_DELEGATION_HOME: join(tmpdir(), "definitely-not-here") },
        "/repo",
        "s1",
        NOW,
      ),
    ).toBe(false);
  });

  it("writes the session id back on the first match", () => {
    const dir = store({ "a.json": marker() });
    expect(
      isDelegatedSession(
        { Q_DELEGATION_HOME: dir },
        "/repo",
        "s1",
        NOW + 1_000,
      ),
    ).toBe(true);

    const written = JSON.parse(
      readFileSync(join(dir, "a.json"), "utf8"),
    ) as DelegationMarker;
    expect(written.sessionIds).toEqual(["s1"]);

    // The binding is what carries the session past the arm window.
    expect(
      isDelegatedSession(
        { Q_DELEGATION_HOME: dir },
        "/repo",
        "s1",
        NOW + 500_000,
      ),
    ).toBe(true);
  });

  it("prunes expired markers off the disk", () => {
    const dir = store({ "old.json": marker({ expiresAt: NOW - 1 }) });
    expect(
      isDelegatedSession({ Q_DELEGATION_HOME: dir }, "/repo", "s1", NOW),
    ).toBe(false);
    expect(() => readFileSync(join(dir, "old.json"), "utf8")).toThrow();
  });

  it("ignores a corrupt marker rather than throwing into the hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-"));
    dirs.push(dir);
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(
      isDelegatedSession({ Q_DELEGATION_HOME: dir }, "/repo", "s1", NOW),
    ).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  branchDecisions,
  detectProvider,
  projectMatches,
  type DecisionRecord,
} from "./analyze-branch";

function decision(
  id: string,
  timestamp: string,
  files: string[],
): DecisionRecord {
  return {
    id,
    type: "decision",
    decision: id,
    reason: "",
    tradeoff: "",
    facets: [],
    needs_your_call: false,
    options: [],
    files,
    timestamp,
  };
}

describe("detectProvider", () => {
  test("detects GitHub ssh remotes", () => {
    expect(detectProvider("git@github.com:org/repo.git")).toBe("github");
  });

  test("detects GitHub https remotes", () => {
    expect(detectProvider("https://github.com/org/repo.git")).toBe("github");
  });

  test("detects GitLab https remotes", () => {
    expect(detectProvider("https://gitlab.com/org/repo.git")).toBe("gitlab");
  });

  test("detects self-hosted GitLab remotes", () => {
    expect(detectProvider("ssh://git@gitlab.acme.com/org/repo.git")).toBe(
      "gitlab",
    );
  });

  test("returns unknown for null or unsupported hosts", () => {
    expect(detectProvider(null)).toBe("unknown");
    expect(detectProvider("https://bitbucket.org/org/repo.git")).toBe(
      "unknown",
    );
  });
});

describe("projectMatches", () => {
  test("matches exact resolved paths", () => {
    expect(projectMatches("/tmp/chronicle", "/tmp/chronicle")).toBe(true);
  });

  test("normalizes trailing slashes", () => {
    expect(projectMatches("/tmp/chronicle/", "/tmp/chronicle")).toBe(true);
  });

  test("rejects different paths", () => {
    expect(projectMatches("/tmp/chronicle-a", "/tmp/chronicle-b")).toBe(false);
  });
});

describe("branchDecisions", () => {
  test("returns empty when input is empty", () => {
    expect(
      branchDecisions([], ["src/a.ts"], "2026-01-01T00:00:00.000Z"),
    ).toEqual([]);
  });

  test("keeps only records at or after the cutoff", () => {
    const records = [
      decision("before", "2025-12-31T23:59:59.999Z", []),
      decision("equal", "2026-01-01T00:00:00.000Z", []),
      decision("after", "2026-01-01T00:00:00.001Z", []),
    ];

    expect(
      branchDecisions(records, [], "2026-01-01T00:00:00.000Z").map(
        (record) => record.id,
      ),
    ).toEqual(["equal", "after"]);
  });

  test("keeps overlapping files and drops non-overlapping files", () => {
    const records = [
      decision("overlap", "2026-01-01T00:00:00.000Z", ["src/a.ts"]),
      decision("miss", "2026-01-01T00:00:00.000Z", ["src/b.ts"]),
    ];

    expect(
      branchDecisions(records, ["src/a.ts"], "2026-01-01T00:00:00.000Z").map(
        (record) => record.id,
      ),
    ).toEqual(["overlap"]);
  });

  test("keeps empty files records on time alone", () => {
    const records = [
      decision("unscoped", "2026-01-01T00:00:00.000Z", []),
      decision("miss", "2026-01-01T00:00:00.000Z", ["src/b.ts"]),
    ];

    expect(
      branchDecisions(records, ["src/a.ts"], "2026-01-01T00:00:00.000Z").map(
        (record) => record.id,
      ),
    ).toEqual(["unscoped"]);
  });
});

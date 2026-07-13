import { describe, expect, test } from "bun:test";
import {
  branchDecisions,
  collectDecisions,
  fallbackPayloadForError,
  detectProvider,
  parseRepoSlug,
  pickPushRemote,
  projectMatches,
  qualifyHead,
  remotePushUrlArgs,
  resolveCrossFork,
  selectBaseRef,
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

  test("compares timestamps chronologically across timezone formats", () => {
    // Cutoff in local +08:00, records in UTC Z. 16:48:34+08:00 == 08:48:34Z, so
    // the 12:59Z record (later) must be kept and the 07:00Z record (earlier)
    // dropped. A lexical string compare would invert this (12 < 16 < 07 is false
    // etc.), which is the real-world bug this guards against.
    const records = [
      decision("after-utc", "2026-06-18T12:59:51.331Z", []),
      decision("before-utc", "2026-06-18T07:00:00.000Z", []),
    ];

    expect(
      branchDecisions(records, [], "2026-06-18T16:48:34+08:00").map(
        (record) => record.id,
      ),
    ).toEqual(["after-utc"]);
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

describe("fallbackPayloadForError", () => {
  test("preserves the failure message", () => {
    expect(fallbackPayloadForError(new Error("merge-base failed")).error).toBe(
      "merge-base failed",
    );
  });

  test("stringifies non-error failures", () => {
    expect(fallbackPayloadForError("boom").error).toBe("boom");
  });
});

describe("parseRepoSlug", () => {
  test("reads owner/name from https and ssh remotes", () => {
    expect(parseRepoSlug("https://github.com/FunnyQ/cc-plugins.git")).toBe(
      "FunnyQ/cc-plugins",
    );
    expect(parseRepoSlug("https://github.com/FunnyQ/cc-plugins")).toBe(
      "FunnyQ/cc-plugins",
    );
    expect(parseRepoSlug("git@github.com:Dylan0203/cc-plugins.git")).toBe(
      "Dylan0203/cc-plugins",
    );
    expect(parseRepoSlug("ssh://git@github.com/Owner/repo.git")).toBe(
      "Owner/repo",
    );
  });

  test("returns null for nothing parseable", () => {
    expect(parseRepoSlug(null)).toBeNull();
    expect(parseRepoSlug("not-a-remote")).toBeNull();
  });
});

describe("qualifyHead", () => {
  test("prefixes the fork owner when head and base repos differ", () => {
    expect(
      qualifyHead("fix/foo", "Dylan0203/cc-plugins", "FunnyQ/cc-plugins"),
    ).toBe("Dylan0203:fix/foo");
  });

  test("leaves head bare when both point at the same repo", () => {
    expect(
      qualifyHead("fix/foo", "FunnyQ/cc-plugins", "FunnyQ/cc-plugins"),
    ).toBe("fix/foo");
  });

  test("leaves head bare when either slug is unknown", () => {
    expect(qualifyHead("fix/foo", null, "FunnyQ/cc-plugins")).toBe("fix/foo");
    expect(qualifyHead("fix/foo", "Dylan0203/cc-plugins", null)).toBe(
      "fix/foo",
    );
  });
});

describe("resolveCrossFork", () => {
  const UPSTREAM = "https://github.com/FunnyQ/cc-plugins.git";
  const FORK = "git@github.com:Dylan0203/cc-plugins.git";

  // origin = upstream, branch pushed to a separate fork remote. This is the case
  // `gh` cannot infer, so the target repo must be made explicit.
  test("qualifies head and names the target repo when origin is upstream", () => {
    expect(resolveCrossFork("fix/foo", FORK, UPSTREAM, "github")).toEqual({
      head: "Dylan0203:fix/foo",
      repo: "FunnyQ/cc-plugins",
    });
  });

  // gh's own fork workflow (origin = your fork). gh already defaults the base repo
  // to the parent; emitting --repo here would open a fork→fork PR instead.
  test("stays out of the way when the branch pushes to origin", () => {
    expect(resolveCrossFork("fix/foo", UPSTREAM, UPSTREAM, "github")).toEqual({
      head: "fix/foo",
      repo: null,
    });
  });

  test("falls back to today's behavior when a remote is unreadable", () => {
    expect(resolveCrossFork("fix/foo", null, UPSTREAM, "github")).toEqual({
      head: "fix/foo",
      repo: null,
    });
    expect(resolveCrossFork("fix/foo", FORK, null, "github")).toEqual({
      head: "fix/foo",
      repo: null,
    });
  });

  // `owner:branch` is gh's syntax, and only gh's. glab reads --source-branch as a
  // plain branch name, so a qualified head would hand it a branch that cannot exist.
  test("keeps a bare head on non-GitHub providers, fork or not", () => {
    const GL_UPSTREAM = "git@gitlab.com:group/project.git";
    const GL_FORK = "git@gitlab.com:me/project.git";
    expect(resolveCrossFork("fix/foo", GL_FORK, GL_UPSTREAM, "gitlab")).toEqual(
      { head: "fix/foo", repo: null },
    );
    expect(resolveCrossFork("fix/foo", FORK, UPSTREAM, "unknown")).toEqual({
      head: "fix/foo",
      repo: null,
    });
  });
});

// Git resolves the push destination through a chain — branch.<name>.pushRemote →
// remote.pushDefault → branch.<name>.remote — not the tracking remote alone. The
// triangular workflow (fetch upstream, push fork) lives entirely in the first two.
describe("pickPushRemote", () => {
  test("branch pushRemote outranks everything", () => {
    expect(
      pickPushRemote({
        pushRemote: "fork",
        pushDefault: "other",
        trackingRemote: "origin",
      }),
    ).toBe("fork");
  });

  // The canonical triangular setup: the branch tracks origin (upstream) for fetch,
  // while remote.pushDefault sends every push to the fork.
  test("remote.pushDefault beats the tracking remote", () => {
    expect(
      pickPushRemote({
        pushRemote: null,
        pushDefault: "fork",
        trackingRemote: "origin",
      }),
    ).toBe("fork");
  });

  test("falls back to the tracking remote, then to null", () => {
    expect(
      pickPushRemote({
        pushRemote: null,
        pushDefault: null,
        trackingRemote: "origin",
      }),
    ).toBe("origin");
    expect(
      pickPushRemote({
        pushRemote: null,
        pushDefault: null,
        trackingRemote: null,
      }),
    ).toBeNull();
  });
});

describe("remotePushUrlArgs", () => {
  test("requests the configured push URL for a named remote", () => {
    expect(remotePushUrlArgs("origin")).toEqual([
      "remote",
      "get-url",
      "--push",
      "origin",
    ]);
  });
});

// A cockpit registry can list several session logs. One of them being unreadable —
// deleted out from under us, half-written, wrong permissions — used to discard every
// decision harvested from its siblings and report hasCockpit:false, silently gutting
// the PR body's "Why" section.
describe("collectDecisions", () => {
  const at = (id: string) => decision(id, "2026-01-01T00:00:00.000Z", []);

  test("gathers records from every readable log", async () => {
    const read = async (path: string) => [at(path)];
    const records = await collectDecisions(["a.jsonl", "b.jsonl"], read);
    expect(records.map((r) => r.id)).toEqual(["a.jsonl", "b.jsonl"]);
  });

  test("skips an unreadable log instead of discarding its siblings", async () => {
    const read = async (path: string) => {
      if (path === "bad.jsonl") throw new Error("EACCES");
      return [at(path)];
    };
    const records = await collectDecisions(
      ["a.jsonl", "bad.jsonl", "b.jsonl"],
      read,
    );
    expect(records.map((r) => r.id)).toEqual(["a.jsonl", "b.jsonl"]);
  });

  test("returns empty when every log fails", async () => {
    const read = async () => {
      throw new Error("EACCES");
    };
    expect(await collectDecisions(["a.jsonl"], read)).toEqual([]);
  });
});

describe("selectBaseRef", () => {
  test("preserves an explicit local base when it exists", () => {
    expect(selectBaseRef("target", true, true)).toBe("target");
  });

  test("falls back to the remote ref in a fresh clone", () => {
    expect(selectBaseRef("develop", false, true)).toBe("origin/develop");
  });

  test("leaves an unknown base unchanged so git reports the error", () => {
    expect(selectBaseRef("missing", false, false)).toBe("missing");
  });
});

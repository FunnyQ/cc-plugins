import { describe, expect, test } from "bun:test";

import { formatPlanDigest, formatRunDigest, type Plan } from "./release";
import type { Unit } from "./stages";

const unit: Unit = {
  component: "chronicle",
  targetVersion: "0.16.0",
  lastTag: "chronicle-v0.15.1",
  tagName: "chronicle-v0.16.0",
  headerLabel: "chronicle 0.16.0",
  pathScope: "packages/chronicle",
  versionFiles: [
    { path: "packages/chronicle/.claude-plugin/plugin.json", kind: "json" },
  ],
  artifacts: [],
};

const plan: Plan = {
  workflow: "github-flow",
  branch: "main",
  head: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
  releaseCommit: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
  changelogPath: "CHANGELOG.md",
  units: [unit],
  files: ["packages/chronicle/.claude-plugin/plugin.json", "CHANGELOG.md"],
  subject: "🔧 release: chronicle 0.16.0",
  stages: [
    { id: "bump", state: "pending" },
    { id: "entry", state: "done" },
    { id: "tag", state: "pending" },
  ],
};

describe("formatPlanDigest", () => {
  test("carries the target, the stage states, and the annalist's inputs", () => {
    const digest = formatPlanDigest(plan);

    expect(digest).toContain("chronicle 0.16.0 → chronicle-v0.16.0");
    expect(digest).toContain("on b0fd788 (main, github-flow)");
    // A done stage is marked, so the caller skips the annalist without reading JSON.
    expect(digest).toContain("stages     bump entry✓ tag");
    expect(digest).toContain(
      'CHANGELOG.md · header "chronicle 0.16.0" · scope packages/chronicle · since chronicle-v0.15.1',
    );
    expect(digest).toContain("🔧 release: chronicle 0.16.0");
  });

  // A blocked stage is the one thing that stops the release, so it gets its own
  // line rather than hiding as a state letter in the stage list.
  test("gives a blocked stage its own line with the reason", () => {
    const digest = formatPlanDigest({
      ...plan,
      stages: [
        { id: "bump", state: "pending" },
        {
          id: "tag",
          state: "blocked",
          note: "chronicle-v0.16.0 is on 1a2b3c4",
        },
      ],
    });

    expect(digest).toContain("BLOCKED    tag: chronicle-v0.16.0 is on 1a2b3c4");
  });

  test("names a whole-repo unit and its scope without a component", () => {
    const digest = formatPlanDigest({
      ...plan,
      units: [
        { ...unit, component: null, pathScope: null, headerLabel: "0.16.0" },
      ],
    });

    expect(digest).toContain("plan       repo 0.16.0 →");
    expect(digest).toContain("scope whole repo");
  });
});

describe("formatRunDigest", () => {
  test("reports what ran, the commit, and the tags", () => {
    const digest = formatRunDigest({
      executed: ["bump", "entry", "commit", "tag"],
      skipped: [],
      releaseCommit: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
      tags: ["chronicle-v0.16.0"],
      branch: "main",
      workflow: "github-flow",
      log: "",
    });

    expect(digest).toContain("executed   bump entry commit tag");
    expect(digest).toContain("skipped    —");
    expect(digest).toContain("commit     b0fd788 on main");
    expect(digest).toContain("tags       chronicle-v0.16.0");
  });

  // A resumed run that finds everything done prints empty lists, which reads as a
  // successful release until the words say otherwise.
  test("says so when a resumed run executed nothing", () => {
    const digest = formatRunDigest({
      executed: [],
      skipped: ["bump", "entry"],
      releaseCommit: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
      tags: [],
      branch: "main",
      workflow: "github-flow",
      log: "",
    });

    expect(digest).toContain("nothing — every stage already done");
    expect(digest).toContain("tags       —");
  });
});

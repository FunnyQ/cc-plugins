import { describe, expect, test } from "bun:test";
import {
  artifactsDone,
  bumpDone,
  commitDone,
  deriveUnits,
  entryDone,
  hasArtifacts,
  stagesFor,
  tagState,
  touchedFiles,
  type Unit,
} from "./stages";
import type { ReleaseConfig } from "./analyze-release";

const perComponent: ReleaseConfig = {
  mode: "per-component",
  workflow: "github-flow",
  tag: "{component}-v{version}",
  changelog: "CHANGELOG.md",
  branches: { main: "main" },
  versionFiles: [],
  components: [
    {
      name: "chronicle",
      path: "packages/chronicle",
      versionFiles: [
        { path: "packages/chronicle/.claude-plugin/plugin.json", kind: "json" },
        { path: "packages/chronicle/.codex-plugin/plugin.json", kind: "json" },
      ],
    },
    {
      name: "monitor",
      path: "packages/monitor",
      versionFiles: [
        { path: "packages/monitor/.claude-plugin/plugin.json", kind: "json" },
      ],
    },
  ],
};

const wholeRepo: ReleaseConfig = {
  mode: "whole-repo",
  workflow: "git-flow",
  tag: "v{version}",
  changelog: "CHANGELOG.md",
  branches: { develop: "develop", main: "main" },
  versionFiles: [{ path: "package.json", kind: "json" }],
};

const tagOnlyShape: ReleaseConfig = { ...wholeRepo, versionFiles: [] };

const json = (v: string) => `{\n  "version": "${v}"\n}\n`;

describe("deriveUnits", () => {
  test("fills tag, header, and scope from the config", () => {
    const [u] = deriveUnits(perComponent, [
      {
        component: "chronicle",
        targetVersion: "0.11.0",
        lastTag: "chronicle-v0.10.6",
      },
    ]);
    expect(u).toEqual({
      component: "chronicle",
      targetVersion: "0.11.0",
      lastTag: "chronicle-v0.10.6",
      tagName: "chronicle-v0.11.0",
      headerLabel: "chronicle 0.11.0",
      pathScope: "packages/chronicle",
      versionFiles: perComponent.components![0].versionFiles,
      artifacts: [],
    });
  });

  test("whole-repo has no component, no scope, and a bare label", () => {
    const [u] = deriveUnits(wholeRepo, [
      { component: null, targetVersion: "2.0.0", lastTag: "v1.9.0" },
    ]);
    expect(u.tagName).toBe("v2.0.0");
    expect(u.headerLabel).toBe("2.0.0");
    expect(u.pathScope).toBe(null);
    expect(u.component).toBe(null);
  });

  test("a coordinated release derives one unit per choice, in order", () => {
    const units = deriveUnits(perComponent, [
      { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
      { component: "monitor", targetVersion: "4.1.0", lastTag: null },
    ]);
    expect(units.map((u) => u.tagName)).toEqual([
      "chronicle-v0.11.0",
      "monitor-v4.1.0",
    ]);
  });

  test("an unknown component is an error, not a silent skip that tags an empty bump", () => {
    expect(() =>
      deriveUnits(perComponent, [
        { component: "ghost", targetVersion: "1.0.0", lastTag: null },
      ]),
    ).toThrow(/ghost/);
  });
});

describe("bumpDone", () => {
  const [unit] = deriveUnits(perComponent, [
    { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
  ]);

  test("true only when every version file carries the target", () => {
    expect(
      bumpDone(unit, {
        "packages/chronicle/.claude-plugin/plugin.json": json("0.11.0"),
        "packages/chronicle/.codex-plugin/plugin.json": json("0.11.0"),
      }),
    ).toBe(true);
  });

  test("false when one file lags — the half-applied bump", () => {
    expect(
      bumpDone(unit, {
        "packages/chronicle/.claude-plugin/plugin.json": json("0.11.0"),
        "packages/chronicle/.codex-plugin/plugin.json": json("0.10.6"),
      }),
    ).toBe(false);
  });

  test("false when a file is unreadable", () => {
    expect(
      bumpDone(unit, {
        "packages/chronicle/.claude-plugin/plugin.json": json("0.11.0"),
        "packages/chronicle/.codex-plugin/plugin.json": null,
      }),
    ).toBe(false);
  });

  test("a leading v on either side still matches", () => {
    const [u] = deriveUnits(wholeRepo, [
      { component: null, targetVersion: "v2.0.0", lastTag: null },
    ]);
    expect(bumpDone(u, { "package.json": json("2.0.0") })).toBe(true);
  });

  test("true when the unit has no version file at all, so the tag-only shape never stalls", () => {
    const [u] = deriveUnits(tagOnlyShape, [
      { component: null, targetVersion: "2.0.0", lastTag: null },
    ]);
    expect(bumpDone(u, {})).toBe(true);
  });
});

describe("entryDone", () => {
  const [unit] = deriveUnits(perComponent, [
    { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
  ]);

  test("true when the changelog heads this unit's entry", () => {
    expect(
      entryDone(unit, "# Changelog\n\n## [chronicle 0.11.0] - 2026-08-09\n"),
    ).toBe(true);
  });

  test("false for another component at the same version", () => {
    expect(entryDone(unit, "## [monitor 0.11.0] - 2026-08-09\n")).toBe(false);
  });

  test("false when only the previous version is there", () => {
    expect(entryDone(unit, "## [chronicle 0.10.6] - 2026-01-01\n")).toBe(false);
  });
});

describe("commitDone — the check the old prepared-state bug turned on", () => {
  const [unit] = deriveUnits(perComponent, [
    { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
  ]);
  const bumped = {
    "packages/chronicle/.claude-plugin/plugin.json": json("0.11.0"),
    "packages/chronicle/.codex-plugin/plugin.json": json("0.11.0"),
  };
  const stale = {
    "packages/chronicle/.claude-plugin/plugin.json": json("0.10.6"),
    "packages/chronicle/.codex-plugin/plugin.json": json("0.10.6"),
  };
  const entry = "## [chronicle 0.11.0] - 2026-08-09\n";

  test("true when HEAD carries both halves", () => {
    expect(commitDone(unit, bumped, entry)).toBe(true);
  });

  test("false when HEAD still has the old version — prepare stopped here", () => {
    expect(commitDone(unit, stale, "# Changelog\n")).toBe(false);
  });

  test("false when HEAD has the bump but not the entry", () => {
    expect(commitDone(unit, bumped, "# Changelog\n")).toBe(false);
  });

  test("the tag-only shape rests entirely on the entry", () => {
    const [u] = deriveUnits(tagOnlyShape, [
      { component: null, targetVersion: "2.0.0", lastTag: null },
    ]);
    expect(commitDone(u, {}, "## [2.0.0] - 2026-08-09\n")).toBe(true);
    expect(commitDone(u, {}, "# Changelog\n")).toBe(false);
  });
});

describe("tagState", () => {
  const [unit] = deriveUnits(perComponent, [
    { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
  ]);

  test("missing when no such tag exists", () => {
    expect(tagState(unit, {}, "abc123")).toBe("missing");
  });

  test("correct when it already points at the release commit — a safe re-run", () => {
    expect(tagState(unit, { "chronicle-v0.11.0": "abc123" }, "abc123")).toBe(
      "correct",
    );
  });

  test("conflict when it points somewhere else", () => {
    expect(tagState(unit, { "chronicle-v0.11.0": "deadbee" }, "abc123")).toBe(
      "conflict",
    );
  });
});

describe("touchedFiles", () => {
  test("every unit's version files plus the changelog, deduped and stable", () => {
    const units = deriveUnits(perComponent, [
      { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
      { component: "monitor", targetVersion: "4.1.0", lastTag: null },
    ]);
    expect(touchedFiles(units, perComponent, { persistConfig: false })).toEqual(
      [
        "packages/chronicle/.claude-plugin/plugin.json",
        "packages/chronicle/.codex-plugin/plugin.json",
        "packages/monitor/.claude-plugin/plugin.json",
        "CHANGELOG.md",
      ],
    );
  });

  test("does not depend on who wrote the files", () => {
    const units = deriveUnits(perComponent, [
      { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
    ]);
    expect(touchedFiles(units, perComponent, { persistConfig: false })).toEqual(
      [
        "packages/chronicle/.claude-plugin/plugin.json",
        "packages/chronicle/.codex-plugin/plugin.json",
        "CHANGELOG.md",
      ],
    );
  });

  test("a first run also stages the config it just wrote", () => {
    const units = deriveUnits(tagOnlyShape, [
      { component: null, targetVersion: "2.0.0", lastTag: null },
    ]);
    expect(touchedFiles(units, tagOnlyShape, { persistConfig: true })).toEqual([
      "CHANGELOG.md",
      ".chronicle/release.json",
    ]);
  });
});

describe("stagesFor", () => {
  test("github-flow has no merge", () => {
    expect(stagesFor(perComponent, { persistConfig: false })).toEqual([
      "bump",
      "entry",
      "commit",
      "tag",
      "push",
    ]);
  });

  test("git-flow wraps the tag in its two merges", () => {
    expect(stagesFor(wholeRepo, { persistConfig: false })).toEqual([
      "bump",
      "entry",
      "commit",
      "merge",
      "tag",
      "back-merge",
      "push",
    ]);
  });

  test("a first run leads with save-config", () => {
    expect(stagesFor(perComponent, { persistConfig: true })[0]).toBe(
      "save-config",
    );
  });
});

describe("artifacts", () => {
  const withArtifact: ReleaseConfig = {
    ...wholeRepo,
    workflow: "github-flow",
    branches: { main: "main" },
    versionFiles: [{ path: "Cargo.toml", kind: "toml" }],
    artifacts: [{ path: "bin/workbench" }],
  };

  const unitOf = (config: ReleaseConfig, targetVersion = "0.8.0") =>
    deriveUnits(config, [
      { component: null, targetVersion, lastTag: "v0.7.0" },
    ])[0];

  test("the stage only exists when the config declares one", () => {
    expect(stagesFor(wholeRepo, { persistConfig: false })).not.toContain(
      "artifacts",
    );
    expect(stagesFor(withArtifact, { persistConfig: false })).toEqual([
      "bump",
      "artifacts",
      "entry",
      "commit",
      "tag",
      "push",
    ]);
  });

  test("it sits right after bump, the earliest it can pass, and before tag, so undoing it needs no force-push", () => {
    const order = stagesFor(withArtifact, { persistConfig: false });
    expect(order.indexOf("artifacts")).toBe(order.indexOf("bump") + 1);
    expect(order.indexOf("artifacts")).toBeLessThan(order.indexOf("tag"));
  });

  test("a component's artifacts reach its unit", () => {
    const config: ReleaseConfig = {
      ...perComponent,
      components: [
        {
          ...perComponent.components![0],
          artifacts: [{ path: "packages/chronicle/bin/cli" }],
        },
        perComponent.components![1],
      ],
    };
    const [a, b] = deriveUnits(config, [
      { component: "chronicle", targetVersion: "0.11.0", lastTag: null },
      { component: "monitor", targetVersion: "3.0.0", lastTag: null },
    ]);
    expect(a.artifacts).toEqual([{ path: "packages/chronicle/bin/cli" }]);
    expect(b.artifacts).toEqual([]);
  });

  test("done when the artifact reports the target version", () => {
    const unit = unitOf(withArtifact);
    expect(artifactsDone(unit, { "bin/workbench": "workbench 0.8.0\n" })).toBe(
      true,
    );
    expect(artifactsDone(unit, { "bin/workbench": "workbench 0.7.0\n" })).toBe(
      false,
    );
  });

  test("an artifact whose command could not run is never done", () => {
    expect(artifactsDone(unitOf(withArtifact), { "bin/workbench": null })).toBe(
      false,
    );
    expect(artifactsDone(unitOf(withArtifact), {})).toBe(false);
  });

  test("a unit with no artifact is vacuously done", () => {
    expect(artifactsDone(unitOf(wholeRepo), {})).toBe(true);
  });

  test("the artifact is staged with the release commit, so the manifest never ships beside a stale binary", () => {
    const units = deriveUnits(withArtifact, [
      { component: null, targetVersion: "0.8.0", lastTag: null },
    ]);
    expect(touchedFiles(units, withArtifact, { persistConfig: false })).toEqual(
      ["Cargo.toml", "bin/workbench", "CHANGELOG.md"],
    );
  });
});

describe("hasArtifacts", () => {
  test("sees a component-level declaration", () => {
    expect(hasArtifacts(perComponent)).toBe(false);
    expect(
      hasArtifacts({
        ...perComponent,
        components: [
          { ...perComponent.components![0], artifacts: [{ path: "bin/x" }] },
        ],
      }),
    ).toBe(true);
  });
});

describe("stages.ts", () => {
  test("imports no fs, shell, or git, so every release decision stays unit-testable", async () => {
    const source = await Bun.file(
      new URL("./stages.ts", import.meta.url),
    ).text();
    const imports = new Bun.Transpiler({ loader: "ts" })
      .scanImports(source)
      .map((i) => i.path);
    expect(imports).toEqual(["./analyze-release"]);
  });
});

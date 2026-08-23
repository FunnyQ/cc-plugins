import { describe, expect, test } from "bun:test";
import {
  agreedVersion,
  applyVersionToContent,
  artifactCommand,
  cargoLockSpec,
  cargoPackageName,
  computeBumps,
  detectShape,
  detectVersionFileDrift,
  detectWorkflow,
  detectWorkflowDrift,
  effectiveWorkflow,
  hasChangelogEntry,
  lastTagFor,
  normalizeVersion,
  parseBranchNames,
  parseConfig,
  readVersionFromContent,
  scopedTagComponents,
  serializeConfig,
  versionInOutput,
  type ReleaseConfig,
} from "./analyze-release";

describe("normalizeVersion", () => {
  test("strips a leading v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
  });
});

describe("computeBumps", () => {
  test("computes patch/minor/major from a clean semver", () => {
    expect(computeBumps("1.2.3")).toEqual({
      patch: "1.2.4",
      minor: "1.3.0",
      major: "2.0.0",
    });
  });

  test("tolerates a leading v and drops prerelease/build metadata", () => {
    expect(computeBumps("v3.18.2-rc.1+build.7")).toEqual({
      patch: "3.18.3",
      minor: "3.19.0",
      major: "4.0.0",
    });
  });

  test("returns null for an unparseable version", () => {
    expect(computeBumps("not-a-version")).toBeNull();
    expect(computeBumps("")).toBeNull();
  });
});

describe("readVersionFromContent", () => {
  test("reads a top-level json version", () => {
    const content = `{\n  "name": "x",\n  "version": "0.4.0"\n}`;
    expect(readVersionFromContent(content, { path: "p", kind: "json" })).toBe(
      "0.4.0",
    );
  });

  test("reads a toml version", () => {
    const content = `[package]\nname = "x"\nversion = "1.5.0"\n`;
    expect(readVersionFromContent(content, { path: "p", kind: "toml" })).toBe(
      "1.5.0",
    );
  });

  test("reads a plain text VERSION file", () => {
    expect(readVersionFromContent("2.0.1\n", { path: "p", kind: "text" })).toBe(
      "2.0.1",
    );
  });

  test("reads a pattern-based version (Rails application.rb constant)", () => {
    const content = `module Diqi\n  class Application < Rails::Application\n    VERSION = "0.9.0"\n  end\nend\n`;
    expect(
      readVersionFromContent(content, {
        path: "config/application.rb",
        pattern: "VERSION\\s*=\\s*[\"']([^\"']+)[\"']",
      }),
    ).toBe("0.9.0");
  });

  test("returns null when nothing matches", () => {
    expect(
      readVersionFromContent("no version here", { path: "p", kind: "toml" }),
    ).toBeNull();
  });
});

describe("applyVersionToContent", () => {
  test("rewrites a json version and preserves formatting", () => {
    const content = `{\n  "name": "x",\n  "version": "0.4.0",\n  "keywords": ["a"]\n}`;
    const out = applyVersionToContent(
      content,
      { path: "p", kind: "json" },
      "0.5.0",
    );
    expect(out).toBe(
      `{\n  "name": "x",\n  "version": "0.5.0",\n  "keywords": ["a"]\n}`,
    );
  });

  test("only touches the top-level version, not nested ones", () => {
    const content = `{\n  "version": "0.4.0",\n  "engine": { "version": "18.0.0" }\n}`;
    const out = applyVersionToContent(
      content,
      { path: "p", kind: "json" },
      "0.5.0",
    );
    expect(out).toContain(`"version": "0.5.0"`);
    expect(out).toContain(`"version": "18.0.0"`);
  });

  test("targets top-level even when a nested version appears first", () => {
    const content = `{\n  "engine": {\n    "version": "18.0.0"\n  },\n  "version": "0.4.0"\n}`;
    const out = applyVersionToContent(
      content,
      { path: "p", kind: "json" },
      "0.5.0",
    );
    expect(out).toContain(`"version": "18.0.0"`); // nested untouched
    expect(out).toContain(`"version": "0.5.0"`); // top-level bumped
    expect(out).not.toContain(`"version": "0.4.0"`);
  });

  test("targets top-level in minified json when a nested version appears first", () => {
    const content = `{"engine":{"version":"18"},"version":"0.4.0"}`;
    const out = applyVersionToContent(
      content,
      { path: "p", kind: "json" },
      "0.5.0",
    );
    expect(out).toBe(`{"engine":{"version":"18"},"version":"0.5.0"}`);
  });

  test("rewrites a toml version", () => {
    const content = `[package]\nversion = "1.5.0"\n`;
    expect(
      applyVersionToContent(content, { path: "p", kind: "toml" }, "1.6.0"),
    ).toBe(`[package]\nversion = "1.6.0"\n`);
  });

  test("rewrites a plain text VERSION file with a trailing newline", () => {
    expect(
      applyVersionToContent("2.0.1\n", { path: "p", kind: "text" }, "2.1.0"),
    ).toBe("2.1.0\n");
  });

  test("rewrites only the captured group of a pattern file", () => {
    const content = `    VERSION = "0.9.0" # bump me\n`;
    const out = applyVersionToContent(
      content,
      {
        path: "config/application.rb",
        pattern: "VERSION\\s*=\\s*[\"']([^\"']+)[\"']",
      },
      "1.0.0",
    );
    expect(out).toBe(`    VERSION = "1.0.0" # bump me\n`);
  });

  test("throws when the version cannot be located (never silently no-ops)", () => {
    expect(() =>
      applyVersionToContent("nothing", { path: "p", kind: "toml" }, "1.0.0"),
    ).toThrow();
  });
});

const CARGO_LOCK = `# This file is automatically @generated by Cargo.
# It is not intended to be manually edited.
version = 4

[[package]]
name = "anyhow"
version = "1.0.86"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "deadbeef"

[[package]]
name = "yazi-claude-ide"
version = "0.4.0"
dependencies = [
 "anyhow",
]

[[package]]
name = "zerocopy"
version = "0.7.35"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

describe("cargoPackageName", () => {
  test("reads the [package] name, not a dependency or workspace name", () => {
    const toml = `[workspace]\nmembers = ["."]\n\n[package]\nname = "yazi-claude-ide"\nversion = "0.4.0"\n\n[dependencies]\nname = "wrong"\n`;
    expect(cargoPackageName(toml)).toBe("yazi-claude-ide");
  });

  test("returns null for a virtual manifest with no [package]", () => {
    expect(
      cargoPackageName(`[workspace]\nmembers = ["crates/*"]\n`),
    ).toBeNull();
  });
});

describe("cargoLockSpec", () => {
  test("scopes the pattern to the crate's own package block", () => {
    const spec = cargoLockSpec("Cargo.lock", "yazi-claude-ide", CARGO_LOCK);
    expect(spec).not.toBeNull();
    expect(readVersionFromContent(CARGO_LOCK, spec!)).toBe("0.4.0");
  });

  test("moves only that block — every dependency version survives", () => {
    const spec = cargoLockSpec("Cargo.lock", "yazi-claude-ide", CARGO_LOCK)!;
    const out = applyVersionToContent(CARGO_LOCK, spec, "0.5.0");
    expect(out).toContain(`name = "yazi-claude-ide"\nversion = "0.5.0"`);
    expect(out).toContain(`name = "anyhow"\nversion = "1.0.86"`);
    expect(out).toContain(`name = "zerocopy"\nversion = "0.7.35"`);
    expect(out.startsWith("# This file is automatically")).toBe(true);
    expect(out).toContain("\nversion = 4\n");
  });

  test("returns null when the lock has no block for the crate", () => {
    expect(cargoLockSpec("Cargo.lock", "not-in-lock", CARGO_LOCK)).toBeNull();
  });
});

describe("scopedTagComponents", () => {
  test("extracts component names from scoped tags", () => {
    const tags = [
      "chronicle-v0.4.0",
      "chronicle-v0.3.2",
      "monitor-v3.18.2",
      "v3.12.1",
      "dispatch-v3.13.0",
    ];
    expect(scopedTagComponents(tags)).toEqual(
      new Set(["chronicle", "monitor", "dispatch"]),
    );
  });

  test("returns an empty set when there are only repo-wide tags", () => {
    expect(scopedTagComponents(["v1.0.0", "v1.1.0"])).toEqual(new Set());
  });
});

describe("detectShape", () => {
  test("suggests per-component when scoped tags back the manifests", () => {
    const shape = detectShape({
      manifests: [
        {
          path: "packages/chronicle/.claude-plugin/plugin.json",
          version: "0.4.0",
          kind: "json",
        },
        {
          path: "packages/chronicle/.codex-plugin/plugin.json",
          version: "0.4.0",
          kind: "json",
        },
        {
          path: "packages/monitor/.claude-plugin/plugin.json",
          version: "3.18.2",
          kind: "json",
        },
      ],
      tags: ["chronicle-v0.4.0", "monitor-v3.18.2"],
    });
    expect(shape.mode).toBe("per-component");
    expect(shape.tag).toBe("{component}-v{version}");
    const names = (shape.components ?? []).map((c) => c.name).sort();
    expect(names).toEqual(["chronicle", "monitor"]);
    const chronicle = shape.components?.find((c) => c.name === "chronicle");
    expect(chronicle?.versionFiles.map((f) => f.path).sort()).toEqual([
      "packages/chronicle/.claude-plugin/plugin.json",
      "packages/chronicle/.codex-plugin/plugin.json",
    ]);
  });

  test("suggests whole-repo with a single obvious manifest", () => {
    const shape = detectShape({
      manifests: [
        { path: "frontend/package.json", version: "0.0.1", kind: "json" },
      ],
      tags: [],
    });
    expect(shape.mode).toBe("whole-repo");
    expect(shape.tag).toBe("v{version}");
    expect(shape.versionFiles.map((f) => f.path)).toEqual([
      "frontend/package.json",
    ]);
  });

  test("carries a manifest's companions into the version files it suggests", () => {
    const lock = {
      path: "Cargo.lock",
      pattern: 'name = "x"\\nversion = "([^"]+)"',
    };
    const shape = detectShape({
      manifests: [
        {
          path: "Cargo.toml",
          version: "0.4.0",
          kind: "toml",
          companions: [lock],
        },
      ],
      tags: [],
    });
    // The lock rides with its manifest rather than counting as one: a second
    // manifest would have collapsed this to the ambiguous, empty case.
    expect(shape.versionFiles).toEqual([
      { path: "Cargo.toml", kind: "toml" },
      lock,
    ]);
  });

  test("carries companions into a per-component's version files", () => {
    const lock = {
      path: "Cargo.lock",
      pattern: 'name = "cli"\\nversion = "([^"]+)"',
    };
    const shape = detectShape({
      manifests: [
        {
          path: "crates/cli/Cargo.toml",
          version: "0.4.0",
          kind: "toml",
          companions: [lock],
        },
      ],
      tags: ["cli-v0.4.0"],
    });
    expect(shape.components?.[0].versionFiles).toEqual([
      { path: "crates/cli/Cargo.toml", kind: "toml" },
      lock,
    ]);
  });

  test("suggests whole-repo with no version files when there is no manifest (Rails-only / diqi first release)", () => {
    const shape = detectShape({ manifests: [], tags: [] });
    expect(shape.mode).toBe("whole-repo");
    expect(shape.versionFiles).toEqual([]);
  });

  test("leaves version files empty when multiple manifests are ambiguous without scoped tags", () => {
    const shape = detectShape({
      manifests: [
        { path: "frontend/package.json", version: "0.0.1", kind: "json" },
        { path: "admin/package.json", version: "1.2.0", kind: "json" },
      ],
      tags: [],
    });
    expect(shape.mode).toBe("whole-repo");
    expect(shape.versionFiles).toEqual([]);
  });
});

describe("parseBranchNames", () => {
  test("reads local + remote names out of `git branch --all` output", () => {
    const out = [
      "* main",
      "  feature/x",
      "  remotes/origin/HEAD -> origin/main",
      "  remotes/origin/main",
    ].join("\n");
    expect(parseBranchNames(out)).toEqual(["main", "feature/x", "origin/main"]);
  });

  test("drops a detached-HEAD line", () => {
    const out = "* (HEAD detached at 1a2b3c4)\n  main";
    expect(parseBranchNames(out)).toEqual(["main"]);
  });
});

describe("detectWorkflow", () => {
  const base = { manifests: [], tags: [] };

  test("detects github-flow when the repo has no develop branch", () => {
    expect(
      detectWorkflow({ ...base, branches: ["main", "origin/main", "fix/x"] }),
    ).toEqual({ workflow: "github-flow", branches: { main: "main" } });
  });

  test("stays git-flow when develop exists only as a remote branch", () => {
    expect(
      detectWorkflow({ ...base, branches: ["main", "origin/develop"] }),
    ).toEqual({
      workflow: "git-flow",
      branches: { develop: "develop", main: "main" },
    });
  });

  test("stays git-flow when the branch list is unknown (older callers)", () => {
    expect(detectWorkflow(base)).toEqual({
      workflow: "git-flow",
      branches: { develop: "develop", main: "main" },
    });
  });

  test("uses master as the long-lived branch when there is no main", () => {
    expect(detectWorkflow({ ...base, branches: ["master", "topic"] })).toEqual({
      workflow: "github-flow",
      branches: { main: "master" },
    });
  });

  test("falls back to the current branch when neither main nor master exists", () => {
    expect(
      detectWorkflow({
        ...base,
        branches: ["trunk", "origin/trunk"],
        currentBranch: "trunk",
      }),
    ).toEqual({ workflow: "github-flow", branches: { main: "trunk" } });
  });
});

describe("detectWorkflowDrift", () => {
  const gitFlow: ReleaseConfig = {
    mode: "whole-repo",
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches: { develop: "develop", main: "main" },
    versionFiles: [],
  };

  test("flags a git-flow config whose develop branch is gone", () => {
    expect(detectWorkflowDrift(gitFlow, ["main", "origin/main"])).toEqual({
      configured: "git-flow",
      missingBranch: "develop",
      suggest: "github-flow",
    });
  });

  test("stays quiet while develop still exists", () => {
    expect(detectWorkflowDrift(gitFlow, ["main", "origin/develop"])).toBeNull();
  });

  test("stays quiet for a github-flow config", () => {
    const githubFlow: ReleaseConfig = {
      ...gitFlow,
      workflow: "github-flow",
      branches: { main: "main" },
    };
    expect(detectWorkflowDrift(githubFlow, ["main"])).toBeNull();
  });

  test("stays quiet when the branch list is unknown", () => {
    expect(detectWorkflowDrift(gitFlow, undefined)).toBeNull();
  });
});

describe("detectShape workflow", () => {
  test("a github-flow suggestion carries no develop branch", () => {
    const shape = detectShape({
      manifests: [
        { path: "frontend/package.json", version: "0.0.1", kind: "json" },
      ],
      tags: [],
      branches: ["main"],
    });
    expect(shape.workflow).toBe("github-flow");
    expect(shape.branches).toEqual({ main: "main" });
  });

  test("a develop branch still suggests git-flow", () => {
    const shape = detectShape({
      manifests: [],
      tags: ["chronicle-v0.4.0"],
      branches: ["main", "develop"],
    });
    expect(shape.workflow).toBe("git-flow");
    expect(shape.branches).toEqual({ develop: "develop", main: "main" });
  });
});

describe("lastTagFor", () => {
  test("matches a version-first template without accepting unrelated tags", () => {
    const config: ReleaseConfig = {
      mode: "whole-repo",
      tag: "{version}-final",
      changelog: "CHANGELOG.md",
      branches: { develop: "develop", main: "main" },
      versionFiles: [],
    };

    expect(
      lastTagFor(["v9.9.9", "1.2.3-final", "2.0.0", "1.3.0-final"], config),
    ).toEqual({ tag: "1.3.0-final", version: "1.3.0" });
  });
});

describe("config roundtrip", () => {
  const config: ReleaseConfig = {
    mode: "whole-repo",
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches: { develop: "develop", main: "main" },
    versionFiles: [
      { path: "frontend/package.json", kind: "json" },
      {
        path: "config/application.rb",
        pattern: "VERSION\\s*=\\s*[\"']([^\"']+)[\"']",
      },
    ],
  };

  test("serialize → parse is lossless", () => {
    expect(parseConfig(serializeConfig(config))).toEqual(config);
  });

  test("parse rejects an unknown mode", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...config, mode: "bogus" })),
    ).toThrow();
  });

  test("parse rejects malformed json", () => {
    expect(() => parseConfig("{ not json")).toThrow();
  });

  test("parse rejects a tag template missing {version}", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...config, tag: "v1.2.3" })),
    ).toThrow();
  });

  test("parse rejects missing branches", () => {
    const { branches, ...noBranches } = config;
    expect(() => parseConfig(JSON.stringify(noBranches))).toThrow();
  });

  test("parse rejects per-component without components[]", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          ...config,
          mode: "per-component",
          tag: "{component}-v{version}",
        }),
      ),
    ).toThrow();
  });

  test("parse accepts a whole-repo config with an empty versionFiles (changelog + tag only)", () => {
    const empty = { ...config, versionFiles: [] };
    expect(parseConfig(JSON.stringify(empty)).versionFiles).toEqual([]);
  });
});

describe("workflow in the config", () => {
  const gitFlow: ReleaseConfig = {
    mode: "whole-repo",
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches: { develop: "develop", main: "main" },
    versionFiles: [],
  };
  const githubFlow: ReleaseConfig = {
    ...gitFlow,
    workflow: "github-flow",
    branches: { main: "main" },
  };

  test("a config predating the field means git-flow", () => {
    expect(effectiveWorkflow(parseConfig(JSON.stringify(gitFlow)))).toBe(
      "git-flow",
    );
  });

  test("parse accepts a github-flow config with no develop branch", () => {
    const parsed = parseConfig(JSON.stringify(githubFlow));
    expect(effectiveWorkflow(parsed)).toBe("github-flow");
    expect(parsed.branches).toEqual({ main: "main" });
  });

  test("serialize → parse is lossless for github-flow", () => {
    expect(parseConfig(serializeConfig(githubFlow))).toEqual(githubFlow);
  });

  test("parse rejects a git-flow config that names no develop", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...gitFlow, branches: { main: "main" } })),
    ).toThrow();
  });

  test("parse rejects any config that names no main", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({ ...githubFlow, branches: { develop: "develop" } }),
      ),
    ).toThrow();
  });

  test("parse rejects an unknown workflow", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...gitFlow, workflow: "trunk-flow" })),
    ).toThrow();
  });
});

describe("agreedVersion", () => {
  test("returns the version when every file agrees", () => {
    expect(agreedVersion([{ current: "3.5.0" }, { current: "v3.5.0" }])).toBe(
      "3.5.0",
    );
  });

  test("returns null when the files disagree", () => {
    expect(agreedVersion([{ current: "3.5.0" }, { current: "3.4.0" }])).toBe(
      null,
    );
  });

  test("returns null when a file has no readable version", () => {
    expect(agreedVersion([{ current: "3.5.0" }, { current: null }])).toBe(null);
  });

  test("returns null for a repo with no version files", () => {
    expect(agreedVersion([])).toBe(null);
  });
});

describe("hasChangelogEntry", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [odin 3.5.0] - 2026-08-07",
    "",
    "### Added",
    "- Something.",
    "",
    "## [odin 3.4.0] - 2026-07-28",
  ].join("\n");

  test("finds a per-component heading", () => {
    expect(hasChangelogEntry(changelog, "3.5.0", "odin")).toBe(true);
  });

  test("misses a version that has no heading", () => {
    expect(hasChangelogEntry(changelog, "3.6.0", "odin")).toBe(false);
  });

  test("does not match another component at the same version", () => {
    expect(hasChangelogEntry(changelog, "3.5.0", "odin-session")).toBe(false);
  });

  test("finds a whole-repo heading", () => {
    expect(hasChangelogEntry("## [0.5.0] - 2026-08-07", "0.5.0")).toBe(true);
  });

  test("tolerates a v prefix on either side", () => {
    expect(hasChangelogEntry("## [v0.5.0] - 2026-08-07", "0.5.0")).toBe(true);
    expect(hasChangelogEntry("## [0.5.0] - 2026-08-07", "v0.5.0")).toBe(true);
  });

  test("ignores a heading that only contains the version as a substring", () => {
    expect(hasChangelogEntry("## [0.5.01] - 2026-08-07", "0.5.0")).toBe(false);
  });
});

describe("hasChangelogEntry edge cases", () => {
  test("escapes regex characters in a component name", () => {
    expect(
      hasChangelogEntry(
        "## [odin.core 1.0.0] - 2026-01-01",
        "1.0.0",
        "odin.core",
      ),
    ).toBe(true);
    expect(
      hasChangelogEntry(
        "## [odinXcore 1.0.0] - 2026-01-01",
        "1.0.0",
        "odin.core",
      ),
    ).toBe(false);
  });

  test("matches a heading in a CRLF file", () => {
    expect(
      hasChangelogEntry(
        "# Changelog\r\n\r\n## [alpha 1.0.0] - 2026-01-01\r\n",
        "1.0.0",
        "alpha",
      ),
    ).toBe(true);
  });

  test("does not match a heading deeper than h2", () => {
    expect(
      hasChangelogEntry("### [alpha 1.0.0] - 2026-01-01", "1.0.0", "alpha"),
    ).toBe(false);
  });

  test("does not match the version inside body text", () => {
    expect(
      hasChangelogEntry(
        "- upgraded to [alpha 1.0.0] last week",
        "1.0.0",
        "alpha",
      ),
    ).toBe(false);
  });
});

describe("versionInOutput", () => {
  test("finds the version anywhere in a --version banner", () => {
    expect(versionInOutput("workbench 0.8.0", "0.8.0")).toBe(true);
    expect(versionInOutput("workbench v0.8.0\n", "v0.8.0")).toBe(true);
  });

  test("rejects the version it does not carry", () => {
    expect(versionInOutput("workbench 0.7.0", "0.8.0")).toBe(false);
    expect(versionInOutput("", "0.8.0")).toBe(false);
  });

  // A substring match would call a 0.8.01 build current for 0.8.0, which is the
  // exact failure this stage exists to catch.
  test("does not match inside a longer version", () => {
    expect(versionInOutput("workbench 0.8.01", "0.8.0")).toBe(false);
    expect(versionInOutput("workbench 10.8.0", "0.8.0")).toBe(false);
    expect(versionInOutput("workbench 0.8.0-rc1", "0.8.0")).toBe(true);
  });
});

describe("artifactCommand", () => {
  test("defaults to running the artifact itself", () => {
    expect(artifactCommand({ path: "bin/workbench" })).toBe(
      "./bin/workbench --version",
    );
  });

  test("uses the configured command when given", () => {
    expect(
      artifactCommand({ path: "dist/cli.js", command: "bun dist/cli.js -V" }),
    ).toBe("bun dist/cli.js -V");
  });
});

describe("detectVersionFileDrift", () => {
  const lock = {
    path: "Cargo.lock",
    pattern: 'name = "workbench"\\nversion = "([^"]+)"',
  };
  const manifests = [
    {
      path: "Cargo.toml",
      version: "0.8.0",
      kind: "toml" as const,
      companions: [lock],
    },
  ];

  test("reports a companion the committed config never listed", () => {
    const config: ReleaseConfig = {
      mode: "whole-repo",
      workflow: "github-flow",
      tag: "v{version}",
      changelog: "CHANGELOG.md",
      branches: { main: "main" },
      versionFiles: [{ path: "Cargo.toml", pattern: 'version = "([^"]+)"' }],
    };
    expect(detectVersionFileDrift(config, manifests)).toEqual([
      { component: null, manifest: "Cargo.toml", missing: lock },
    ]);
  });

  test("stays quiet once the companion is listed", () => {
    const config: ReleaseConfig = {
      mode: "whole-repo",
      workflow: "github-flow",
      tag: "v{version}",
      changelog: "CHANGELOG.md",
      branches: { main: "main" },
      versionFiles: [{ path: "Cargo.toml", kind: "toml" }, lock],
    };
    expect(detectVersionFileDrift(config, manifests)).toEqual([]);
  });

  // Only a manifest the config already bumps can be missing a companion. A repo
  // that deliberately releases something else must not be nagged about a crate
  // it never listed.
  test("ignores a manifest the config does not bump at all", () => {
    const config: ReleaseConfig = {
      mode: "whole-repo",
      workflow: "github-flow",
      tag: "v{version}",
      changelog: "CHANGELOG.md",
      branches: { main: "main" },
      versionFiles: [{ path: "package.json", kind: "json" }],
    };
    expect(detectVersionFileDrift(config, manifests)).toEqual([]);
  });

  test("names the component whose version files are short", () => {
    const crateLock = {
      path: "Cargo.lock",
      pattern: 'name = "cli"\\nversion = "([^"]+)"',
    };
    const config: ReleaseConfig = {
      mode: "per-component",
      workflow: "github-flow",
      tag: "{component}-v{version}",
      changelog: "CHANGELOG.md",
      branches: { main: "main" },
      versionFiles: [],
      components: [
        {
          name: "cli",
          path: "crates/cli",
          versionFiles: [{ path: "crates/cli/Cargo.toml", kind: "toml" }],
        },
      ],
    };
    expect(
      detectVersionFileDrift(config, [
        {
          path: "crates/cli/Cargo.toml",
          version: "0.4.0",
          kind: "toml",
          companions: [crateLock],
        },
      ]),
    ).toEqual([
      {
        component: "cli",
        manifest: "crates/cli/Cargo.toml",
        missing: crateLock,
      },
    ]);
  });
});

describe("parseConfig artifacts", () => {
  const base = {
    mode: "whole-repo",
    workflow: "github-flow",
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches: { main: "main" },
    versionFiles: [],
  };

  test("accepts an artifacts list", () => {
    const config = parseConfig(
      JSON.stringify({ ...base, artifacts: [{ path: "bin/workbench" }] }),
    );
    expect(config.artifacts).toEqual([{ path: "bin/workbench" }]);
  });

  test("rejects an artifact with no path", () => {
    expect(() =>
      parseConfig(JSON.stringify({ ...base, artifacts: [{ build: "make" }] })),
    ).toThrow(/artifacts/);
  });
});

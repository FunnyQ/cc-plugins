import { describe, expect, test } from "bun:test";
import {
  applyVersionToContent,
  computeBumps,
  detectShape,
  normalizeVersion,
  parseConfig,
  readVersionFromContent,
  scopedTagComponents,
  serializeConfig,
  tagPrefix,
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

describe("tagPrefix", () => {
  const whole: ReleaseConfig = {
    mode: "whole-repo",
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches: { develop: "develop", main: "main" },
    versionFiles: [],
  };

  test("whole-repo default", () => {
    expect(tagPrefix(whole)).toBe("v");
  });

  test("per-component fills {component}", () => {
    const cfg: ReleaseConfig = { ...whole, tag: "{component}-v{version}" };
    expect(tagPrefix(cfg, "chronicle")).toBe("chronicle-v");
  });

  test("honors a custom template (source of truth, not hard-coded 'v')", () => {
    expect(tagPrefix({ ...whole, tag: "release-{version}" })).toBe("release-");
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

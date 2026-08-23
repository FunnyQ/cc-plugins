import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";

import {
  GLOBAL_CONFIG_NAMES,
  buildApplyPlan,
  buildTargets,
  classifyLink,
  decideSubagentDepth,
  findSkillDirs,
  parseJsonc,
  resolveGlobalConfig,
  resolveSkillNames,
  type LinkState,
} from "./install";

// Enumeration reads the repo it ships with; `home` stays fictional so no test ever
// touches a real HOME.
const repoRoot = resolve(import.meta.dir, "..");
const home = "/tmp/opencode-installer-home";

// The golden list — the ONE place a skill count is written down. Every other
// expectation here derives from it or from the built target set, so adding a
// skill reds exactly this constant instead of three unrelated magic numbers.
const EXPECTED_SKILL_NAMES = [
  "adr",
  "autopilot",
  "chronicle-install",
  "cockpit",
  "commit",
  "flightplan",
  "herdr",
  "herdr-browser",
  "herdr-protocol-upgrade",
  "monitor-install",
  "pr",
  "preflight",
  "relay",
  "release",
  "usage-dashboard",
  "waypoints",
];

// Non-skill targets, each fixed by a directory this installer owns.
const PLUGIN_TARGETS = 1;
const AGENT_TARGETS = 13;
const COMMAND_TARGETS = 2;
const CONFIG_TARGETS = 1;

describe("findSkillDirs", () => {
  const dirs = findSkillDirs(repoRoot);

  test("finds every skill that carries a SKILL.md", () => {
    expect(dirs).toHaveLength(EXPECTED_SKILL_NAMES.length);
  });

  test("excludes monitor's shared support directory", () => {
    expect(
      dirs.some(
        (entry) => entry.plugin === "monitor" && entry.dir === "shared",
      ),
    ).toBe(false);
  });
});

describe("resolveSkillNames", () => {
  test("leaves unique skill names alone", () => {
    const named = resolveSkillNames([
      { plugin: "relay", dir: "relay" },
      { plugin: "herdr", dir: "herdr" },
    ]);

    expect(named.map((entry) => entry.name)).toEqual(["relay", "herdr"]);
  });

  test("plugin-prefixes both sides of a name collision", () => {
    const named = resolveSkillNames([
      { plugin: "monitor", dir: "install" },
      { plugin: "chronicle", dir: "install" },
      { plugin: "relay", dir: "relay" },
    ]);

    expect(named.map((entry) => entry.name)).toEqual([
      "monitor-install",
      "chronicle-install",
      "relay",
    ]);
  });
});

describe("buildTargets", () => {
  const targets = buildTargets(repoRoot, home);

  test("builds the exact target composition", () => {
    expect(
      targets
        .filter((target) => target.group === "skill")
        .map((target) => target.name)
        .sort(),
    ).toEqual(EXPECTED_SKILL_NAMES);
    expect(targets.filter((target) => target.group === "plugin")).toHaveLength(
      PLUGIN_TARGETS,
    );
    expect(targets.filter((target) => target.group === "agent")).toHaveLength(
      AGENT_TARGETS,
    );
    expect(targets.filter((target) => target.group === "command")).toHaveLength(
      COMMAND_TARGETS,
    );
    expect(targets.filter((target) => target.group === "config")).toHaveLength(
      CONFIG_TARGETS,
    );
    // The total is the sum of the parts above — asserted so a target in no
    // known group cannot slip in uncounted.
    expect(targets).toHaveLength(
      EXPECTED_SKILL_NAMES.length +
        PLUGIN_TARGETS +
        AGENT_TARGETS +
        COMMAND_TARGETS +
        CONFIG_TARGETS,
    );
  });

  test("excludes monitor's shared support directory", () => {
    expect(
      targets.some((target) =>
        target.source?.endsWith("packages/monitor/skills/shared"),
      ),
    ).toBe(false);
    expect(targets.some((target) => target.name === "shared")).toBe(false);
  });

  test("installs both colliding install skills at distinct paths", () => {
    const byName = new Map(targets.map((target) => [target.name, target]));

    expect(byName.get("monitor-install")?.source).toBe(
      join(repoRoot, "packages/monitor/skills/install"),
    );
    expect(byName.get("chronicle-install")?.source).toBe(
      join(repoRoot, "packages/chronicle/skills/install"),
    );
  });

  test("gives every target its own installed path", () => {
    const paths = targets.map((target) => target.installed);

    expect(new Set(paths).size).toBe(paths.length);
  });

  test("keeps every installed path within the OpenCode config directory", () => {
    const root = join(home, ".config", "opencode");

    for (const target of targets) {
      const child = relative(root, target.installed);
      expect(child).not.toBe("");
      expect(child.startsWith("..") || child.startsWith("/")).toBe(false);
    }
  });
});

describe("classifyLink", () => {
  const expected = join(repoRoot, "opencode", "plugin.ts");

  test.each([
    ["ok", { exists: true, isSymlink: true, resolved: expected }],
    ["missing", { exists: false, isSymlink: false, resolved: null }],
    [
      "stale",
      {
        exists: true,
        isSymlink: true,
        resolved: join(repoRoot, "old", "plugin.ts"),
      },
    ],
    [
      "broken",
      {
        exists: false,
        isSymlink: true,
        resolved: join(repoRoot, "gone", "plugin.ts"),
      },
    ],
    ["foreign", { exists: true, isSymlink: false, resolved: null }],
    [
      "foreign",
      { exists: true, isSymlink: true, resolved: "/another/repo/plugin.ts" },
    ],
  ] satisfies Array<
    [
      LinkState,
      { exists: boolean; isSymlink: boolean; resolved: string | null },
    ]
  >)("classifies %s links", (state, probe) =>
    expect(classifyLink(probe, expected, repoRoot)).toBe(state),
  );
});

describe("decideSubagentDepth", () => {
  test.each([
    [{}, "write", 2],
    [{ subagent_depth: 1 }, "write", 2],
    [{ subagent_depth: 2 }, "ok", 2],
    [{ subagent_depth: 5 }, "ok", 5],
    [{ subagent_depth: "2" }, "write", 2],
    [[], "unparsable", 2],
  ] as const)("decides %#", (config, action, value) => {
    expect(decideSubagentDepth(config)).toMatchObject({ action, value });
  });

  test("does not mutate input objects", () => {
    const sufficient = { subagent_depth: 5, theme: "q" };
    const insufficient = { subagent_depth: 1, theme: "q" };

    decideSubagentDepth(sufficient);
    decideSubagentDepth(insufficient);

    expect(sufficient).toEqual({ subagent_depth: 5, theme: "q" });
    expect(insufficient).toEqual({ subagent_depth: 1, theme: "q" });
  });

  test("downgrades a needed write to manual when the config carries comments", () => {
    expect(decideSubagentDepth({}, true)).toMatchObject({ action: "manual" });
    expect(decideSubagentDepth({ subagent_depth: 1 }, true)).toMatchObject({
      action: "manual",
    });
  });

  test("leaves a sufficient commented config alone", () => {
    expect(decideSubagentDepth({ subagent_depth: 3 }, true)).toMatchObject({
      action: "ok",
      value: 3,
    });
  });
});

describe("parseJsonc", () => {
  test("accepts plain JSON without reporting loss", () => {
    expect(parseJsonc('{"subagent_depth": 2}')).toEqual({
      value: { subagent_depth: 2 },
      ok: true,
      lossy: false,
    });
  });

  test("strips line and block comments and reports the loss", () => {
    const text = `{
      // the depth chronicle needs
      "subagent_depth": 2, /* raise-only */
      "theme": "q"
    }`;

    expect(parseJsonc(text)).toEqual({
      value: { subagent_depth: 2, theme: "q" },
      ok: true,
      lossy: true,
    });
  });

  test("strips trailing commas without calling the file lossy", () => {
    expect(parseJsonc('{"a": [1, 2,], "b": 3,}')).toEqual({
      value: { a: [1, 2], b: 3 },
      ok: true,
      lossy: false,
    });
  });

  test("never mistakes string content for syntax", () => {
    // `$schema` is in every generated OpenCode config, and a naive stripper
    // truncates it at the `//`.
    const text = '{"$schema": "https://opencode.ai/config.json", "a": "x,}"}';

    expect(parseJsonc(text)).toEqual({
      value: { $schema: "https://opencode.ai/config.json", a: "x,}" },
      ok: true,
      lossy: false,
    });
  });

  test("reports genuinely broken JSON", () => {
    expect(parseJsonc("{ nope")).toMatchObject({ ok: false });
  });
});

describe("resolveGlobalConfig", () => {
  const configRoot = join(home, ".config", "opencode");
  const only =
    (...present: string[]) =>
    (path: string) =>
      present.includes(path);

  test.each(GLOBAL_CONFIG_NAMES)("resolves an existing %s", (name) => {
    expect(resolveGlobalConfig(configRoot, only(join(configRoot, name)))).toBe(
      join(configRoot, name),
    );
  });

  test("prefers the file OpenCode merges last when several exist", () => {
    expect(
      resolveGlobalConfig(
        configRoot,
        only(
          join(configRoot, "config.json"),
          join(configRoot, "opencode.json"),
          join(configRoot, "opencode.jsonc"),
        ),
      ),
    ).toBe(join(configRoot, "opencode.jsonc"));
  });

  test("creates opencode.json when nothing exists", () => {
    expect(resolveGlobalConfig(configRoot, () => false)).toBe(
      join(configRoot, "opencode.json"),
    );
  });
});

describe("buildApplyPlan", () => {
  const targets = buildTargets(repoRoot, home);
  const symlinks = targets.filter((target) => target.group !== "config");

  test("creates every target on a clean home", () => {
    const states = new Map(
      symlinks.map((target) => [target.installed, "missing" as const]),
    );
    const plan = buildApplyPlan(targets, states, decideSubagentDepth({}));

    // One create per symlink, plus the single config write.
    expect(
      plan.operations.filter(
        (operation) =>
          operation.action === "create" || operation.action === "write",
      ),
    ).toHaveLength(symlinks.length + CONFIG_TARGETS);
    expect(plan.success).toBe(true);
  });

  test("creates nothing on an already-correct home", () => {
    const states = new Map(
      symlinks.map((target) => [target.installed, "ok" as const]),
    );
    const plan = buildApplyPlan(
      targets,
      states,
      decideSubagentDepth({ subagent_depth: 2 }),
    );

    expect(
      plan.operations.every((operation) => operation.action === "keep"),
    ).toBe(true);
    expect(plan.success).toBe(true);
  });

  test("replaces stale and broken links", () => {
    const states = new Map(
      symlinks.map((target) => [target.installed, "ok" as LinkState]),
    );
    states.set(symlinks[0].installed, "stale");
    states.set(symlinks[1].installed, "broken");
    const plan = buildApplyPlan(
      targets,
      states,
      decideSubagentDepth({ subagent_depth: 2 }),
    );

    expect(plan.operations[0].action).toBe("replace");
    expect(plan.operations[1].action).toBe("replace");
    expect(plan.success).toBe(true);
  });

  test("skips foreign entries and fails the plan", () => {
    const states = new Map(
      symlinks.map((target) => [target.installed, "ok" as LinkState]),
    );
    states.set(symlinks[0].installed, "foreign");
    const plan = buildApplyPlan(
      targets,
      states,
      decideSubagentDepth({ subagent_depth: 2 }),
    );

    expect(
      plan.operations.find((operation) => operation.target === symlinks[0])
        ?.action,
    ).toBe("skip");
    expect(plan.success).toBe(false);
  });

  test("skips the config write when the file is unparsable", () => {
    const states = new Map(
      symlinks.map((target) => [target.installed, "ok" as LinkState]),
    );
    const plan = buildApplyPlan(
      targets,
      states,
      decideSubagentDepth("not json"),
    );

    expect(plan.operations.at(-1)?.action).toBe("skip");
    expect(plan.success).toBe(false);
  });
});

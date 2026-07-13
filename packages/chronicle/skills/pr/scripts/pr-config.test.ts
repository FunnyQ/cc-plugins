import { describe, expect, test } from "bun:test";
import {
  buildFirstRunState,
  configCommitArgs,
  parsePrConfig,
  resolveConfiguredBase,
  selectProductionBranch,
  serializePrConfig,
  type PrConfig,
} from "./pr-config";

describe("parsePrConfig", () => {
  test("accepts GitHub Flow config", () => {
    expect(parsePrConfig('{"workflow":"github-flow","base":"main"}')).toEqual({
      workflow: "github-flow",
      base: "main",
    });
  });

  test("accepts Git Flow config", () => {
    expect(
      parsePrConfig(
        '{"workflow":"git-flow","production":"master","development":"develop"}',
      ),
    ).toEqual({
      workflow: "git-flow",
      production: "master",
      development: "develop",
    });
  });

  test("rejects incomplete or unknown config", () => {
    expect(() => parsePrConfig('{"workflow":"github-flow"}')).toThrow(
      "base must be a non-empty string",
    );
    expect(() => parsePrConfig('{"workflow":"trunk"}')).toThrow(
      "unknown workflow trunk",
    );
  });

  test("normalizes surrounding whitespace in branch names", () => {
    expect(parsePrConfig('{"workflow":"github-flow","base":" main "}')).toEqual(
      { workflow: "github-flow", base: "main" },
    );
  });
});

describe("resolveConfiguredBase", () => {
  test("always uses the configured GitHub Flow base", () => {
    const config: PrConfig = { workflow: "github-flow", base: "main" };
    expect(resolveConfiguredBase(config, "feature/a")).toBe("main");
    expect(resolveConfiguredBase(config, "release/1.0.0")).toBe("main");
  });

  test("routes Git Flow release and hotfix branches to production", () => {
    const config: PrConfig = {
      workflow: "git-flow",
      production: "main",
      development: "develop",
    };
    expect(resolveConfiguredBase(config, "release/1.0.0")).toBe("main");
    expect(resolveConfiguredBase(config, "release-1.0.0")).toBe("main");
    expect(resolveConfiguredBase(config, "hotfix/urgent")).toBe("main");
    expect(resolveConfiguredBase(config, "hotfix-urgent")).toBe("main");
    expect(resolveConfiguredBase(config, "feature/a")).toBe("develop");
  });
});

describe("selectProductionBranch", () => {
  test("uses a non-develop remote default", () => {
    expect(
      selectProductionBranch("master", { hasMain: false, hasMaster: true }),
    ).toBe("master");
  });

  test("finds main or master when develop is the remote default", () => {
    expect(
      selectProductionBranch("develop", { hasMain: true, hasMaster: true }),
    ).toBe("main");
    expect(
      selectProductionBranch("develop", { hasMain: false, hasMaster: true }),
    ).toBe("master");
  });
});

describe("buildFirstRunState", () => {
  test("suggests both workflows when production and develop exist", () => {
    expect(
      buildFirstRunState({
        configPath: "/repo/.chronicle/pr.json",
        branch: "feature/a",
        defaultBranch: "main",
        hasDevelop: true,
        productionBranch: "main",
      }),
    ).toEqual({
      status: "needs-setup",
      configPath: "/repo/.chronicle/pr.json",
      branch: "feature/a",
      defaultBranch: "main",
      suggestions: [
        { workflow: "github-flow", base: "main" },
        {
          workflow: "git-flow",
          production: "main",
          development: "develop",
        },
      ],
    });
  });

  test("only suggests GitHub Flow without a develop branch", () => {
    expect(
      buildFirstRunState({
        configPath: "/repo/.chronicle/pr.json",
        branch: "feature/a",
        defaultBranch: "main",
        hasDevelop: false,
        productionBranch: "main",
      }).suggestions,
    ).toEqual([{ workflow: "github-flow", base: "main" }]);
  });
});

describe("serializePrConfig", () => {
  test("writes stable committed JSON", () => {
    expect(serializePrConfig({ workflow: "github-flow", base: "main" })).toBe(
      '{\n  "workflow": "github-flow",\n  "base": "main"\n}\n',
    );
  });
});

describe("configCommitArgs", () => {
  test("commits only the config path", () => {
    const args = configCommitArgs("/repo/.chronicle/pr.json");
    expect(args.slice(0, 2)).toEqual(["commit", "--only"]);
    expect(args.at(-1)).toBe("/repo/.chronicle/pr.json");
  });
});

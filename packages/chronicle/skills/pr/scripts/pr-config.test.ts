import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildFirstRunState,
  parseSaveArgs,
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

describe("parseSaveArgs", () => {
  test("parses a config save without committing", () => {
    expect(parseSaveArgs(["save", "github-flow", "main"])).toEqual({
      workflow: "github-flow",
      base: "main",
    });
  });

  test("rejects the hidden commit option", () => {
    expect(() =>
      parseSaveArgs(["save", "github-flow", "main", "--commit"]),
    ).toThrow("--commit is not supported");
  });
});

describe("save CLI", () => {
  test("writes config without staging or committing it", () => {
    const repo = mkdtempSync(join(tmpdir(), "chronicle-pr-config-save-"));
    try {
      Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
      Bun.spawnSync(["git", "config", "user.name", "Chronicle Test"], {
        cwd: repo,
      });
      Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], {
        cwd: repo,
      });
      writeFileSync(join(repo, "README.md"), "# test\n");
      Bun.spawnSync(["git", "add", "README.md"], { cwd: repo });
      Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: repo });
      writeFileSync(join(repo, "unrelated.txt"), "keep staged\n");
      Bun.spawnSync(["git", "add", "unrelated.txt"], { cwd: repo });

      const result = Bun.spawnSync(
        [
          "bun",
          resolve(import.meta.dir, "pr-config.ts"),
          "save",
          "github-flow",
          "main",
        ],
        { cwd: repo, stdout: "pipe", stderr: "pipe" },
      );

      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(repo, ".chronicle", "pr.json"), "utf8")).toBe(
        '{\n  "workflow": "github-flow",\n  "base": "main"\n}\n',
      );
      expect(
        Bun.spawnSync(["git", "status", "--porcelain"], {
          cwd: repo,
          stdout: "pipe",
        }).stdout.toString(),
      ).toBe("A  unrelated.txt\n?? .chronicle/\n");
      expect(
        Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
          cwd: repo,
          stdout: "pipe",
        }).stdout.toString(),
      ).toBe("1\n");

      Bun.spawnSync(["git", "add", "--", ".chronicle/pr.json"], {
        cwd: repo,
      });
      const commit = Bun.spawnSync(
        [
          "git",
          "commit",
          "--only",
          "-m",
          "🔧 chore: Configure Chronicle PR workflow",
          "--",
          ".chronicle/pr.json",
        ],
        { cwd: repo, stdout: "pipe", stderr: "pipe" },
      );

      expect(commit.exitCode).toBe(0);
      expect(
        Bun.spawnSync(["git", "show", "--format=", "--name-only", "HEAD"], {
          cwd: repo,
          stdout: "pipe",
        }).stdout.toString(),
      ).toBe(".chronicle/pr.json\n");
      expect(
        Bun.spawnSync(["git", "status", "--porcelain"], {
          cwd: repo,
          stdout: "pipe",
        }).stdout.toString(),
      ).toBe("A  unrelated.txt\n");
    } finally {
      Bun.spawnSync(["trash", repo]);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "check-branch.sh");
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "chronicle-branch-guard-"));
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
});

afterEach(() => {
  Bun.spawnSync(["trash", repo]);
});

function writePrConfig(config: unknown): void {
  mkdirSync(join(repo, ".chronicle"), { recursive: true });
  writeFileSync(join(repo, ".chronicle", "pr.json"), JSON.stringify(config));
}

function runHook(command = "git commit -m test") {
  return Bun.spawnSync(["bash", hook], {
    cwd: repo,
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_input: { command } }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("check-branch", () => {
  test("asks before committing on a configured GitHub Flow base", () => {
    writePrConfig({ workflow: "github-flow", base: "main" });

    const result = runHook();

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"permissionDecision":"ask"');
    expect(result.stdout.toString()).toContain("GitHub Flow");
  });

  test("asks before committing on a configured Git Flow production branch", () => {
    writePrConfig({
      workflow: "git-flow",
      production: "main",
      development: "develop",
    });

    expect(runHook().stdout.toString()).toContain('"permissionDecision":"ask"');
  });

  test("allows commits away from the configured protected branch", () => {
    writePrConfig({ workflow: "github-flow", base: "main" });
    Bun.spawnSync(["git", "checkout", "-b", "feature/safe"], { cwd: repo });

    expect(runHook().stdout.toString()).toBe("");
  });

  test("lets Chronicle config override stale legacy git-flow config", () => {
    writePrConfig({ workflow: "github-flow", base: "develop" });
    Bun.spawnSync(["git", "config", "gitflow.branch.develop", "develop"], {
      cwd: repo,
    });
    Bun.spawnSync(["git", "config", "gitflow.branch.master", "main"], {
      cwd: repo,
    });

    expect(runHook().stdout.toString()).toBe("");
  });

  test("preserves the legacy git-flow fallback without PR config", () => {
    Bun.spawnSync(["git", "config", "gitflow.branch.develop", "develop"], {
      cwd: repo,
    });
    Bun.spawnSync(["git", "config", "gitflow.branch.master", "main"], {
      cwd: repo,
    });

    expect(runHook().stdout.toString()).toContain('"permissionDecision":"ask"');
  });

  test("ignores commands that do not commit", () => {
    writePrConfig({ workflow: "github-flow", base: "main" });

    expect(runHook("git status").stdout.toString()).toBe("");
  });
});

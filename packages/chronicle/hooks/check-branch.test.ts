import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "check-branch.sh");
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "chronicle-branch-guard-"));
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "config", "core.autocrlf", "false"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
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

  test("exempts a Chronicle release commit on the GitHub Flow base, since that flow's one long-lived branch is where the release bump lands", () => {
    writePrConfig({ workflow: "github-flow", base: "main" });

    const result = runHook(
      `git commit -m "$(printf '%s' '🔧 release: chronicle 0.9.3')"`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  test("still asks for a release commit on the Git Flow production branch, since Git Flow releases belong on develop", () => {
    writePrConfig({
      workflow: "git-flow",
      production: "main",
      development: "develop",
    });

    expect(
      runHook(`git commit -m "🔧 release: chronicle 0.9.3"`).stdout.toString(),
    ).toContain('"permissionDecision":"ask"');
  });

  test("fails open when jq is missing or the payload is unparseable, so the guard never breaks every Bash command", () => {
    writePrConfig({ workflow: "github-flow", base: "main" });
    const bin = mkdtempSync(join(tmpdir(), "chronicle-no-jq-"));
    // A symlinked MSYS cat.exe cannot load msys-2.0.dll from its own directory, so wrap the real binary instead.
    for (const tool of ["git", "cat"]) {
      const real = Bun.which(tool)!.replaceAll("\\", "/");
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${real}' "$@"\n`, {
        mode: 0o755,
      });
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"),
    );
    const noJq = Bun.spawnSync([Bun.which("bash")!, hook], {
      cwd: repo,
      env: { ...env, PATH: bin },
      stdin: new TextEncoder().encode(
        JSON.stringify({ tool_input: { command: "git commit -m test" } }),
      ),
    });
    const unparseable = Bun.spawnSync(["bash", hook], {
      cwd: repo,
      stdin: new TextEncoder().encode("{ git commit"),
    });
    rmSync(bin, { recursive: true, force: true });

    expect(noJq.exitCode).toBe(0);
    expect(noJq.stdout.toString()).toBe("");
    expect(unparseable.exitCode).toBe(0);
    expect(unparseable.stdout.toString()).toBe("");
  });

  test("ignores commands that do not commit", () => {
    writePrConfig({ workflow: "github-flow", base: "main" });

    expect(runHook("git status").stdout.toString()).toBe("");
  });
});

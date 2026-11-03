import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
const hook = join(import.meta.dir, "check-branch.codex.ts");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "chronicle-codex-"));
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function configure(config: unknown) {
  mkdirSync(join(repo, ".chronicle"));
  writeFileSync(join(repo, ".chronicle/pr.json"), JSON.stringify(config));
}

function run(command = "git commit -m test", cwd = repo) {
  const result = Bun.spawnSync([process.execPath, hook], {
    cwd,
    stdin: new TextEncoder().encode(
      JSON.stringify({
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    ),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString();
}

test("denies a protected commit with a supported Codex reason and never runs it", () => {
  configure({ workflow: "github-flow", base: "main" });
  const output = JSON.parse(run());
  expect(output.hookSpecificOutput).toMatchObject({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  });
  expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
    "topic branch",
  );
  expect(output.hookSpecificOutput.permissionDecisionReason).not.toContain(
    "confirm explicitly",
  );
  expect(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).exitCode,
  ).not.toBe(0);
});

test("uses the hook event cwd even when launched elsewhere", () => {
  configure({ workflow: "github-flow", base: "main" });
  expect(
    JSON.parse(run(undefined, tmpdir())).hookSpecificOutput.permissionDecision,
  ).toBe("deny");
});

test("permits a topic branch and unrelated shell commands", () => {
  configure({ workflow: "github-flow", base: "main" });
  expect(run("git status")).toBe("");
  Bun.spawnSync(["git", "checkout", "-b", "topic"], { cwd: repo });
  expect(run()).toBe("");
});

test("preserves the GitHub Flow release exemption", () => {
  configure({ workflow: "github-flow", base: "main" });
  expect(run('git commit -m "🔧 release: chronicle 1.0.0"')).toBe("");
});

test("denies Git Flow production commits, including release commits", () => {
  configure({
    workflow: "git-flow",
    production: "main",
    development: "develop",
  });
  const output = JSON.parse(run('git commit -m "🔧 release: chronicle 1.0.0"'));
  expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
    "develop",
  );
});

test("retains the legacy git-flow fallback", () => {
  Bun.spawnSync(["git", "config", "gitflow.branch.develop", "develop"], {
    cwd: repo,
  });
  expect(JSON.parse(run()).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("ignores malformed input and non-shell calls", () => {
  configure({ workflow: "github-flow", base: "main" });
  for (const input of [
    "invalid",
    "null",
    JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { command: "git commit" },
    }),
  ]) {
    const result = Bun.spawnSync([process.execPath, hook], {
      cwd: repo,
      stdin: new TextEncoder().encode(input),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  }
});

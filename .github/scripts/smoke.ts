import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearBaseline,
  clearReported,
} from "../../packages/guard/hooks/sweep-state.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCAFFOLD = join(
  ROOT,
  "packages/dispatch/skills/flightplan/scripts/scaffold.ts",
);
const LINT = join(
  ROOT,
  "packages/dispatch/skills/flightplan/scripts/lint-task.ts",
);
const WORKTREE = join(
  ROOT,
  "packages/dispatch/skills/flightplan/scripts/worktree.ts",
);
const COMMIT = join(ROOT, "packages/chronicle/skills/commit/scripts/commit.ts");
const RELEASE = join(
  ROOT,
  "packages/chronicle/skills/release/scripts/release.ts",
);
const SWEEP = join(ROOT, "packages/guard/hooks/comment-sweep.ts");

// Without the key no step calls TypeSafe's Jev over the network.
const env = { ...process.env };
delete env.TYPESAFE_API_KEY;

type Run = { code: number; stdout: string; stderr: string };

function run(cmd: string[], cwd: string, stdin?: string): Run {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
  });
  return {
    code: r.exitCode ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

const bun = (script: string, args: string[], cwd: string, stdin?: string) =>
  run([process.execPath, script, ...args], cwd, stdin);

let last: Run | undefined;

function check(ok: boolean, what: string): void {
  if (ok) return;
  throw new Error(
    `${what}\n--- stdout\n${last?.stdout ?? ""}\n--- stderr\n${last?.stderr ?? ""}`,
  );
}

function expectExit(r: Run, code: number, what: string): Run {
  last = r;
  check(r.code === code, `${what} exited ${r.code}, expected ${code}`);
  return r;
}

function step(name: string, fn: () => void): void {
  last = undefined;
  try {
    fn();
  } catch (e) {
    throw new Error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
  console.log(`ok ${name}`);
}

const TASK = `# WORK-01: Smoke task

> **Required reading** (read before starting; do not need to open other files):
>
> - \`../_context/shared.md\`
>
> **Depends on**: none — foundation task
> **Status**: todo

## Goal

Prove the smoke tree lints clean.

## Files to create / modify

- \`landed.txt\` (new) — one line.

## Acceptance criteria

- [ ] \`landed.txt\` holds \`landed\`.

## Verification

- [ ] \`cat landed.txt\` prints \`landed\`.

## Eval rubric

> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension   | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
| ----------- | ------ | ---------- | --------------- | ---------- |
| Correctness | ×3     | missing    | wrong text      | exact text |
`;

const RELEASE_CONFIG = {
  mode: "whole-repo",
  workflow: "github-flow",
  tag: "v{version}",
  changelog: "CHANGELOG.md",
  branches: { main: "main" },
  versionFiles: [{ path: "VERSION", kind: "text" }],
};

// A dedicated parent keeps the worktree tool's sibling `.repo-autopilot/` inside the temp tree.
const parent = mkdtempSync(join(tmpdir(), "q-lab-smoke-"));
const repo = join(parent, "repo");
const out = join(parent, "out");
const sessionId = `smoke-${process.pid}-${Date.now()}`;

const git = (...args: string[]) => {
  const r = expectExit(
    run(["git", "-C", repo, ...args], repo),
    0,
    `git ${args[0]}`,
  );
  return r.stdout.trim();
};

try {
  mkdirSync(repo);
  mkdirSync(out);
  git("init", "-q", "-b", "main");
  // The Windows runner defaults to autocrlf=true, which would make the byte-exact LF checks meaningless.
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "smoke");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  writeFileSync(join(repo, "VERSION"), "0.1.0\n");
  mkdirSync(join(repo, ".chronicle"));
  writeFileSync(
    join(repo, ".chronicle", "release.json"),
    JSON.stringify(RELEASE_CONFIG, null, 2) + "\n",
  );
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const planDir = join(repo, "docs", "smoke");
  const tasksDir = join(planDir, "tasks");

  step("flightplan", () => {
    expectExit(
      bun(SCAFFOLD, ["smoke", "work", "--docs-root", join(repo, "docs")], repo),
      0,
      "scaffold",
    );
    check(
      statSync(join(tasksDir, "work")).isDirectory(),
      "tasks/work is not a directory",
    );
    writeFileSync(
      join(tasksDir, "_context", "shared.md"),
      "# Shared context\n\nA smoke-test plan.\n",
    );
    writeFileSync(join(tasksDir, "work", "01-smoke-task.md"), TASK);
    expectExit(bun(LINT, [tasksDir], repo), 0, "lint-task");
  });

  step("worktree", () => {
    const REF = ["work", "01"].join("/");
    // --repo is left un-realpathed so a Windows 8.3 short tmpdir reaches the tool as autopilot would hand it.
    const common = ["--repo", repo, "--slug", "smoke", "--plan-dir", planDir];
    const created = JSON.parse(
      expectExit(bun(WORKTREE, ["create", REF, ...common], repo), 0, "create")
        .stdout,
    );
    const baseline = JSON.parse(
      expectExit(
        bun(WORKTREE, ["fingerprint", ...common], repo),
        0,
        "fingerprint",
      ).stdout,
    ).fingerprint;
    writeFileSync(join(created.path, "landed.txt"), "landed\n");
    const landed = JSON.parse(
      expectExit(
        bun(
          WORKTREE,
          ["land", REF, ...common, "--expect", baseline, "--op", "smoke-land"],
          repo,
        ),
        0,
        "land",
      ).stdout,
    );
    check(landed.status === "clean", `land status ${landed.status}`);
    check(
      readFileSync(join(repo, "landed.txt"), "utf8") === "landed\n",
      "landed.txt is not byte-exact `landed\\n`",
    );
    const removed = JSON.parse(
      expectExit(bun(WORKTREE, ["remove", REF, ...common], repo), 0, "remove")
        .stdout,
    );
    check(removed.removed === true, "remove did not report removed:true");
  });

  step("commit", () => {
    const files = git("status", "--porcelain", "-uall")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    // commit.ts refuses a plan file inside the repo it commits.
    const planFile = join(out, "plan.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        commits: [{ type: "docs", subject: "Add smoke plan", files }],
      }),
    );
    const result = JSON.parse(
      expectExit(
        bun(COMMIT, ["apply", "--plan-file", planFile], repo),
        0,
        "commit",
      ).stdout,
    );
    check(result.ok === true, "commit ok is not true");
    check(
      git("log", "-1", "--format=%s").endsWith("docs: Add smoke plan"),
      "commit subject mismatch",
    );
    check(git("status", "--porcelain") === "", "tree not clean after commit");
  });

  step("sweep", () => {
    // GUARD_STATE_DIR stays unset so guard's default per-OS scratch root is exercised.
    const payload = JSON.stringify({ session_id: sessionId, cwd: repo });
    expectExit(bun(SWEEP, ["snapshot"], repo, payload), 0, "snapshot");
    writeFileSync(
      join(repo, "app.ts"),
      "const a = 1;\n// one\n// two\n// three\nconst b = 2;\n",
    );
    const r = expectExit(bun(SWEEP, ["sweep"], repo, payload), 0, "sweep");
    const decision = JSON.parse(r.stdout);
    check(
      decision.decision === "block" &&
        String(decision.reason).includes("comment-sweep"),
      "sweep did not block",
    );
    rmSync(join(repo, "app.ts"));
  });

  step("release", () => {
    // A pre-written entry header makes the `entry` stage count as done, so no annalist-written entries file is needed.
    writeFileSync(
      join(repo, "CHANGELOG.md"),
      "# Changelog\n\n## [0.2.0] - 2026-01-01\n",
    );
    const units = JSON.stringify([
      { component: null, targetVersion: "0.2.0", lastTag: null },
    ]);
    expectExit(
      bun(RELEASE, ["run", "--units", units, "--through", "tag"], repo),
      0,
      "release",
    );
    check(
      readFileSync(join(repo, "VERSION"), "utf8") === "0.2.0\n",
      "VERSION is not 0.2.0",
    );
    check(git("tag", "--list", "v0.2.0") === "v0.2.0", "tag v0.2.0 missing");
    check(
      git("rev-parse", "v0.2.0^{commit}") === git("rev-parse", "HEAD"),
      "tag is not on HEAD",
    );
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  rmSync(parent, { recursive: true, force: true });
  clearBaseline(sessionId);
  clearReported(sessionId);
}

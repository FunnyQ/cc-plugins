// Tests for current-session discovery.
// Run: bun test monitor/skills/cockpit/scripts/find-session.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const SCRIPT = join(import.meta.dir, "find-session.ts");
const SID_OLD = "11111111-1111-1111-1111-111111111111";
const SID_NEW = "22222222-2222-2222-2222-222222222222";

let projectDir: string;
let codexDir: string;

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: projectDir,
    env: { ...process.env, ...env },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString(),
  };
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "find-session-proj-")));
  codexDir = realpathSync(mkdtempSync(join(tmpdir(), "find-session-codex-")));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
});

describe("find-session --provider claude", () => {
  test("trusts CLAUDE_CODE_SESSION_ID over any transcript-mtime guess", () => {
    const live = "abcdef00-1111-2222-3333-444455556666";
    // No transcript fixtures: the env var alone must decide the answer.
    const result = run(["--provider", "claude"], {
      CLAUDE_CODE_SESSION_ID: live,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(live);
  });

  test("falls back to the transcript scan when the env var is absent", () => {
    // Empty env var → not authoritative → fall through to the mtime scan, which
    // finds no transcript dir for this throwaway project and exits non-zero.
    const result = run(["--provider", "claude"], {
      CLAUDE_CODE_SESSION_ID: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no transcript dir");
  });
});

describe("find-session --provider codex", () => {
  test("returns newest Codex thread for cwd", () => {
    const db = new Database(join(codexDir, "state_5.sqlite"));
    db.run(
      `create table threads (
        id text primary key,
        cwd text not null,
        rollout_path text not null,
        archived integer not null default 0,
        created_at integer not null,
        updated_at integer not null,
        created_at_ms integer,
        updated_at_ms integer
      )`,
    );
    db.run(
      `insert into threads
       (id, cwd, rollout_path, archived, created_at, updated_at, created_at_ms, updated_at_ms)
       values (?, ?, ?, 0, 1, 1, 1000, 1000)`,
      [SID_OLD, projectDir, "sessions/old.jsonl"],
    );
    db.run(
      `insert into threads
       (id, cwd, rollout_path, archived, created_at, updated_at, created_at_ms, updated_at_ms)
       values (?, ?, ?, 0, 2, 2, 2000, 2000)`,
      [SID_NEW, projectDir, "sessions/new.jsonl"],
    );
    db.close();

    const result = run(["--provider", "codex"], {
      COCKPIT_CODEX_DIR: codexDir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(SID_NEW);
  });

  test("missing Codex DB exits non-zero", () => {
    const result = run(["--provider", "codex"], {
      COCKPIT_CODEX_DIR: codexDir,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no Codex state database");
  });
});

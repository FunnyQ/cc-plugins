// Tests for the `cockpit` CLI (kernel/02 + bridge/02).
// Run: bun test cockpit/skills/cockpit/scripts/cockpit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cockpit.ts");
const SID = "11111111-1111-1111-1111-111111111111";

let projectDir: string;
let cockpitHome: string;

function run(args: string[], cwd = projectDir) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: { ...process.env, COCKPIT_HOME: cockpitHome },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function readLines(path: string): any[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  // realpathSync so it matches process.cwd() (macOS resolves /var → /private/var)
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-proj-")));
  cockpitHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-home-")));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("cockpit start", () => {
  test("writes project-meta.md with project_goal frontmatter", () => {
    const r = run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "test",
      "--project-goal",
      "scratch",
    ]);
    expect(r.code).toBe(0);
    const meta = readFileSync(
      join(projectDir, ".cockpit/project-meta.md"),
      "utf8",
    );
    expect(meta).toMatch(/^---\n/);
    expect(meta).toMatch(/project_goal: scratch/);
    expect(meta).toMatch(/owner: Q/);
    expect(meta).toMatch(/created: \d{4}-/);
  });

  test("goal record is line 1 with session_goal but no project_goal", () => {
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "test",
      "--project-goal",
      "scratch",
    ]);
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    const lines = readLines(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0].type).toBe("goal");
    expect(lines[0].session_goal).toBe("test");
    expect(lines[0].ts).toBeTruthy();
    expect(lines[0].project_goal).toBeUndefined();
  });

  test("registers the session with a fresh heartbeat", () => {
    const before = Date.now();
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "test",
      "--project-goal",
      "scratch",
    ]);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const entry = reg.sessions.find((s: any) => s.sessionId === SID);
    expect(entry).toBeTruthy();
    expect(entry.project).toBe(projectDir);
    expect(entry.logPath).toBe(
      join(projectDir, ".cockpit/logs", `${SID}.jsonl`),
    );
    expect(new Date(entry.lastHeartbeat).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  test("preserves created timestamp when meta already exists", () => {
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "a",
      "--project-goal",
      "p",
    ]);
    const first = readFileSync(
      join(projectDir, ".cockpit/project-meta.md"),
      "utf8",
    );
    const created1 = first.match(/created: (\S+)/)![1];
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "b",
      "--project-goal",
      "p2",
    ]);
    const second = readFileSync(
      join(projectDir, ".cockpit/project-meta.md"),
      "utf8",
    );
    const created2 = second.match(/created: (\S+)/)![1];
    expect(created2).toBe(created1);
    expect(second).toMatch(/project_goal: p2/);
  });
});

describe("cockpit log", () => {
  beforeEach(() => {
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "test",
      "--project-goal",
      "scratch",
    ]);
  });

  test("appends one valid 8-field decision record with defaults", () => {
    const r = run([
      "log",
      "--session",
      SID,
      "--decision",
      "chose X",
      "--reason",
      "Y",
    ]);
    expect(r.code).toBe(0);
    const lines = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`));
    expect(lines.length).toBe(2);
    const rec = lines[1];
    expect(Object.keys(rec).sort()).toEqual(
      [
        "decision",
        "files",
        "needs_your_call",
        "options",
        "reason",
        "timestamp",
        "tradeoff",
        "type",
      ].sort(),
    );
    expect(rec.type).toBe("decision");
    expect(rec.decision).toBe("chose X");
    expect(rec.reason).toBe("Y");
    expect(rec.tradeoff).toBe("");
    expect(rec.needs_your_call).toBe(false);
    expect(rec.options).toEqual([]);
    expect(rec.files).toEqual([]);
    expect(rec.timestamp).toBeTruthy();
  });

  test("--needs-call, repeated --option and --file populate the arrays", () => {
    run([
      "log",
      "--session",
      SID,
      "--decision",
      "pick path",
      "--reason",
      "ambiguous",
      "--needs-call",
      "--option",
      "A",
      "--option",
      "B",
      "--file",
      "src/x.ts",
      "--file",
      "src/y.ts",
      "--tradeoff",
      "slower",
    ]);
    const rec = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`)).at(
      -1,
    );
    expect(rec.needs_your_call).toBe(true);
    expect(rec.options).toEqual(["A", "B"]);
    expect(rec.files).toEqual(["src/x.ts", "src/y.ts"]);
    expect(rec.tradeoff).toBe("slower");
  });

  test("two logs append two lines without rewriting earlier ones", () => {
    run(["log", "--session", SID, "--decision", "one", "--reason", "r1"]);
    run(["log", "--session", SID, "--decision", "two", "--reason", "r2"]);
    const lines = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`));
    expect(lines.length).toBe(3);
    expect(lines[1].decision).toBe("one");
    expect(lines[2].decision).toBe("two");
  });

  test("a malformed line does not break parsing of the others", () => {
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    run(["log", "--session", SID, "--decision", "one", "--reason", "r1"]);
    // corrupt: append a broken line by hand, then a good one
    Bun.spawnSync(["bash", "-c", `echo 'not json{{' >> ${logPath}`]);
    run(["log", "--session", SID, "--decision", "two", "--reason", "r2"]);
    const good = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    expect(good.map((r: any) => r.decision).filter(Boolean)).toEqual([
      "one",
      "two",
    ]);
  });

  test("log refreshes the session heartbeat", () => {
    const reg1 = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const hb1 = reg1.sessions.find(
      (s: any) => s.sessionId === SID,
    ).lastHeartbeat;
    Bun.sleepSync(1100);
    run(["log", "--session", SID, "--decision", "d", "--reason", "r"]);
    const reg2 = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const hb2 = reg2.sessions.find(
      (s: any) => s.sessionId === SID,
    ).lastHeartbeat;
    expect(new Date(hb2).getTime()).toBeGreaterThan(new Date(hb1).getTime());
  });
});

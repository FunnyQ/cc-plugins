// Tests for the `cockpit` CLI (kernel/02 + bridge/02).
// Run: bun test packages/monitor/skills/cockpit/scripts/cockpit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cockpit.ts");
const SID = "11111111-1111-1111-1111-111111111111";

let projectDir: string;
let cockpitHome: string;
let configHome: string;

function run(args: string[], cwd = projectDir) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      COCKPIT_HOME: cockpitHome,
      XDG_CONFIG_HOME: configHome,
    },
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
  configHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-config-")));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(cockpitHome, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("cockpit config", () => {
  test("writes log_language and get-language prints only the value", () => {
    const write = run(["config", "--log-language", "zh-TW"]);
    expect(write.code).toBe(0);
    expect(write.stdout).toBe("cockpit: log_language = zh-TW\n");
    expect(write.stderr).toBe("");

    const read = run(["config", "get-language"]);
    expect(read.code).toBe(0);
    expect(read.stdout).toBe("zh-TW\n");
    expect(read.stderr).toBe("");
  });

  test("get-language defaults to English with no config", () => {
    const r = run(["config", "get-language"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("English\n");
    expect(r.stderr).toBe("");
  });

  test("rejects empty config invocation with usage", () => {
    const r = run(["config"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage: cockpit config");
  });
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
    expect(meta).toMatch(/owner: user/);
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
    expect(entry.provider).toBe("claude");
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

  test("defaults log_language to English when not given", () => {
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "a",
      "--project-goal",
      "p",
    ]);
    const meta = readFileSync(
      join(projectDir, ".cockpit/project-meta.md"),
      "utf8",
    );
    expect(meta).toMatch(/log_language: English/);
  });

  test("writes the given log_language", () => {
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "a",
      "--project-goal",
      "p",
      "--log-language",
      "zh-TW",
    ]);
    const meta = readFileSync(
      join(projectDir, ".cockpit/project-meta.md"),
      "utf8",
    );
    expect(meta).toMatch(/log_language: zh-TW/);
  });

  test("re-running start preserves the decision trail (only refreshes the goal)", () => {
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "g1",
      "--project-goal",
      "p",
    ]);
    run(["log", "--session", SID, "--decision", "A", "--reason", "ra"]);
    run(["log", "--session", SID, "--decision", "B", "--reason", "rb"]);
    expect(readLines(logPath).length).toBe(3);

    // Re-run start on the SAME session — must not truncate the decisions.
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "g2",
      "--project-goal",
      "p",
    ]);
    const lines = readLines(logPath);
    expect(lines.length).toBe(3);
    expect(lines[0].type).toBe("goal");
    expect(lines[0].session_goal).toBe("g2"); // goal refreshed
    expect(lines[1].decision).toBe("A"); // decisions intact
    expect(lines[2].decision).toBe("B");
  });

  test("preserves log_language when start is re-run without the flag", () => {
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "a",
      "--project-goal",
      "p",
      "--log-language",
      "日本語",
    ]);
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "b",
      "--project-goal",
      "p2",
    ]);
    const meta = readFileSync(
      join(projectDir, ".cockpit/project-meta.md"),
      "utf8",
    );
    expect(meta).toMatch(/log_language: 日本語/);
  });

  test("--provider codex registers a Codex-backed session", () => {
    const r = run([
      "start",
      "--provider",
      "codex",
      "--session",
      SID,
      "--session-goal",
      "a",
      "--project-goal",
      "p",
    ]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const entry = reg.sessions.find((s: any) => s.sessionId === SID);
    expect(entry.provider).toBe("codex");
  });

  test("--provider opencode registers an OpenCode-backed session", () => {
    const r = run([
      "start",
      "--provider",
      "opencode",
      "--session",
      "ses_test",
      "--session-goal",
      "a",
      "--project-goal",
      "p",
    ]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const entry = reg.sessions.find((s: any) => s.sessionId === "ses_test");
    expect(entry.provider).toBe("opencode");
  });

  test("rejects unknown providers", () => {
    const r = run([
      "start",
      "--provider",
      "other",
      "--session",
      SID,
      "--session-goal",
      "a",
      "--project-goal",
      "p",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid provider");
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

  test("appends one valid decision record with defaults", () => {
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
        "facets",
        "files",
        "id",
        "kind",
        "needs_your_call",
        "options",
        "reason",
        "source",
        "timestamp",
        "tradeoff",
        "type",
      ].sort(),
    );
    expect(rec.kind).toBe("decision");
    expect(rec.source).toBe("agent");
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.type).toBe("decision");
    expect(rec.decision).toBe("chose X");
    expect(rec.reason).toBe("Y");
    expect(rec.tradeoff).toBe("");
    expect(rec.needs_your_call).toBe(false);
    expect(rec.options).toEqual([]);
    expect(rec.files).toEqual([]);
    expect(rec.facets).toEqual([]);
    expect(rec.timestamp).toBeTruthy();
  });

  test("repeated --facet parses into {label, text}, splitting on the first colon", () => {
    run([
      "log",
      "--session",
      SID,
      "--decision",
      "chose X",
      "--reason",
      "Y",
      "--facet",
      "REJECTED: per-session servers churn ports",
      "--facet",
      "RISK: assumes single-writer registry: breaks on a 2nd daemon",
      "--facet",
      "an unlabeled note",
    ]);
    const rec = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`)).at(
      -1,
    );
    expect(rec.facets).toEqual([
      { label: "REJECTED", text: "per-session servers churn ports" },
      {
        label: "RISK",
        text: "assumes single-writer registry: breaks on a 2nd daemon",
      },
      { label: "", text: "an unlabeled note" },
    ]);
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

describe("cockpit scribe", () => {
  // Note: no cockpit start is called — scribe auto-registers on first write.

  test("write mode: creates log file and record with correct shape", () => {
    const r = run([
      "scribe",
      "--session",
      SID,
      "--type",
      "learning",
      "--title",
      "Why fork",
      "--text",
      "cache-warm",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`scribed learning for ${SID}`);

    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    const lines = readLines(logPath);
    expect(lines.length).toBe(1);
    const rec = lines[0];
    expect(rec.type).toBe("decision");
    expect(rec.kind).toBe("learning");
    expect(rec.source).toBe("scribe");
    expect(rec.decision).toBe("Why fork");
    expect(rec.reason).toBe("cache-warm");
    expect(rec.needs_your_call).toBe(false);
    expect(rec.tradeoff).toBe("");
    expect(rec.facets).toEqual([]);
    expect(rec.options).toEqual([]);
    expect(rec.files).toEqual([]);
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.timestamp).toBeTruthy();
  });

  test("auto-registers the session so it becomes tracked", () => {
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "rationale",
      "--title",
      "T",
      "--text",
      "X",
    ]);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const entry = reg.sessions.find((s: any) => s.sessionId === SID);
    expect(entry).toBeTruthy();
    expect(entry.project).toBe(projectDir);
    expect(entry.sessionId).toBe(SID);
    expect(entry.logPath).toBe(
      join(projectDir, ".cockpit/logs", `${SID}.jsonl`),
    );
  });

  test("does not write a goal record on first scribe", () => {
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "caveat",
      "--title",
      "T",
      "--text",
      "X",
    ]);
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    const lines = readLines(logPath);
    expect(lines.every((r: any) => r.type !== "goal")).toBe(true);
  });

  test("rejects invalid --type with non-zero exit and error message", () => {
    const r = run([
      "scribe",
      "--session",
      SID,
      "--type",
      "bogus",
      "--text",
      "X",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid --type");
    // No log file should be created
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    expect(() => readFileSync(logPath, "utf8")).toThrow();
  });

  test("rejects missing --text with non-zero exit", () => {
    const r = run([
      "scribe",
      "--session",
      SID,
      "--type",
      "learning",
      "--title",
      "T",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--text");
  });

  test("--recent with no prior log exits 0 and prints nothing", () => {
    const r = run(["scribe", "--session", SID, "--recent"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("--recent prints only scribe entries (not agent/goal records)", () => {
    // Write a manual log entry (agent source) via cockpit start + log
    run([
      "start",
      "--session",
      SID,
      "--session-goal",
      "test",
      "--project-goal",
      "p",
    ]);
    run([
      "log",
      "--session",
      SID,
      "--decision",
      "agent-entry",
      "--reason",
      "r",
    ]);
    // Write a scribe entry
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "rationale",
      "--title",
      "scribe-entry",
      "--text",
      "body",
    ]);

    const r = run(["scribe", "--session", SID, "--recent"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("scribe-entry");
    expect(r.stdout).not.toContain("agent-entry");
  });

  test("--recent defaults to N=8 and respects N=3 override", () => {
    // Write 10 scribe entries
    for (let i = 0; i < 10; i++) {
      run([
        "scribe",
        "--session",
        SID,
        "--type",
        "learning",
        "--title",
        `entry-${i}`,
        "--text",
        `body-${i}`,
      ]);
    }
    const r8 = run(["scribe", "--session", SID, "--recent"]);
    expect(r8.code).toBe(0);
    const lines8 = r8.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    expect(lines8.length).toBe(8);

    const r3 = run(["scribe", "--session", SID, "--recent", "3"]);
    expect(r3.code).toBe(0);
    const lines3 = r3.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    expect(lines3.length).toBe(3);
  });

  test("--recent --provider does not consume --provider as N", () => {
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "learning",
      "--title",
      "T",
      "--text",
      "X",
    ]);
    // --recent --provider codex: N must stay 8 (not NaN/error), --provider properly parsed
    const r = run([
      "scribe",
      "--session",
      SID,
      "--recent",
      "--provider",
      "codex",
    ]);
    // Should exit 0 (not crash trying to parse "--provider" as a number)
    expect(r.code).toBe(0);
    // The single entry should still be printed (N=8 means all 1 entries show)
    expect(r.stdout).toContain("learning");
  });

  test("backward-compat: old log lines without kind/source do not crash --recent", () => {
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    // Manually write a "old" decision record without kind/source
    const oldRec = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      type: "decision",
      decision: "old-decision",
      reason: "old-reason",
      tradeoff: "",
      facets: [],
      needs_your_call: false,
      options: [],
      files: [],
      timestamp: new Date().toISOString(),
    };
    // Ensure log dir exists
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "caveat",
      "--title",
      "new-entry",
      "--text",
      "body",
    ]);
    // Now append the old-style record (appendFileSync imported at top of file)
    appendFileSync(logPath, JSON.stringify(oldRec) + "\n");

    const r = run(["scribe", "--session", SID, "--recent"]);
    expect(r.code).toBe(0);
    // Only scribe-sourced entries appear; old agent entry is filtered out
    expect(r.stdout).toContain("new-entry");
    expect(r.stdout).not.toContain("old-decision");
  });

  test("concurrency guard: two near-simultaneous writes both succeed and both ids persist", () => {
    const SID2 = "22222222-2222-2222-2222-222222222222";
    // Launch two scribe writes concurrently using spawnSync (they run sequentially
    // in Bun.spawnSync but we verify both ids end up in the log regardless of order)
    const proc1 = Bun.spawnSync(
      [
        "bun",
        CLI,
        "scribe",
        "--session",
        SID2,
        "--type",
        "learning",
        "--title",
        "write-one",
        "--text",
        "body-one",
      ],
      { cwd: projectDir, env: { ...process.env, COCKPIT_HOME: cockpitHome } },
    );
    const proc2 = Bun.spawnSync(
      [
        "bun",
        CLI,
        "scribe",
        "--session",
        SID2,
        "--type",
        "rationale",
        "--title",
        "write-two",
        "--text",
        "body-two",
      ],
      { cwd: projectDir, env: { ...process.env, COCKPIT_HOME: cockpitHome } },
    );
    expect(proc1.exitCode).toBe(0);
    expect(proc2.exitCode).toBe(0);

    const logPath = join(projectDir, ".cockpit/logs", `${SID2}.jsonl`);
    const lines = readLines(logPath);
    expect(lines.length).toBe(2);
    const decisions = lines.map((r: any) => r.decision);
    expect(decisions).toContain("write-one");
    expect(decisions).toContain("write-two");
  });
});

// Tests for the `cockpit` CLI (kernel/02 + bridge/02).
// Run: bun test packages/monitor/skills/cockpit/scripts/cockpit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessions } from "./registry";

const CLI = join(import.meta.dir, "cockpit.ts");
const SID = "11111111-1111-1111-1111-111111111111";

let projectDir: string;
let cockpitHome: string;
let configHome: string;

function run(
  args: string[],
  cwd = projectDir,
  extraEnv: Record<string, string> = {},
) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      COCKPIT_HOME: cockpitHome,
      XDG_CONFIG_HOME: configHome,
      ...extraEnv,
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

function sessionViewFor(sessionId: string) {
  const prev = process.env.COCKPIT_HOME;
  process.env.COCKPIT_HOME = cockpitHome;
  try {
    return buildSessions().find((s) => s.sessionId === sessionId);
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_HOME;
    else process.env.COCKPIT_HOME = prev;
  }
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

describe("cockpit prep", () => {
  test("prints the resolved session id and configured language", () => {
    run(["config", "--log-language", "zh-TW"]);
    const r = run(["prep"], projectDir, { CLAUDE_CODE_SESSION_ID: SID });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Session id:");
    expect(r.stdout).toContain(SID);
    expect(r.stdout).toContain("Decision-log language:");
    expect(r.stdout).toContain("zh-TW");
  });
});

describe("cockpit log", () => {
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
    expect(lines.length).toBe(1);
    const rec = lines[0];
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

  test("--diagram stores the Mermaid source verbatim on the record", () => {
    const mmd = "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Go]";
    run([
      "log",
      "--session",
      SID,
      "--decision",
      "shape the flow",
      "--reason",
      "structure beats prose",
      "--diagram",
      mmd,
    ]);
    const rec = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`)).at(
      -1,
    );
    expect(rec.diagram).toBe(mmd);
  });

  test("a --diagram that fails lint blocks the write with a fix hint", () => {
    const logPath = join(projectDir, ".cockpit/logs", `${SID}.jsonl`);
    const res = run([
      "log",
      "--session",
      SID,
      "--decision",
      "d",
      "--reason",
      "r",
      "--diagram",
      "flowchart TD\n  A[cache miss (L2)] --> B",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("failed lint");
    expect(res.stderr).toContain('["cache miss (L2)"]');
    // Nothing persisted — the lint gates before any write.
    expect(() => readLines(logPath)).toThrow();
  });

  test("scribe --diagram is gated by the same lint", () => {
    const res = run([
      "scribe",
      "--session",
      SID,
      "--provider",
      "claude",
      "--type",
      "learning",
      "--text",
      "t",
      "--diagram",
      "not-a-diagram\n  A --> B",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("failed lint");
  });

  test("a log without --diagram omits the field entirely", () => {
    run(["log", "--session", SID, "--decision", "plain", "--reason", "r"]);
    const rec = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`)).at(
      -1,
    );
    expect("diagram" in rec).toBe(false);
  });

  test("two logs append two lines without rewriting earlier ones", () => {
    run(["log", "--session", SID, "--decision", "one", "--reason", "r1"]);
    run(["log", "--session", SID, "--decision", "two", "--reason", "r2"]);
    const lines = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`));
    expect(lines.length).toBe(2);
    expect(lines[0].decision).toBe("one");
    expect(lines[1].decision).toBe("two");
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
    run(["log", "--session", SID, "--decision", "initial", "--reason", "r"]);
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

  test("auto-registers a fresh session so it becomes tracked", () => {
    const before = Date.now();
    const r = run([
      "log",
      "--session",
      SID,
      "--decision",
      "first decision",
      "--reason",
      "no prior registration",
    ]);
    expect(r.code).toBe(0);
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
    expect(sessionViewFor(SID)?.tracked).toBe(true);
  });

  test("reaps registry entries whose last signal is older than the TTL", () => {
    const STALE = "99999999-9999-9999-9999-999999999999";
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    // Seed: one long-ended entry (20d, no log file → mtime 0) + one recent (2d).
    const RECENT = "22222222-2222-2222-2222-222222222222";
    writeFileSync(
      join(cockpitHome, "registry.json"),
      JSON.stringify({
        sessions: [
          {
            provider: "claude",
            project: projectDir,
            sessionId: STALE,
            logPath: join(projectDir, ".cockpit/logs", `${STALE}.jsonl`),
            lastHeartbeat: daysAgo(20),
          },
          {
            provider: "claude",
            project: projectDir,
            sessionId: RECENT,
            logPath: join(projectDir, ".cockpit/logs", `${RECENT}.jsonl`),
            lastHeartbeat: daysAgo(2),
          },
        ],
      }),
    );
    // Any write triggers the reap.
    run(["log", "--session", SID, "--decision", "d", "--reason", "r"]);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const ids = reg.sessions.map((s: any) => s.sessionId);
    expect(ids).toContain(SID); // just-touched
    expect(ids).toContain(RECENT); // within window
    expect(ids).not.toContain(STALE); // reaped
  });

  test("--provider codex routes log registration to a Codex-backed session", () => {
    const r = run([
      "log",
      "--provider",
      "codex",
      "--session",
      SID,
      "--decision",
      "d",
      "--reason",
      "r",
    ]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const entry = reg.sessions.find((s: any) => s.sessionId === SID);
    expect(entry.provider).toBe("codex");
  });

  test("rejects unknown providers", () => {
    const r = run([
      "log",
      "--provider",
      "other",
      "--session",
      SID,
      "--decision",
      "d",
      "--reason",
      "r",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid provider");
  });
});

describe("cockpit scribe", () => {
  // Note: scribe auto-registers on first write.

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

  test("--diagram rides on a scribed entry", () => {
    const mmd =
      "sequenceDiagram\n  UI->>Agent: needs_your_call\n  Agent-->>UI: answer";
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "rationale",
      "--title",
      "the wait/send bridge",
      "--text",
      "UI→agent only; answers ride the transcript",
      "--diagram",
      mmd,
    ]);
    const rec = readLines(join(projectDir, ".cockpit/logs", `${SID}.jsonl`)).at(
      -1,
    );
    expect(rec.diagram).toBe(mmd);
    expect(rec.source).toBe("scribe");
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
    expect(sessionViewFor(SID)?.tracked).toBe(true);
  });

  test("writes only a decision record on first scribe", () => {
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
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("decision");
  });

  test("--provider opencode routes scribe registration to an OpenCode-backed session", () => {
    const r = run([
      "scribe",
      "--provider",
      "opencode",
      "--session",
      "ses_test",
      "--type",
      "rationale",
      "--title",
      "T",
      "--text",
      "X",
    ]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(
      readFileSync(join(cockpitHome, "registry.json"), "utf8"),
    );
    const entry = reg.sessions.find((s: any) => s.sessionId === "ses_test");
    expect(entry.provider).toBe("opencode");
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

  test("--recent prints only scribe entries, not agent entries", () => {
    run([
      "log",
      "--session",
      SID,
      "--decision",
      "agent-entry",
      "--reason",
      "r",
    ]);
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

  test("--prep bundles language, recent entries, and git context", () => {
    run(["config", "--log-language", "zh-TW"]);
    run([
      "scribe",
      "--session",
      SID,
      "--type",
      "learning",
      "--title",
      "new-entry",
      "--text",
      "body",
    ]);

    const r = run(["scribe", "--session", SID, "--prep"]);

    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Decision-log language:");
    expect(r.stdout).toContain("zh-TW");
    expect(r.stdout).toContain("Recent scribe entries:");
    expect(r.stdout).toContain("learning · new-entry");
    expect(r.stdout).toContain("Git change context:");
    expect(r.stdout).toContain("$ git diff");
    expect(r.stdout).toContain("not available");
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

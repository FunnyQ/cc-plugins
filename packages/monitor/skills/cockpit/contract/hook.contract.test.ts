import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  baseEnv,
  cleanup,
  fixtureEnv,
  makeHomes,
  makeProviderFixtures,
  readJsonl,
  run,
  type Env,
  type Homes,
  type ProviderFixtures,
} from "./fixtures";
import { PLUGIN_ROOT } from "./launcher";

let homes: Homes;
let fixtures: ProviderFixtures;
let env: Env;
let bin: string;

beforeEach(() => {
  homes = makeHomes();
  fixtures = makeProviderFixtures(homes);
  bin = join(homes.root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  // Keep git probes deterministic without writing a commit or touching the worktree's index.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' "$PWD" ;;
  *"rev-parse HEAD"*) printf 'fixture-head\\n' ;;
  *"diff HEAD --numstat"*) printf '%s\\t0\\tfixture.ts\\n' "\${FIXTURE_CHANGED_LINES:-1}" ;;
  *"status --porcelain"*) printf ' M fixture.ts\\n' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  env = baseEnv(homes, { ...fixtureEnv(fixtures), PATH: bin });
});
afterEach(() => cleanup(homes.root));

function payload(event: "SessionStart" | "Stop") {
  return {
    session_id: fixtures.claudeSessionId,
    cwd: fixtures.projectDir,
    hook_event_name: event,
    ...(event === "SessionStart" ? { source: "startup" } : {}),
  };
}

function hook(
  event: "session-start" | "stop",
  extra: Env = {},
  stdin?: string,
) {
  return run("hook", [event], {
    env: { ...env, ...extra },
    cwd: fixtures.projectDir,
    stdin:
      stdin ??
      JSON.stringify(payload(event === "stop" ? "Stop" : "SessionStart")),
  });
}

function guidance(session: string | null, codex = false): string {
  const command = `/cockpit scribe --session ${session ?? "<parent-session-id>"}`;
  const spawn = codex
    ? `a background sub-agent with fork_context: true and no agent_type, prompt: "You are running under Codex. Run ${command} --provider codex"`
    : `Agent(subagent_type: "fork", prompt: "Run ${command}")`;
  return (
    "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: " +
    spawn +
    (session
      ? "."
      : ", substituting this main session's id, which you resolve first.") +
    " One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine." +
    (codex
      ? ""
      : ' Use "fork" exactly (omitting it starts a fresh, context-less agent that cannot see the work).') +
    " Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output.\n"
  );
}

function reminder(session: string, codex = false): string {
  const command = `/cockpit scribe --session ${session}`;
  const spawn = codex
    ? `spawn a background sub-agent (fork_context: true, no agent_type) with the prompt "You are running under Codex. Run ${command} --provider codex"`
    : `spawn a fork (subagent_type:"fork") to run ${command}`;
  return `💭 If that change hid a real decision/learning/caveat, ${spawn} — prefer a Mermaid \`--diagram\` if it has any shape, else a terse note. Otherwise skip.`;
}

function seedTrail() {
  const result = run(
    "cli",
    [
      "log",
      "--session",
      fixtures.claudeSessionId,
      "--decision",
      "Keep the wire shape",
      "--reason",
      "Existing readers depend on it",
    ],
    { env, cwd: fixtures.projectDir },
  );
  expect(result).toEqual({
    exitCode: 0,
    stdout: `cockpit: logged decision for ${fixtures.claudeSessionId}\n`,
    stderr: "",
  });
  expect(
    readJsonl(
      join(
        fixtures.projectDir,
        ".cockpit",
        "logs",
        `${fixtures.claudeSessionId}.jsonl`,
      ),
    ),
  ).toHaveLength(1);
}

function delegationMarker() {
  const directory = join(homes.root, ".local", "share", "q-lab", "delegation");
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  const path = join(directory, `${now}-fixture.json`);
  writeFileSync(
    path,
    JSON.stringify({
      cwd: fixtures.projectDir,
      backend: "codex",
      startedAt: now,
      armUntil: now + 30_000,
      expiresAt: now + 60_000,
      sessionIds: [],
    }),
  );
  return path;
}

describe("hook: session-start", () => {
  test("prints the exact Claude guidance with a newline and no writes", () => {
    expect(hook("session-start")).toEqual({
      exitCode: 0,
      stdout: guidance(fixtures.claudeSessionId),
      stderr: "",
    });
    expect(existsSync(join(homes.cockpitHome, "registry.json"))).toBe(false);
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(
      false,
    );
  });

  test("prints the exact Codex guidance using the resolved thread id", () => {
    expect(hook("session-start", { PLUGIN_ROOT })).toEqual({
      exitCode: 0,
      stdout: guidance(fixtures.codexThreadId, true),
      stderr: "",
    });
  });

  test("suppresses Claude guidance when claude is on PATH", () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 97\n");
    chmodSync(join(bin, "claude"), 0o755);
    expect(hook("session-start")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("suppresses delegated sessions in both harnesses", () => {
    for (const extra of [
      { RELAY_DELEGATED: "1" },
      { RELAY_DELEGATED: "1", PLUGIN_ROOT },
    ] as Env[]) {
      expect(hook("session-start", extra)).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    }
  });

  test("binds a Codex delegation marker to the payload session id", () => {
    const path = delegationMarker();
    expect(hook("session-start", { PLUGIN_ROOT })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw).sessionIds).toEqual([fixtures.claudeSessionId]);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    expect(env.HOME).toBe(homes.root);
  });

  test("uses the OpenCode payload id", () => {
    expect(
      hook(
        "session-start",
        {},
        JSON.stringify({
          ...payload("SessionStart"),
          provider: "opencode",
          session_id: "ses_payload",
        }),
      ),
    ).toEqual({ exitCode: 0, stdout: guidance("ses_payload"), stderr: "" });
  });

  test("suppresses SDK and subagent payloads", () => {
    expect(
      hook("session-start", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }),
    ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(
      hook(
        "session-start",
        {},
        JSON.stringify({ ...payload("SessionStart"), agent_id: "child" }),
      ),
    ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("keeps an existing binding after the arm window", () => {
    const path = delegationMarker();
    expect(hook("session-start", { PLUGIN_ROOT }).stdout).toBe("");
    const marker = JSON.parse(readFileSync(path, "utf8"));
    marker.armUntil = Date.now() - 1;
    writeFileSync(path, JSON.stringify(marker));
    expect(hook("session-start", { PLUGIN_ROOT })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("ignores markers without PLUGIN_ROOT", () => {
    const path = delegationMarker();
    const before = readFileSync(path, "utf8");
    expect(hook("session-start")).toEqual({
      exitCode: 0,
      stdout: guidance(fixtures.claudeSessionId),
      stderr: "",
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("handles empty and garbage stdin under every environment suppression", () => {
    for (const stdin of ["", "{broken"]) {
      expect(hook("session-start", {}, stdin)).toEqual({
        exitCode: 0,
        stdout: guidance(fixtures.claudeSessionId),
        stderr: "",
      });
      for (const extra of [
        { RELAY_DELEGATED: "1" },
        { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
      ] as Env[]) {
        expect(hook("session-start", extra, stdin)).toEqual({
          exitCode: 0,
          stdout: "",
          stderr: "",
        });
      }
    }
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 97\n");
    chmodSync(join(bin, "claude"), 0o755);
    for (const stdin of ["", "{broken"])
      expect(hook("session-start", {}, stdin)).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
  });

  test("keeps guidance enabled with session nudges off", () => {
    // Seeded as `cockpit nudge off --scope session` writes it, so this group needs no nudge CLI.
    writeFileSync(
      join(homes.cockpitHome, "scribe-nudge-toggle.json"),
      JSON.stringify({
        [fixtures.claudeSessionId]: { state: "off", ts: Date.now() },
      }),
    );
    // pins TS quirk: SessionStart never reads the Stop-hook nudge toggle.
    expect(hook("session-start")).toEqual({
      exitCode: 0,
      stdout: guidance(fixtures.claudeSessionId),
      stderr: "",
    });
  });

  test("invalid stdin uses environment-only resolution and delegation checks", () => {
    expect(
      hook(
        "session-start",
        { CLAUDE_CODE_SESSION_ID: fixtures.claudeSessionId },
        "{broken",
      ),
    ).toEqual({
      exitCode: 0,
      stdout: guidance(fixtures.claudeSessionId),
      stderr: "",
    });
    expect(hook("session-start", { PLUGIN_ROOT }, "{broken")).toEqual({
      exitCode: 0,
      stdout: guidance(fixtures.codexThreadId, true),
      stderr: "",
    });
    expect(hook("session-start", { RELAY_DELEGATED: "1" }, "{broken")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});

describe("hook: stop", () => {
  test("suppresses invalid stdin, active Stop hooks, SDK and subagents", () => {
    for (const stdin of ["", "{broken", JSON.stringify({ ...payload("Stop"), stop_hook_active: true }), JSON.stringify({ ...payload("Stop"), agent_id: "child" })])
      expect(hook("stop", {}, stdin)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(hook("stop", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).stdout).toBe("");
  });

  test("prints structural text in both harnesses", () => {
    for (const codex of [false, true]) {
      const session = codex ? fixtures.codexThreadId : fixtures.claudeSessionId;
      const light = reminder(session, codex);
      const text = light.replace("💭 If that change", "📐 Sizable change (1 files, ~80 lines). If it")
        .replace("prefer a Mermaid `--diagram` if it has any shape, else a terse note. Otherwise skip.", "draw it with a Mermaid `--diagram` first (flow / sequence / state / fan-out), prose only for what a picture can't carry.");
      const output = codex ? { systemMessage: text } : { hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } };
      expect(hook("stop", { FIXTURE_CHANGED_LINES: "80", COCKPIT_NUDGE_THROTTLE_MS: "-1", ...(codex ? { PLUGIN_ROOT } : {}) }, JSON.stringify({ ...payload("Stop"), session_id: codex ? fixtures.codexThreadId : fixtures.claudeSessionId })).stdout).toBe(JSON.stringify(output));
    }
  });

  test("suppresses unchanged signatures after throttle expires and preserves raw git stdout", () => {
    expect(hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: "-1" }).stdout).not.toBe("");
    const marker = JSON.parse(readFileSync(join(homes.cockpitHome, "scribe-nudge.json"), "utf8"));
    expect(marker[fixtures.claudeSessionId].lastSig).toBe(new Bun.CryptoHasher("sha1").update("fixture-head\n 1\t0\tfixture.ts\n  M fixture.ts\n").digest("hex"));
    expect(hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: "-1" }).stdout).toBe("");
  });

  test("throttles before any git process and falls back for zero and garbage windows", () => {
    const calls = join(homes.root, "git-calls");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf called >> '${calls}'\nexit 1\n`);
    for (const window of ["60000", "0", "garbage"]) {
      writeFileSync(join(homes.cockpitHome, "scribe-nudge.json"), JSON.stringify({ [fixtures.claudeSessionId]: { lastNudgeMs: Date.now(), lastSig: "old" } }));
      expect(hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: window })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
    expect(existsSync(calls)).toBe(false);
  });

  test("suppresses project and user opt-outs", () => {
    const path = join(homes.configHome, "q-lab/cockpit/config.json");
    mkdirSync(join(homes.configHome, "q-lab/cockpit"), { recursive: true });
    for (const nudges of [{ user: "off" }, { projects: { [fixtures.projectDir]: "off" } }]) {
      writeFileSync(path, JSON.stringify({ nudges }));
      expect(hook("stop")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  test("returns silently outside git and prunes stale marker entries", () => {
    const path = join(homes.cockpitHome, "scribe-nudge.json");
    writeFileSync(path, JSON.stringify({ stale: { lastNudgeMs: Date.now() - 86400001, lastSig: "old" }, fresh: { lastNudgeMs: Date.now(), lastSig: "keep" } }));
    expect(hook("stop").stdout).not.toBe("");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual(["fresh", fixtures.claudeSessionId]);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 1\n");
    expect(hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: "-1" })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("launches a detached headless scribe with the exact argv", async () => {
    const capture = join(homes.root, "launch.json");
    const claude = join(bin, "claude");
    writeFileSync(claude, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), delegated: process.env.RELAY_DELEGATED }));\n`);
    chmodSync(claude, 0o755);
    const { underTest } = await import("./launcher");
    const skill = join(PLUGIN_ROOT, "skills/cockpit");
    const cli = join(skill, underTest === "rust" ? "bin/cockpit" : "scripts/cockpit.ts");
    const invocation = `${underTest === "rust" ? "" : "bun "}${cli}`;
    const refs = join(skill, "references");
    const session = fixtures.claudeSessionId;
    const prompt = `Scribe this session's decision log. In one turn, read ${refs}/scribe.md and run \`${invocation} scribe --prep --session ${session}\`. Then follow scribe.md: the CLI is ${cli}, and every call passes --session ${session}. Spell each call as \`${invocation} scribe …\`, never through a shell variable. When done, reply with one line.`;
    expect(hook("stop")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    for (let i = 0; i < 100 && !existsSync(capture); i++) await Bun.sleep(20);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({ argv: ["-p", prompt, "--resume", session, "--fork-session", "--no-session-persistence", "--effort", "low", "--output-format", "json", "--allowedTools", `Bash(${invocation} scribe:*)`, `Read(/${refs}/**)`], cwd: fixtures.projectDir, delegated: "1" });
  });

  test("prints the exact Claude JSON without a trailing newline", () => {
    seedTrail();
    // pins TS quirk: without claude on PATH Stop emits context instead of spawning a detached scribe.
    const expected = {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: reminder(fixtures.claudeSessionId),
      },
    };
    const before = Date.now();
    expect(hook("stop")).toEqual({
      exitCode: 0,
      stdout: JSON.stringify(expected),
      stderr: "",
    });
    const raw = readFileSync(
      join(homes.cockpitHome, "scribe-nudge.json"),
      "utf8",
    );
    const marker = JSON.parse(raw);
    expect(Object.keys(marker)).toEqual([fixtures.claudeSessionId]);
    expect(marker[fixtures.claudeSessionId].lastNudgeMs).toBeGreaterThanOrEqual(
      before,
    );
    expect(marker[fixtures.claudeSessionId].lastNudgeMs).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(marker[fixtures.claudeSessionId].lastSig).toMatch(/^[0-9a-f]{40}$/);
    expect(raw).toBe(JSON.stringify(marker));
  });

  test("prints the exact Codex systemMessage JSON", () => {
    seedTrail();
    expect(hook("stop", { PLUGIN_ROOT })).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: reminder(fixtures.codexThreadId, true),
      }),
      stderr: "",
    });
  });

  test("suppresses Stop after a session nudge off toggle", () => {
    seedTrail();
    expect(
      run("cli", ["nudge", "off", "--scope", "session"], {
        env,
        cwd: fixtures.projectDir,
      }).exitCode,
    ).toBe(0);
    for (const extra of [{}, { PLUGIN_ROOT }] as Env[])
      expect(hook("stop", extra)).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(
      false,
    );
  });

  test("suppresses delegated Stop in both harnesses", () => {
    seedTrail();
    for (const extra of [
      { RELAY_DELEGATED: "1" },
      { RELAY_DELEGATED: "1", PLUGIN_ROOT },
    ] as Env[])
      expect(hook("stop", extra)).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(
      false,
    );
  });

  test("binds a Stop delegation marker and writes no nudge marker", () => {
    seedTrail();
    const path = delegationMarker();
    expect(hook("stop", { PLUGIN_ROOT })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(JSON.parse(readFileSync(path, "utf8")).sessionIds).toEqual([
      fixtures.claudeSessionId,
    ]);
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(
      false,
    );
  });

  test("throttles immediate Stop even when the code signature changed", () => {
    seedTrail();
    const first = hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: "60000" });
    expect(first).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: reminder(fixtures.claudeSessionId),
        },
      }),
      stderr: "",
    });
    const path = join(homes.cockpitHome, "scribe-nudge.json");
    const marker = readFileSync(path, "utf8");
    expect(
      hook("stop", {
        COCKPIT_NUDGE_THROTTLE_MS: "60000",
        FIXTURE_CHANGED_LINES: "2",
      }),
    ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(path, "utf8")).toBe(marker);
  });
});

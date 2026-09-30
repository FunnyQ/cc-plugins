import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseEnv, cleanup, fixtureEnv, makeHomes, makeProviderFixtures, readJsonl, run, type Env, type Homes, type ProviderFixtures } from "./fixtures";
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
  writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' "$PWD" ;;
  *"rev-parse HEAD"*) printf 'fixture-head\\n' ;;
  *"diff HEAD --numstat"*) printf '%s\\t0\\tfixture.ts\\n' "\${FIXTURE_CHANGED_LINES:-1}" ;;
  *"status --porcelain"*) printf ' M fixture.ts\\n' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, "git"), 0o755);
  env = baseEnv(homes, { ...fixtureEnv(fixtures), PATH: bin });
});
afterEach(() => cleanup(homes.root));

function payload(event: "SessionStart" | "Stop") {
  return { session_id: fixtures.claudeSessionId, cwd: fixtures.projectDir, hook_event_name: event, ...(event === "SessionStart" ? { source: "startup" } : {}) };
}

function hook(event: "session-start" | "stop", extra: Env = {}, stdin?: string) {
  return run("hook", [event], { env: { ...env, ...extra }, cwd: fixtures.projectDir, stdin: stdin ?? JSON.stringify(payload(event === "stop" ? "Stop" : "SessionStart")) });
}

function guidance(session: string | null, codex = false): string {
  const command = `/cockpit scribe --session ${session ?? "<parent-session-id>"}`;
  const spawn = codex
    ? `a background sub-agent with fork_context: true and no agent_type, prompt: "You are running under Codex. Run ${command} --provider codex"`
    : `Agent(subagent_type: "fork", prompt: "Run ${command}")`;
  return "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: " + spawn +
    (session ? "." : ", substituting this main session's id, which you resolve first.") +
    " One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine." +
    (codex ? "" : ' Use "fork" exactly (omitting it starts a fresh, context-less agent that cannot see the work).') +
    " Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output.\n";
}

function reminder(session: string, codex = false): string {
  const command = `/cockpit scribe --session ${session}`;
  const spawn = codex
    ? `spawn a background sub-agent (fork_context: true, no agent_type) with the prompt "You are running under Codex. Run ${command} --provider codex"`
    : `spawn a fork (subagent_type:"fork") to run ${command}`;
  return `💭 If that change hid a real decision/learning/caveat, ${spawn} — prefer a Mermaid \`--diagram\` if it has any shape, else a terse note. Otherwise skip.`;
}

function seedTrail() {
  const result = run("cli", ["log", "--session", fixtures.claudeSessionId, "--decision", "Keep the wire shape", "--reason", "Existing readers depend on it"], { env, cwd: fixtures.projectDir });
  expect(result).toEqual({ exitCode: 0, stdout: `cockpit: logged decision for ${fixtures.claudeSessionId}\n`, stderr: "" });
  expect(readJsonl(join(fixtures.projectDir, ".cockpit", "logs", `${fixtures.claudeSessionId}.jsonl`))).toHaveLength(1);
}

function delegationMarker() {
  const directory = join(homes.root, ".local", "share", "q-lab", "delegation");
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  const path = join(directory, `${now}-fixture.json`);
  writeFileSync(path, JSON.stringify({ cwd: fixtures.projectDir, backend: "codex", startedAt: now, armUntil: now + 30_000, expiresAt: now + 60_000, sessionIds: [] }));
  return path;
}

describe("hook: session-start", () => {
  test("prints the exact Claude guidance with a newline and no writes", () => {
    expect(hook("session-start")).toEqual({ exitCode: 0, stdout: guidance(fixtures.claudeSessionId), stderr: "" });
    expect(existsSync(join(homes.cockpitHome, "registry.json"))).toBe(false);
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(false);
  });

  test("prints the exact Codex guidance using the resolved thread id", () => {
    expect(hook("session-start", { PLUGIN_ROOT })).toEqual({ exitCode: 0, stdout: guidance(fixtures.codexThreadId, true), stderr: "" });
  });

  test("suppresses Claude guidance when claude is on PATH", () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 97\n");
    chmodSync(join(bin, "claude"), 0o755);
    expect(hook("session-start")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("suppresses delegated sessions in both harnesses", () => {
    for (const extra of [{ RELAY_DELEGATED: "1" }, { RELAY_DELEGATED: "1", PLUGIN_ROOT }] as Env[]) {
      expect(hook("session-start", extra)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  test("binds a Codex delegation marker to the payload session id", () => {
    const path = delegationMarker();
    expect(hook("session-start", { PLUGIN_ROOT })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw).sessionIds).toEqual([fixtures.claudeSessionId]);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    expect(env.HOME).toBe(homes.root);
  });

  test("keeps guidance enabled with session nudges off", () => {
    const result = run("cli", ["nudge", "off", "--scope", "session"], { env, cwd: fixtures.projectDir });
    expect(result.exitCode).toBe(0);
    // pins TS quirk: SessionStart never reads the Stop-hook nudge toggle.
    expect(hook("session-start")).toEqual({ exitCode: 0, stdout: guidance(fixtures.claudeSessionId), stderr: "" });
  });

  test("invalid stdin uses environment-only resolution and delegation checks", () => {
    expect(hook("session-start", { CLAUDE_CODE_SESSION_ID: fixtures.claudeSessionId }, "{broken")).toEqual({ exitCode: 0, stdout: guidance(fixtures.claudeSessionId), stderr: "" });
    expect(hook("session-start", { PLUGIN_ROOT }, "{broken")).toEqual({ exitCode: 0, stdout: guidance(fixtures.codexThreadId, true), stderr: "" });
    expect(hook("session-start", { RELAY_DELEGATED: "1" }, "{broken")).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });
});

describe("hook: stop", () => {
  test("prints the exact Claude JSON without a trailing newline", () => {
    seedTrail();
    // pins TS quirk: without claude on PATH Stop emits context instead of spawning a detached scribe.
    const expected = { hookSpecificOutput: { hookEventName: "Stop", additionalContext: reminder(fixtures.claudeSessionId) } };
    const before = Date.now();
    expect(hook("stop")).toEqual({ exitCode: 0, stdout: JSON.stringify(expected), stderr: "" });
    const raw = readFileSync(join(homes.cockpitHome, "scribe-nudge.json"), "utf8");
    const marker = JSON.parse(raw);
    expect(Object.keys(marker)).toEqual([fixtures.claudeSessionId]);
    expect(marker[fixtures.claudeSessionId].lastNudgeMs).toBeGreaterThanOrEqual(before);
    expect(marker[fixtures.claudeSessionId].lastNudgeMs).toBeLessThanOrEqual(Date.now());
    expect(marker[fixtures.claudeSessionId].lastSig).toMatch(/^[0-9a-f]{40}$/);
    expect(raw).toBe(JSON.stringify(marker));
  });

  test("prints the exact Codex systemMessage JSON", () => {
    seedTrail();
    expect(hook("stop", { PLUGIN_ROOT })).toEqual({ exitCode: 0, stdout: JSON.stringify({ systemMessage: reminder(fixtures.codexThreadId, true) }), stderr: "" });
  });

  test("suppresses Stop after a session nudge off toggle", () => {
    seedTrail();
    expect(run("cli", ["nudge", "off", "--scope", "session"], { env, cwd: fixtures.projectDir }).exitCode).toBe(0);
    for (const extra of [{}, { PLUGIN_ROOT }] as Env[]) expect(hook("stop", extra)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(false);
  });

  test("suppresses delegated Stop in both harnesses", () => {
    seedTrail();
    for (const extra of [{ RELAY_DELEGATED: "1" }, { RELAY_DELEGATED: "1", PLUGIN_ROOT }] as Env[]) expect(hook("stop", extra)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(false);
  });

  test("binds a Stop delegation marker and writes no nudge marker", () => {
    seedTrail();
    const path = delegationMarker();
    expect(hook("stop", { PLUGIN_ROOT })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(JSON.parse(readFileSync(path, "utf8")).sessionIds).toEqual([fixtures.claudeSessionId]);
    expect(existsSync(join(homes.cockpitHome, "scribe-nudge.json"))).toBe(false);
  });

  test("throttles immediate Stop even when the code signature changed", () => {
    seedTrail();
    const first = hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: "60000" });
    expect(first).toEqual({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: reminder(fixtures.claudeSessionId) } }), stderr: "" });
    const path = join(homes.cockpitHome, "scribe-nudge.json");
    const marker = readFileSync(path, "utf8");
    expect(hook("stop", { COCKPIT_NUDGE_THROTTLE_MS: "60000", FIXTURE_CHANGED_LINES: "2" })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(path, "utf8")).toBe(marker);
  });
});

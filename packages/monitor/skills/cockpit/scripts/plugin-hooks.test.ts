import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import manifest from "../../../.claude-plugin/plugin.json";

const pluginRoot = resolve(import.meta.dir, "../../..");

const decisionLogHook = manifest.hooks.SessionStart.flatMap(
  (group) => group.hooks,
).find((hook) => hook.command.includes("decision-log-start.ts"));
const scribeNudgeHook = manifest.hooks.Stop.flatMap(
  (group) => group.hooks,
).find((hook) => hook.command.includes("scribe-nudge.ts"));

describe("decision-log SessionStart hook", () => {
  it("stays quiet for relay-delegated sessions", () => {
    expect(decisionLogHook).toBeDefined();
    const result = Bun.spawnSync(["sh", "-c", decisionLogHook!.command], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        RELAY_DELEGATED: "1",
      },
      stdin: Buffer.from("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  it("injects guidance for ordinary sessions", () => {
    expect(decisionLogHook).toBeDefined();
    const env = { ...process.env };
    Object.assign(env, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    delete env.RELAY_DELEGATED;
    const result = Bun.spawnSync(["sh", "-c", decisionLogHook!.command], {
      env,
      stdin: Buffer.from("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("DECISION LOG ACTIVE");
  });

  it("stays quiet for SDK sessions and subagents", () => {
    expect(decisionLogHook).toBeDefined();
    for (const input of [
      {
        env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
        hookInput: {},
      },
      {
        env: { CLAUDE_CODE_ENTRYPOINT: "cli" },
        hookInput: { agent_id: "agent-123" },
      },
    ]) {
      const result = Bun.spawnSync(["sh", "-c", decisionLogHook!.command], {
        env: {
          ...process.env,
          ...input.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
        },
        stdin: Buffer.from(JSON.stringify(input.hookInput)),
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
    }
  });
});

describe("scribe-nudge Stop hook", () => {
  it("stays quiet for automated and subagent sessions", () => {
    expect(scribeNudgeHook).toBeDefined();
    for (const input of [
      {
        env: { RELAY_DELEGATED: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
        hookInput: {},
      },
      {
        env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
        hookInput: {},
      },
      {
        env: { CLAUDE_CODE_ENTRYPOINT: "cli" },
        hookInput: { agent_id: "agent-123" },
      },
    ]) {
      const result = Bun.spawnSync(["sh", "-c", scribeNudgeHook!.command], {
        env: {
          ...process.env,
          ...input.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
        },
        stdin: Buffer.from(JSON.stringify(input.hookInput)),
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
    }
  });
});

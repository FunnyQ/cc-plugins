import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { command, PLUGIN_ROOT, SCRIPTS_DIR, underTest } from "./launcher";
import {
  baseEnv, cleanup, fixtureEnv, makeHomes, makeProviderFixtures,
  startDaemon, stopDaemon,
} from "./fixtures";

describe("harness: launcher", () => {
  test("maps every process and CLI subcommand in the current mode", () => {
    expect(underTest).toBe(process.env.COCKPIT_BIN ? "rust" : "ts");
    expect(SCRIPTS_DIR).toBe(join(PLUGIN_ROOT, "skills/cockpit/scripts"));
    const binary = process.env.COCKPIT_BIN!;
    for (const proc of ["server", "channel"] as const) {
      expect(command(proc, ["--port", "12345"])).toEqual(
        underTest === "rust"
          ? [binary, proc, "--port", "12345"]
          : ["bun", join(SCRIPTS_DIR, `cockpit-${proc}.ts`), "--port", "12345"],
      );
    }
    for (const subcommand of ["log", "scribe", "prep", "config", "wait", "send", "restart", "nudge", "find-session"]) {
      expect(command("cli", [subcommand, "argument"])).toEqual(
        underTest === "rust"
          ? [binary, subcommand, "argument"]
          : subcommand === "find-session"
            ? ["bun", join(SCRIPTS_DIR, "find-session.ts"), "argument"]
            : ["bun", join(SCRIPTS_DIR, "cockpit.ts"), subcommand, "argument"],
      );
    }
    for (const [hook, script] of [["session-start", "decision-log-start.ts"], ["stop", "scribe-nudge.ts"]]) {
      expect(command("hook", [hook])).toEqual(
        underTest === "rust" ? [binary, "hook", hook] : ["bun", join(SCRIPTS_DIR, script)],
      );
    }
    if (underTest === "ts") expect(() => command("hook", ["unknown"])).toThrow();
  });

  test("removes parent session and delegation variables before spawning", () => {
    const homes = makeHomes();
    const keys = ["CLAUDE_CODE_SESSION_ID", "RELAY_DELEGATED", "OPENCODE_SESSION_ID", "COCKPIT_HOME"];
    const saved = keys.map((key) => process.env[key]);
    try {
      keys.forEach((key) => { process.env[key] = key === "RELAY_DELEGATED" ? "1" : "parent-value"; });
      const env = baseEnv(homes);
      const child = Bun.spawnSync(["bun", "-e", "console.log(JSON.stringify(process.env))"], { env });
      expect(child.exitCode).toBe(0);
      const received = JSON.parse(child.stdout.toString());
      for (const key of keys.slice(0, 3)) expect(received[key]).toBeUndefined();
      expect(received.COCKPIT_HOME).toBe(homes.cockpitHome);
      expect(received.HOME).toBe(homes.root);
      expect(received.XDG_CONFIG_HOME).toBe(homes.configHome);
      expect(received.XDG_DATA_HOME).toBe(homes.dataHome);
      expect(baseEnv(homes, { RELAY_DELEGATED: "case-value" }).RELAY_DELEGATED).toBe("case-value");
    } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
      cleanup(homes.root);
    }
  });

  test("resolves all provider fixtures through the TS reader", () => {
    const homes = makeHomes();
    try {
      const f = makeProviderFixtures(homes);
      expect(existsSync(join(f.projectDir, ".git"))).toBe(true);
      const env = baseEnv(homes, fixtureEnv(f));
      for (const [provider, id] of [["claude", f.claudeSessionId], ["codex", f.codexThreadId], ["opencode", f.opencodeSessionId]]) {
        const result = Bun.spawnSync(["bun", join(SCRIPTS_DIR, "find-session.ts"), "--provider", provider, f.projectDir], { env, cwd: f.projectDir });
        expect(result.stderr.toString()).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe(id);
      }
    } finally {
      cleanup(homes.root);
    }
  });

  test("starts an isolated daemon and stops its PID", async () => {
    const homes = makeHomes();
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon(baseEnv(homes));
      expect(typeof daemon.info.pid).toBe("number");
      expect(daemon.info.pid).toBe(daemon.proc.pid);
      expect(typeof daemon.info.port).toBe("number");
      expect(daemon.info.port).toBe(daemon.port);
      expect(daemon.port).not.toBe(5858);
      expect(typeof daemon.token).toBe("string");
      expect(daemon.token.length).toBeGreaterThan(0);
      expect(daemon.info.root.endsWith("/skills/cockpit/scripts")).toBe(true);
      await stopDaemon(daemon);
      expect(() => process.kill(daemon!.info.pid, 0)).toThrow();
    } finally {
      if (daemon) await stopDaemon(daemon);
      cleanup(homes.root);
    }
  }, 15000);
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "setup-codex-agents.ts");
const pluginRoot = resolve(import.meta.dir, "../../..");
let codexHome: string;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "chronicle-codex-agents-"));
});

afterEach(() => {
  Bun.spawnSync(["trash", codexHome]);
});

function run(...args: string[]) {
  return Bun.spawnSync(["bun", script, "--plugin-root", pluginRoot, ...args], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("setup-codex-agents", () => {
  it("previews all three roles without writing", () => {
    const result = run("--dry-run");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("chronicle_lawspeaker");
    expect(result.stdout.toString()).toContain("chronicle_watcher");
    expect(result.stdout.toString()).toContain("chronicle_runesmith");
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  });

  it("installs role files and preserves existing config", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    const result = run("--apply");

    expect(result.exitCode).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("# BEGIN chronicle codex agents");
    expect(config).toContain("[agents.chronicle_lawspeaker]");
    expect(config).toContain("[agents.chronicle_watcher]");
    expect(config).toContain("[agents.chronicle_runesmith]");

    const installed = Object.fromEntries(
      ["lawspeaker", "watcher", "runesmith"].map((role) => [
        role,
        readFileSync(
          join(codexHome, "agents", "chronicle", `${role}.toml`),
          "utf8",
        ),
      ]),
    );
    expect(installed.lawspeaker).toContain('model = "gpt-5.6-terra"');
    expect(installed.lawspeaker).toContain("generic sub-agent runtime");
    expect(installed.lawspeaker).toContain("watcher.toml");
    expect(installed.lawspeaker).toContain("runesmith.toml");
    expect(installed.watcher).toContain('model = "gpt-5.6-luna"');
    expect(installed.runesmith).toContain('model = "gpt-5.6-luna"');
    for (const content of Object.values(installed)) {
      expect(content).toContain("developer_instructions");
    }
  });

  it("is idempotent and replaces its managed block", () => {
    expect(run("--apply").exitCode).toBe(0);
    expect(run("--apply").exitCode).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config.match(/# BEGIN chronicle codex agents/g)).toHaveLength(1);
    expect(config.match(/\[agents\.chronicle_lawspeaker\]/g)).toHaveLength(1);
  });
});

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
  it("previews all roles without writing", () => {
    const result = run("--dry-run");
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output.match(/^\[agents\.chronicle_/gm)).toHaveLength(13);
    for (const role of [
      "lawspeaker",
      "watcher",
      "runesmith",
      "storykeeper",
      "skald",
      "messenger",
      "skirnir",
      "annalist",
      "lorekeeper",
      "gleaner",
      "reckoner",
      "codifier",
      "barrowkeeper",
    ]) {
      expect(output).toContain(`[agents.chronicle_${role}]`);
    }
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
    expect(config).toContain("[agents.chronicle_storykeeper]");
    expect(config).toContain("[agents.chronicle_skald]");
    expect(config).toContain("[agents.chronicle_messenger]");
    expect(config).toContain("[agents.chronicle_annalist]");

    const installed = Object.fromEntries(
      [
        "lawspeaker",
        "watcher",
        "runesmith",
        "storykeeper",
        "skald",
        "messenger",
        "skirnir",
        "annalist",
        "lorekeeper",
        "gleaner",
        "reckoner",
        "codifier",
        "barrowkeeper",
      ].map((role) => [
        role,
        readFileSync(
          join(codexHome, "agents", "chronicle", `${role}.toml`),
          "utf8",
        ),
      ]),
    );
    expect(installed.lawspeaker).toContain('model = "gpt-5.6-terra"');
    expect(installed.lawspeaker).toContain("chronicle_watcher");
    expect(installed.lawspeaker).toContain("chronicle_runesmith");
    expect(installed.watcher).toContain('model = "gpt-5.6-luna"');
    expect(installed.runesmith).toContain('model = "gpt-5.6-luna"');
    expect(installed.runesmith).toContain("commit.ts apply");
    expect(installed.watcher).toContain("commit.ts propose");
    expect(installed.storykeeper).toContain('model = "gpt-5.6-terra"');
    expect(installed.storykeeper).toContain("chronicle_skald");
    expect(installed.storykeeper).toContain("chronicle_messenger");
    expect(installed.skald).toContain('model = "gpt-5.6-terra"');
    expect(installed.messenger).toContain('model = "gpt-5.6-luna"');
    expect(installed.annalist).toContain('model = "gpt-5.6-terra"');
    expect(installed.lorekeeper).toContain('model = "gpt-5.6-terra"');
    expect(installed.gleaner).toContain('model = "gpt-5.6-luna"');
    expect(installed.reckoner).toContain('model = "gpt-5.6-terra"');
    expect(installed.codifier).toContain('model = "gpt-5.6-terra"');
    expect(installed.barrowkeeper).toContain('model = "gpt-5.6-luna"');
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

  it("removes retired role files and preserves unrelated files", () => {
    const targetDir = join(codexHome, "agents", "chronicle");
    Bun.spawnSync(["mkdir", "-p", targetDir]);
    for (const role of ["hammerbearer", "oathkeeper", "seer", "smith"]) {
      writeFileSync(join(targetDir, `${role}.toml`), `legacy = "${role}"\n`);
    }
    writeFileSync(join(targetDir, "personal.toml"), 'name = "personal"\n');

    expect(run("--apply").exitCode).toBe(0);

    for (const role of ["hammerbearer", "oathkeeper", "seer", "smith"]) {
      expect(existsSync(join(targetDir, `${role}.toml`))).toBe(false);
    }
    expect(readFileSync(join(targetDir, "personal.toml"), "utf8")).toBe(
      'name = "personal"\n',
    );
  });
});

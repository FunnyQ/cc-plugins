import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The Codex roles are prose rewrites of the Claude agents, so their bodies cannot be
// compared byte for byte the way the OpenCode copies are. What drifted before was
// checkable anyway: a role that kept an old effort, and a role that never learned
// about a new script. These pin the parts that must agree.
const pluginRoot = resolve(import.meta.dir, "../../..");
const claudeDir = join(pluginRoot, "agents");
const codexDir = join(pluginRoot, "agents-codex");

// sonnet → terra and haiku → luna is the tier mapping every role already follows.
const CODEX_MODEL: Record<string, string> = {
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
};

const names = (dir: string, ext: string) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(ext))
    .map((file) => file.slice(0, -ext.length))
    .sort();

function frontmatter(name: string): Record<string, string> {
  const text = readFileSync(join(claudeDir, `${name}.md`), "utf8");
  const block = text.slice(3, text.indexOf("\n---", 3));
  return Object.fromEntries(
    block
      .split("\n")
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1]!, match[2]!.trim()]),
  );
}

function tomlValue(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key} = "([^"]*)"`, "m"))?.[1];
}

const chronicleScripts = new Set(
  readdirSync(join(pluginRoot, "skills"), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => path.split("/").at(-1)!),
);

const scriptsNamed = (text: string) =>
  [...new Set(text.match(/[a-z][a-z-]*\.ts/g) ?? [])]
    .filter((script) => chronicleScripts.has(script))
    .sort();

describe("codex agents track their claude sources", () => {
  test("every claude agent has a codex role and nothing else does", () => {
    expect(names(codexDir, ".toml")).toEqual(names(claudeDir, ".md"));
  });

  test.each(names(claudeDir, ".md"))(
    "%s keeps the same model tier and effort",
    (name) => {
      const meta = frontmatter(name);
      const toml = readFileSync(join(codexDir, `${name}.toml`), "utf8");

      expect(CODEX_MODEL[meta.model!]).toBeDefined();
      expect(tomlValue(toml, "model")).toBe(CODEX_MODEL[meta.model!]);
      expect(tomlValue(toml, "model_reasoning_effort")).toBe(meta.effort);
    },
  );

  test.each(names(claudeDir, ".md"))(
    "%s names every chronicle script its source names",
    (name) => {
      const claude = readFileSync(join(claudeDir, `${name}.md`), "utf8");
      const toml = readFileSync(join(codexDir, `${name}.toml`), "utf8");

      expect(scriptsNamed(toml)).toEqual(scriptsNamed(claude));
    },
  );
});

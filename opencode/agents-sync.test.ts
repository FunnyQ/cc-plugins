import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The OpenCode agent definitions are hand-copied chronicle agent bodies with
// OpenCode frontmatter on top. Ten of the thirteen bodies are byte-identical to
// their chronicle source, so an edit to a chronicle agent that never reaches the
// copy is a silent fork of ~1,600 lines. This pins that identity: drift becomes
// a test failure instead of two agents quietly disagreeing.
//
// The three orchestrators are exempt because their bodies genuinely differ —
// they carry the OpenCode `task` spawn wording and the `subagent_depth`
// prerequisite, neither of which belongs in the Claude copy. Their *shared*
// prose is unguarded; that is the known cost of the hand-copy model.
const DIVERGENT = new Set(["lawspeaker", "storykeeper", "lorekeeper"]);

const repoRoot = resolve(import.meta.dir, "..");

/** Everything after the closing `---` of the YAML frontmatter. */
function body(path: string): string {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text.trim() : text.slice(end + 4).trim();
}

const agents = [
  "annalist",
  "barrowkeeper",
  "codifier",
  "gleaner",
  "lawspeaker",
  "lorekeeper",
  "messenger",
  "reckoner",
  "runesmith",
  "skald",
  "skirnir",
  "storykeeper",
  "watcher",
];

describe("opencode agents track their chronicle sources", () => {
  test.each(agents.filter((name) => !DIVERGENT.has(name)))(
    "%s is byte-identical to the chronicle agent",
    (name) => {
      expect(body(join(repoRoot, "opencode", "agents", `${name}.md`))).toBe(
        body(join(repoRoot, "packages", "chronicle", "agents", `${name}.md`)),
      );
    },
  );

  test.each([...DIVERGENT])(
    "%s diverges on purpose and still exists on both sides",
    (name) => {
      const ported = body(join(repoRoot, "opencode", "agents", `${name}.md`));
      const source = body(
        join(repoRoot, "packages", "chronicle", "agents", `${name}.md`),
      );

      expect(ported).not.toBe("");
      expect(source).not.toBe("");
      // If these ever converge, the exemption is stale — drop the name from
      // DIVERGENT so the byte-equality guard starts covering it.
      expect(ported).not.toBe(source);
    },
  );

  test("covers every shipped OpenCode agent", () => {
    const shipped = readdirSync(join(repoRoot, "opencode", "agents"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -".md".length))
      .sort();

    expect(shipped).toEqual([...agents].sort());
  });
});

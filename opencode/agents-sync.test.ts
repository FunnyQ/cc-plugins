import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The OpenCode agent definitions are hand-copied chronicle agent bodies with
// OpenCode frontmatter on top, so an edit to a chronicle agent that never reaches
// the copy is a silent fork. This pins every body byte-identical: drift becomes a
// test failure instead of two agents quietly disagreeing.
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
  "judge",
  "lawspeaker",
  "storykeeper",
];

describe("opencode agents track their chronicle sources", () => {
  test.each(agents)(
    "%s is byte-identical to the chronicle agent",
    (name) => {
      expect(body(join(repoRoot, "opencode", "agents", `${name}.md`))).toBe(
        body(join(repoRoot, "packages", "chronicle", "agents", `${name}.md`)),
      );
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

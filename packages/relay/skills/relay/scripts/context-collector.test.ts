import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collect,
  collectFileContents,
  collectGitInfo,
  collectRelatedGitInfo,
} from "./context-collector";

let originalCwd = "";
let root = "";

beforeEach(async () => {
  originalCwd = process.cwd();
  root = await mkdtemp(join(tmpdir(), "relay-context-collector-"));
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
});

function git(args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
}

describe("collectFileContents", () => {
  test("returns present file content with correct fence", async () => {
    await writeFile(join(root, "example.ts"), "const answer = 42;\n");

    expect(collectFileContents(["example.ts"])).toBe(
      "# Current Files\n\n## example.ts\n```ts\nconst answer = 42;\n\n```\n",
    );
  });

  test("returns missing file placeholder without code fence", () => {
    expect(collectFileContents(["missing.ts"])).toBe(
      "# Current Files\n\n## missing.ts\n> File not found\n",
    );
  });

  test("skips binary file with placeholder", async () => {
    await writeFile(join(root, "image.bin"), Buffer.from([1, 2, 0, 3]));

    expect(collectFileContents(["image.bin"])).toBe(
      "# Current Files\n\n## image.bin\n> Binary file, skipped\n",
    );
  });

  test("skips files larger than 100 KB with placeholder", async () => {
    await writeFile(join(root, "large.txt"), "x".repeat(101 * 1024));

    expect(collectFileContents(["large.txt"])).toBe(
      "# Current Files\n\n## large.txt\n> File too large (101 KB), skipped\n",
    );
  });

  test("returns empty string when no files are requested", () => {
    expect(collectFileContents([])).toBe("");
  });
});

describe("git collectors", () => {
  test("collectGitInfo uses canonical headings", async () => {
    git(["init"]);
    await writeFile(join(root, "tracked.ts"), "export const value = 1;\n");
    git(["add", "tracked.ts"]);
    git([
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Relay Test",
      "-c",
      "user.email=relay@example.com",
      "commit",
      "-m",
      "initial commit",
    ]);
    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");

    const output = collectGitInfo();

    expect(output).toStartWith(
      "# Git Info\n\n## Status\n```\nM tracked.ts\n```\n",
    );
    expect(output).toContain("\n## Unstaged Changes\n```diff\n");
    expect(output).toContain("\n## Recent Commits\n```\n");
  });

  test("collectRelatedGitInfo scopes headings and omits recent commits", async () => {
    git(["init"]);
    await writeFile(join(root, "related.ts"), "export const value = 1;\n");
    await writeFile(join(root, "other.ts"), "export const other = 1;\n");
    git(["add", "related.ts", "other.ts"]);
    git([
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Relay Test",
      "-c",
      "user.email=relay@example.com",
      "commit",
      "-m",
      "initial commit",
    ]);
    await writeFile(join(root, "related.ts"), "export const value = 2;\n");
    git(["add", "related.ts"]);
    await writeFile(join(root, "related.ts"), "export const value = 3;\n");
    await writeFile(join(root, "other.ts"), "export const other = 2;\n");

    const output = collectRelatedGitInfo(["related.ts"]);

    expect(output).toStartWith(
      "# Git Info\n\n## Related Status\n```\nMM related.ts\n```\n",
    );
    expect(output).toContain("\n## Related Staged Changes\n```diff\n");
    expect(output).toContain("\n## Related Unstaged Changes\n```diff\n");
    expect(output).not.toContain("## Recent Commits");
    expect(output).not.toContain("other.ts");
  });
});

describe("collect", () => {
  test("with gitScope none and noProject true returns only file contents", async () => {
    await writeFile(join(root, "example.ts"), "export const value = 1;\n");

    expect(
      collect({
        files: ["example.ts"],
        gitScope: "none",
        noProject: true,
      }),
    ).toBe(
      "# Current Files\n\n## example.ts\n```ts\nexport const value = 1;\n\n```\n",
    );
  });

  test("with gitScope none and noProject true returns empty without files", () => {
    expect(
      collect({
        files: [],
        gitScope: "none",
        noProject: true,
      }),
    ).toBe("");
  });

  test("omits empty git section and joins file and project sections exactly", async () => {
    await writeFile(join(root, "example.ts"), "export const value = 1;\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "relay-fixture",
        dependencies: { bun: "latest" },
        devDependencies: { typescript: "latest" },
        scripts: { test: "ignored" },
      }),
    );

    expect(
      collect({
        files: ["example.ts"],
        gitScope: "all",
        noProject: false,
      }),
    ).toBe(
      [
        "# Current Files\n\n## example.ts\n```ts\nexport const value = 1;\n\n```\n",
        '# Project Info\n\n## Tech Stack\nNode.js\n\n## package.json\n```json\n{\n  "name": "relay-fixture",\n  "dependencies": {\n    "bun": "latest"\n  },\n  "devDependencies": {\n    "typescript": "latest"\n  }\n}\n```\n',
      ].join("\n---\n\n"),
    );
  });

  test("related git scope omits empty related git section", async () => {
    await writeFile(join(root, "example.ts"), "export const value = 1;\n");

    expect(
      collect({
        files: ["example.ts"],
        gitScope: "related",
        noProject: true,
      }),
    ).toBe(
      "# Current Files\n\n## example.ts\n```ts\nexport const value = 1;\n\n```\n",
    );
  });

  test("with no files and project enabled returns project section only", async () => {
    await writeFile(join(root, "Gemfile"), 'source "https://rubygems.org"\n');

    expect(
      collect({
        files: [],
        gitScope: "none",
        noProject: false,
      }),
    ).toBe(
      '# Project Info\n\n## Tech Stack\nRuby\n\n## Gemfile\n```\nsource "https://rubygems.org"\n\n```\n',
    );
  });

  test("uses exact separator between present sections", async () => {
    await writeFile(join(root, "example.txt"), "hello\n");
    await writeFile(join(root, "CLAUDE.md"), "Project note\n");

    const output = collect({
      files: ["example.txt"],
      gitScope: "none",
      noProject: false,
    });

    expect(output).toContain("\n---\n\n");
    expect(output.split("\n---\n\n")).toHaveLength(2);
    expect(output).toBe(
      "# Current Files\n\n## example.txt\n```txt\nhello\n\n```\n" +
        "\n---\n\n" +
        "# Project Info\n\n## CLAUDE.md\nProject note\n\n",
    );
  });
});

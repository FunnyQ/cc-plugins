import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendFileContract,
  ASK_RESULT_END_MARKER,
  createAskRunDir,
  extractFinalText,
} from "./ask-contract.ts";

describe("appendFileContract", () => {
  test("names the result path and the sentinel in the instructions", () => {
    const out = appendFileContract("what time is it?", "/tmp/x/result.md");
    expect(out).toContain("what time is it?");
    expect(out).toContain("/tmp/x/result.md");
    expect(out).toContain(ASK_RESULT_END_MARKER);
  });
});

describe("extractFinalText", () => {
  test("returns the answer when the last line is the sentinel", () => {
    const content = `the answer is 4\n${ASK_RESULT_END_MARKER}\n`;
    expect(extractFinalText(content)).toBe("the answer is 4");
  });

  test("returns null when the sentinel is missing entirely", () => {
    expect(extractFinalText("still writing the answer")).toBeNull();
  });

  test("returns null when the sentinel is present but not the last line", () => {
    const content = `${ASK_RESULT_END_MARKER}\nmore text came after it\n`;
    expect(extractFinalText(content)).toBeNull();
  });

  test("tolerates a trailing blank line after the sentinel", () => {
    const content = `answer here\n${ASK_RESULT_END_MARKER}\n\n`;
    expect(extractFinalText(content)).toBe("answer here");
  });
});

describe("createAskRunDir", () => {
  test("creates and returns the exact directory when given one", async () => {
    const base = await mkdtemp(join(tmpdir(), "herd-ask-contract-test-"));
    try {
      const exact = join(base, "run-dir");
      const dir = createAskRunDir(exact);
      expect(dir).toBe(exact);
      const stat = await Bun.file(dir).stat();
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("two calls with no override never collide", async () => {
    const dirs: string[] = [];
    try {
      dirs.push(createAskRunDir());
      dirs.push(createAskRunDir());
      expect(dirs[0]).not.toBe(dirs[1]);
      for (const dir of dirs) {
        expect(dirname(dir)).toBe(join("/tmp", "q-lab", "herdr", "ask"));
        expect((await Bun.file(dir).stat()).isDirectory()).toBe(true);
      }
    } finally {
      await Promise.all(
        dirs.map((dir) => rm(dir, { recursive: true, force: true })),
      );
    }
  });
});

describe("package boundaries", () => {
  const herdrRoot = join(import.meta.dir, "../../..");
  const sources = [...new Bun.Glob("**/*.ts").scanSync(herdrRoot)]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.includes("node_modules"));
  const read = (path: string) => Bun.file(join(herdrRoot, path)).text();

  test("nothing in herdr imports relay, since relay versions separately", async () => {
    for (const path of sources) {
      expect([path, await read(path)]).not.toEqual([
        path,
        expect.stringMatching(/from\s+["'][^"']*relay[^"']*["']/),
      ]);
    }
  });

  test("only createAskRunDir creates a result dir, so no caller bypasses its seam", async () => {
    const callers = [];
    for (const path of sources.filter(
      (p) => p.startsWith("skills/herdr/scripts/") && !p.endsWith(".test.ts"),
    )) {
      if ((await read(path)).includes("mkdirSync")) callers.push(path);
    }
    expect(callers).toEqual(["skills/herdr/scripts/ask-contract.ts"]);
  });
});

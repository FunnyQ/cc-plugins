import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import {
  appendFileContract,
  ASK_RESULT_END_MARKER,
  createAskRunDir,
  askRunPath,
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
        const root =
          process.platform === "win32"
            ? join(tmpdir(), "q-lab", "herdr", "ask")
            : "/tmp/q-lab/herdr/ask";
        expect(realpathSync.native(dirname(dir))).toBe(realpathSync.native(root));
        expect(basename(dir)).toMatch(/^\d+-\d+-[a-f0-9]{8}$/);
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

describe("ask platform paths", () => {
  test("uses the injected Windows temp root and preserves exact overrides", () => {
    const root = "C:\\Users\\Q\\AppData\\Local\\Temp";
    const path = askRunPath(undefined, "win32", root);
    expect(win32.dirname(path)).toBe(win32.join(root, "q-lab", "herdr", "ask"));
    expect(win32.basename(path)).toMatch(/^\d+-\d+-[a-f0-9]{8}$/);
    expect(askRunPath("C:/exact path/../run", "win32", root)).toBe(
      "C:/exact path/../run",
    );
  });

  test("keeps Unix roots on macOS, Linux and WSL regardless of temp override", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(askRunPath(undefined, platform, "/some/custom/temp")).toMatch(
        /^\/tmp\/q-lab\/herdr\/ask\/\d+-\d+-[a-f0-9]{8}$/,
      );
    }
  });

  test("UUID keeps repeated calls unique even within the same timestamp", () => {
    const now = Date.now;
    Date.now = () => 123;
    try {
      const paths = Array.from({ length: 100 }, () =>
        askRunPath(undefined, "win32", "C:/Temp"),
      );
      expect(new Set(paths).size).toBe(100);
      expect(paths.every((path) =>
        win32.basename(path).startsWith(`123-${process.pid}-`),
      )).toBe(true);
    } finally {
      Date.now = now;
    }
  });

  test("keeps the complete multiline result contract for Windows paths", () => {
    const result = "C:\\Users\\Q\\Temp\\ask run\\result.md";
    const contract = appendFileContract("Question", result);
    expect(contract).toContain(result);
    expect(contract).toContain("complete final answer");
    expect(contract).toContain("caller does not read your pane");
    expect(contract).toContain(`last line must be exactly: ${ASK_RESULT_END_MARKER}`);
    const answer = "# Answer\n\nFirst paragraph.\n\nSecond paragraph.";
    expect(extractFinalText(`${answer}\r\n${ASK_RESULT_END_MARKER}\r\n`)).toBe(answer);
  });
});

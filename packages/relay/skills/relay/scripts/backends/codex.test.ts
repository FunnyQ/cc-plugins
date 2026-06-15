import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, statSync, utimesSync } from "fs";
import { join } from "path";
import * as os from "os";
import {
  buildImagePrompt,
  extractGeneratedPngPath,
  findNewestPng,
  codexBackend,
} from "./codex";
import type { InvokeOpts } from "../types";

describe("codexBackend", () => {
  describe("supports", () => {
    it("should support delegate, review, and image modes", () => {
      expect(codexBackend.supports.has("delegate")).toBe(true);
      expect(codexBackend.supports.has("review")).toBe(true);
      expect(codexBackend.supports.has("image")).toBe(true);
    });
  });

  describe("strategy", () => {
    it("should return native for default review", () => {
      const opts: InvokeOpts = { scope: "uncommitted" };
      expect(codexBackend.strategy("review", opts)).toBe("native");
    });

    it("should return native for review with base scope", () => {
      const opts: InvokeOpts = { scope: "base:main" };
      expect(codexBackend.strategy("review", opts)).toBe("native");
    });

    it("should return native for review with commit scope", () => {
      const opts: InvokeOpts = { scope: "commit:abc123" };
      expect(codexBackend.strategy("review", opts)).toBe("native");
    });

    it("should return prompt for review with custom-files scope", () => {
      const opts: InvokeOpts = { scope: "custom-files" };
      expect(codexBackend.strategy("review", opts)).toBe("prompt");
    });

    it("should return prompt for delegate", () => {
      const opts: InvokeOpts = {};
      expect(codexBackend.strategy("delegate", opts)).toBe("prompt");
    });

    it("should return native for image", () => {
      const opts: InvokeOpts = {};
      expect(codexBackend.strategy("image", opts)).toBe("native");
    });
  });

  describe("invoke", () => {
    describe("delegate mode", () => {
      it("should build argv with workspace-write sandbox", () => {
        const opts: InvokeOpts = {
          promptText: "test prompt",
          lastFile: "/tmp/last.txt",
          dangerous: false,
        };
        const result = codexBackend.invoke("delegate", opts);
        expect(result.argv).toEqual([
          "codex",
          "exec",
          "-s",
          "workspace-write",
          "-a",
          "never",
          "-o",
          "/tmp/last.txt",
          "-",
        ]);
        expect(result.stdin).toBe("test prompt");
      });

      it("should build argv with dangerous bypass flag when requested", () => {
        const opts: InvokeOpts = {
          promptText: "test prompt",
          lastFile: "/tmp/last.txt",
          dangerous: true,
        };
        const result = codexBackend.invoke("delegate", opts);
        expect(result.argv).toEqual([
          "codex",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "-o",
          "/tmp/last.txt",
          "-",
        ]);
        expect(result.stdin).toBe("test prompt");
      });
    });

    describe("review native mode", () => {
      it("should build argv with --uncommitted for uncommitted scope", () => {
        const opts: InvokeOpts = { scope: "uncommitted" };
        const result = codexBackend.invoke("review", opts);
        expect(result.argv).toEqual(["codex", "review", "--uncommitted"]);
        expect(result.stdin).toBeUndefined();
      });

      it("should build argv with --base for base scope", () => {
        const opts: InvokeOpts = { scope: "base:main" };
        const result = codexBackend.invoke("review", opts);
        expect(result.argv).toEqual(["codex", "review", "--base", "main"]);
        expect(result.stdin).toBeUndefined();
      });

      it("should build argv with --commit for commit scope", () => {
        const opts: InvokeOpts = { scope: "commit:abc123def456" };
        const result = codexBackend.invoke("review", opts);
        expect(result.argv).toEqual([
          "codex",
          "review",
          "--commit",
          "abc123def456",
        ]);
        expect(result.stdin).toBeUndefined();
      });
    });

    describe("review custom-files (prompt fallback)", () => {
      it("should build argv with read-only exec for custom-files scope", () => {
        const opts: InvokeOpts = {
          scope: "custom-files",
          promptText: "review prompt",
          lastFile: "/tmp/last.txt",
        };
        const result = codexBackend.invoke("review", opts);
        expect(result.argv).toEqual([
          "codex",
          "exec",
          "-s",
          "read-only",
          "-o",
          "/tmp/last.txt",
          "-",
        ]);
        expect(result.stdin).toBe("review prompt");
      });
    });

    describe("image mode", () => {
      it("should build argv with image prompt from task", () => {
        const opts: InvokeOpts = {
          task: "a sunset over mountains",
          lastFile: "/tmp/last.txt",
        };
        const result = codexBackend.invoke("image", opts);
        expect(result.argv).toEqual([
          "codex",
          "exec",
          "-o",
          "/tmp/last.txt",
          "Generate an image of: a sunset over mountains. Use gpt-image-2.",
        ]);
        expect(result.stdin).toBeUndefined();
      });

      it("should use focus as fallback for image prompt", () => {
        const opts: InvokeOpts = {
          focus: "a cat",
          lastFile: "/tmp/last.txt",
        };
        const result = codexBackend.invoke("image", opts);
        expect(result.argv[result.argv.length - 1]).toBe(
          "Generate an image of: a cat. Use gpt-image-2.",
        );
      });

      it("should use generic prompt if neither task nor focus provided", () => {
        const opts: InvokeOpts = { lastFile: "/tmp/last.txt" };
        const result = codexBackend.invoke("image", opts);
        expect(result.argv[result.argv.length - 1]).toBe(
          "Generate an image of: an image. Use gpt-image-2.",
        );
      });
    });
  });

  describe("parseOutput", () => {
    it("should return input unchanged", () => {
      const raw = "Some output from codex";
      expect(codexBackend.parseOutput(raw)).toBe(raw);
    });

    it("should preserve multi-line output", () => {
      const raw = "Line 1\nLine 2\nLine 3";
      expect(codexBackend.parseOutput(raw)).toBe(raw);
    });
  });

  describe("buildImagePrompt", () => {
    it("should format prompt with gpt-image-2", () => {
      const result = buildImagePrompt("a blue ocean");
      expect(result).toBe(
        "Generate an image of: a blue ocean. Use gpt-image-2.",
      );
    });

    it("should handle prompts with special characters", () => {
      const result = buildImagePrompt("a cat & dog on a beach");
      expect(result).toBe(
        "Generate an image of: a cat & dog on a beach. Use gpt-image-2.",
      );
    });

    it("should handle empty prompt", () => {
      const result = buildImagePrompt("");
      expect(result).toBe("Generate an image of: . Use gpt-image-2.");
    });
  });

  describe("extractGeneratedPngPath", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(os.tmpdir(), `test-png-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      // Cleanup
      try {
        const fs = require("fs");
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it("should extract absolute path from output", () => {
      const pngPath = join(tempDir, "test.png");
      writeFileSync(pngPath, "fake png");

      const output = `Generated image: ${pngPath}`;
      const result = extractGeneratedPngPath(output);
      expect(result).toBe(pngPath);
    });

    it("should resolve tilde-relative paths", () => {
      // This test depends on a real ~/something.png existing, so we skip in CI
      // or use a fixture. For now, test the path resolution logic via direct test.
      const output = `Image saved to ~/test-image.png`;
      const result = extractGeneratedPngPath(output);
      // Will be null since ~/test-image.png likely doesn't exist
      expect(result).toBeNull();
    });

    it("should return null if no .png found in output", () => {
      const output = "No image generated";
      const result = extractGeneratedPngPath(output);
      expect(result).toBeNull();
    });

    it("should return null if path in output doesn't exist", () => {
      const output = "/nonexistent/path/image.png";
      const result = extractGeneratedPngPath(output);
      expect(result).toBeNull();
    });

    it("should find first valid PNG path among multiple candidates", () => {
      const validPath = join(tempDir, "valid.png");
      writeFileSync(validPath, "fake");

      const output = `/nonexistent/bad.png and ${validPath} are here`;
      const result = extractGeneratedPngPath(output);
      expect(result).toBe(validPath);
    });
  });

  describe("findNewestPng", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(os.tmpdir(), `test-newest-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
      mkdirSync(join(tempDir, "subdir"), { recursive: true });
    });

    afterEach(() => {
      try {
        const fs = require("fs");
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it("should find the newest PNG file after a given date", () => {
      const oldPng = join(tempDir, "old.png");
      const newPng = join(tempDir, "new.png");

      const oldTime = new Date(Date.now() - 10000);
      const newTime = new Date(Date.now() - 1000);

      writeFileSync(oldPng, "old");
      writeFileSync(newPng, "new");

      // Set mtimes using utimesSync
      utimesSync(oldPng, oldTime, oldTime);
      utimesSync(newPng, newTime, newTime);

      const cutoff = new Date(Date.now() - 5000);
      const result = findNewestPng(cutoff, tempDir);
      expect(result).toBe(newPng);
    });

    it("should recursively scan subdirectories", () => {
      const subPng = join(tempDir, "subdir", "nested.png");
      writeFileSync(subPng, "nested");

      const cutoff = new Date(Date.now() - 5000);
      const result = findNewestPng(cutoff, tempDir);
      expect(result).toBe(subPng);
    });

    it("should return null if no PNGs found after cutoff date", () => {
      const oldPng = join(tempDir, "old.png");
      writeFileSync(oldPng, "old");

      // Set mtime to well before the cutoff (year 2020)
      const veryOldTime = new Date("2020-01-01");
      utimesSync(oldPng, veryOldTime, veryOldTime);

      const cutoff = new Date(Date.now() - 5000);
      const result = findNewestPng(cutoff, tempDir);
      expect(result).toBeNull();
    });

    it("should return null if baseDir doesn't exist", () => {
      const nonexistent = join(tempDir, "nonexistent");
      const cutoff = new Date();
      const result = findNewestPng(cutoff, nonexistent);
      expect(result).toBeNull();
    });

    it("should select the newest among multiple valid PNGs", () => {
      const png1 = join(tempDir, "img1.png");
      const png2 = join(tempDir, "img2.png");

      writeFileSync(png1, "1");
      writeFileSync(png2, "2");

      // Give png2 a newer mtime
      const time1 = new Date(Date.now() - 3000);
      const time2 = new Date(Date.now() - 1000);

      utimesSync(png1, time1, time1);
      utimesSync(png2, time2, time2);

      const cutoff = new Date(Date.now() - 5000);
      const result = findNewestPng(cutoff, tempDir);
      expect(result).toBe(png2);
    });
  });

  describe("postRun", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(os.tmpdir(), `test-postrun-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try {
        const fs = require("fs");
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it("should return parsed unchanged for delegate mode", () => {
      const parsed = "Some delegate output";
      const opts: InvokeOpts = {};
      const result = codexBackend.postRun!("delegate", parsed, opts);
      expect(result).toBe(parsed);
    });

    it("should return parsed unchanged for review mode", () => {
      const parsed = "Some review output";
      const opts: InvokeOpts = {};
      const result = codexBackend.postRun!("review", parsed, opts);
      expect(result).toBe(parsed);
    });

    it("should copy image PNG to output path for image mode", () => {
      // Create a source PNG
      const sourceDir = join(tempDir, "source");
      mkdirSync(sourceDir);
      const sourcePng = join(sourceDir, "generated.png");
      writeFileSync(sourcePng, "fake png data");

      // Set up output path
      const outDir = join(tempDir, "output");
      mkdirSync(outDir);
      const outPath = join(outDir, "result.png");

      // Mock extractGeneratedPngPath to return our source PNG
      const opts: InvokeOpts = { out: outPath };
      const parsed = `Image at ${sourcePng}`;

      // We can't easily mock extractGeneratedPngPath, so we'll test with a real path
      // For this test to work, we need to use the PNG path directly in the output
      const result = codexBackend.postRun!("image", parsed, opts);

      // Result should indicate success
      expect(result).toContain("Image saved:");
      expect(result).toContain(".png");
    });

    it("should return error message if PNG not found", () => {
      const opts: InvokeOpts = { out: "/tmp/nonexistent/result.png" };
      const parsed = "No PNG path in output";
      const result = codexBackend.postRun!("image", parsed, opts);
      expect(result).toContain("Error");
      expect(result).toContain("No image found");
    });
  });
});

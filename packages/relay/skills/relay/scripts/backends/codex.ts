import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { Backend, Mode, InvokeOpts, PostRunResult } from "../types";
import { addTimestampSuffix, run } from "../shared";

// Codex binary from environment or default
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

/**
 * Build the gpt-image-2 prompt for codex image generation.
 * Pure function for testing.
 */
export function buildImagePrompt(prompt: string): string {
  return `Generate an image of: ${prompt}. Use gpt-image-2.`;
}

/**
 * Extract a PNG path from codex output text.
 * Looks for patterns like /path/file.png or ~/path/file.png that exist on disk.
 * Returns the first match, or null if none found.
 * Pure function for testing.
 */
export function extractGeneratedPngPath(output: string): string | null {
  // Match absolute or tilde-relative paths ending in .png
  const matches = output.match(/(?:~|\/)[^\s"'`]+\.png/g) ?? [];

  for (const match of matches) {
    const fullPath = match.startsWith("~/")
      ? join(homedir(), match.slice(2))
      : match;
    if (existsSync(fullPath)) return fullPath;
  }

  return null;
}

/**
 * Find the newest PNG file in ~/.codex/generated_images modified after a given date.
 * Recursively scans the directory.
 * baseDir is injectable for testing (default: ~/.codex/generated_images).
 * Pure function for testing.
 */
export function findNewestPng(after: Date, baseDir?: string): string | null {
  const dir = baseDir ?? join(homedir(), ".codex", "generated_images");
  if (!existsSync(dir)) return null;

  let newest: { path: string; mtime: Date } | null = null;

  const scan = (currentDir: string) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const full = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (entry.isFile() && entry.name.endsWith(".png")) {
        const stat = statSync(full);
        if (stat.mtime > after && (!newest || stat.mtime > newest.mtime)) {
          newest = { path: full, mtime: stat.mtime };
        }
      }
    }
  };

  scan(dir);
  return newest ? newest.path : null;
}

export const codexBackend: Backend = {
  name: "codex",
  supports: new Set(["delegate", "review", "image"]),

  strategy(mode: Mode, opts: InvokeOpts) {
    if (mode === "review") {
      // Custom-file review degrades to prompt strategy; others are native
      return opts.scope === "custom-files" ? "prompt" : "native";
    }
    if (mode === "delegate") return "prompt";
    // image mode is native
    return "native";
  },

  invoke(mode: Mode, opts: InvokeOpts) {
    if (mode === "delegate") {
      // delegate: codex exec with sandbox flags or dangerous bypass
      const argv = opts.dangerous
        ? [
            CODEX_BIN,
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            "-o",
            opts.lastFile!,
            "-",
          ]
        : [
            CODEX_BIN,
            "exec",
            "-s",
            "workspace-write",
            "-a",
            "never",
            "-o",
            opts.lastFile!,
            "-",
          ];
      return { argv, stdin: opts.promptText };
    }

    if (mode === "review") {
      if (opts.scope === "custom-files") {
        // Custom-file review uses read-only exec with a prompt file
        const argv = [
          CODEX_BIN,
          "exec",
          "-s",
          "read-only",
          "-o",
          opts.lastFile!,
          "-",
        ];
        return { argv, stdin: opts.promptText };
      }

      // Native review: parse scope and build codex review flags
      const argv = [CODEX_BIN, "review"];
      if (!opts.scope || opts.scope === "uncommitted") {
        argv.push("--uncommitted");
      } else if (opts.scope.startsWith("base:")) {
        const ref = opts.scope.slice(5); // "base:<ref>" → "<ref>"
        argv.push("--base", ref);
      } else if (opts.scope.startsWith("commit:")) {
        const sha = opts.scope.slice(7); // "commit:<sha>" → "<sha>"
        argv.push("--commit", sha);
      } else {
        // Bare ref/SHA (e.g. "--scope main" or "--scope abc123"): treat as a
        // base ref so it reviews against that point, instead of silently
        // falling through to a plain `codex review` of the wrong diff.
        argv.push("--base", opts.scope);
      }
      return { argv };
    }

    if (mode === "image") {
      // image: codex exec with image prompt (no stdin)
      const prompt = buildImagePrompt(opts.task || opts.focus || "an image");
      const argv = [CODEX_BIN, "exec", "-o", opts.lastFile!, prompt];
      return { argv };
    }

    // Should not reach here if mode is validated upstream
    throw new Error(`Unsupported mode for codex: ${mode}`);
  },

  parseOutput(raw: string): string {
    // Codex output is already clean; return as-is
    return raw;
  },

  postRun(mode: Mode, parsed: string, opts: InvokeOpts): PostRunResult {
    if (mode !== "image") return { ok: true, text: parsed };

    // Image mode: locate PNG and copy to opts.out with timestamp suffix
    // Try to extract PNG path from output first
    let sourcePng = extractGeneratedPngPath(parsed);

    // Fallback: find the newest PNG created since the run started. relay.ts
    // captures runStartedAt just before the spawn; using it (instead of a fixed
    // 1s window measured after the run finished) avoids false "No image found"
    // for generations that take longer than a second.
    if (!sourcePng) {
      const after = opts.runStartedAt ?? new Date(Date.now() - 1000);
      sourcePng = findNewestPng(after);
    }

    if (!sourcePng) {
      return {
        ok: false,
        text: `Error: No image found in ~/.codex/generated_images after generation\n`,
      };
    }

    // Copy PNG to output path with timestamp suffix
    const finalPath = addTimestampSuffix(opts.out!);
    const outDir = dirname(finalPath);

    // Ensure output directory exists
    if (!existsSync(outDir)) {
      const mkdirResult = run(["mkdir", "-p", outDir]);
      if (!mkdirResult.ok) {
        return {
          ok: false,
          text: `Error: Failed to create output directory ${outDir}\n`,
        };
      }
    }

    // Copy the PNG file
    const cpResult = run(["cp", sourcePng, finalPath]);
    if (!cpResult.ok) {
      return {
        ok: false,
        text: `Error: Failed to copy image from ${sourcePng} to ${finalPath}: ${cpResult.stderr}\n`,
      };
    }

    return { ok: true, text: `Image saved: ${finalPath}\n` };
  },
};

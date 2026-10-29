import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type {
  Backend,
  Mode,
  InvokeOpts,
  LiveSpec,
  PostRunResult,
} from "../types";
import { addTimestampSuffix } from "../shared";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

/** Names no model: codex routes image requests to its built-in imagegen skill. */
export function buildImagePrompt(prompt: string): string {
  return `Generate an image of: ${prompt}.`;
}

export function extractGeneratedPngPath(
  output: string,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  const matches =
    output.match(/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'`]+\.png/g) ?? [];

  for (const match of matches) {
    const fullPath = /^~[\\/]/.test(match)
      ? join(home, match.slice(2))
      : match;
    if (exists(fullPath)) return fullPath;
  }

  return null;
}

export const generatedImages = {
  dir: join(homedir(), ".codex", "generated_images"),
};

export function findNewestPng(
  after: Date,
  dir = generatedImages.dir,
): string | null {
  if (!existsSync(dir)) return null;

  let newest: { path: string; mtime: Date } | null = null;

  for (const entry of readdirSync(dir, {
    recursive: true,
    encoding: "utf-8",
  })) {
    if (!entry.endsWith(".png")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    if (stat.mtime > after && (!newest || stat.mtime > newest.mtime)) {
      newest = { path: full, mtime: stat.mtime };
    }
  }

  return newest?.path ?? null;
}

/**
 * The mtime search runs FIRST because it carries actual semantics: it only ever
 * matches a file written after this run started. The prose scrape is the
 * fallback, for a codex that saved outside ~/.codex/generated_images — it
 * matches any path-shaped token that happens to exist on disk, so a model
 * merely REFERRING to an older image ("similar to ~/reference.png") would
 * otherwise silently copy the wrong file.
 */
export function selectSourcePng(
  parsed: string,
  after: Date,
  baseDir?: string,
): string | null {
  return findNewestPng(after, baseDir) ?? extractGeneratedPngPath(parsed);
}

export const codexBackend: Backend = {
  name: "codex",
  supports: new Set(["delegate", "review", "image"]),

  invoke(mode: Mode, opts: InvokeOpts) {
    if (mode === "delegate") {
      // `codex exec` is non-interactive by default; `-s` controls the sandbox.
      // (The old `-a never` approval flag was removed in codex >= 0.139 —
      // passing it makes `codex exec` error with "unexpected argument '-a'".)
      // `danger-full-access` is the non-dangerous default because the
      // workspace-write sandbox blocks routine delegate work (writes outside
      // the workspace root, network fetches) far more often than it helps.
      const sandbox = opts.dangerous
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["-s", "danger-full-access"];
      const model = opts.model ? ["-m", opts.model] : [];
      return {
        argv: [
          CODEX_BIN,
          "exec",
          ...model,
          ...sandbox,
          "-o",
          opts.lastFile!,
          "-",
        ],
        stdin: opts.promptText,
      };
    }

    if (mode === "review") {
      const argv = [CODEX_BIN, "review"];
      // `codex review` has no -m; a JSON string is also a valid TOML string.
      if (opts.model) argv.push("-c", `model=${JSON.stringify(opts.model)}`);
      if (!opts.task?.trim()) argv.push("--uncommitted");
      argv.push("-");
      return { argv, stdin: opts.promptText };
    }

    return {
      argv: [CODEX_BIN, "exec", "-o", opts.lastFile!, "-"],
      stdin: buildImagePrompt(opts.task || "an image"),
    };
  },

  parseOutput(raw: string): string {
    return raw;
  },

  invokeLive(mode: Mode, opts: InvokeOpts): LiveSpec | null {
    if (mode === "image") return null;
    // The TUI's startup update prompt blocks the pane before the bootstrap
    // lands, and picking "Update now" exits codex instead of continuing.
    const argv = ["-c", "check_for_update_on_startup=false"];
    if (opts.model) argv.push("-m", opts.model);
    // Non-dangerous drops the sandbox but KEEPS approvals: the TUI's own
    // prompts stay visible in the pane, which is the point of live mode.
    if (opts.dangerous) argv.push("--dangerously-bypass-approvals-and-sandbox");
    else argv.push("-s", "danger-full-access");
    return { agentBin: CODEX_BIN, argv };
  },

  postRun(mode: Mode, parsed: string, opts: InvokeOpts): PostRunResult {
    if (mode !== "image") return { ok: true, text: parsed };

    // relay.ts captures runStartedAt just before the spawn; using it (instead of
    // a fixed 1s window measured after the run finished) avoids false "No image
    // found" for generations that take longer than a second.
    const after = opts.runStartedAt ?? new Date(Date.now() - 1000);
    const sourcePng = selectSourcePng(parsed, after);

    if (!sourcePng) {
      return {
        ok: false,
        text: `Error: No image found in ~/.codex/generated_images after generation\n`,
      };
    }

    const finalPath = addTimestampSuffix(opts.out!);

    try {
      mkdirSync(dirname(finalPath), { recursive: true });
      copyFileSync(sourcePng, finalPath);
    } catch (error) {
      return {
        ok: false,
        text: `Error: Failed to copy image from ${sourcePng} to ${finalPath}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      };
    }

    return { ok: true, text: `Image saved: ${finalPath}\n` };
  },
};

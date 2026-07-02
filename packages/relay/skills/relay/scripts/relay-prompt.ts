#!/usr/bin/env bun

import { writeFileSync } from "fs";
import { join } from "path";
import { collect } from "./context-collector";
import { createTmpRunDir, parseCsv } from "./shared";
import type { Mode, Scope } from "./types";

export type PromptKind = "delegate" | "review";

export type FormatOptions = {
  kind: PromptKind;
  context: string; // pre-collected git/file/project context (caller runs collect())
  focus: string; // review concern
  task: string; // delegate task
  files: string[]; // for the delegate file-scope line
};

/**
 * Pure formatter: takes a context string and formats it into a prompt.
 * No filesystem I/O, no backend-specific naming.
 */
export function formatPrompt(options: FormatOptions): string {
  const { kind, context, focus, task, files } = options;

  const separator = "\n\n---\n\n";

  if (kind === "review") {
    const reviewFocus =
      focus && focus.trim()
        ? focus
        : "general code quality, bugs, and improvements";
    return (
      context +
      separator +
      "Review the above for code quality, bugs, and improvements.\n" +
      `Focus: ${reviewFocus}\n` +
      "Analyze only — do not modify any files; produce findings as a report."
    );
  }

  if (kind === "delegate") {
    if (!task) {
      throw new Error("Delegate task is required");
    }
    const fileScope =
      files.length > 0 ? files.join(", ") : "(no explicit file scope)";
    return (
      context +
      separator +
      `Task: ${task}\n\n` +
      "Execution constraints:\n" +
      "- Modify only the files needed for this task. If possible, stay within: " +
      fileScope +
      "\n" +
      "- Do not revert user changes or unrelated dirty work.\n" +
      "- Do not create commits.\n" +
      "- After finishing, list changed files and verification commands/results."
    );
  }

  throw new Error(`Unknown prompt kind: ${kind}`);
}

// Sentinel the live delegate writes as the LAST line of result.md — relay's
// poll loop treats the file as final only once this line has landed.
export const RESULT_END_MARKER = "==== RELAY RESULT END ====";

/**
 * Append the live-run result-file contract to a prompt. The delegate runs in
 * an interactive TUI pane, so its final answer is captured via this file —
 * pane reads are lossy (alt-screen TUIs leave scrollback empty).
 * Pure function.
 */
export function appendFileContract(prompt: string, resultPath: string): string {
  return (
    prompt +
    "\n\n---\n\n" +
    "Result-file contract (IMPORTANT):\n" +
    `- When your answer is FINAL, write it — the COMPLETE final answer, as markdown — to: ${resultPath}\n` +
    `- The file's last line must be exactly: ${RESULT_END_MARKER}\n` +
    "- Do not write the file until the answer is final; write it once, in full.\n" +
    "- The file is how your answer is collected — relay does not read the pane. Writing it is mandatory.\n" +
    "- If writing it is genuinely impossible (e.g. a sandbox blocks the path), print the FULL answer in the pane and state you could not write the file — a human reads it from the pane (relay reports the pane's name when it gives up waiting)."
  );
}

/**
 * Live review runs in a TUI (no native `codex review`), so a git-ref scope
 * becomes an instruction telling the agent to produce the diff itself.
 * `custom-files` returns "" — the files are already inlined in the prompt.
 * Pure function.
 */
export function scopeInstruction(scope: Scope | undefined): string {
  if (!scope || scope === "uncommitted") {
    return "Review scope: the uncommitted working-tree changes. Run `git diff` and `git status --short` to see them.";
  }
  if (scope === "custom-files") return "";
  if (scope.startsWith("base:")) {
    const ref = scope.slice(5);
    return `Review scope: changes since ${ref}. Run \`git diff ${ref}...\` to see them.`;
  }
  if (scope.startsWith("commit:")) {
    const sha = scope.slice(7);
    return `Review scope: the single commit ${sha}. Run \`git show ${sha}\` to see it.`;
  }
  // Bare ref/SHA — same treatment as base:<ref> (mirrors the headless mapping).
  return `Review scope: changes since ${scope}. Run \`git diff ${scope}...\` to see them.`;
}

/**
 * Impure: collects context, formats, writes <kind>-prompt.md to a tmp dir, returns the path.
 * Imported and called by the relay entry point directly.
 */
export function buildPromptFile(options: {
  kind: PromptKind;
  files: string[];
  focus: string;
  task: string;
  gitScope: "all" | "related" | "none";
  noProject: boolean;
}): string {
  const { kind, files, focus, task, gitScope, noProject } = options;

  // Validate delegate requires a task
  if (kind === "delegate" && !task) {
    const msg = "Error: delegate mode requires a task (--task or stdin)";
    console.error(msg);
    process.exit(1);
  }

  // Collect context from filesystem
  const context = collect({ files, gitScope, noProject });

  // Format the prompt
  const prompt = formatPrompt({
    kind,
    context,
    focus,
    task,
    files,
  });

  // Write to tmp directory
  const tmpDir = createTmpRunDir();
  const fileName = `${kind}-prompt.md`;
  const promptPath = join(tmpDir, fileName);
  writeFileSync(promptPath, prompt, "utf-8");

  return promptPath;
}

// Optional CLI entry for manual/debug use
if (import.meta.main) {
  async function readStdin(): Promise<string> {
    let input = "";
    for await (const chunk of Bun.stdin.stream()) {
      input += new TextDecoder().decode(chunk);
    }
    return input.trim();
  }

  async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
      console.error(
        "Usage: relay-prompt <delegate|review> --files <csv> [--focus <t>] [--task <t>] [--git-scope <s>] [--no-project]",
      );
      process.exit(1);
    }

    const kind = args[0];
    if (kind !== "delegate" && kind !== "review") {
      console.error(`Error: unknown prompt kind "${kind}"`);
      process.exit(1);
    }

    const opts: {
      kind: PromptKind;
      files: string[];
      focus: string;
      task: string;
      gitScope: "all" | "related" | "none";
      noProject: boolean;
    } = {
      kind: kind as PromptKind,
      files: [],
      focus: "",
      task: "",
      gitScope: "related",
      noProject: false,
    };

    // Parse arguments
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--files" && i + 1 < args.length) {
        opts.files = parseCsv(args[++i]);
      } else if (arg === "--focus" && i + 1 < args.length) {
        opts.focus = args[++i];
      } else if (arg === "--task" && i + 1 < args.length) {
        opts.task = args[++i];
      } else if (arg === "--git-scope" && i + 1 < args.length) {
        const scope = args[++i];
        if (scope === "all" || scope === "related" || scope === "none") {
          opts.gitScope = scope;
        }
      } else if (arg === "--no-project") {
        opts.noProject = true;
      }
    }

    // Read stdin fallbacks for task and focus
    const stdinData = await readStdin();
    if (!opts.task && kind === "delegate") {
      opts.task = stdinData;
    }
    if (!opts.focus && kind === "review" && stdinData) {
      opts.focus = stdinData;
    }

    // Build the prompt file
    const promptPath = buildPromptFile(opts);
    console.log(promptPath);
  }

  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

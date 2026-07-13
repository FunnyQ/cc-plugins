#!/usr/bin/env bun

import { writeFileSync } from "fs";
import { join } from "path";
import { collect } from "./context-collector";
import { createTmpRunDir, parseCsv } from "./shared";
import type { Mode } from "./types";

export type PromptKind = "delegate" | "review";

export type FormatOptions = {
  kind: PromptKind;
  context: string; // pre-collected git/file/project context (caller runs collect())
  task: string;
  files: string[]; // for the delegate file-scope line
};

/**
 * Pure formatter: takes a context string and formats it into a prompt.
 * No filesystem I/O, no backend-specific naming.
 */
export function formatPrompt(options: FormatOptions): string {
  const { kind, context, task, files } = options;

  const separator = "\n\n---\n\n";

  if (kind === "review") {
    return context + separator + buildReviewPrompt(task);
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

const REVIEW_CONTRACT =
  "Analyze only. Do not modify files. Return findings as a report.";

export function buildReviewPrompt(task: string | undefined): string {
  const request = task?.trim();
  if (request) {
    return `${REVIEW_CONTRACT}\nFollow the user's review request exactly.\n\nUser request:\n${request}`;
  }

  return (
    `${REVIEW_CONTRACT}\n` +
    "Review only the uncommitted changes in the working tree. " +
    "Run `git status --short`, `git diff`, and `git diff --cached`; " +
    "inspect relevant untracked files listed by status. Do not audit unrelated code."
  );
}

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
 * Impure: collects context, formats, writes <kind>-prompt.md to a tmp dir, returns the path.
 * Imported and called by the relay entry point directly.
 */
export function buildPromptFile(options: {
  kind: PromptKind;
  files: string[];
  task: string;
  gitScope: "all" | "related" | "none";
  noProject: boolean;
}): string {
  const { kind, files, task, gitScope, noProject } = options;

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
        "Usage: relay-prompt <delegate|review> --files <csv> [--task <t>] [--git-scope <s>] [--no-project]",
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
      task: string;
      gitScope: "all" | "related" | "none";
      noProject: boolean;
    } = {
      kind: kind as PromptKind,
      files: [],
      task: "",
      gitScope: "related",
      noProject: false,
    };

    // Parse arguments
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--files" && i + 1 < args.length) {
        opts.files = parseCsv(args[++i]);
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

    // Read stdin as the task fallback for both modes.
    const stdinData = await readStdin();
    if (!opts.task) {
      opts.task = stdinData;
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

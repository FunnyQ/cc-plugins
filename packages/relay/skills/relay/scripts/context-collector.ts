#!/usr/bin/env bun

import { readFileSync, existsSync, statSync } from "fs";
import { resolve, extname } from "path";
import { parseCsv } from "./shared";

type Options = {
  files: string[];
  gitScope: "all" | "related" | "none";
  noProject: boolean;
};

const MAX_OUTPUT_LENGTH = 50_000;

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const options: Options = { files: [], gitScope: "all", noProject: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--files" && i + 1 < args.length) {
      options.files = parseCsv(args[++i]);
    } else if (arg === "--no-git") {
      options.gitScope = "none";
    } else if (arg === "--git-scope" && i + 1 < args.length) {
      const scope = args[++i];
      if (scope === "all" || scope === "related" || scope === "none") {
        options.gitScope = scope;
      }
    } else if (arg === "--no-project") {
      options.noProject = true;
    }
  }

  return options;
}

function shell(args: string[], maxLength = MAX_OUTPUT_LENGTH): string {
  const proc = Bun.spawnSync(args);
  if (proc.exitCode !== 0) return "";
  let out = proc.stdout.toString().trim();
  if (out.length > maxLength) {
    out = out.substring(0, maxLength) + "\n... (truncated)";
  }
  return out;
}

function safeReadFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function isGitRepo(): boolean {
  return shell(["git", "rev-parse", "--is-inside-work-tree"]) === "true";
}

export function collectGitInfo(): string {
  if (!isGitRepo()) return "";

  const sections: string[] = [];
  sections.push("# Git Info\n");

  const status = shell(["git", "status", "--short"]);
  sections.push("## Status\n```\n" + (status || "(clean)") + "\n```\n");

  const diffStaged = shell(["git", "diff", "--staged"]);
  if (diffStaged) {
    sections.push("## Staged Changes\n```diff\n" + diffStaged + "\n```\n");
  }

  const diffUnstaged = shell(["git", "diff"]);
  if (diffUnstaged) {
    sections.push("## Unstaged Changes\n```diff\n" + diffUnstaged + "\n```\n");
  }

  const log = shell(["git", "log", "--oneline", "-5"]);
  if (log) {
    sections.push("## Recent Commits\n```\n" + log + "\n```\n");
  }

  return sections.join("\n");
}

export function collectRelatedGitInfo(files: string[]): string {
  if (!isGitRepo() || files.length === 0) return "";

  const sections: string[] = [];
  sections.push("# Git Info\n");

  const status = shell(["git", "status", "--short", "--", ...files]);
  sections.push("## Related Status\n```\n" + (status || "(clean)") + "\n```\n");

  const diffStaged = shell(["git", "diff", "--staged", "--", ...files]);
  if (diffStaged) {
    sections.push(
      "## Related Staged Changes\n```diff\n" + diffStaged + "\n```\n",
    );
  }

  const diffUnstaged = shell(["git", "diff", "--", ...files]);
  if (diffUnstaged) {
    sections.push(
      "## Related Unstaged Changes\n```diff\n" + diffUnstaged + "\n```\n",
    );
  }

  return sections.join("\n");
}

export function collectFileContents(files: string[]): string {
  if (files.length === 0) return "";

  const sections: string[] = [];
  sections.push("# Current Files\n");

  for (const filePath of files) {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
      sections.push(`## ${filePath}\n> File not found\n`);
      continue;
    }

    const stat = statSync(resolved);
    if (stat.size > 100_000) {
      sections.push(
        `## ${filePath}\n> File too large (${(stat.size / 1024).toFixed(0)} KB), skipped\n`,
      );
      continue;
    }

    try {
      // Skip binary files (null byte heuristic)
      const buffer = readFileSync(resolved);
      if (buffer.includes(0)) {
        sections.push(`## ${filePath}\n> Binary file, skipped\n`);
        continue;
      }
      const content = buffer.toString("utf-8");
      const ext = extname(filePath).slice(1);
      sections.push(`## ${filePath}\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
    } catch {
      sections.push(`## ${filePath}\n> Could not read file\n`);
    }
  }

  return sections.join("\n");
}

export function collectProjectInfo(): string {
  const sections: string[] = [];
  sections.push("# Project Info\n");

  // Detect tech stack and read key project files in one pass
  const stackIndicators: Record<string, { stack: string; read?: boolean }> = {
    "package.json": { stack: "Node.js", read: true },
    Gemfile: { stack: "Ruby", read: true },
    "pyproject.toml": { stack: "Python" },
    "Cargo.toml": { stack: "Rust" },
    "go.mod": { stack: "Go" },
    "composer.json": { stack: "PHP" },
  };

  const detectedStacks: string[] = [];

  for (const [file, { stack, read }] of Object.entries(stackIndicators)) {
    if (!existsSync(file)) continue;
    detectedStacks.push(stack);

    if (!read) continue;
    const content = safeReadFile(file);
    if (!content) continue;

    if (file === "package.json") {
      try {
        const pkg = JSON.parse(content);
        const summary: Record<string, unknown> = {};
        if (pkg.name) summary.name = pkg.name;
        if (pkg.dependencies) summary.dependencies = pkg.dependencies;
        if (pkg.devDependencies) summary.devDependencies = pkg.devDependencies;
        sections.push(
          `## ${file}\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
        );
      } catch {
        // malformed package.json, skip
      }
    } else {
      sections.push(`## ${file}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  if (detectedStacks.length > 0) {
    // Insert tech stack summary after the "# Project Info" header
    sections.splice(1, 0, "## Tech Stack\n" + detectedStacks.join(", ") + "\n");
  }

  const claudeMd = safeReadFile("CLAUDE.md");
  if (claudeMd) {
    sections.push("## CLAUDE.md\n" + claudeMd + "\n");
  }

  return sections.join("\n");
}

export function collect(options: Options): string {
  const parts: string[] = [];

  if (options.gitScope !== "none") {
    const git =
      options.gitScope === "related"
        ? collectRelatedGitInfo(options.files)
        : collectGitInfo();
    if (git) parts.push(git);
  }

  const files = collectFileContents(options.files);
  if (files) parts.push(files);

  if (!options.noProject) {
    const project = collectProjectInfo();
    if (project) parts.push(project);
  }

  return parts.join("\n---\n\n");
}

if (import.meta.main) {
  const options = parseArgs(process.argv);
  const output = collect(options);
  process.stdout.write(output);
}

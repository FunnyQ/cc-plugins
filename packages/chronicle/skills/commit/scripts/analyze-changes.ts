#!/usr/bin/env bun
import { $ } from "bun";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const DEFAULT_PROMPT_PATH = resolve(
  SCRIPT_DIR,
  "../references/commit-template.md",
);
const TEMP_OUTPUT_DIR = "/tmp/chronicle/commit";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type ParsedStatus = {
  path: string;
  oldPath?: string;
  staged: boolean;
  status: FileStatus;
};

type AnalyzedFile = ParsedStatus & {
  diff: string;
  insertions: number;
  deletions: number;
};

type AnalysisResult = {
  files: AnalyzedFile[];
  recentCommits: string[];
};

type Numstat = {
  insertions: number;
  deletions: number;
};

function statusFromCode(code: string): FileStatus | undefined {
  switch (code) {
    case "A":
    case "?":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "M":
      return "modified";
    default:
      return undefined;
  }
}

export function parseStatusLine(line: string): ParsedStatus[] {
  if (line.length < 4) return [];

  const index = line[0];
  const worktree = line[1];
  const rawPath = line.slice(3);
  const [rawOldPath, rawNewPath] = rawPath.split(" -> ");
  const path = unquoteGitPath(rawNewPath ?? rawOldPath);
  const oldPath = rawNewPath ? unquoteGitPath(rawOldPath) : undefined;

  if (index === "?") {
    return [{ path, oldPath, staged: false, status: "added" }];
  }

  const entries: ParsedStatus[] = [];
  const stagedStatus = statusFromCode(index);
  if (stagedStatus) {
    entries.push({ path, oldPath, staged: true, status: stagedStatus });
  }

  const unstagedStatus = statusFromCode(worktree);
  if (unstagedStatus === "modified" || unstagedStatus === "deleted") {
    entries.push({
      path,
      oldPath,
      staged: false,
      status: unstagedStatus,
    });
  }

  return entries;
}

export function unquoteGitPath(rawPath: string): string {
  if (!rawPath.startsWith('"') || !rawPath.endsWith('"')) {
    return rawPath;
  }

  try {
    return JSON.parse(rawPath);
  } catch {
    return rawPath.slice(1, -1);
  }
}

const SKIP_DIFF_PATTERNS: RegExp[] = [
  /\.lock$/,
  /lock\.json$/,
  /lock\.yaml$/,
  /\.lockb$/,
  /yarn\.lock$/,
  /node_modules/,
];

export function shouldSkipDiff(path: string): boolean {
  return SKIP_DIFF_PATTERNS.some((pattern) => pattern.test(path));
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".avif",
  ".svg",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".avi",
  ".mov",
  ".flac",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".sqlite",
  ".db",
  ".lockb",
]);

export function isBinaryFile(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function readChronicleTemplateOverride(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  if (!("skills" in settings)) return undefined;

  const skills = settings.skills;
  if (!skills || typeof skills !== "object" || !("chronicle" in skills)) {
    return undefined;
  }

  const chronicle = skills.chronicle;
  if (!chronicle || typeof chronicle !== "object" || !("commit" in chronicle)) {
    return undefined;
  }

  const commit = chronicle.commit;
  if (!commit || typeof commit !== "object" || !("templatePath" in commit)) {
    return undefined;
  }

  return typeof commit.templatePath === "string"
    ? commit.templatePath
    : undefined;
}

export async function resolvePromptPath(): Promise<string> {
  try {
    const settingsPath = resolve(homedir(), ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const override = readChronicleTemplateOverride(settings);
    return override ? expandHome(override) : DEFAULT_PROMPT_PATH;
  } catch {
    return DEFAULT_PROMPT_PATH;
  }
}

async function gitText(
  args: TemplateStringsArray,
  ...values: unknown[]
): Promise<string> {
  return await $({ raw: args }, ...values).text();
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function parseNumstat(output: string): Numstat {
  const match = /^(\d+|-)\t(\d+|-)/.exec(output.trim());
  if (!match || match[1] === "-" || match[2] === "-") {
    return { insertions: 0, deletions: 0 };
  }

  return {
    insertions: Number(match[1]),
    deletions: Number(match[2]),
  };
}

async function readUntrackedFile(path: string): Promise<AnalyzedFile> {
  const content = await Bun.file(path).text();
  return {
    path,
    staged: false,
    status: "added",
    diff: `+++ new file: ${path}\n${content}`,
    insertions: lineCount(content),
    deletions: 0,
  };
}

function binaryResult(entry: ParsedStatus): AnalyzedFile {
  return {
    ...entry,
    diff: "[binary file - diff skipped]",
    insertions: 0,
    deletions: 0,
  };
}

async function analyzeFile(entry: ParsedStatus): Promise<AnalyzedFile> {
  if (
    entry.status === "added" &&
    !entry.staged &&
    !shouldSkipDiff(entry.path)
  ) {
    if (isBinaryFile(entry.path)) {
      return binaryResult(entry);
    }

    return { ...entry, ...(await readUntrackedFile(entry.path)) };
  }

  if (shouldSkipDiff(entry.path)) {
    const content = await Bun.file(entry.path)
      .text()
      .catch(() => "");
    return {
      ...entry,
      diff: "[lock file - diff skipped]",
      insertions: lineCount(content),
      deletions: 0,
    };
  }

  if (isBinaryFile(entry.path)) {
    return binaryResult(entry);
  }

  const cached = entry.staged ? "--cached" : "";
  const [numstatText, diff] = await Promise.all([
    cached
      ? gitText`git diff --cached --numstat -- ${entry.path}`
      : gitText`git diff --numstat -- ${entry.path}`,
    cached
      ? gitText`git diff --cached -- ${entry.path}`
      : gitText`git diff -- ${entry.path}`,
  ]);
  const stats = parseNumstat(numstatText);

  return { ...entry, ...stats, diff };
}

async function analyzeChanges(): Promise<AnalysisResult> {
  const statusOutput = (await gitText`git status --porcelain -uall`).trimEnd();
  const statusLines = statusOutput ? statusOutput.split("\n") : [];
  const entries = statusLines.flatMap(parseStatusLine);
  const [files, logOutput] = await Promise.all([
    Promise.all(entries.map(analyzeFile)),
    gitText`git log --oneline -10`.catch(() => ""),
  ]);

  return {
    files,
    recentCommits: logOutput.trimEnd() ? logOutput.trimEnd().split("\n") : [],
  };
}

async function main() {
  const [analysis, promptPath] = await Promise.all([
    analyzeChanges(),
    resolvePromptPath(),
  ]);
  await mkdir(TEMP_OUTPUT_DIR, { recursive: true });
  const outputPath = resolve(TEMP_OUTPUT_DIR, `${Date.now()}.json`);
  await Bun.write(outputPath, JSON.stringify(analysis, null, 2));

  console.log(
    JSON.stringify({
      outputPath,
      promptPath,
      totalFiles: analysis.files.length,
    }),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("analyze-changes error:", err.message);
    process.exit(2);
  });
}

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
const MAX_DIFF_LINES = 400;
const MAX_TOTAL_DIFF_LINES = 3000;
const MAX_UNTRACKED_INLINE_BYTES = 256 * 1024;

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
  summary: FileSummary[];
  files: AnalyzedFile[];
  recentCommits: string[];
  elidedFiles: number;
};

type Numstat = {
  insertions: number;
  deletions: number;
};

type FileSummary = ParsedStatus & Numstat;

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
  // A worktree-side "added" with an empty index side is `git add -N`
  // (intent-to-add): a brand-new file, staged only as a placeholder with no
  // content. It has to be reported or the analysis silently loses the file.
  // Guarded on `!stagedStatus` so an unmerged "AA" conflict keeps its single
  // staged entry instead of being reported twice.
  if (unstagedStatus === "added" && !stagedStatus) {
    return [{ path, oldPath, staged: false, status: "added" }];
  }
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

export function parseNumstat(output: string): Numstat {
  const match = /^(\d+|-)\t(\d+|-)/.exec(output.trim());
  if (!match || match[1] === "-" || match[2] === "-") {
    return { insertions: 0, deletions: 0 };
  }

  return {
    insertions: Number(match[1]),
    deletions: Number(match[2]),
  };
}

export function capDiff(
  diff: string,
  stats: Numstat,
  maxLines = MAX_DIFF_LINES,
): string {
  const diffLines = diff.split("\n");
  if (diffLines.length <= maxLines) return diff;

  return [
    ...diffLines.slice(0, maxLines),
    `[diff truncated: ${maxLines} of ${diffLines.length} lines shown; +${stats.insertions}/-${stats.deletions} total]`,
  ].join("\n");
}

function omittedDiff(
  file: AnalyzedFile,
  totalFiles: number,
  maxLines: number,
): string {
  return `[diff omitted: changeset exceeds the ${maxLines}-line aggregate budget; +${file.insertions}/-${file.deletions} in this file — ${totalFiles} files changed]`;
}

/**
 * Per-file capping still lets a wide changeset blow past a usable context, so
 * trim whole diffs — largest first — until the changeset fits. Stats survive,
 * so the reader always keeps the shape of what was dropped.
 */
export function applyTotalDiffBudget<T extends AnalyzedFile>(
  files: T[],
  maxLines = MAX_TOTAL_DIFF_LINES,
): T[] {
  const counts = files.map((file) => lineCount(file.diff));
  let total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= maxLines) return files;

  const biggestFirst = counts
    .map((count, index) => ({ count, index }))
    .sort((a, b) => b.count - a.count);

  const trimmed = new Set<number>();
  for (const { count, index } of biggestFirst) {
    if (total <= maxLines) break;
    trimmed.add(index);
    total =
      total -
      count +
      lineCount(omittedDiff(files[index], files.length, maxLines));
  }

  return files.map((file, index) =>
    trimmed.has(index)
      ? { ...file, diff: omittedDiff(file, files.length, maxLines) }
      : file,
  );
}

/**
 * Lock files never contribute a readable diff, but their stats still tell the
 * story ("deps churned"). An untracked one is wholly new, so its line count IS
 * the insertion count; a tracked one has to come from numstat or we'd report
 * the entire file as added.
 */
async function lockfileStats(entry: ParsedStatus): Promise<Numstat> {
  if (entry.status === "added" && !entry.staged) {
    const content = await Bun.file(entry.path)
      .text()
      .catch(() => "");
    return { insertions: lineCount(content), deletions: 0 };
  }

  const numstat = entry.staged
    ? await gitText`git diff --cached --numstat -- ${entry.path}`
    : await gitText`git diff --numstat -- ${entry.path}`;

  return parseNumstat(numstat);
}

async function readUntrackedFile(path: string): Promise<AnalyzedFile> {
  const file = Bun.file(path);
  const content = await file.text();
  const insertions = lineCount(content);

  if (file.size > MAX_UNTRACKED_INLINE_BYTES) {
    return {
      path,
      staged: false,
      status: "added",
      diff: `+++ new file: ${path}\n[large file - content skipped]`,
      insertions,
      deletions: 0,
    };
  }

  const stats = { insertions, deletions: 0 };
  return {
    path,
    staged: false,
    status: "added",
    ...stats,
    diff: capDiff(`+++ new file: ${path}\n${content}`, stats),
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

export async function analyzeFile(entry: ParsedStatus): Promise<AnalyzedFile> {
  try {
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
      return {
        ...entry,
        diff: "[lock file - diff skipped]",
        ...(await lockfileStats(entry)),
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

    return { ...entry, ...stats, diff: capDiff(diff, stats) };
  } catch {
    return {
      ...entry,
      diff: "[unreadable - skipped]",
      insertions: 0,
      deletions: 0,
    };
  }
}

function summarizeFile(file: AnalyzedFile): FileSummary {
  return {
    path: file.path,
    oldPath: file.oldPath,
    staged: file.staged,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
  };
}

async function analyzeChanges(): Promise<AnalysisResult> {
  // core.quotePath=false: git otherwise octal-escapes every non-ASCII path, and
  // those escapes are not JSON, so unquoteGitPath hands back the escaped string
  // and the path never matches the file it names.
  const statusOutput = (
    await gitText`git -c core.quotePath=false status --porcelain -uall`
  ).trimEnd();
  const statusLines = statusOutput ? statusOutput.split("\n") : [];
  const entries = statusLines.flatMap(parseStatusLine);
  const [analyzed, logOutput] = await Promise.all([
    Promise.all(entries.map(analyzeFile)),
    gitText`git log --oneline -10`.catch(() => ""),
  ]);
  const files = applyTotalDiffBudget(analyzed);
  const elidedFiles = files.filter((file) =>
    file.diff.startsWith("[diff omitted:"),
  ).length;

  return {
    summary: files.map(summarizeFile),
    files,
    recentCommits: logOutput.trimEnd() ? logOutput.trimEnd().split("\n") : [],
    elidedFiles,
  };
}

export type PlanVerification = {
  ok: boolean;
  missing: string[];
  leftover: string[];
};

function normalizePath(path: string): string {
  const unquoted = unquoteGitPath(path.trim());
  return unquoted.startsWith("./") ? unquoted.slice(2) : unquoted;
}

/**
 * A commit run is only trustworthy when the plan and the repository agree, so
 * check both directions. `missing` catches a planned file the commit never
 * picked up; `leftover` catches a changed file the plan never knew about — the
 * failure the reporting agent cannot see, because a file that is absent from
 * the plan is absent from its success report too.
 */
export function verifyPlanLanded(
  planned: string[],
  committed: string[],
  remaining: string[],
): PlanVerification {
  const committedPaths = new Set(committed.map(normalizePath));
  const missing = [...new Set(planned.map(normalizePath))].filter(
    (path) => !committedPaths.has(path),
  );
  const leftover = [...new Set(remaining.map(normalizePath))];

  return {
    ok: missing.length === 0 && leftover.length === 0,
    missing,
    leftover,
  };
}

export async function committedPathsSince(base: string): Promise<string[]> {
  // --no-renames keeps a rename's old path in the list, matching the plan's
  // habit of carrying both oldPath and path for one commit.
  const output = (
    await gitText`git -c core.quotePath=false diff --name-only --no-renames ${base} HEAD`
  ).trimEnd();

  return output ? output.split("\n") : [];
}

export async function remainingPaths(): Promise<string[]> {
  const output = (
    await gitText`git -c core.quotePath=false status --porcelain -uall`
  ).trimEnd();
  if (!output) return [];

  // Read the raw status lines instead of parseStatusLine: a status code the
  // parser does not map would drop out here too, and that silent drop is
  // exactly what this check exists to expose.
  return output.split("\n").map((line) => {
    const rawPath = line.slice(3);
    const [rawOldPath, rawNewPath] = rawPath.split(" -> ");
    return rawNewPath ?? rawOldPath;
  });
}

async function verifyMain(argv: string[]) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex === -1 ? "" : (argv[baseIndex + 1] ?? "");
  const separator = argv.indexOf("--");
  const planned = separator === -1 ? [] : argv.slice(separator + 1);

  if (!base || planned.length === 0) {
    console.error(
      "usage: analyze-changes.ts verify --base <sha> -- <planned file> ...",
    );
    process.exit(2);
  }

  const [committed, remaining] = await Promise.all([
    committedPathsSince(base),
    remainingPaths(),
  ]);
  const verification = verifyPlanLanded(planned, committed, remaining);

  console.log(
    JSON.stringify(
      {
        base,
        plannedFiles: planned.length,
        committedFiles: committed.length,
        ...verification,
      },
      null,
      2,
    ),
  );

  if (!verification.ok) process.exit(3);
}

async function main() {
  const repoRoot = (await gitText`git rev-parse --show-toplevel`).trim();
  if (repoRoot) process.chdir(repoRoot);
  if (process.argv[2] === "verify") return await verifyMain(process.argv);

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
      elidedFiles: analysis.elidedFiles,
    }),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("analyze-changes error:", err.message);
    process.exit(2);
  });
}

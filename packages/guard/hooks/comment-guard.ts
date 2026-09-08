#!/usr/bin/env bun
/**
 * PostToolUse hook: surface newly added comment lines so the model re-judges why vs what.
 *
 * Input (stdin): JSON with tool_name and tool_input.
 * Output: silent unless the edit added comment lines.
 * Exit codes:
 *   0 = ok / skipped file type / no comment added
 *   2 = comments added (PostToolUse exit 2 + stderr surfaces feedback to the LLM)
 *
 * Detects only. The why-vs-what judgement is the model's — this hook never
 * guesses at meaning, it just hands the lines back.
 */

export type ToolInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
};

const SKIP_EXTS = new Set([".md", ".mdx", ".txt", ".json"]);

const MARKERS: Record<string, readonly string[]> = {
  "#": [".rb", ".py", ".sh", ".yaml", ".yml", ".toml"],
  "//": [
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".vue",
    ".go",
    ".rs",
    ".c",
    ".h",
    ".java",
    ".css",
    ".scss",
  ],
  "/*": [
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".vue",
    ".go",
    ".rs",
    ".c",
    ".h",
    ".java",
    ".css",
    ".scss",
  ],
  "--": [".sql", ".lua"],
  "<!--": [".html"],
};

export function markersFor(filePath: string): string[] {
  const dot = filePath.lastIndexOf(".");
  const slash = filePath.lastIndexOf("/");
  const ext = dot > slash ? filePath.slice(dot).toLowerCase() : "";
  if (!ext || SKIP_EXTS.has(ext) || filePath.includes("/docs/")) return [];
  return Object.keys(MARKERS).filter((m) => MARKERS[m]!.includes(ext));
}

function commentLines(text: string, marks: string[]): string[] {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      // Leading marker only. A trailing `#` or `//` is usually inside a string —
      // matching those flags every `url = "http://..."` as a comment.
      .filter((l) => marks.some((m) => l.startsWith(m)))
  );
}

/**
 * Comment lines present in the new text beyond what the old text already had.
 *
 * A multiset difference, not a line diff: we only care about comment lines, and
 * on those the multiset answer is the better one — moving an existing comment
 * is not an addition, while rewording one is a new claim to justify.
 */
export function addedCommentLines(
  toolName: string,
  input: ToolInput,
  marks: string[],
): string[] {
  if (toolName === "Write") return commentLines(input.content ?? "", marks);

  const before = new Map<string, number>();
  for (const line of commentLines(input.old_string ?? "", marks)) {
    before.set(line, (before.get(line) ?? 0) + 1);
  }

  const added: string[] = [];
  for (const line of commentLines(input.new_string ?? "", marks)) {
    const seen = before.get(line) ?? 0;
    if (seen > 0) before.set(line, seen - 1);
    else added.push(line);
  }
  return added;
}

/** Trimmed line text -> queue of 1-based line numbers, for reverse lookup. */
export function lineIndex(fileText: string): Map<string, number[]> {
  const index = new Map<string, number[]>();
  fileText.split("\n").forEach((line, i) => {
    const key = line.trim();
    const queue = index.get(key);
    if (queue) queue.push(i + 1);
    else index.set(key, [i + 1]);
  });
  return index;
}

export function formatReason(
  fileName: string,
  hits: string[],
  index: Map<string, number[]>,
): string {
  const rows = hits.map((line) => {
    // Same text can appear twice; pop so each hit claims its own line number.
    const num = index.get(line)?.shift() ?? "?";
    return `  ${fileName}:${num}  ${line}`;
  });
  return [
    `本次新增 ${hits.length} 行註解，逐行回答：這行說的是 why 還是 what？是 what 就刪掉。`,
    ...rows,
  ].join("\n");
}

async function main(): Promise<number> {
  let payload: { tool_name?: string; tool_input?: ToolInput };
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    return 0;
  }

  const toolName = payload.tool_name ?? "";
  if (toolName !== "Edit" && toolName !== "Write") return 0;

  const input = payload.tool_input ?? {};
  const filePath = input.file_path ?? "";
  if (!filePath) return 0;

  const marks = markersFor(filePath);
  if (marks.length === 0) return 0;

  const hits = addedCommentLines(toolName, input, marks);
  if (hits.length === 0) return 0;

  // PostToolUse runs after the write landed, so the file on disk carries the
  // line numbers that tool_input does not.
  let fileText = "";
  try {
    fileText = await Bun.file(filePath).text();
  } catch {
    // Unreadable file still reports the lines, with `?` for every number.
  }

  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  console.error(formatReason(fileName, hits, lineIndex(fileText)));
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}

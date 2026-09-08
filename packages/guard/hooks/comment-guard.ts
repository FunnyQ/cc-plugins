#!/usr/bin/env bun
/**
 * PostToolUse hook: surface the comment blocks an edit added or grew, so the
 * model re-judges why vs what.
 *
 * Input (stdin): JSON with tool_name and tool_input.
 * Output: silent unless a reportable block exists.
 * Exit codes:
 *   0 = ok / skipped file type / nothing to report
 *   2 = block reported (PostToolUse exit 2 + stderr surfaces feedback to the LLM)
 *
 * Detects only. The why-vs-what judgement is the model's — this hook never
 * guesses at meaning, it just hands the lines back.
 *
 * A block reports when it runs MIN_BLOCK_LINES or longer AND this edit put at
 * least one line in it. One- and two-line comments never fire: measured over
 * this repo, that silences 68% of blocks, which is what keeps the hook quiet
 * enough to leave switched on. The file-header block is exempt — it documents
 * the module, which is the one place prose is the point.
 */

export type ToolInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
};

/** A contiguous run of comment lines, with the ones this edit added marked. */
export type CommentBlock = {
  start: number;
  lines: string[];
  added: boolean[];
};

const MIN_BLOCK_LINES = 3;

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

/**
 * Comment-or-not for each trimmed line.
 *
 * Stateful across `/* ... *\/` so a docblock counts its full height rather than
 * just the opening line. Tracking the open block is what lets `*` continuations
 * count without becoming a marker of their own — as a marker it would read
 * `*ptr = 0` and a wrapped multiplication as comments.
 */
export function commentFlags(lines: string[], marks: string[]): boolean[] {
  const hasBlockMarker = marks.includes("/*");
  const flags: boolean[] = [];
  let open = false;

  for (const line of lines) {
    if (open) {
      flags.push(true);
      if (line.includes("*/")) open = false;
      continue;
    }
    // Leading marker only. A trailing `#` or `//` is usually inside a string —
    // matching those flags every `url = "http://..."` as a comment.
    const starts = marks.some((m) => line.startsWith(m));
    flags.push(starts);
    if (
      starts &&
      hasBlockMarker &&
      line.startsWith("/*") &&
      !line.includes("*/")
    )
      open = true;
  }
  return flags;
}

function commentLines(text: string, marks: string[]): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  return lines.filter((_, i) => commentFlags(lines, marks)[i]);
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

/**
 * The blocks worth reporting, read off the file on disk.
 *
 * Blocks come from disk rather than from `new_string` because an Edit fragment
 * truncates any block that continues past its edges, which would both mis-size
 * the run and hide whether it sits at the top of the file.
 */
export function flaggedBlocks(
  fileText: string,
  marks: string[],
  added: string[],
): CommentBlock[] {
  const lines = fileText.split("\n").map((l) => l.trim());
  const flags = commentFlags(lines, marks);

  const pending = new Map<string, number>();
  for (const line of added) pending.set(line, (pending.get(line) ?? 0) + 1);

  const blocks: CommentBlock[] = [];
  let sawCode = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!flags[i]) {
      if (line !== "" && !line.startsWith("#!")) sawCode = true;
      i++;
      continue;
    }

    const header = !sawCode;
    const start = i + 1;
    const body: string[] = [];
    const marked: boolean[] = [];

    while (i < lines.length && flags[i]) {
      const text = lines[i]!;
      const left = pending.get(text) ?? 0;
      // Consume in file order so each added occurrence claims one line, and so a
      // hit landing in an exempt or short block still spends itself.
      if (left > 0) pending.set(text, left - 1);
      body.push(text);
      marked.push(left > 0);
      i++;
    }

    if (!header && body.length >= MIN_BLOCK_LINES && marked.some(Boolean)) {
      blocks.push({ start, lines: body, added: marked });
    }
  }
  return blocks;
}

export function formatReason(fileName: string, blocks: CommentBlock[]): string {
  const total = blocks.reduce((n, b) => n + b.lines.length, 0);
  const out = [
    `comment-guard: ${blocks.length} comment block(s), ${total} lines, in ${fileName}.`,
    `Answer for every line marked +: does it say why, or what? Delete the ones that say what.`,
  ];

  for (const block of blocks) {
    const end = block.start + block.lines.length - 1;
    out.push(`  ${fileName}:${block.start}-${end}`);
    block.lines.forEach((line, k) => {
      out.push(`  ${block.added[k] ? "+" : " "} ${block.start + k}  ${line}`);
    });
  }
  return out.join("\n");
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

  const added = addedCommentLines(toolName, input, marks);
  if (added.length === 0) return 0;

  // PostToolUse runs after the write landed, so the file on disk is the shape
  // being judged. Without it there is no block sizing worth reporting.
  let fileText: string;
  try {
    fileText = await Bun.file(filePath).text();
  } catch {
    return 0;
  }

  const blocks = flaggedBlocks(fileText, marks, added);
  if (blocks.length === 0) return 0;

  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  console.error(formatReason(fileName, blocks));
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}

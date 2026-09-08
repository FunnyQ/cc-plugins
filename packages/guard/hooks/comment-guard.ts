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

/** A language's comment forms: line markers, plus open/close block pairs. */
export type Syntax = {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
};

/** A contiguous run of comment lines, with the ones this edit added marked. */
export type CommentBlock = {
  start: number;
  lines: string[];
  added: boolean[];
};

const MIN_BLOCK_LINES = 3;

const SKIP_EXTS = new Set([".md", ".mdx", ".txt", ".json"]);

const HASH: Syntax = { line: ["#"], block: [] };
const C: Syntax = { line: ["//"], block: [["/*", "*/"]] };
const CSS: Syntax = { line: [], block: [["/*", "*/"]] };
const MARKUP: Syntax = { line: [], block: [["<!--", "-->"]] };
const PHP: Syntax = { line: ["//", "#"], block: [["/*", "*/"]] };
const SQL: Syntax = { line: ["--"], block: [["/*", "*/"]] };
const LUA: Syntax = { line: ["--"], block: [["--[[", "]]"]] };
const HASKELL: Syntax = { line: ["--"], block: [["{-", "-}"]] };
const ERB: Syntax = { line: ["<%#"], block: [["<!--", "-->"]] };
// Haml and Slim open an HTML comment with a bare `/`, and Haml a silent one
// with `-#`. Both are indentation-scoped, so only the opening line is seen.
const INDENTED: Syntax = { line: ["-#", "/"], block: [] };
// A single-file component mixes a markup template with a script and a style
// block, so it needs every form its three sections can carry.
const COMPONENT: Syntax = {
  line: ["//"],
  block: [
    ["/*", "*/"],
    ["<!--", "-->"],
  ],
};

const BY_EXT: Record<string, Syntax> = {
  ".rb": HASH,
  ".rake": HASH,
  ".gemspec": HASH,
  ".py": HASH,
  ".sh": HASH,
  ".bash": HASH,
  ".zsh": HASH,
  ".fish": HASH,
  ".yaml": HASH,
  ".yml": HASH,
  ".toml": HASH,
  ".ex": HASH,
  ".exs": HASH,
  ".pl": HASH,
  ".pm": HASH,
  ".r": HASH,
  ".env": HASH,
  ".ini": HASH,
  ".conf": HASH,
  ".properties": HASH,
  ".graphql": HASH,
  ".gql": HASH,
  ".tf": HASH,
  ".hcl": HASH,

  ".js": C,
  ".mjs": C,
  ".cjs": C,
  ".jsx": C,
  ".ts": C,
  ".mts": C,
  ".cts": C,
  ".tsx": C,
  ".jsonc": C,
  ".json5": C,
  ".go": C,
  ".rs": C,
  ".c": C,
  ".h": C,
  ".cpp": C,
  ".cc": C,
  ".cxx": C,
  ".hpp": C,
  ".hh": C,
  ".hxx": C,
  ".m": C,
  ".mm": C,
  ".cs": C,
  ".java": C,
  ".kt": C,
  ".kts": C,
  ".scala": C,
  ".swift": C,
  ".dart": C,
  ".zig": C,
  ".proto": C,
  ".scss": C,
  ".sass": C,
  ".less": C,
  ".styl": C,

  ".css": CSS,
  ".html": MARKUP,
  ".htm": MARKUP,
  ".xml": MARKUP,
  ".svg": MARKUP,

  ".vue": COMPONENT,
  ".svelte": COMPONENT,
  ".astro": COMPONENT,

  ".erb": ERB,
  ".haml": INDENTED,
  ".slim": INDENTED,
  ".php": PHP,
  ".sql": SQL,
  ".lua": LUA,
  ".hs": HASKELL,
};

/** Build files carry no extension, so they are matched on the name instead. */
const BY_NAME: Record<string, Syntax> = {
  rakefile: HASH,
  gemfile: HASH,
  guardfile: HASH,
  capfile: HASH,
  brewfile: HASH,
  procfile: HASH,
  makefile: HASH,
  dockerfile: HASH,
  justfile: HASH,
};

export function syntaxFor(filePath: string): Syntax | null {
  if (filePath.includes("/docs/")) return null;

  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  if (SKIP_EXTS.has(ext)) return null;
  if (ext && BY_EXT[ext]) return BY_EXT[ext]!;

  // `Dockerfile.dev` is still a Dockerfile, so the stem gets a second look.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return BY_NAME[base.toLowerCase()] ?? BY_NAME[stem.toLowerCase()] ?? null;
}

/**
 * Comment-or-not for each trimmed line.
 *
 * Stateful across every open/close pair the language has, so a docblock, an
 * HTML comment and a Lua long comment all count their full height rather than
 * just the opening line. Tracking the open pair is also what lets a `*`
 * continuation count without becoming a marker of its own — as a marker it
 * would read `*ptr = 0` and a wrapped multiplication as comments.
 *
 * Block openers are tested before line markers because several overlap: Lua's
 * `--[[` also starts with its line marker `--`.
 */
export function commentFlags(lines: string[], syntax: Syntax): boolean[] {
  const flags: boolean[] = [];
  let closer: string | null = null;

  for (const line of lines) {
    if (closer !== null) {
      flags.push(true);
      if (line.includes(closer)) closer = null;
      continue;
    }

    const pair = syntax.block.find(([open]) => line.startsWith(open));
    if (pair) {
      flags.push(true);
      if (!line.slice(pair[0].length).includes(pair[1])) closer = pair[1];
      continue;
    }

    // Leading marker only. A trailing `#` or `//` is usually inside a string —
    // matching those flags every `url = "http://..."` as a comment.
    flags.push(syntax.line.some((m) => line.startsWith(m)));
  }
  return flags;
}

function commentLines(text: string, syntax: Syntax): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const flags = commentFlags(lines, syntax);
  return lines.filter((_, i) => flags[i]);
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
  syntax: Syntax,
): string[] {
  if (toolName === "Write") return commentLines(input.content ?? "", syntax);

  const before = new Map<string, number>();
  for (const line of commentLines(input.old_string ?? "", syntax)) {
    before.set(line, (before.get(line) ?? 0) + 1);
  }

  const added: string[] = [];
  for (const line of commentLines(input.new_string ?? "", syntax)) {
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
  syntax: Syntax,
  added: string[],
): CommentBlock[] {
  const lines = fileText.split("\n").map((l) => l.trim());
  const flags = commentFlags(lines, syntax);

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

  const syntax = syntaxFor(filePath);
  if (!syntax) return 0;

  const added = addedCommentLines(toolName, input, syntax);
  if (added.length === 0) return 0;

  // PostToolUse runs after the write landed, so the file on disk is the shape
  // being judged. Without it there is no block sizing worth reporting.
  let fileText: string;
  try {
    fileText = await Bun.file(filePath).text();
  } catch {
    return 0;
  }

  const blocks = flaggedBlocks(fileText, syntax, added);
  if (blocks.length === 0) return 0;

  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  console.error(formatReason(fileName, blocks));
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}

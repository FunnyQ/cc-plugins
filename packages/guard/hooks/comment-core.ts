/**
 * The Node-free half of comment-guard: syntax tables, block scan, diff
 * resolution and the report text. The Claude Code mod imports it, and a mod
 * runs with no Node, so nothing here may import a `node:` module.
 */

// node:path is out of a mod's reach; these copy its posix answers, pinned by a test against it.
export function baseName(filePath: string): string {
  return filePath.replace(/\/+$/, "").split("/").pop() ?? "";
}

export function extName(filePath: string): string {
  const name = baseName(filePath);
  const dot = name.lastIndexOf(".");
  return dot <= 0 || name === ".." ? "" : name.slice(dot);
}

export type ToolInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
};

/** One unified-diff hunk as Claude Code reports it on `tool_response`. */
export type Hunk = {
  newStart?: number;
  lines?: string[];
};

export type ToolResponse = {
  type?: string;
  structuredPatch?: Hunk[];
  /** Claude Code held the edit for review: the file on disk is unchanged. */
  staged?: boolean;
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
  /** Comment lines, not counting blanks bridged in from between paragraphs. */
  height: number;
};

const MIN_BLOCK_LINES = 3;

const SKIP_EXTS = new Set([".md", ".mdx", ".txt", ".json"]);

// Third-party and generated trees. Their comments are someone else's to justify.
const SKIP_SEGMENTS = new Set(["docs", "vendor", "node_modules"]);

const HASH: Syntax = { line: ["#"], block: [] };
const C: Syntax = { line: ["//"], block: [["/*", "*/"]] };
const CSS: Syntax = { line: [], block: [["/*", "*/"]] };
const MARKUP: Syntax = { line: [], block: [["<!--", "-->"]] };
const PHP: Syntax = { line: ["//", "#"], block: [["/*", "*/"]] };
const SQL: Syntax = { line: ["--"], block: [["/*", "*/"]] };
const LUA: Syntax = { line: ["--"], block: [["--[[", "]]"]] };
const HASKELL: Syntax = { line: ["--"], block: [["{-", "-}"]] };
const ERB: Syntax = {
  line: [],
  block: [
    ["<%#", "%>"],
    ["<!--", "-->"],
  ],
};
// Haml/Slim scope by indentation and the scan sees trimmed lines, so a multi-line `-#` block reports as one and never reaches MIN_BLOCK_LINES.
const HAML: Syntax = { line: ["-#", "/"], block: [["<!--", "-->"]] };
// A single-file component mixes a markup template with a script and a style
// block, so it needs every form its three sections can carry.
const COMPONENT: Syntax = {
  line: ["//"],
  block: [
    ["/*", "*/"],
    ["<!--", "-->"],
  ],
};

export const BY_EXT: Record<string, Syntax> = {
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
  ".haml": HAML,
  ".slim": HAML,
  ".php": PHP,
  ".sql": SQL,
  ".lua": LUA,
  ".hs": HASKELL,
};

/** Build files carry no extension, so they are matched on the name instead. */
export const BY_NAME: Record<string, Syntax> = {
  ".env": HASH,
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

// Policy, not lookup: `COMMENT_GUARDED` in opencode/plugin.ts mirrors syntaxFor's half alone, so folding these checks in would leave it compared against a set it cannot encode.
export function isGuardedPath(filePath: string): boolean {
  if (/\.min\.(js|css)$/.test(filePath)) return false;
  // Segments, not a substring: a relative `docs/gen.py` has no leading slash.
  if (filePath.split("/").some((part) => SKIP_SEGMENTS.has(part))) return false;
  return !SKIP_EXTS.has(extName(filePath));
}

export function syntaxFor(filePath: string): Syntax | null {
  const ext = extName(filePath).toLowerCase();
  const known = BY_EXT[ext];
  if (known) return known;

  // `Dockerfile.DEV` is still a Dockerfile, and basename's own suffix match is case-sensitive, so both halves are lowered before the extension comes off.
  const name = baseName(filePath).toLowerCase();
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  return BY_NAME[stem] ?? null;
}

/**
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
 * A `-` line consumes no line in the new file, so only context and additions
 * advance the counter. `\ No newline at end of file` is a diff annotation
 * rather than a line and is skipped the same way. Text is trimmed on both
 * sides, because the block scan compares trimmed lines too.
 */
export function patchLines(patch: Hunk[]): {
  added: { n: number; text: string }[];
  removed: string[];
} {
  const added: { n: number; text: string }[] = [];
  const removed: string[] = [];
  for (const hunk of patch) {
    let n = hunk.newStart ?? 1;
    for (const line of hunk.lines ?? []) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-")) {
        removed.push(line.slice(1).trim());
        continue;
      }
      if (line.startsWith("+")) added.push({ n, text: line.slice(1).trim() });
      n++;
    }
  }
  return { added, removed };
}

/**
 * A line the diff also removed is not new — re-indenting a block, or moving one
 * between two points of the same edit, rewrites every line it touches and would
 * otherwise re-ask for a comment nobody wrote. Subtracting the removed texts as
 * a multiset is what keeps the diff path agreeing with `addedCommentLines`:
 * moving a comment is not an addition, rewording one is.
 *
 * A formatter running as a second PostToolUse hook rewrites the file in
 * parallel with this one, and every line the diff named then shifts — marks
 * land on the wrong lines, or the block falls silent because they land on code.
 * Text is the weaker answer but it cannot be shifted, so a lost race degrades
 * instead of lying.
 */
export function resolveAdded(
  patch: Hunk[],
  lines: string[],
): Set<number> | string[] {
  const { added, removed } = patchLines(patch);

  const pool = new Map<string, number>();
  for (const text of removed) pool.set(text, (pool.get(text) ?? 0) + 1);

  const net = added.filter(({ text }) => {
    const left = pool.get(text) ?? 0;
    if (left === 0) return true;
    pool.set(text, left - 1);
    return false;
  });

  const intact = net.every((a) => lines[a.n - 1] === a.text);
  return intact ? new Set(net.map((a) => a.n)) : net.map((a) => a.text);
}

/**
 * Blocks come from disk rather than from `new_string` because an Edit fragment
 * truncates any block that continues past its edges, which would both mis-size
 * the run and hide whether it sits at the top of the file.
 *
 * `added` is line numbers when the harness handed us a diff, and comment text
 * otherwise. Text is the weaker answer — an added line whose wording repeats an
 * untouched one marks whichever comes first in the file — so it is the fallback
 * for harnesses that report no diff, not the preferred path.
 */
export function flaggedBlocks(
  fileText: string,
  syntax: Syntax,
  added: string[] | Set<number>,
): CommentBlock[] {
  const lines = fileText.split("\n").map((l) => l.trim());
  const flags = commentFlags(lines, syntax);

  const byNumber = added instanceof Set ? added : null;
  const pending = new Map<string, number>();
  if (!(added instanceof Set)) {
    for (const line of added) pending.set(line, (pending.get(line) ?? 0) + 1);
  }

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
    let bridged = 0;

    while (i < lines.length) {
      if (!flags[i]) {
        // One blank keeps the run open so a paragraph break cannot split a block below the threshold; two blanks read as a real separation.
        if (lines[i] !== "" || !flags[i + 1]) break;
        body.push("");
        marked.push(false);
        bridged++;
        i++;
        continue;
      }

      const text = lines[i]!;
      let hit: boolean;
      if (byNumber) {
        hit = byNumber.has(i + 1);
      } else {
        const left = pending.get(text) ?? 0;
        // Consume in file order so each added occurrence claims one line, and so a
        // hit landing in an exempt or short block still spends itself.
        if (left > 0) pending.set(text, left - 1);
        hit = left > 0;
      }
      body.push(text);
      marked.push(hit);
      i++;
    }

    // Counted, not filtered on empty text: a blank line inside a `/* */` is a comment line and still counts, while a bridged one is not and does not.
    const height = body.length - bridged;
    if (!header && height >= MIN_BLOCK_LINES && marked.some(Boolean)) {
      blocks.push({ start, lines: body, added: marked, height });
    }
  }
  return blocks;
}

// The read is injected rather than done up front so a skipped edit never touches the disk.
export async function blocksFor(
  toolName: string,
  input: ToolInput,
  response: ToolResponse,
  read: (filePath: string) => Promise<string>,
): Promise<{ blocks: CommentBlock[]; asked: string[] }> {
  const none = { blocks: [], asked: [] };
  const filePath = input.file_path ?? "";
  if (!filePath || !isGuardedPath(filePath)) return none;
  const syntax = syntaxFor(filePath);
  if (!syntax) return none;

  if (response.staged) return none;
  const patch = response.structuredPatch;
  // A Write that creates a file reports no hunks at all (78 of 78 measured), so
  // an empty patch means "nothing changed" only when the file already existed.
  if (response.type === "update" && patch?.length === 0) return none;

  // PostToolUse runs after the write landed, so the file on disk is the shape
  // being judged. Without it there is no block sizing worth reporting.
  let fileText: string;
  try {
    fileText = await read(filePath);
  } catch {
    return none;
  }

  // Live on both harnesses, not dead code: a create Write sends an empty patch, and OpenCode's `commentPayload` sends none at all.
  const added = patch?.length
    ? resolveAdded(
        patch,
        fileText.split("\n").map((l) => l.trim()),
      )
    : addedCommentLines(toolName, input, syntax);

  const blocks = flaggedBlocks(fileText, syntax, added);
  const asked = blocks.flatMap((b) => b.lines.filter((_, k) => b.added[k]));
  return { blocks, asked };
}

// Kept out of formatReason so the sweep asks once however many files it reports.
export const ASK =
  "Answer for every line marked +: does it say why, or what? Delete the ones that say what.";

export function formatReason(
  fileName: string,
  blocks: CommentBlock[],
  label = "💬 comment-guard",
): string {
  const total = blocks.reduce((n, b) => n + b.height, 0);
  const out = [
    `${label}: ${blocks.length} comment block(s), ${total} lines, in ${fileName}.`,
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

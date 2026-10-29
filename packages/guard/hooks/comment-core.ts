/**
 * The Node-free half of comment-guard: syntax tables, block scan, diff
 * resolution and the report text. The Claude Code mod imports it, and a mod
 * runs with no Node, so nothing here may import a `node:` module.
 */

// node:path is out of a mod's reach; accept both path separators here.
export function baseName(filePath: string): string {
  return filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
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

export type Syntax = {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
};

export type Tag = "suppression" | "constraint";

export type CommentBlock = {
  start: number;
  lines: string[];
  added: boolean[];
  height: number;
  tags: (Tag | null)[];
};

const MIN_BLOCK_LINES = 3;

const SUPPRESSION =
  /(?:\/\/|\/\*|#|--)\s*(?:eslint-disable|@ts-(?:ignore|expect-error|nocheck)|biome-ignore|oxlint-disable|deno-lint-ignore|stylelint-disable|noqa|type:\s*ignore|pyright:\s*ignore|pylint:\s*disable|rubocop:disable|standard:disable|nolint|NOLINT|shellcheck\s+disable|swiftlint:disable|istanbul\s+ignore|c8\s+ignore|pragma:\s*no\s+cover)/g;

const SHOUTED = /\b(?:IMPORTANT|DO NOT)\b/g;
const CONSTRAINT =
  /\b(?:do not|don't) (?:remove|delete|change|edit|modify|touch|move|rename|reorder)\b|\b(?:talk to|check with) \S+(?: \S+)? before\b/gi;

function unquoted(line: string, pattern: RegExp): boolean {
  for (const m of line.matchAll(pattern)) {
    const before = line.slice(0, m.index).replace(/\w'\w/g, "");
    const open = ['"', "'", "`"].some((q) => before.split(q).length % 2 === 0);
    if (!open) return true;
  }
  return false;
}

const isSuppression = (line: string) => unquoted(line, SUPPRESSION);

function tagFor(line: string, comment: boolean): Tag | null {
  if (isSuppression(line)) return "suppression";
  return comment && (unquoted(line, SHOUTED) || unquoted(line, CONSTRAINT))
    ? "constraint"
    : null;
}

const SKIP_EXTS = new Set([".md", ".mdx", ".txt", ".json"]);

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
const HAML: Syntax = { line: ["-#", "/"], block: [["<!--", "-->"]] };
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

export function isGuardedPath(filePath: string): boolean {
  if (/\.min\.(js|css)$/.test(filePath)) return false;
  if (filePath.split(/[\\/]/).some((part) => SKIP_SEGMENTS.has(part)))
    return false;
  return !SKIP_EXTS.has(extName(filePath));
}

export function syntaxFor(filePath: string): Syntax | null {
  const ext = extName(filePath).toLowerCase();
  const known = BY_EXT[ext];
  if (known) return known;

  const name = baseName(filePath).toLowerCase();
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  return BY_NAME[stem] ?? null;
}

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

    flags.push(syntax.line.some((m) => line.startsWith(m)));
  }
  return flags;
}

function commentLines(text: string, syntax: Syntax): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const flags = commentFlags(lines, syntax);
  return lines.filter((l, i) => flags[i] || isSuppression(l));
}

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
  { every = false }: { every?: boolean } = {},
): CommentBlock[] {
  const lines = fileText.split("\n").map((l) => l.trim());
  const flags = commentFlags(lines, syntax);

  const byNumber = added instanceof Set ? added : null;
  const pending = new Map<string, number>();
  if (!(added instanceof Set)) {
    for (const line of added) pending.set(line, (pending.get(line) ?? 0) + 1);
  }
  const claim = (i: number): boolean => {
    if (byNumber) return byNumber.has(i + 1);
    const left = pending.get(lines[i]!) ?? 0;
    if (left > 0) pending.set(lines[i]!, left - 1);
    return left > 0;
  };

  const blocks: CommentBlock[] = [];
  let sawCode = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!flags[i]) {
      if (line !== "" && !line.startsWith("#!")) sawCode = true;
      if (isSuppression(line) && claim(i)) {
        blocks.push({
          start: i + 1,
          lines: [line],
          added: [true],
          height: 1,
          tags: ["suppression"],
        });
      }
      i++;
      continue;
    }

    const header = !sawCode;
    const start = i + 1;
    const body: string[] = [];
    const marked: boolean[] = [];
    const tags: (Tag | null)[] = [];
    let bridged = 0;

    while (i < lines.length) {
      if (!flags[i]) {
        if (lines[i] !== "" || !flags[i + 1]) break;
        body.push("");
        marked.push(false);
        tags.push(null);
        bridged++;
        i++;
        continue;
      }

      const text = lines[i]!;
      const hit = claim(i);
      body.push(text);
      marked.push(hit);
      tags.push(hit ? tagFor(text, true) : null);
      i++;
    }

    const height = body.length - bridged;
    const sized =
      (every || (!header && height >= MIN_BLOCK_LINES)) && marked.some(Boolean);
    if (sized || tags.some(Boolean)) {
      blocks.push({ start, lines: body, added: marked, height, tags });
    }
  }
  return blocks;
}

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
  if (response.type === "update" && patch?.length === 0) return none;

  // PostToolUse runs after the write landed, so the file on disk is the shape
  // being judged. Without it there is no block sizing worth reporting.
  let fileText: string;
  try {
    fileText = await read(filePath);
  } catch {
    return none;
  }

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

export const ASK =
  "Answer for every line marked +: does it say why, or what? Delete the ones that say what. " +
  "A why that excuses a workaround or surprise in our own code is a refactor, not a comment: rename, extract, or type the code until the why is obvious, then delete it. " +
  "Keep a why only when it names something we cannot change: a dependency, platform, vendor, or protocol.";

const TAG_ASK: Record<Tag, string> = {
  suppression:
    "For a line tagged [suppression]: look up the rule it silences. If the rule catches real bugs or guards correctness or safety, delete the suppression and fix the code it hid. Keep it only for a style-only or faulty rule.",
  constraint:
    "For a line tagged [constraint]: a comment enforces nothing. If the code you are already changing can carry the rule as a test, type, runtime check, or lint, encode it and delete the comment. Otherwise tell the user which check would enforce it.",
};

export function askFor(blocks: CommentBlock[]): string {
  const present = new Set(blocks.flatMap((b) => b.tags));
  const extra = (Object.keys(TAG_ASK) as Tag[]).filter((t) => present.has(t));
  return [ASK, ...extra.map((t) => TAG_ASK[t])].join("\n");
}

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
      const tag = block.tags[k] ? `  [${block.tags[k]}]` : "";
      out.push(
        `  ${block.added[k] ? "+" : " "} ${block.start + k}  ${line}${tag}`,
      );
    });
  }
  return out.join("\n");
}

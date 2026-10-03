import { tokenize } from "./shell";

// chroma's lexer names, which glow reads off a fence
const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  rb: "ruby",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  vue: "vue",
  sql: "sql",
  swift: "swift",
  lua: "lua",
  md: "markdown",
};

export const languageOf = (path: string): string | undefined =>
  BY_EXT[path.split(".").pop()!.toLowerCase()];

const READERS = new Set(["cat", "head", "tail", "bat", "sed"]);

// glow only helps output whose language is known: raw text through it turns `#` lines into headings and `-` lines into bullets
export const language = (
  command: string,
  stdout: string,
): string | undefined => {
  const out = stdout.trim();
  if (/^[[{]/.test(out)) {
    try {
      JSON.parse(out);
      return "json";
    } catch {}
  }
  if (/^(diff --git |--- a\/|@@ )/.test(out)) return "diff";

  const tokens = tokenize(command.trim()).filter((t) => t.kind !== "space");
  if (tokens.some((t) => t.kind === "op")) return undefined;
  const [head, ...rest] = tokens;
  if (head?.kind !== "cmd" || !READERS.has(head.text)) return undefined;
  if (head.text === "sed" && !rest.some((t) => t.text === "-n"))
    return undefined;
  // a count like `head -n 5` is a bare word too, so a file is a word with an extension
  const files = rest.filter((t) => t.kind === "text" && /\.\w+$/.test(t.text));
  if (files.length !== 1) return undefined;
  return languageOf(files[0]!.text);
};

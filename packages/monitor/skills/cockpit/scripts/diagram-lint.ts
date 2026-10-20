import { SEMANTIC_NODES } from "../dashboard/dist/modules/diagram.js";
import { detectType, parse } from "../dashboard/dist/vendor/pele.js";

const VALID_CLASSES = new Set(Object.keys(SEMANTIC_NODES));

function firstMeaningfulLine(src: string): string | null {
  const lines = src.split("\n");
  let i = 0;
  if (lines[i]?.trim() === "---") {
    i++;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++; // past the closing ---
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith("%%")) return t;
  }
  return null;
}

function bracketProblem(src: string): string | null {
  const stripped = src
    .replace(/`[^`]*`/g, "") // markdown-string labels
    .replace(/"[^"]*"/g, "") // quoted labels
    .replace(/%%[^\n]*/g, "") // comments / init directives
    .replace(/-{1,2}\)/g, ""); // sequence async arrows `-)` / `--)`
  const openerFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (const ch of stripped) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch in openerFor) {
      if (stack.pop() !== openerFor[ch])
        return `unbalanced brackets — stray "${ch}"`;
    }
  }
  if (stack.length)
    return `unbalanced brackets — unclosed "${stack[stack.length - 1]}"`;
  return null;
}

function heuristicProblems(src: string, typeWord: string): string[] {
  const problems: string[] = [];

  if (typeWord !== "mindmap") {
    const bracket = bracketProblem(src);
    if (bracket) problems.push(bracket);
  }

  for (const m of src.matchAll(/\[([^\[\]\n]*)\]/g)) {
    const c = m[1];
    if (c.startsWith('"') && c.endsWith('"')) continue;
    if (c.startsWith("(") && c.endsWith(")")) continue;
    // `[/` and `[\` open the parallelogram/trapezoid shapes, which MUST close
    // with a matching `/]` or `\]`. A label that only *starts* with a slash —
    // e.g. a slash-command like [/release] — is read as an unterminated shape
    // and fails the whole parse. Quoting opts out of shape parsing entirely.
    // Balanced shapes ([/…/], [/…\], [\…/], [\…\]) end with a slash → skip.
    if (
      (c.startsWith("/") || c.startsWith("\\")) &&
      !(c.endsWith("/") || c.endsWith("\\"))
    ) {
      problems.push(
        `node label [${c}] opens a parallelogram/trapezoid ("[${c[0]}") that never closes — wrap the label in quotes: ["${c}"]`,
      );
      continue;
    }
    if (/[()]/.test(c)) {
      problems.push(
        `unquoted "(" or ")" in node label [${c}] — wrap the label in quotes: ["${c}"]`,
      );
    }
  }

  return problems;
}

function parseProblem(src: string): string | null {
  try {
    parse(src);
    return null;
  } catch (e) {
    const msg = (e as Error)?.message?.trim();
    return msg
      ? `mermaid parse error — ${msg}`
      : "mermaid rejected this source";
  }
}

export async function lintDiagram(src: string): Promise<string[]> {
  const problems: string[] = [];
  if (!src.trim()) return ["empty diagram source"];

  const first = firstMeaningfulLine(src);
  const typeWord = first?.split(/\s/)[0] ?? "";
  if (!first || !detectType(src)) {
    return [
      `first line "${first ?? ""}" is not a Mermaid diagram type — start with e.g. "flowchart TD", "stateDiagram-v2", "sequenceDiagram"`,
    ];
  }

  for (const m of src.matchAll(/:::([\w-]+)/g)) {
    if (!VALID_CLASSES.has(m[1])) {
      problems.push(
        `unknown node class ":::${m[1]}" — the palette defines: ${[...VALID_CLASSES].join(", ")}`,
      );
    }
  }

  const parsed = parseProblem(src);
  if (parsed !== null) {
    problems.push(parsed, ...heuristicProblems(src, typeWord));
  }

  return problems;
}

// CLI entry for the Rust `cockpit log|scribe --diagram` gate: source on stdin,
// problems as a JSON array on stdout.
if (import.meta.main) {
  const problems = await lintDiagram(await Bun.stdin.text());
  process.stdout.write(JSON.stringify(problems) + "\n");
}

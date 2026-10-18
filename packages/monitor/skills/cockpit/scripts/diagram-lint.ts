// Write-time lint for `--diagram` Mermaid source. A parse failure normally
// surfaces where the agent can't see it — in the dashboard, where the card
// silently degrades to raw source. This lint closes that feedback loop at the
// CLI instead, so `cockpit log`/`scribe` exit non-zero with a fix hint and the
// author corrects the source and re-runs.
//
// The check that matters is the renderer's *own* parser: the dashboard draws
// with the vendored pele bundle, which needs no DOM, so the lint imports the
// same file and the CLI's verdict is the renderer's verdict. Heuristics can only
// approximate it — the dotted-arrow label `-.a.b.->` is a real case that slipped
// past them and rendered as raw source.
//
// Two things the parser can't do, so they stay hand-rolled:
//   - `:::class` validation — pele happily accepts an unknown class name;
//     the dashboard's CSS silently ignores it.
//   - fix hints — the parser reports *where*, the label heuristics report *how
//     to fix*. They only run once the parser has already failed, so a misfire
//     can never block a legitimate write on its own.
import { SEMANTIC_NODES } from "../dashboard/dist/modules/diagram.js";
import { detectType, parse } from "../dashboard/dist/vendor/pele.js";

const VALID_CLASSES = new Set(Object.keys(SEMANTIC_NODES));

// First line that isn't blank, a `%%` comment/directive, or inside a
// `---` YAML frontmatter block.
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

// The old rule set, now demoted to the fix-hint layer once the real parser has
// already failed. Every
// rule here targets a known parse killer and is conservative — when in doubt it
// stays quiet.
function heuristicProblems(src: string, typeWord: string): string[] {
  const problems: string[] = [];

  // Mindmap node shapes ()cloud( / ))bang(( ) are legitimately unbalanced.
  if (typeWord !== "mindmap") {
    const bracket = bracketProblem(src);
    if (bracket) problems.push(bracket);
  }

  // Unquoted () inside a [...] node label is the classic Mermaid parse killer.
  // Allowed: fully-quoted labels ["…"] and the cylinder shape [(…)].
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

// null = parses clean · string = the parser's own message (carries the line
// number).
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

// Lint Mermaid source. Returns [] when clean, else one message per problem —
// each phrased as "what's wrong — how to fix".
export async function lintDiagram(src: string): Promise<string[]> {
  const problems: string[] = [];
  if (!src.trim()) return ["empty diagram source"];

  const first = firstMeaningfulLine(src);
  const typeWord = first?.split(/\s/)[0] ?? "";
  if (!first || !detectType(src)) {
    // Stop here: the parser's own "no diagram type detected" never shows the
    // author what a valid first line looks like, and every downstream rule
    // would be linting a language it can't identify.
    return [
      `first line "${first ?? ""}" is not a Mermaid diagram type — start with e.g. "flowchart TD", "stateDiagram-v2", "sequenceDiagram"`,
    ];
  }

  // `:::class` markers must name a predefined semantic class — anything else
  // renders as the default accent and the author never learns the tag was dead.
  // The parser accepts these happily, so this rule is ours forever.
  for (const m of src.matchAll(/:::([\w-]+)/g)) {
    if (!VALID_CLASSES.has(m[1])) {
      problems.push(
        `unknown node class ":::${m[1]}" — the palette defines: ${[...VALID_CLASSES].join(", ")}`,
      );
    }
  }

  const parsed = parseProblem(src);
  if (parsed !== null) {
    // Add any heuristic that recognizes the same source, for the fix hint the
    // parser's positional error doesn't give.
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

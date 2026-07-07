// Write-time lint for `--diagram` Mermaid source. Mermaid's real parser is
// DOM-bound (it only runs in the dashboard), so a parse failure normally
// surfaces where the agent can't see it: the card silently degrades to raw
// source. This lint closes that feedback loop at the CLI instead — it catches
// the common parse killers cheaply and lets `cockpit log`/`scribe` exit
// non-zero with a fix hint, so the author corrects the source and re-runs.
// Conservative by design: every rule targets a known failure mode; when in
// doubt, pass (a false "ok" degrades gracefully in the card, a false error
// blocks a legitimate write).
import { SEMANTIC_NODES } from "../dashboard/dist/modules/diagram.js";

const VALID_CLASSES = new Set(Object.keys(SEMANTIC_NODES));

// Diagram types the dashboard renderer accepts — the complete first-line
// keyword set of the vendored mermaid v11 bundle (derived from its detector
// regexes; diagram-lint.test.ts asserts each keyword exists in the bundle so
// this list can't drift ahead of the vendor). The rule exists to catch typos
// ("flowchat"), so it must never be narrower than what the renderer supports.
export const DIAGRAM_TYPES = new Set([
  "flowchart",
  "flowchart-elk",
  "graph",
  "stateDiagram",
  "stateDiagram-v2",
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "kanban",
  "requirementDiagram",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "xychart-beta",
  "sankey-beta",
  "block-beta",
  "packet-beta",
  "radar-beta",
  "architecture-beta",
  "treemap",
  "treemap-beta",
  "treeView-beta",
  "venn-beta",
  "wardley-beta",
  "eventmodeling",
  "info",
]);

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

// Lint Mermaid source. Returns [] when clean, else one message per problem —
// each phrased as "what's wrong — how to fix".
export function lintDiagram(src: string): string[] {
  const problems: string[] = [];
  if (!src.trim()) return ["empty diagram source"];

  const first = firstMeaningfulLine(src);
  const typeWord = first?.split(/\s/)[0] ?? "";
  if (!first || !DIAGRAM_TYPES.has(typeWord)) {
    problems.push(
      `first line "${first ?? ""}" is not a Mermaid diagram type — start with e.g. "flowchart TD", "stateDiagram-v2", "sequenceDiagram"`,
    );
  }

  // Mindmap node shapes ()cloud( / ))bang(( ) are legitimately unbalanced.
  if (typeWord !== "mindmap") {
    const bracket = bracketProblem(src);
    if (bracket) problems.push(bracket);
  }

  // `:::class` markers must name a predefined semantic class — anything else
  // renders as the default accent and the author never learns the tag was dead.
  for (const m of src.matchAll(/:::([\w-]+)/g)) {
    if (!VALID_CLASSES.has(m[1])) {
      problems.push(
        `unknown node class ":::${m[1]}" — the palette defines: ${[...VALID_CLASSES].join(", ")}`,
      );
    }
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

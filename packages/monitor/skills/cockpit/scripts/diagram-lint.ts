// Write-time lint for `--diagram` Mermaid source. A parse failure normally
// surfaces where the agent can't see it — in the dashboard, where the card
// silently degrades to raw source. This lint closes that feedback loop at the
// CLI instead, so `cockpit log`/`scribe` exit non-zero with a fix hint and the
// author corrects the source and re-runs.
//
// The check that matters is Mermaid's *own* parser: the vendored UMD bundle
// runs headless under happy-dom (~200 ms cold, paid only when --diagram is
// present), so the CLI's verdict is the renderer's verdict. Heuristics can only
// approximate it — the dotted-arrow label `-.a.b.->` is a real case that slipped
// past them and rendered as raw source.
//
// Two things the parser can't do, so they stay hand-rolled:
//   - `:::class` validation — mermaid happily accepts an unknown class name;
//     the dashboard's scoped CSS silently ignores it.
//   - fix hints — mermaid reports *where*, the label heuristics report *how to
//     fix*. They only run once the parser has already failed (or is missing),
//     so a misfire can never block a legitimate write on its own.
//
// When the parser is unavailable (no happy-dom, unreadable bundle, eval blew
// up) the heuristics carry the whole lint. That degrade is silent by design: a
// missing parser is not the author's problem and must never block a write.
import { SEMANTIC_NODES } from "../dashboard/dist/modules/diagram.js";

const VALID_CLASSES = new Set(Object.keys(SEMANTIC_NODES));

// Diagram types the dashboard renderer accepts — the complete first-line
// keyword set of the vendored mermaid v11 bundle (derived from its detector
// regexes; diagram-lint.test.ts asserts each keyword exists in the bundle so
// this list can't drift ahead of the vendor). Kept ahead of the real parse
// because mermaid's own message for a typo ("No diagram type detected matching
// given configuration for text: flowchat TD…") never shows the author what a
// valid first line looks like.
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

// The old rule set, now demoted to two jobs: the fallback lint when the real
// parser can't run, and the fix-hint layer when it has already failed. Every
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

// ---------- The real parser, headless ----------

type MermaidParser = (src: string) => Promise<unknown>;

const BUNDLE_PATH = new URL(
  "../dashboard/dist/vendor/mermaid.min.js",
  import.meta.url,
).pathname;

// Resolves to mermaid's `parse`, or null when the parser can't be stood up.
// Memoized (including the null): a process linting several diagrams pays the
// ~200 ms once, and one failed load doesn't get retried per diagram.
let _parserPromise: Promise<MermaidParser | null> | null = null;

async function loadParser(): Promise<MermaidParser | null> {
  // happy-dom is a runtime dep resolved by Bun's auto-install; on a fresh,
  // offline machine the import simply fails and we degrade.
  const { Window } = await import("happy-dom");
  const w = new Window({ url: "http://localhost" });
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    "window",
    "document",
    "navigator",
    "location",
    "HTMLElement",
    "SVGElement",
    "Element",
    "Node",
    "getComputedStyle",
  ]) {
    g[k] = (w as unknown as Record<string, unknown>)[k];
  }
  g.window = w;
  g.document = w.document;

  // The bundle's tail is `globalThis["mermaid"] = __esbuild_esm_mermaid_nm…`,
  // but its head declares that namespace with a top-level `var`. Inside a real
  // <script> tag (the dashboard) that var lands on globalThis; inside an eval
  // under Bun it does not. So pre-create the namespace and strip the `var`.
  const code = await Bun.file(BUNDLE_PATH).text();
  g.__esbuild_esm_mermaid_nm = {};
  (0, eval)(code.replace("var __esbuild_esm_mermaid_nm;", ""));

  const mermaid = g.mermaid as
    { initialize: (c: unknown) => void; parse: MermaidParser } | undefined;
  if (!mermaid) return null;

  // Mirror dashboard/dist/modules/diagram.js — the lint must agree with the
  // renderer. Only the parse-relevant options matter here (theme/themeCSS are
  // render-time), but htmlLabels + securityLevel are kept in lockstep anyway so
  // a future divergence in diagram.js is visible as a diff in both files.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "base",
    flowchart: { htmlLabels: false, curve: "basis" },
  });
  return (src: string) => mermaid.parse(src);
}

function getParser(): Promise<MermaidParser | null> {
  if (!_parserPromise) _parserPromise = loadParser().catch(() => null);
  return _parserPromise;
}

// null = parses clean · string = the parser's own message (carries the line
// number) · undefined = the parser is unavailable, say nothing and degrade.
async function parseProblem(src: string): Promise<string | null | undefined> {
  const parse = await getParser();
  if (!parse) return undefined;
  try {
    await parse(src);
    return null;
  } catch (e) {
    const msg = (e as Error)?.message?.trim();
    return msg
      ? `mermaid parse error — ${msg}`
      : "mermaid rejected this source";
  }
}

// Lint Mermaid source. Returns [] when clean, else one message per problem —
// each phrased as "what's wrong — how to fix". Never throws: a broken parser
// degrades to the heuristics, it never blocks a write.
export async function lintDiagram(src: string): Promise<string[]> {
  const problems: string[] = [];
  if (!src.trim()) return ["empty diagram source"];

  const first = firstMeaningfulLine(src);
  const typeWord = first?.split(/\s/)[0] ?? "";
  if (!first || !DIAGRAM_TYPES.has(typeWord)) {
    // Stop here: mermaid's own "no diagram type detected" adds nothing, and
    // every downstream rule would be linting a language it can't identify.
    return [
      `first line "${first ?? ""}" is not a Mermaid diagram type — start with e.g. "flowchart TD", "stateDiagram-v2", "sequenceDiagram"`,
    ];
  }

  // `:::class` markers must name a predefined semantic class — anything else
  // renders as the default accent and the author never learns the tag was dead.
  // Mermaid parses these happily, so this rule is ours forever.
  for (const m of src.matchAll(/:::([\w-]+)/g)) {
    if (!VALID_CLASSES.has(m[1])) {
      problems.push(
        `unknown node class ":::${m[1]}" — the palette defines: ${[...VALID_CLASSES].join(", ")}`,
      );
    }
  }

  const parsed = await parseProblem(src);
  if (parsed === undefined) {
    // No parser: the heuristics are the lint.
    problems.push(...heuristicProblems(src, typeWord));
  } else if (parsed !== null) {
    // Parser found it. Add any heuristic that recognizes the same source, for
    // the fix hint mermaid's positional error doesn't give.
    problems.push(parsed, ...heuristicProblems(src, typeWord));
  }

  return problems;
}

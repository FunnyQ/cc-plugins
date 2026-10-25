export type DiffOp = { op: "same" | "del" | "add"; text: string };

// past this many lines a side, an LCS table costs more than a diff is worth to a reader
const MAX_DIFF_LINES = 200;

const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;
// a pre's text never runs past its own </pre>, or a match starting at an earlier figure swallows the diff
const TEXT = "((?:(?!</pre)[\\s\\S])*)";
const DIFF = new RegExp(
  `<figure${ATTRS}>\\s*<pre${ATTRS}>${TEXT}</pre\\s*>\\s*<pre${ATTRS}>${TEXT}</pre\\s*>\\s*</figure\\s*>`,
  "gi",
);
const PRE = new RegExp(`<pre${ATTRS}>${TEXT}</pre\\s*>`, "gi");

const attrPattern = (name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
const CLASS_ATTR = attrPattern("class");
const LANG_ATTR = attrPattern("data-lang");

const attr = (attrs: string, pattern: RegExp): string | undefined => {
  const m = pattern.exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
};

const hasClass = (attrs: string, name: string): boolean =>
  (attr(attrs, CLASS_ATTR) ?? "").split(/\s+/).includes(name);

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const UNESCAPES = Object.fromEntries(
  Object.entries(ESCAPES).map(([c, e]) => [e, c]),
);

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

export const unescapeHtml = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => UNESCAPES[e]!);

const sourceOf = (inner: string): string =>
  unescapeHtml(inner.replace(/^\s*<code[^>]*>|<\/code\s*>\s*$/gi, ""))
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "");

const codeBlock = (lang: string, source: string, extra = ""): string =>
  `<pre class="code" data-lang="${escapeHtml(lang)}"${extra}><code>${escapeHtml(source)}</code></pre>`;

const diagramFallback = (source: string): string =>
  `${codeBlock("mermaid", source, " data-pele")}<p class="render-note">This diagram could not render; its source is shown.</p>`;

// matches exactly what diagramFallback writes; its escaped source holds no "<"
export const DIAGRAM_FALLBACK =
  /<pre class="code" data-lang="mermaid" data-pele><code>([^<]*)<\/code><\/pre><p class="render-note">[^<]*<\/p>/g;

export const hasDiagram = (main: string): boolean =>
  [...main.matchAll(PRE)].some(([, attrs]) => hasClass(attrs!, "mermaid"));

export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES)
    return [
      ...a.map((text) => ({ op: "del" as const, text })),
      ...b.map((text) => ({ op: "add" as const, text })),
    ];
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: "same", text: a[i]! });
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
    ) {
      ops.push({ op: "del", text: a[i++]! });
    } else {
      ops.push({ op: "add", text: b[j++]! });
    }
  }
  return ops;
}

const diffBlock = (before: string, after: string): string => {
  const lines = lineDiff(before, after)
    .map(({ op, text }) => {
      const cls = op === "same" ? "" : ` class="${op}"`;
      return `<span${cls}>${escapeHtml(text) || " "}</span>`;
    })
    .join("");
  return `<pre class="diff"><code>${lines}</code></pre>`;
};

// the cleaner's regexes read text as well as tags, so raw-text blocks leave before it runs and come back after
export function prepareBlocks(main: string): {
  main: string;
  splice: (cleaned: string) => string;
} {
  // grown until the fragment cannot already hold it, so text the fork wrote never reads as a placeholder
  let tag = "runes-block";
  while (main.includes(tag)) tag += "-";
  const blocks: string[] = [];
  const hold = (html: string) => `<!--${tag}:${blocks.push(html) - 1}-->`;
  const lifted = main
    .replace(DIFF, (whole, figure, beforeAttrs, before, afterAttrs, after) =>
      hasClass(figure, "diff") &&
      hasClass(beforeAttrs, "before") &&
      hasClass(afterAttrs, "after")
        ? hold(diffBlock(sourceOf(before), sourceOf(after)))
        : whole,
    )
    .replace(PRE, (whole, attrs: string, inner: string) => {
      if (hasClass(attrs, "mermaid"))
        return hold(diagramFallback(sourceOf(inner)));
      if (hasClass(attrs, "code"))
        return hold(codeBlock(attr(attrs, LANG_ATTR) ?? "", sourceOf(inner)));
      return whole;
    });
  return {
    main: lifted,
    splice: (cleaned) =>
      cleaned.replace(
        new RegExp(`<!--${tag}:(\\d+)-->`, "g"),
        (_, n: string) => blocks[Number(n)] ?? "",
      ),
  };
}

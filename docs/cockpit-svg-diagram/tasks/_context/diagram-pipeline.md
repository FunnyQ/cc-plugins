# The diagram pipeline — current state and the new contract

> Everything an executor needs to know about how a diagram travels from `cockpit log --diagram` to a rendered card. Read this before touching any file in the pipeline.

## Current pipeline, file by file

### `packages/monitor/skills/cockpit/scripts/cockpit.ts`

- `--diagram` is registered in `SINGLE_FLAGS` (a set of flag names whose value is the next argv token). Its value arrives as `args.single["diagram"]`.
- `gateDiagram(cmd, src)` runs before anything is written. It early-returns on an absent value (so a non-diagram call never pays the lint's cost), calls `lintDiagram(src)`, and on any problem prints a header line plus one `  - <problem>` line per problem to stderr and calls `process.exit(1)`.
- Both `cockpit log` and `cockpit scribe` call `await gateDiagram(...)`, then spread the value into the record conditionally, in this shape:

  ```ts
  ...(args.single["diagram"] ? { diagram: args.single["diagram"] } : {}),
  ```

  That conditional spread is the "lean shape" discipline: an entry with no diagram carries no key at all.
- The record type is:

  ```ts
  type DecisionRecord = {
    id: string;
    type: "decision";
    kind?: DecisionKind;         // "decision" | "rationale" | "learning" | "caveat"
    source?: DecisionSource;     // "agent" | "scribe"
    decision: string;
    reason: string;
    tradeoff: string;
    facets: Facet[];
    needs_your_call: boolean;
    options: string[];
    files: string[];
    diagram?: string;            // Mermaid source today
    timestamp: string;
  };
  ```

- Each record is `JSON.stringify`d onto one line of `<repo>/.cockpit/logs/<sessionId>.jsonl`.

### `packages/monitor/skills/cockpit/scripts/diagram-lint.ts`

- Exports `lintDiagram(src: string): Promise<string[]>` — `[]` when clean, otherwise one message per problem, each phrased `what's wrong — how to fix`. It never throws.
- Exports `DIAGRAM_TYPES`, a `Set<string>` of every first-line keyword the vendored mermaid v11 bundle accepts (`flowchart`, `graph`, `stateDiagram-v2`, `sequenceDiagram`, `classDiagram`, `mindmap`, `pie`, `gitGraph`, `timeline`, `C4Context`, `xychart-beta`, … 35 entries). None of them begins with `<`.
- `firstMeaningfulLine(src)` skips a leading `---` YAML frontmatter block, blank lines, and `%%` comments, and returns the first real line.
- The very first check: if that line's first word is not in `DIAGRAM_TYPES`, the function **returns immediately** with a single message and runs nothing else:

  ```
  first line "<line>" is not a Mermaid diagram type — start with e.g. "flowchart TD", "stateDiagram-v2", "sequenceDiagram"
  ```

  That early return is where the SVG cross-hint belongs.
- The real verdict comes from mermaid's own parser, stood up headless under happy-dom in `loadParser()`. The parser promise is memoized including its `null`, so one failed load is not retried per diagram. When the parser is unavailable, `parseProblem()` returns `undefined` and the hand-rolled heuristics carry the whole lint. That degrade is silent by design: a missing parser is not the author's problem and must never block a write. **Any new lint must degrade the same way.**

### `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js`

- `NIGHT_FLIGHT_THEME` — the mermaid `themeVariables` object, all concrete hex because mermaid's khroma colour engine cannot parse `oklch()`.
- `SEMANTIC_NODES` — the `:::ok` / `:::bad` / `:::fix` / `:::info` / `:::warn` / `:::start` palette. `diagram-lint.ts` imports this to validate `:::class` markers, so the two cannot drift.
- `loadMermaid()` — injects `../vendor/mermaid.min.js` as a `<script>` on first render, then `initialize()`s it with `securityLevel: "strict"`, `htmlLabels: false`, `theme: "base"`, the theme variables, and the semantic-node CSS. A failed load drops the cached promise so a later render can retry.
- `nextDiagramId()` — a monotonic counter producing `cockpit-mmd-N`, used so mermaid's id-scoped `<style>` block cannot collide across cards. There is deliberately no `Math.random()`.
- `sanitizeSvg(svg)` — lazily imports `../vendor/purify.es.mjs` and runs:

  ```js
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "script"],
  });
  ```

- `renderDiagram(text)` — trims, loads mermaid, renders, sanitizes, and returns `{ ok: true, svg }` or `{ ok: false, error }`. It never throws. On a parse failure it also removes any stray `[id^="dcockpit-mmd-"]` node mermaid injected into `<body>`.
- `openDiagramLightbox(svg, title)` / `closeDiagramLightbox()` — the enlarge overlay, built lazily on first open. It holds the currently displayed SVG in a module-level `_lightboxSvg` so the download button reuses the exact markup in the card rather than re-rendering.
- `standaloneSvg(svg)` — parses the SVG, sets `xmlns`, and sets `root.style.backgroundColor = "#0e101f"` (`--space`) so a downloaded file is readable outside the cockpit's dark page. `downloadDiagramSvg()` calls it and saves as `cockpit-<slug>.svg`.

### `packages/monitor/skills/cockpit/dashboard/dist/modules/decision-log.js`

- Around lines 391–414, card HTML is built once and never re-run. When `rec.diagram` is set it emits:

  ```js
  const diagram = rec.diagram
    ? `<figure class="decision-card__diagram" data-pending>
         <pre class="decision-card__diagram-src">${esc(rec.diagram)}</pre>
       </figure>`
    : "";
  ```

  then after building `card.innerHTML` calls `mountDiagram(card, rec.diagram)`.
- `mountDiagram(card, source)` awaits `renderDiagram(source)`. On success it replaces the figure's contents with the SVG, drops `data-pending`, adds `is-zoomable`, sets `role="button"` / `tabindex="0"` / `aria-label="Enlarge diagram"`, and wires click plus Enter/Space to `openDiagramLightbox(result.svg, title)` where `title` is the card headline's text. On failure the `<pre>` stays and the figure is flagged so CSS marks it as an unrendered fallback.

### `packages/monitor/skills/cockpit/dashboard/dist/style.css`

- Diagram styling lives around lines 1707–1870: `.decision-card__diagram`, `.decision-card__diagram-src`, the `[data-pending]` and `[data-failed]` states, `.is-zoomable` with its `⤢` hint, and the `.diagram-lightbox*` overlay rules.
- Night Flight tokens are declared on `:root` at the top of the file, in `oklch()`.

### A caveat that spans two modules

`dashboard/dist/modules/transcript.js` imports the same `../vendor/purify.es.mjs` module instance and registers a **global** `DOMPurify.addHook("afterSanitizeAttributes", …)` that forces `target="_blank"` and a safe `rel` on links. Because the module instance is shared, that hook also runs during diagram sanitization. It is believed harmless (it only adds attributes to `<a>`), but it must be confirmed rather than assumed when the sanitize policy changes.

## The new contract

### Format detection (CLI only)

```ts
export type DiagramFormat = "mermaid" | "svg";

// Pure. "svg" when the first non-whitespace character is "<", else "mermaid".
export function detectDiagramFormat(src: string): DiagramFormat;
```

This single rule is reliable in both directions: no Mermaid diagram-type keyword begins with `<`, and every well-formed SVG document begins with `<` (an XML prolog, a comment, or the root element itself).

### `@path` input (CLI only)

```ts
// "@some/file" → that file's contents. Anything else → returned unchanged.
// Throws (or exits non-zero naming the path) when the file is missing or unreadable.
export function readDiagramArg(value: string): string;
```

`@` resolution happens **before** detection. The resolved content is what is stored in the JSONL — the record stays self-contained, since the browser has no access to the author's filesystem. No Mermaid source and no SVG document begins with `@`, so the prefix is unambiguous.

### Record shape

```ts
diagram?: string;
diagram_format?: "mermaid" | "svg";   // written ONLY when "svg"
```

A Mermaid entry is byte-identical to one written before this change. Every reader treats an absent `diagram_format` as `"mermaid"`.

### Frontend rendering

```js
// format defaults to "mermaid" so existing call sites and stored entries are unaffected.
export async function renderDiagram(text, format = "mermaid")
// → { ok: true, svg } | { ok: false, error }
```

The SVG branch must not touch mermaid at all — a session whose only diagrams are SVG never fetches the 3.3MB bundle.

### Sanitize policy (both formats, one config)

```js
DOMPurify.sanitize(svg, {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["foreignObject", "script"],
  ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpe?g|gif|webp|svg\+xml);|#)/i,
});
```

The tightened URI policy is strictly narrower than today's and mermaid's strict output emits no external references, so applying it to both paths is safe and keeps one configuration to reason about.

That regexp is the **single authority on which URIs survive**: a `#` fragment, or a `data:` URI whose MIME type is png, jpeg (`jpg` or `jpeg`), gif, webp, or svg+xml. Nothing else. The write-time SVG lint must admit exactly this set and no more — a looser lint passes something the renderer then strips, which is the silent failure the lint exists to prevent.

**`ALLOWED_URI_REGEXP` governs attributes only.** It does not reach `url()` or `@font-face src` inside a `<style>` element. Stripping remote `url()` from CSS is the job of the style-scoping pass, not of DOMPurify.

### Style scoping (SVG only)

An SVG's `<style>` element is a **document-level** style element once the SVG is inlined into an HTML page. Mermaid's output is id-scoped so it is inert; an author's SVG is not. Before an author SVG is inserted, every rule inside every `<style>` must be rewritten so its selector only matches inside that one figure.

**The scope anchor is the `<svg>` root's own id, not the surrounding figure's.** The download button serialises the SVG element alone, without the figure, so rules anchored to a figure id would resolve inside the card and match nothing in the saved file — the author's styling would silently disappear from every download. Anchored to the root, one selector works in both places. One accepted consequence: a rule targeting the root element itself (`svg { … }`) becomes `#id svg` and matches nothing, since the root is not its own descendant. That is a silent no-op rather than a leak, and the authoring docs tell authors to style a wrapping `<g>` instead.

The contract, not the implementation:

- Each rule's selector is prefixed with the SVG root's unique id selector, for example `#cockpit-svg-3 rect { … }`.
- Rules nested inside `@media` are rewritten in place; the `@media` wrapper survives.
- Any rule the pass cannot confidently rewrite is **dropped**. Fail closed. Never emit an unrewritten rule.
- Any `url()` that is not a `data:` URI or a `#` fragment is removed. A relative path counts as removable — it would resolve against the dashboard's own origin.

  **A `url()` reaches the page through three doors, and `ALLOWED_URI_REGEXP` guards none of them** — it governs URI-valued attributes such as `href` and `src`, and never inspects CSS:
  1. `<style>` element text.
  2. An inline `style` attribute — `<rect style="fill:url(https://…)">`.
  3. An SVG presentation attribute — `<rect fill="url(https://…)">`, and likewise `stroke`, `filter`, `mask`, `clip-path`, `marker-start`, `marker-mid`, `marker-end`, `marker`.

  The scoping pass closes all three, and the write-time lint reports all three. A `#` fragment survives everywhere: `fill="url(#gradient)"` referring to a `<linearGradient>` in the same document is the common legitimate case.
- `@font-face` whose `src` is not a `data:` URI is dropped entirely.
- `@keyframes` is dropped entirely. An animation name is not a selector, so prefixing cannot reach it and a surviving rule registers globally — the same escape by another door. An animated author SVG therefore shows its static first frame.

### Theme tokens

Because the SVG is inlined into the card's DOM, CSS custom properties inherit into it for free. An author writes `stroke="currentColor"` or `fill="var(--aurora)"` and lands in the theme; an author who writes literal hex keeps their own look. Nothing is rewritten either way.

`diagram.js` gains one exported constant, the custom-property name → concrete-hex map. It is the single source for the standalone-download baking and for the token table published in the authoring docs.

```js
export const NIGHT_FLIGHT_TOKENS = {
  "--space": "#0e101f",
  "--hull": "#171929",
  "--hull-2": "#222537",
  "--edge": "#393c4d",
  "--starlight": "#edeef4",
  "--ink-muted": "#a8aab6",
  "--ink-faint": "#777988",
  "--aurora": "#2ad7d7",
  "--signal": "#feb354",
  "--positive": "#4fd6a3",
  "--danger": "#e5605f",
};
```

Every value above is already present as a hex literal in `NIGHT_FLIGHT_THEME` or `SEMANTIC_NODES` in the same file; these are the sRGB renderings of the `oklch()` tokens declared on `:root` in `style.css`. Drift here means an off-theme diagram, never a broken one.

### Standalone download

The card's tokens do not travel with a downloaded file, so `var(--aurora)` and `currentColor` would resolve to nothing. `standaloneSvg()` therefore injects a `<style>` block into the serialized root that declares every entry of `NIGHT_FLIGHT_TOKENS` plus a root `color`, alongside the existing `--space` background. Declaring the tokens is deliberately chosen over computing and baking each element's resolved colour: it is one string, it cannot desynchronise from the live render, and it leaves the author's markup untouched.

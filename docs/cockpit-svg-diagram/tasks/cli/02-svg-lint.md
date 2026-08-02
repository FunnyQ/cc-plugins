# CLI-02: SVG lint at write time

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: cli/01
> **Blocks**: docs/01
> **Status**: todo

## Goal

A broken or unrenderable raw SVG fails at `cockpit log` / `cockpit scribe` with a fix hint, instead of degrading silently in a dashboard the authoring agent never sees.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/svg-lint.ts` (new) — exports `lintSvg`.
- `packages/monitor/skills/cockpit/scripts/svg-lint.test.ts` (new) — unit tests for every check plus the degrade path.
- `packages/monitor/skills/cockpit/scripts/cockpit.ts` (modify) — the diagram gate's SVG branch calls `lintSvg` instead of running no lint.

## Implementation notes

### The contract

`lintSvg` mirrors the Mermaid lint's contract exactly. An executor who has read one has read both.

```ts
export async function lintSvg(src: string): Promise<string[]>;
```

- Returns `[]` when the source is clean.
- Otherwise returns one message per problem, each phrased `what's wrong — how to fix`. The "how to fix" half is the entire point: the author is an agent that cannot see the rendered card, so a message naming only the symptom leaves them guessing.
- **It never throws.** Hostile, truncated, or binary-ish input produces messages or an empty array, never an exception. The gate that calls it treats a thrown error as a crashed CLI, which would block a legitimate write.

### Why this lint exists at all

The browser sanitizes and strips before rendering, so most of the problems below do not break the page — they silently produce an SVG with holes in it, on a screen the authoring agent never opens. Every check here reports something the renderer will *remove*, so the author learns at the only moment they can still fix it. That is the same reasoning that put the Mermaid lint in the CLI.

### Checks to implement

Implement each check and give each its own message. Suggested wording is illustrative; keep the `what's wrong — how to fix` shape and keep the fix half concrete.

1. **Not well-formed XML.** Report the parser's own message when one is available, so the author gets the position.
   `not well-formed XML — <parser message>; check for an unclosed tag or an unescaped "&"`

2. **Root element is not `<svg>`.** Name what was found.
   `root element is <div>, not <svg> — pass the SVG document itself, not the HTML wrapping it`

3. **No `viewBox` on the root `<svg>`.** Require it outright; a width/height pair is not a substitute. To enlarge a diagram the lightbox strips the inline `width`, `height` and `max-width` and lets CSS scale the element — which only works when there is a `viewBox` to scale by. An SVG sized only by width and height is legal markup that renders, then refuses to fit the card and refuses to enlarge, so accepting it would ship a diagram missing an affordance every Mermaid diagram has.
   `<svg> has no viewBox — add viewBox="0 0 W H" so the diagram can scale to the card and enlarge`

4. **A URI in `href`, `xlink:href`, or `src` that the renderer will not admit.** Anything it rejects is stripped and the image renders with a hole. This applies to `<a href>` as well as `<image>` and `<use>` — an author linking out of a diagram should know the link will not survive.
   `remote reference href="https://…" — the renderer strips it; inline the asset as a data: URI, or drop the link`

   **The admitted set must match the renderer exactly, character for character.** The renderer sanitizes with this attribute policy:

   ```
   /^(?:data:image\/(?:png|jpe?g|gif|webp|svg\+xml);|#)/i
   ```

   So the lint admits a `#` fragment, or a `data:` URI whose MIME type is one of **png, jpeg (`jpg` or `jpeg`), gif, webp, svg+xml** — and nothing else. Everything else is reported, including a relative path (it would resolve against the dashboard's own origin and fetch nothing useful) and a `data:image/…` type outside that list, such as `data:image/bmp`. A looser rule here is worse than no rule: it passes the write-time gate and then vanishes in the dashboard, which is precisely the silent failure this lint exists to prevent. Encode the shared list once and cite the renderer as its source in a comment.

5. **A `url()` in a `<style>` declaration that is neither a `data:` URI nor a `#` fragment, or an `@font-face` whose `src` is not a `data:` URI.** The renderer's attribute policy governs attributes only, so the style-scoping pass is what removes these — but the outcome for the author is the same, the font or fill silently disappears.
   `@font-face src url("https://…") — the renderer drops it; embed the font as a data: URI or rely on the card's font stack`

   Report **every** such value, not only the obviously remote ones. A relative `url(../asset.svg)` is removed by the renderer just as a `https://` one is, so a lint that only catches remote URLs lets it through the gate and then loses it in the browser. Note that the CSS rule is deliberately **looser** than the attribute rule above: in CSS any `data:` URI survives, while an attribute must additionally carry one of the five admitted image MIME types. Keep the two rules separate; collapsing them in either direction produces a lint that disagrees with the renderer.

   **A `url()` can arrive through three doors; check all three.** The renderer's `ALLOWED_URI_REGEXP` governs only URI-valued attributes such as `href` and `src`, and strips the rest in its CSS pass. A lint that inspects only `<style>` elements passes a live remote fetch straight through the gate.

   1. `<style>` element text — the obvious one.
   2. An inline `style` attribute: `<rect style="fill:url(https://example.com/x.svg)">`. CSS living in an attribute.
   3. An SVG presentation attribute that takes a paint or reference value: `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-start`, `marker-mid`, `marker-end`, `marker`. `<rect fill="url(https://example.com/p.svg#g)">` fetches remotely and is governed by none of the above.

   In every one of the three, a `#` fragment survives — `fill="url(#gradient)"` pointing at a `<linearGradient>` in the same document is the common legitimate case and must not be reported.

6. **A `<script>` element, an `on*` event-handler attribute, or a `<foreignObject>`.** All three are removed before render. `<foreignObject>` deserves its own hint, because it is the one an author reaches for innocently: HTML inside an SVG is the natural way to lay out rich text, and it is exactly what gets stripped.
   `<foreignObject> is stripped by the renderer — draw the text as <text> elements instead`

7. **Empty or whitespace-only source.** Return a single message and run nothing else, matching the Mermaid lint's `empty diagram source` behaviour.

Report every problem found, not just the first. The gate prints them all at once, and an author who fixes one issue per run pays a round trip for each.

### The degrade discipline — the crux of this task

The Mermaid lint stands up happy-dom to run mermaid's real parser. It memoizes the resulting promise **including its `null`**, so one failed load is not retried per diagram, and when the parser is unavailable it says nothing and lets the write proceed. Its own comment states the rule: a missing parser is not the author's problem and must never block a write.

`lintSvg` degrades the same way:

- Use happy-dom's `DOMParser` for every DOM-dependent check. It is already the runtime dependency Bun auto-installs for the Mermaid lint. **Add no new dependency.**
- Memoize the loaded window (or the parse function), including the failed case, so a process linting several diagrams pays the load once and a failed load is not retried.
- When happy-dom cannot be imported, **skip every DOM-dependent check silently**. Only the empty-source check is pure enough to survive, so on a machine with no happy-dom a non-empty SVG lints clean and is written. That is correct: an unavailable parser is an environment problem, and blocking the write would punish the author for it.

A happy-dom `DOMParser` parsing XML signals a malformed document by producing a `parsererror` element in the result rather than by throwing. Check for it explicitly — relying on a `try`/`catch` here silently passes every malformed document.

### Make the degrade path testable

The degrade path is an acceptance criterion, so a test must be able to reach it without uninstalling happy-dom. Add the smallest seam that allows this — an optional injected parser, where an explicit `null` means "no parser available" and an omitted argument means "load happy-dom":

```ts
export type XmlParse = (src: string) => Document;

export async function lintSvg(src: string, parse?: XmlParse | null): Promise<string[]>;
```

Justify no more than that. A configuration object or a swappable loader registry is more machinery than the one failure this seam prevents (an unverified degrade path shipping).

### Wiring into the diagram gate

The diagram gate in `cockpit.ts` already resolves an `@path` argument, detects the format, and routes Mermaid source to the existing Mermaid lint. This task fills the SVG branch, which currently runs no lint at all.

Leave the gate's failure output shape untouched: a header line naming the command, then one `  - <problem>` line per problem on stderr, then `process.exit(1)`. Two lints now feed that same printer, so the author sees an identical failure shape regardless of which format they passed.

Keep the early-out that skips the whole gate when no `--diagram` was passed. A `cockpit log` call without a diagram must not pay for a happy-dom load.

### Test cases to cover

- A minimal clean SVG (root `<svg>` with a `viewBox` and one `<rect>`) returns `[]`.
- An unclosed tag returns a message carrying the parser's own text.
- A `<div>` root returns the root-element message naming `div`.
- An `<svg>` with no `viewBox` returns the scaling message — including one that carries `width` and `height`, since those do not substitute.
- `<image href="https://example.com/x.png">`, `<use href="../shared.svg#icon">` and `<image href="data:image/bmp;base64,…">` are all reported; `<image href="data:image/png;base64,…">`, `<image href="data:image/jpeg;base64,…">` and `<use href="#local">` are not.
- `<style>@font-face { src: url(https://example.com/f.woff2); }</style>` is reported; the same rule with a `data:` src is not. A declaration carrying `url(../asset.svg)` is reported too — relative counts, not just remote.
- `<script>`, an `onclick` attribute, and `<foreignObject>` are each reported.
- `""` and `"   \n  "` each return exactly one message.
- Several problems in one document return several messages.
- Hostile input — deeply nested elements, a stray NUL byte, a truncated document — resolves without throwing.
- With the parser injected as `null`, a document that would fail every DOM-dependent check returns `[]`, and an empty source still returns its one message.

## Acceptance criteria

- [ ] `lintSvg(src)` returns `[]` for a clean SVG and one `what's wrong — how to fix` message per problem otherwise, and reports every problem found rather than stopping at the first.
- [ ] Malformed XML is detected via the `parsererror` element (not via a thrown exception) and the reported message carries the parser's own text when available.
- [ ] A non-`<svg>` root element and a missing `viewBox` are each reported with their own message, and an SVG carrying `width` and `height` but no `viewBox` is still reported.
- [ ] A remote or relative `href` / `xlink:href` / `src` is reported, and so is a `data:` URI whose MIME type falls outside png / jpeg / gif / webp / svg+xml; a URI inside that list, or a `#` fragment, is not reported. The admitted set matches the renderer's own attribute policy exactly.
- [ ] Any `url()` that is neither a `data:` URI nor a `#` fragment is reported — remote and relative alike — through all three doors: a `<style>` element, an inline `style` attribute, and a presentation attribute such as `fill` / `filter` / `mask` / `clip-path` / `marker-*`. A non-`data:` `@font-face src` is reported too, and `url(#gradient)` is never reported. The CSS rule admits any `data:` URI, unlike the narrower URI-attribute rule, and the two are kept separate.
- [ ] A `<script>` element, an `on*` attribute, and a `<foreignObject>` are each reported.
- [ ] Empty or whitespace-only source returns exactly one message.
- [ ] `lintSvg` never throws, for any input in the hostile set listed above.
- [ ] With no parser available, every DOM-dependent check is skipped silently and a non-empty SVG lints clean — the write is never blocked by a missing happy-dom.
- [ ] The diagram gate routes SVG source to `lintSvg`, prints every returned problem in the existing header-plus-bullets shape, and exits non-zero.

## Verification

- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/svg-lint.test.ts` — all tests pass.
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` — the whole suite is green, including the untouched Mermaid lint and theme tests.
- [ ] Run `cockpit log` with a deliberately broken SVG (a `<div>` root carrying a `<script>` and a remote `<image href>`). Quote the stderr output and the exit code. Expect a non-zero exit and one bullet per problem.
- [ ] Run `cockpit log` with a clean SVG. Confirm exit code 0 and that the entry was appended to the session's JSONL.
- [ ] Run `git status --short` and quote it. Expect `packages/monitor/skills/cockpit/scripts/svg-lint.ts`, `packages/monitor/skills/cockpit/scripts/svg-lint.test.ts`, `packages/monitor/skills/cockpit/scripts/cockpit.ts`, plus this task file. Any OTHER path is a real scope violation.

## Eval rubric

> Scale and dimension definitions: see `../_context/rubric.md`. Each dimension is scored 0–5; the weighted average must be `>= 4.0` to pass; `Correctness < 4` is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A listed check is missing, or malformed XML passes because the code relied on a thrown exception instead of `parsererror` | Every check exists but one misfires — a `data:` URI or `#` fragment is flagged as remote, or only the first problem is reported | All seven checks fire on the cases listed and stay quiet on the legitimate ones; every problem in a document is reported at once |
| Backward compatibility | ×2 | A missing happy-dom now blocks a write, or a `--diagram`-free call pays a parser load | Degrades without throwing but reports spurious problems when the parser is absent, or the gate's failure output shape changed | Absent happy-dom skips the DOM-dependent checks silently and the write proceeds; the Mermaid path, the gate's output shape, and the no-diagram early-out are untouched |
| Test coverage | ×2 | No tests, or only the clean-SVG case | Happy path plus one or two failure cases; the degrade path is unverified | Covers every listed check on both its positive and negative case, the multi-problem case, the hostile throw-free set, and the injected-`null` degrade path |
| Interface & readability | ×1 | I/O and check logic tangled; the parser is reloaded per call | Works, but the seam is broader than needed or the memoization misses the failed case | `lintSvg` mirrors the Mermaid lint's shape, the parser (including its failure) is memoized once, the test seam is the single optional parameter, `type` not `interface` |

## Out of scope

- **Sanitizing or rewriting the SVG.** Deferred. Reason: the CLI validates and never rewrites — what the author passed is byte-for-byte what lands in the JSONL, and the browser's sanitize is the only security boundary.
- **The frontend renderer and the style-scoping pass.** Deferred to the UI bucket. This task only reports what those will strip.
- **Rendering the SVG to check that it looks right.** Deferred. Reason: this lint checks structure, not aesthetics; there is no headless renderer to judge a drawing against.
- **A size cap on the source.** Deferred by an explicit decision recorded in the shared context.

# Cockpit `--diagram` raw-SVG escape hatch

> **Status**: approved
> **Owner**: unassigned
> **Last updated**: 2026-08-02

## Overview

`cockpit log --diagram` / `cockpit scribe --diagram` currently accept Mermaid source only. Add a second accepted input — raw SVG — so diagrams Mermaid cannot express (custom coordinates, exact typography, hand-drawn style, an existing exported file) can still ride a decision card, without changing a single existing Mermaid call site.

## Goals

- `--diagram` accepts raw SVG as well as Mermaid, detected automatically, with no new flag.
- `--diagram @path` reads the argument from a file, orthogonal to which of the two formats the file holds.
- Raw SVG renders inside the decision card and lightbox with the same affordances Mermaid already has (enlarge, download).
- Author-supplied `<style>` inside an SVG cannot escape the card and restyle the dashboard.
- No remote resource is fetched to render a decision card.
- Every existing Mermaid entry — already on disk and newly written — renders byte-identically to today.

## Non-goals

- **Version bump and CHANGELOG.** Not touched here. `/chronicle:release` owns the two `plugin.json` files and the changelog entry.
- **Bitmap formats.** `--diagram` accepts two text formats, Mermaid and SVG. An embedded `data:image/png` is an internal detail of an SVG, never its own path.
- **Pre-rendering Mermaid to SVG at write time.** The decision trail keeps the author's source. The CLI never rewrites what it was given.
- **Light mode or multi-theme.** Cockpit has one theme, Night Flight. The SVG path adds no theme layer.
- **Recolouring author SVG.** No heuristic maps author colours onto the palette. The author opts into the theme, or does not.
- **A size cap on `--diagram`.** Deliberately deferred until a real case hurts.

## Context

Today's pipeline, all inside `packages/monitor/skills/cockpit/`:

1. `scripts/cockpit.ts` — `--diagram` is a single-valued flag. `gateDiagram()` (line 314) calls `lintDiagram()` before anything is written, and exits non-zero with fix hints on failure. The source lands in `DecisionRecord.diagram` (line 79) and is appended to `.cockpit/logs/<session>.jsonl`.
2. `scripts/diagram-lint.ts` — runs the *vendored mermaid bundle's own parser* headless under happy-dom, plus hand-rolled heuristics for `:::class` validation and fix hints. Degrades silently when the parser can't be stood up; never blocks a write on its own.
3. `dashboard/dist/modules/diagram.js` — lazy-loads the 3.3MB mermaid UMD bundle on first render, themes it with `NIGHT_FLIGHT_THEME` (concrete hex, because mermaid's khroma engine cannot parse `oklch()`), renders, then sanitizes through DOMPurify's SVG profile. Also owns the lightbox and `standaloneSvg()` (bakes `--space` as the background so a downloaded file is readable outside the cockpit).
4. `dashboard/dist/modules/decision-log.js:394-414` — emits a `<figure data-pending>` holding the source in a `<pre>`, then `mountDiagram()` replaces it with the SVG. On failure the `<pre>` stays as the fallback.

Two properties of the current design drive most decisions below:

- **The feedback loop is closed at the CLI.** A broken diagram surfaces in the dashboard, where the authoring agent cannot see it. That is exactly why `diagram-lint.ts` exists. The SVG path must behave the same way.
- **The frontend sanitize is the only security boundary.** The daemon streams the jsonl straight to the browser, so whatever else happens, the browser must sanitize. Sanitizing again at write time would be a second boundary that also makes the stored trail differ from the author's source.

One hazard the Mermaid path never hits: **a `<style>` element inside inline SVG is a document-level style element.** Mermaid's output is id-scoped (`#cockpit-mmd-3 .node rect`) so it is inert. A hand-authored or Excalidraw-exported SVG carrying `<style>rect { fill: #fff }</style>` would repaint the whole dashboard. DOMPurify's SVG profile permits the `style` tag, so today's config does not stop this.

## Requirements

### MVP

1. **Format detection** — the CLI decides Mermaid vs SVG from the content alone.
   - Acceptance: a pure `detectDiagramFormat(src)` returns `"svg"` when the first non-whitespace character is `<`, else `"mermaid"`. Unit-tested against an XML prolog, a leading XML comment, leading blank lines, a Mermaid YAML-frontmatter source, and every keyword in `DIAGRAM_TYPES`.

2. **`@path` input** — `--diagram @some/file` reads the argument from disk.
   - Acceptance: the file's contents are resolved *before* detection, so `@flow.mmd` and `@flow.svg` both work with no extension rule. The resolved content is stored inline in the jsonl — the record stays self-contained. A missing or unreadable path exits non-zero naming the path.

3. **Record format** — the entry records which format it holds.
   - Acceptance: `DecisionRecord` gains `diagram_format?: "mermaid" | "svg"`. It is written **only** when the value is `"svg"`, so a Mermaid entry is byte-identical to one written today. Readers treat an absent field as `"mermaid"`.

4. **SVG lint at the CLI** — the same loud-at-write-time contract Mermaid gets.
   - Acceptance: `lintSvg(src)` returns `[]` when clean, else one `what's wrong — how to fix` message per problem, and never throws. It flags: not well-formed XML; a root element that is not `<svg>`; a missing `viewBox` (required outright — a width/height pair is not a substitute, because the lightbox scales by the viewBox); an attribute URI outside the renderer's admitted set; a `url()` inside `<style>` that is neither `data:` nor a `#` fragment; a `<script>`, `on*` handler, or `<foreignObject>`. When happy-dom is unavailable the DOM-dependent checks are skipped silently, exactly as `diagram-lint.ts` degrades.

5. **Cross-format fix hint** — a near-miss SVG is not diagnosed as broken Mermaid.
   - Acceptance: when `lintDiagram()` rejects the first line *and* the source contains `<svg`, the message says the source looks like SVG whose root element is preceded by something else, and points at `--diagram @path.svg`.

6. **Raw SVG rendering** — the card shows the SVG.
   - Acceptance: `renderDiagram(text, format)` routes on format; the SVG path skips mermaid entirely (the 3.3MB bundle is never fetched for an SVG-only session) and returns the sanitized markup.

7. **Sanitize policy** — one config, tightened, shared by both paths, and the single authority on admitted URIs.
   - Acceptance: DOMPurify runs with the SVG profile, `FORBID_TAGS: ["foreignObject", "script"]`, and an `ALLOWED_URI_REGEXP` admitting only a `#` fragment or a `data:` URI of type png / jpeg / gif / webp / svg+xml. The write-time SVG lint admits exactly that set and no more, so nothing passes the CLI only to be stripped in the browser. Verified: mermaid output is unchanged under the tightened policy, a remote `<image href="https://…">` is stripped, and `data:image/bmp` is rejected at the CLI.

8. **Style scoping** — author CSS cannot leave the diagram.
   - Acceptance: every rule inside an SVG `<style>` is rewritten to be prefixed by the **SVG root's** unique id selector before insertion; any rule the pass cannot confidently rewrite is **dropped**, not passed through (fail-closed). Remote `url()` inside CSS is stripped in the same pass. A test asserts a hostile `rect { fill: red }` cannot match an element outside the SVG. The anchor is the root and not the surrounding figure because the download serialises the SVG alone — a figure-anchored selector would resolve in the card and match nothing in the saved file.

9. **Themeable without rewriting** — the author opts into Night Flight.
   - Acceptance: an inline SVG written with `stroke="currentColor"` or `fill="var(--aurora)"` picks up the card's tokens. A `NIGHT_FLIGHT_TOKENS` constant (custom-property name → concrete hex) is exported from `diagram.js`, guarded by a hex-only test in the style of `diagram-theme.test.ts`, and is the single source for both the download baking and the doc's token table. A second test parses the published table out of `references/diagram.md` and asserts it equals the constant in both directions, so "single source" is enforced rather than asserted.

10. **Download stays faithful** — a downloaded SVG is not colourless.
    - Acceptance: `standaloneSvg()` injects a `<style>` block into the serialized root defining `NIGHT_FLIGHT_TOKENS` plus a root `color`, so `var(--…)` and `currentColor` still resolve in a standalone file. The existing `--space` background behaviour is preserved.

11. **Failure presentation** — a broken SVG does not flood the column.
    - Acceptance: on failure the figure shows a one-line notice with the source folded inside a collapsed `<details>`. The Mermaid path keeps its current behaviour of showing the source directly.

12. **Documentation** — an agent author knows when and how to reach for it.
    - Acceptance: `references/diagram.md` states Mermaid is the default, lists the concrete cases SVG exists for, publishes the token table, states the sanitize rules the author must respect, and shows `@path`. `references/pilot.md` and `references/scribe.md` describe both accepted formats.

13. **No Mermaid regression** — every existing behaviour survives.
    - Acceptance: `bun test packages/monitor/skills/cockpit/scripts/` passes, including the untouched `diagram-lint.test.ts` and `diagram-theme.test.ts`.

### Later

- **A size cap on `--diagram`** — deferred by decision; revisit if an entry ever makes the SSE replay visibly slow.
- **Preserving CSS animation in an author SVG** — `@keyframes` rules are dropped rather than renamed, so an animated SVG shows its static first frame. Renaming would require rewriting `animation-name` and the `animation` shorthand correctly, and one missed reference leaves the global registration in place. Revisit only if a real diagram needs animation.

## Tech decisions

- **Stack**: Bun + TypeScript for `scripts/`; plain ES modules for `dashboard/dist/modules/` (no build step, `dist/` is committed as-is).
- **Types**: `type`, never `interface`.
- **No new npm dependency.** happy-dom is already the runtime dep `diagram-lint.ts` auto-installs; DOMPurify is already vendored.
- **Storage**: unchanged — one JSON line per entry in `.cockpit/logs/<session>.jsonl`.
- **Detection lives in exactly one place**, the CLI. The frontend routes on the stored `diagram_format` and never sniffs.
- **The CLI validates and never rewrites.** What the author passed is what lands in the jsonl.
- **The frontend sanitize is the only security boundary**, for both formats.
- **Fail-closed on anything unparseable** in the style-scoping pass.
- **Conventions**: see `tasks/_context/shared.md`.

## Architecture

```
cockpit log/scribe --diagram <inline | @path>
  │
  ├─ readDiagramArg()        @path → file contents          [scripts/diagram-format.ts]
  ├─ detectDiagramFormat()   first non-ws char is "<" ?     [scripts/diagram-format.ts, pure]
  │
  ├─ svg      → lintSvg()          [scripts/svg-lint.ts]      ─┐ fix hints,
  └─ mermaid  → lintDiagram()      [scripts/diagram-lint.ts]  ─┘ exit 1 on problems
                    └─ cross-hint when source contains "<svg"
  │
  └─ DecisionRecord { diagram, diagram_format?: "svg" } → .cockpit/logs/<session>.jsonl
                                    │
                          daemon SSE → dashboard
                                    │
     decision-log.js  mountDiagram(card, source, format)
        │
        ├─ mermaid → renderDiagram(src, "mermaid")  → lazy mermaid UMD → sanitizeSvg()
        └─ svg     → renderDiagram(src, "svg")      → sanitizeSvg() → scopeSvgStyles(el, "#svg-root-id")
                                                                        [modules/svg-scope.js]
        │
        └─ failure → one-line notice + collapsed <details> holding the source
```

New files: `scripts/diagram-format.ts`, `scripts/svg-lint.ts`, `dashboard/dist/modules/svg-scope.js`, plus their tests and `scripts/diagram-docs.test.ts` (the token-table drift guard).
Modified: `scripts/cockpit.ts`, `scripts/diagram-lint.ts`, `dashboard/dist/modules/diagram.js`, `dashboard/dist/modules/decision-log.js`, `dashboard/dist/style.css`, `references/{diagram,pilot,scribe}.md`.

## Bucketing

- **Strategy**: layer.
- **Why**: the CLI contract, the browser rendering, and the authoring docs have disjoint file sets, separate test commands, and different failure modes — the `cli` bucket is about backward compatibility, `ui` is about the sanitize boundary, `docs` is about accuracy against shipped behaviour. That is also why each bucket gets its own rubric.

### Buckets

- **`cli/`** — everything under `scripts/`. Starts at the format contract, ends when both lints are green and Mermaid callers are provably untouched.
- **`ui/`** — everything under `dashboard/dist/`. Starts once the `diagram_format` contract is frozen, ends when a raw SVG renders, scopes, enlarges, and downloads correctly.
- **`docs/`** — `references/*.md`, then the terminal integration review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| cli | 01 | diagram-format-contract | todo | >= 4.0 | — |
| cli | 02 | svg-lint | todo | >= 4.0 | cli/01 |
| cli | 03 | mermaid-cross-hint | todo | >= 4.0 | cli/01 |
| ui | 01 | svg-render-path | todo | >= 4.0 | cli/01 |
| ui | 02 | style-scoping | todo | >= 4.0 | — |
| ui | 03 | card-integration | todo | >= 4.0 | ui/01, ui/02 |
| docs | 01 | diagram-docs | todo | >= 4.0 | cli/02, cli/03, ui/03 |
| docs | 02 | final-review 🏁 | todo | >= 4.0 | cli/01, cli/02, cli/03, ui/01, ui/02, ui/03, docs/01 |

Eight tasks, not the seven named during the interview — the split is 3 / 3 / 2, with the terminal `Final review` as the eighth. It stays a task of its own rather than being folded into the docs task: it gates integration and regressions, which is a different job from writing the reference.

## Cross-bucket dependencies

```
cli/01 ──┬── cli/02 ──┐
         ├── cli/03 ──┤
         └── ui/01 ───┼── docs/01 ── docs/02 🏁
ui/02 ───────────────┤
         ui/01+ui/02 → ui/03 ──┘
```

`cli/01` is the only blocking wave-1 task on the CLI side; `ui/02` (style scoping) has no upstream dependency at all and can run in wave 1 alongside it.

## Eval rubric

Per bucket, defined in `tasks/_context/rubric.md`. Each task file reproduces its bucket's table inline.

- **`cli/`** — Correctness ×3 · Backward compatibility ×2 · Test coverage ×2 · Interface & readability ×1. Pass `>= 4.0`. Veto: Correctness < 4.
- **`ui/`** — Correctness ×3 · Sanitize & scoping boundary ×3 · Test coverage ×2 · Interface & readability ×1. Pass `>= 4.0`. Veto: Correctness < 4 or Sanitize & scoping boundary < 4.
- **`docs/`** — Accuracy vs shipped behaviour ×3 · Actionability for an agent author ×2 · Concision & style-guide fit ×1. Pass `>= 4.0`. Veto: Accuracy < 4.

## Verification

- Unit: `bun test packages/monitor/skills/cockpit/scripts/` — the gate for every task.
- Frontend logic is verified by extracting it into modules importable under happy-dom (the discipline `diagram-theme.test.ts` already enforces on `diagram.js`).
- The `Final review` task additionally runs a live smoke: start the daemon on an isolated port and home (`COCKPIT_HOME=/tmp/cockpit-dev bun …/cockpit-server.ts --port 5999`), write one Mermaid entry and one raw-SVG entry, and confirm in the browser that both render, that the SVG's `<style>` did not leak, that enlarge and download work, and that a deliberately broken SVG shows the collapsed fallback.

## Open questions

1. **Is happy-dom's CSSOM strong enough to unit-test the scoping pass?** If `CSSStyleSheet`/`cssRules` is too thin there, the test must drive the pass through a hand-built rule list instead. Not blocking: the fail-closed requirement makes the *contract* testable regardless of how the rewrite is implemented. Resolved inside the style-scoping task.
2. **Does `transcript.js`'s global DOMPurify `afterSanitizeAttributes` hook affect `<a>` inside an SVG?** `transcript.js:150` registers a hook on the shared DOMPurify module instance, and `diagram.js` imports the same instance. Harmless if it only adds `target`/`rel`, but it must be confirmed rather than assumed. Resolved inside the SVG render-path task.

## Known gaps

- No cap on diagram size, by decision.
- **The Mermaid no-regression evidence is a sample, not a proof.** The goal states every Mermaid entry renders byte-identically; the sanitize-policy comparison covers a deliberate spread (flowchart with semantic classes, `stateDiagram-v2`, `sequenceDiagram` with a note, `classDiagram`, a punctuated edge label) rather than all 35 diagram types in `DIAGRAM_TYPES`. The tightened policy only narrows URI handling and mermaid's strict output emits no external references, so the residual risk is confined to a diagram type that emits a URI-bearing attribute. Accepted rather than exhaustively tested.
- **Author CSS containment rests on an enumerated grammar.** The scoping pass drops every construct outside a listed set instead of parsing CSS generally. A browser-valid rule the grammar does not model is silently dropped, so an unusual authoring style loses its styling. That is the intended trade: over-dropping costs one diagram, under-dropping costs the page.

## References

- `packages/monitor/skills/cockpit/references/diagram.md` — the authoring reference this work extends.
- `packages/monitor/skills/cockpit/DESIGN.md` — Night Flight design system.

# DOCS-01: Authoring reference for the SVG escape hatch

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: cli/02, cli/03, ui/03
> **Blocks**: docs/02
> **Status**: todo

## Goal

An agent about to attach a diagram knows that Mermaid is the default, knows the specific cases raw SVG exists for, and knows what the renderer will strip.

## Files to create / modify

- `packages/monitor/skills/cockpit/references/diagram.md` (modify) — add the raw-SVG section: when to reach for it, how to pass it, the theme token table, the sanitize rules, and the `<style>` scoping behaviour.
- `packages/monitor/skills/cockpit/references/pilot.md` (modify) — rewrite the `--diagram` bullet (currently around line 140) to describe two accepted formats.
- `packages/monitor/skills/cockpit/references/scribe.md` (modify) — rewrite the `--diagram` bullet (currently around line 175) and the CLI surface line above it to describe two accepted formats.
- `packages/monitor/skills/cockpit/scripts/diagram-docs.test.ts` (new) — assert the published token table and the renderer's exported constant cannot drift apart.

This unit of work edits documentation. The one exception is the drift-guard test above — it exists to keep the documentation honest, not to add behaviour. Change no shipped code: no module under `dashboard/dist/`, no CLI script, nothing that alters what the feature does.

## Implementation notes

### The framing is a requirement, not a suggestion

Mermaid stays the documented default. Introduce raw SVG only *after* the reader has been told that Mermaid is the normal path. Present raw SVG as an escape hatch with an enumerated set of cases.

The reason is concrete and worth stating in the document itself: an agent that hits one Mermaid syntax error must not flee into hand-written SVG. The existing document already tells authors to correct a failing Mermaid source and re-run rather than dropping the diagram; the SVG section must not quietly offer an easier exit from that instruction.

The four cases where raw SVG is the right choice:

1. Custom coordinates — the author needs elements at exact positions Mermaid's layout engine will not produce.
2. Exact typographic layout — the author needs specific type sizes, alignment, or spacing.
3. A hand-drawn or sketch aesthetic.
4. An SVG that already exists as a file.

Anything a Mermaid diagram type covers stays Mermaid. Say that explicitly.

### How an author passes SVG

Two channels, both already used for Mermaid:

```bash
# inline, same heredoc pattern Mermaid uses
--diagram "$(cat <<'SVG'
<svg viewBox="0 0 240 80" xmlns="http://www.w3.org/2000/svg">…</svg>
SVG
)"

# from a file
--diagram @docs/flow.svg
```

State the `@` rule precisely, because it is easy to get wrong in prose:

- `@` means "read the argument from this file". It is an input channel.
- `@` is independent of format. `@flow.mmd` reads a Mermaid file and works exactly the same way.
- There is no format flag. There is no extension rule. The format is detected from the content.
- The file's contents are stored in the entry. The dashboard never reads the author's filesystem, so the path is resolved once, at write time.

### The theme contract

The SVG is inlined into the card's DOM, so CSS custom properties inherit into it for free.

- An author opts into the theme by writing `stroke="currentColor"` or `fill="var(--aurora)"`.
- An author who writes literal hex keeps their own look. A hand-drawn sketch stays exactly as drawn.
- Nothing is recoloured either way. State this, because "will the cockpit repaint my diagram?" is the first question a hand-drawn diagram raises.

Publish this token table. Every value comes from the constant the renderer exports (`NIGHT_FLIGHT_TOKENS` in `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js`), so read that constant and copy it value for value rather than transcribing from here:

| Token | Hex | Reads as |
|---|---|---|
| `--space` | `#0e101f` | card surface |
| `--hull` | `#171929` | raised panel |
| `--hull-2` | `#222537` | raised panel, one step up |
| `--edge` | `#393c4d` | borders |
| `--starlight` | `#edeef4` | primary ink |
| `--ink-muted` | `#a8aab6` | secondary ink |
| `--ink-faint` | `#777988` | lines, arrows |
| `--aurora` | `#2ad7d7` | the cool navigation accent |
| `--signal` | `#feb354` | the one warm reserve |
| `--positive` | `#4fd6a3` | success |
| `--danger` | `#e5605f` | failure |

Note that a downloaded SVG carries these declarations with it, so `var(--…)` and `currentColor` still resolve in a standalone file.

**Guard the table with a test, not with good intentions.** A hand-copied table is a second source of truth, and calling the constant "the single source" while maintaining a copy by hand is exactly how the two drift. Add `packages/monitor/skills/cockpit/scripts/diagram-docs.test.ts`: read `references/diagram.md`, parse the token table's `| \`--name\` | \`#hex\` |` rows, import `NIGHT_FLIGHT_TOKENS` from `dashboard/dist/modules/diagram.js`, and assert the two sets are equal in both directions — no token in the table that is missing from the constant, and none in the constant that is missing from the table. The importable-under-plain-Bun discipline the diagram module already keeps is what makes this test possible with no DOM.

### What gets stripped

List these, and state the consequence rather than only the rule:

- `<script>` — removed.
- `on*` event handlers, for example `onclick` — removed.
- `<foreignObject>` — removed. Labels must be SVG `<text>`.
- Any URI in `href`, `xlink:href`, or `src` outside the admitted set — removed. Only a `#` fragment, or a `data:` URI whose MIME type is png, jpeg, gif, webp, or svg+xml, survives. Name the list; "data URIs survive" is too loose, because `data:image/bmp` does not.
- Any `url()` that is not a `data:` URI or a `#` fragment — removed, wherever it sits: a `<style>` element, an inline `style="fill:url(…)"` attribute, or a presentation attribute such as `fill`, `filter`, `mask`, `clip-path`, or `marker-*`. Relative counts, not only remote. `@font-face` with a non-`data:` `src` is dropped whole. Reassure the author about the common case: `fill="url(#gradient)"` pointing at a gradient defined in the same SVG always survives.

The consequence, stated plainly: a remote font or a remote image will simply be missing from the rendered card. Inline it as a `data:` URI, or drop it.

### `<style>` is scoped for you

Explain the behaviour, and the one condition attached to it:

- The renderer rewrites every rule inside a `<style>` element so it can only match inside that one diagram. An author does not need to scope their own selectors, and the rewritten rules travel with a downloaded file.
- A rule targeting the root `<svg>` element itself is a silent no-op, because the scope anchors to that root. Advise wrapping the drawing in a `<g>` and styling that instead.
- The pass fails closed. A rule it cannot rewrite with confidence is dropped, not passed through unscoped.
- Therefore a rule written in an unusual form may silently vanish. Advise keeping selectors plain — element, class, and id selectors, without exotic syntax.
- `@keyframes` rules are dropped. An animation name is not a selector, so it cannot be scoped, and a global registration could retime an animation elsewhere in the dashboard. An animated SVG therefore renders as its static first frame. Do not rely on CSS animation in a decision-card diagram.

Explain *why* the scoping exists, in one sentence: a `<style>` element inside an inlined SVG is a document-level style element, so an unscoped `rect { … }` rule would repaint the whole dashboard.

### Always set a `viewBox`

Without a `viewBox` the figure cannot scale to the card width and cannot enlarge in the lightbox. The write-time lint requires one and rejects an SVG that lacks it.

State the one thing an author will otherwise get wrong: a `width` and `height` pair is **not** a substitute and does not satisfy the lint. Those size the element; only `viewBox` gives it a coordinate system to scale by.

### The write-time lint is the feedback loop

Raw SVG gets the same contract Mermaid already has: the CLI lints before anything is written, exits non-zero, and prints a fix hint. Repeat the existing instruction — correct the source and re-run it, rather than dropping the diagram.

### The worked example

Include one small, readable example that uses both `currentColor` and a `var(--…)` token. Keep it short enough to take in at a glance:

```svg
<svg viewBox="0 0 240 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="8" width="96" height="64" rx="10"
        fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="56" y="45" text-anchor="middle" fill="currentColor"
        font-family="sans-serif" font-size="13">stash</text>
  <path d="M112 40 h24" stroke="var(--ink-faint)" stroke-width="2"/>
  <circle cx="176" cy="40" r="26"
          fill="none" stroke="var(--aurora)" stroke-width="2"/>
  <text x="176" y="45" text-anchor="middle" fill="var(--starlight)"
        font-family="sans-serif" font-size="13">gate</text>
</svg>
```

Verify the example lints clean before shipping it. A documented example that fails the project's own lint is the most likely defect in this unit of work.

### The two flag descriptions

`packages/monitor/skills/cockpit/references/pilot.md` currently reads:

```
- `--diagram` — optional **Mermaid** source. Use it when structure beats
  prose: for a flow, a state machine, a sequence, or a dependency graph.
  Attach it only when a picture genuinely carries what a sentence cannot.
  When you decide to attach a `--diagram`, read
  [references/diagram.md](diagram.md) first.
```

`packages/monitor/skills/cockpit/references/scribe.md` currently reads:

```
- `--diagram` — optional **Mermaid** source. The dashboard renders it inline as a
  Night Flight-themed SVG. Read [references/diagram.md](diagram.md) first.
```

Rewrite both so they name two accepted formats and mention `@path`. Keep both short. Neither file duplicates the reference — each already links to `diagram.md`, and that stays the single deep source. Keep Mermaid named first in both, so the default survives the edit.

Also update the CLI surface line in `scribe.md`, which currently reads `[--diagram <mermaid>]`, so the placeholder no longer claims one format.

### Writing style

Apply these to every sentence written into the three files:

- Write one instruction per sentence. Start with a verb.
- Put the condition before the instruction. Put the warning before the step it affects.
- Use one term per thing. Never vary wording for style.
- Copy identifiers, code, errors, and log messages exactly.
- Cut every word that carries no meaning.
- Match the voice of the file being edited. `diagram.md` is terse and imperative; keep it that way.

## Acceptance criteria

- [ ] `diagram.md` names Mermaid as the default before raw SVG is introduced, and states that anything a Mermaid diagram type covers stays Mermaid.
- [ ] `diagram.md` lists all four cases for raw SVG: custom coordinates, exact typographic layout, a hand-drawn or sketch aesthetic, and an existing SVG file.
- [ ] `diagram.md` states the anti-pattern explicitly: do not switch to raw SVG to escape a Mermaid parse error; fix the source instead.
- [ ] `diagram.md` documents `--diagram @path` as an input channel independent of format, and states that `@flow.mmd` works the same way.
- [ ] The token table in `diagram.md` matches the `NIGHT_FLIGHT_TOKENS` constant in `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js` value for value, with no token present in one and missing from the other — and `diagram-docs.test.ts` asserts that equality in both directions, so a later edit to either side fails the suite instead of drifting silently.
- [ ] `diagram.md` lists every stripped item — `<script>`, `on*` handlers, `<foreignObject>`, disallowed URIs in `href` / `xlink:href` / `src`, and remote `url()` in CSS — and states the two survival rules separately, because they differ: an **attribute** survives only as a `#` fragment or a `data:` URI of type png, jpeg, gif, webp, or svg+xml, while a **CSS `url()`** survives as any `data:` URI or `#` fragment. A blanket "all `data:` URIs survive" is wrong for attributes and fails this criterion.
- [ ] `diagram.md` states that `<style>` rules are scoped to the diagram automatically, that the pass fails closed by dropping a rule it cannot rewrite, that a rule targeting the root `<svg>` is a no-op, and that `@keyframes` rules are dropped so an animated SVG shows its static first frame.
- [ ] `diagram.md` states that `viewBox` is required, that the write-time lint rejects an SVG without it, and that a `width`/`height` pair is not a substitute.
- [ ] The `--diagram` descriptions in `pilot.md` and `scribe.md` both name two accepted formats and mention `@path`, and the `scribe.md` CLI surface line no longer reads `[--diagram <mermaid>]`.

## Verification

- [ ] Read `diagram.md`, `pilot.md`, and `scribe.md` end to end after editing. Confirm every claim against the shipped code: check the lint messages against `packages/monitor/skills/cockpit/scripts/svg-lint.ts`, the token values and the sanitize policy against `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js`, and the scoping behaviour against `packages/monitor/skills/cockpit/dashboard/dist/modules/svg-scope.js`.
- [ ] Copy the worked example verbatim out of `diagram.md` into a temporary file. Run it through the CLI against an isolated home and confirm it exits zero:
      `COCKPIT_HOME=/tmp/cockpit-docs-check bun packages/monitor/skills/cockpit/scripts/cockpit.ts log --decision "docs example check" --reason "verify the documented SVG lints clean" --diagram @/tmp/docs-example.svg`
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` and confirm the suite is green.
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/diagram-docs.test.ts` — the token table and the exported constant agree in both directions.
- [ ] Run `git status --short` and quote it. Expect `packages/monitor/skills/cockpit/references/diagram.md`, `packages/monitor/skills/cockpit/references/pilot.md`, `packages/monitor/skills/cockpit/references/scribe.md`, and `packages/monitor/skills/cockpit/scripts/diagram-docs.test.ts`, plus at most this task file. Any OTHER path is a real scope violation.

## Eval rubric

> Every dimension is scored 0–5. Weighted average >= 4.0 to pass. `Accuracy vs shipped behaviour < 4` is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Accuracy vs shipped behaviour | ×3 | Documents a token, flag, or error message that does not exist in the code; the token table disagrees with the exported constant | Claims are broadly right but at least one was transcribed from the spec rather than checked against the code; the worked example was never run through the lint | Every claim was checked against the file that implements it; the worked example lints clean |
| Actionability for an agent author | ×2 | An agent cannot tell which format to use, or does not learn that remote references are stripped | The cases are listed but the anti-pattern or the stripping consequences are vague | An agent can decide Mermaid vs SVG without reading the source, and knows before writing what will be removed |
| Concision & style-guide fit | ×1 | Rambling prose; the term for one thing varies between sentences; the file's existing voice is broken | Readable but padded, or the condition trails the instruction | One instruction per sentence starting with a verb; condition before instruction; one term per thing; voice matches the surrounding file |

## Out of scope

- Any change to shipped code. Deferred. Reason: the CLI lint, the renderer, and the scoping pass are each written elsewhere, and this document describes their shipped behaviour. The drift-guard test is the sole file written here that is not documentation, and it only reads the two sources and compares them — it changes no behaviour.
- Documenting a size cap on `--diagram`. Deferred. Reason: no cap exists, by decision. Do not invent one in prose.
- Bumping any `plugin.json` version or editing `CHANGELOG.md`. Deferred. Reason: `/chronicle:release` owns both.
- Rewriting the existing Mermaid guidance — the type table, the layout discipline, the `:::class` palette. Deferred. Reason: that guidance is unaffected by this change, and editing it would put a Mermaid regression inside a documentation task.

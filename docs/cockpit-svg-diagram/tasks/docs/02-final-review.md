# DOCS-02: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: cli/01, cli/02, cli/03, ui/01, ui/02, ui/03, docs/01
> **Status**: todo
> **Final review**: true

## Goal

Confirm the whole raw-SVG escape hatch composes end to end, that no Mermaid behaviour regressed, and that the shipped code, tests, and documentation agree with each other.

## What this task reviews, and what it does not

This is the holistic gate. It does **not** re-score the individual units of work — each carried its own rubric and passed it. This task checks four things the per-unit rubrics structurally cannot see:

- **Integration** — the CLI, the renderer, and the documentation compose into one working path.
- **Regressions** — everything that worked before this feature still works identically.
- **Consistency across layers** — the code, the tests, and the documentation describe the same behaviour.
- **Meeting the goal** — an author can now attach a diagram Mermaid cannot express, and nothing outside the feature was put at risk to make that possible.

Fixes are in scope. When a check fails, repair it in the file that owns the behaviour, then re-run the full verification below. Do not paper over a failure by editing this task file.

## Files to create / modify

- No new files. This task produces a verdict.
- Any repair lands in the file that owns the defect: `packages/monitor/skills/cockpit/scripts/*.ts`, `packages/monitor/skills/cockpit/dashboard/dist/modules/*.js`, `packages/monitor/skills/cockpit/dashboard/dist/style.css`, or `packages/monitor/skills/cockpit/references/*.md`.
- Do not bump any `plugin.json` version. Do not touch `CHANGELOG.md`. A release is a separate, human-run step.

## Implementation notes

Work the four groups below in order. Each bullet is a concrete check with a concrete answer, not a judgement call.

### Group 1 — Integration: does the whole path compose?

- **Both formats survive a real round trip.** Write one entry carrying Mermaid source and one carrying raw SVG through `cockpit log --diagram`, then open the dashboard and confirm each renders as its own format: the Mermaid entry as a themed Mermaid diagram, the SVG entry as the author's own markup.
- **Sniffing happens exactly once, at write time.** Grep the frontend modules for any content inspection of the diagram string — a leading-character test, an `<svg` substring test, an XML-prolog test. There must be none. The renderer routes on the stored `diagram_format` field and nothing else. A second detection point is a defect even if it currently agrees with the first, because the two will drift.
- **`@path` resolves for both formats.** Write one entry with `--diagram @<file>.mmd` and one with `--diagram @<file>.svg`. Confirm both are accepted with no extension rule involved, and then read the resulting JSONL line: the stored value must be the file's **contents**, never the path string. A stored path would be unreadable to the browser, which has no access to the author's filesystem.
- **The stored field appears only where it should.** Read the JSONL lines written above. The SVG entry carries `diagram_format: "svg"`. The Mermaid entry carries no `diagram_format` key at all.
- **The CLI did not rewrite anything.** Compare the stored diagram string byte for byte against the source that was passed in. They must be identical — the CLI validates and never rewrites.

### Group 2 — Regressions: is anything that worked before now different?

- **A pre-existing entry still renders.** Take a decision-log line written before this feature existed — Mermaid source, no `diagram_format` key — and confirm it renders exactly as it did. An absent field means Mermaid; there is no migration and none should be needed.
- **A diagram-free record is byte-identical to before.** Write an entry with no `--diagram` at all. Its JSON must carry neither a `diagram` key nor a `diagram_format` key. The conditional-spread "lean shape" discipline is intact.
- **A Mermaid record is byte-identical to before.** Write an entry with `--diagram` carrying Mermaid source. Its JSON must carry `diagram` and no `diagram_format`. Diff it against the shape produced before this work; only the values differ.
- **The mermaid bundle is still lazy, and the SVG path never touches it.** Open the dashboard on a session whose only diagrams are SVG, with the browser network panel open. The ~3.3MB `vendor/mermaid.min.js` must never be requested. Then open a session with a Mermaid diagram and confirm it is requested exactly once, on first render.
- **The Mermaid failure fallback is unchanged.** Write an entry whose Mermaid source cannot render in the browser and confirm the card still shows the source directly, in the existing `<pre>`, not folded into a collapsed disclosure. The folded fallback belongs to the SVG path only.
- **The existing tests were not weakened.** Confirm the pre-existing lint and theme test files still assert what they asserted before — a test relaxed to accommodate new behaviour is a regression wearing a green tick.

### Group 3 — Consistency across layers

- **Tokens match, value for value.** Read the token table published in the authoring reference against the exported token constant in the renderer module. Every name and every hex value must match. A documented token that does not exist, or a value that drifted, sends an author's diagram off-theme with no error anywhere.
- **Quoted lint messages match emitted strings.** For every lint message reproduced in the documentation, find the string the code actually emits and confirm they are the same text. A documented message that does not match what the author sees is worse than no example.
- **The documented sanitize policy matches the code.** The forbidden tags, the allowed-URI rule, and the statement that the URI rule governs attributes but not CSS `url()` must all match the sanitize configuration as written.
- **The worked example lints clean.** Take the example SVG published in the authoring reference and pass it through the real CLI. It must be accepted with no problems reported. An example that fails the project's own lint is the fastest way to teach an author the wrong thing.
- **The documentation's framing survived.** Confirm the reference still presents Mermaid as the default and raw SVG as an escape hatch with a listed set of cases, rather than as two equal options.

### Group 4 — The security boundary

This is the one part of this work that can damage something outside the feature. Treat every check here as blocking.

**How to get these payloads onto a card.** The write-time lint rejects a remote `href`, a remote CSS `url()`, a `<script>`, an `on*` handler, and a `<foreignObject>` — that rejection is a feature, and it means the CLI can never produce the cards these checks need. Append each of these entries **directly** as a JSON line to the isolated home's `.cockpit/logs/<session>.jsonl`, with `diagram_format` set to `"svg"`, bypassing the gate. That is deliberate: this group verifies the browser-side boundary, which must hold on its own even if the CLI lint were absent, misconfigured, or bypassed by a hand-edited log. Only the hostile-`<style>` case can also arrive through the CLI, since the lint does not reject it.

- **A global style rule cannot escape its own SVG.** Write an entry whose SVG carries a hostile document-level rule, for example a `<style>` block declaring `rect { fill: red }` with no scoping of its own. Load the dashboard and confirm that other cards, the surrounding chrome, and any Mermaid diagram on the page are all visually untouched. Then inspect the injected style text and confirm the selector was rewritten to be prefixed by that SVG root's unique id selector.
- **No remote request fires on card render.** With the network panel open and filtered to remote hosts, render an SVG carrying all four surfaces at once: a remote `href` on an `<image>`, a remote `url()` inside a `<style>` declaration, a remote `url()` inside an inline `style` attribute such as `<rect style="fill:url(https://…)">`, and a remote `url()` in a presentation attribute such as `<rect fill="url(https://…)">`. Confirm zero requests to a remote host, and confirm all four references are gone from the rendered markup. Only the first is DOMPurify's job — its URI policy governs URI-valued attributes and never inspects CSS, so the other three all fall to the style-scoping pass. A hole in any one of the four is invisible from the other three. Then confirm the legitimate case still works: `fill="url(#gradient)"` referring to a gradient in the same SVG must render.
- **Script surfaces are stripped.** Render an SVG carrying a `<script>` element, an `on*` event-handler attribute, and a `<foreignObject>`. Confirm none survives into the DOM.
- **Unparseable rules were dropped, not passed through.** Feed the style-scoping pass a rule it cannot confidently rewrite and confirm the rule is absent from the output entirely. Fail-closed is the contract; a rule that survives unrewritten is a scoping hole regardless of whether that particular rule is harmless.
- **A `data:` image and a `#` fragment still work.** Confirm the tightened URI policy did not also break the legitimate cases: an embedded `data:image/png` renders, and an internal `#` fragment reference still resolves.

### Group 5 — Whole-tree verification

- The full test suite passes.
- **Scope.** Run `git status --short` and quote its full output. The paths this plan legitimately touches are: `packages/monitor/skills/cockpit/scripts/*`, `packages/monitor/skills/cockpit/dashboard/dist/modules/*`, `packages/monitor/skills/cockpit/dashboard/dist/style.css`, `packages/monitor/skills/cockpit/references/*.md`, and the plan's own files under `docs/cockpit-svg-diagram/`. Judge only the entries **outside** that set. Any such entry is a real scope violation and must be reverted or explained. Expect this task file itself to appear as modified — the runner edits it as bookkeeping, so its presence is normal and is not a violation.
- Confirm no `plugin.json` version changed and `CHANGELOG.md` is untouched.

## Acceptance criteria

- [ ] A Mermaid entry and a raw-SVG entry, both written through the CLI, each render as their own format in the dashboard.
- [ ] Content sniffing exists in exactly one place, the CLI; no frontend module inspects the diagram string to decide its format, and the stored diagram string is byte-identical to what was passed in.
- [ ] `--diagram @<path>` is accepted for both a Mermaid file and an SVG file, with no extension rule, and the resolved file **contents** are what the JSONL stores.
- [ ] A record with no diagram carries neither `diagram` nor `diagram_format`; a record with Mermaid carries `diagram` only; `diagram_format` appears only for SVG; and a pre-existing Mermaid entry with no format key renders exactly as before.
- [ ] The mermaid bundle is requested only when a Mermaid diagram renders, never for an SVG-only session, and the Mermaid failure fallback still shows the source directly.
- [ ] Every published token name and hex value matches the renderer's exported constant; every lint message quoted in the documentation matches the emitted string; the documented sanitize policy matches the code; and the documentation's worked example lints clean through the real CLI.
- [ ] A hostile document-level `<style>` inside a card SVG leaves every other card and the surrounding chrome visually untouched, and its selector is verifiably prefixed with the **SVG root's** id — not the surrounding figure's, which does not travel into a downloaded file; a rule the pass could not rewrite is absent from the output.
- [ ] Rendering a card fires no request to a remote host: a remote `href` and a remote CSS `url()` are both stripped, as are `<script>`, `on*` handlers, and `<foreignObject>`; a `data:` image and a `#` fragment still work.
- [ ] `bun test packages/monitor/skills/cockpit/scripts/` passes, no `plugin.json` version changed, `CHANGELOG.md` is untouched, and `git status --short` shows no path outside the set named in the implementation notes.

## Verification

- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` and confirm the whole suite passes, including the pre-existing lint and theme test files.
- [ ] Start an isolated daemon — `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999` — and never start or restart the user's real daemon on port 5858.
- [ ] Against that daemon, write three entries through the CLI: one carrying Mermaid source, one carrying clean raw SVG, and one carrying SVG with a hostile document-level `<style>` block. Open the dashboard and confirm each behaves as specified in the implementation notes.
- [ ] Exercise the renderer's failure path by appending an entry **directly** as a JSON line to that isolated home's `.cockpit/logs/<session>.jsonl`, with `diagram_format` set to `"svg"` and `diagram` set to markup that cannot yield an SVG root — `<div>not a diagram</div>` is the reliable choice. The write-time lint rejects this by design, so a CLI-written entry can never reach the dashboard in that state. Confirm the card shows the one-line notice with a collapsed `<details>` holding the source.
- [ ] On the clean SVG card, confirm enlarge opens the lightbox and download saves a file. On the broken SVG card, confirm the failure notice appears with the source folded into a collapsed disclosure rather than shown directly.
- [ ] Open the downloaded SVG standalone, outside the dashboard, and confirm its theme colours still resolve — a file that renders colourless means the token declarations did not travel with it.
- [ ] Write one more entry with `--diagram @<path>` pointing at an SVG file, then read the JSONL line and confirm the stored value is the file's contents, not the path.
- [ ] With the browser network panel open and filtered to remote hosts, reload the dashboard and confirm zero remote requests on card render, and that `vendor/mermaid.min.js` is fetched only for the Mermaid card.
- [ ] Run `git status --short` and quote its full output. Expect paths under `packages/monitor/skills/cockpit/` (scripts, dashboard modules, `style.css`, references) and under `docs/cockpit-svg-diagram/`, plus at most this task file. Any OTHER path is a real scope violation.
- [ ] Confirm by inspection that no `plugin.json` `version` field changed and that `CHANGELOG.md` has no diff.

## Eval rubric

> Scale and dimension definitions: see `../_context/rubric.md`. Each dimension 0–5; weighted average >= 4.0 to pass. `Meets the plan goal < 4` is an automatic veto. These dimensions score the whole deliverable, not the individual units of work.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration / does it compose | ×3 | A format written by the CLI does not render, or the renderer sniffs content instead of routing on the stored field | Both formats render, but `@path` stores the wrong thing, or the stored field appears on Mermaid entries too | Both formats round-trip through CLI, storage, and renderer; detection happens exactly once at write time; `@path` stores resolved contents for both formats |
| No regressions | ×3 | A pre-existing Mermaid entry renders differently, or a diagram-free record's JSON shape changed | Records are shape-identical but the mermaid bundle now loads for SVG-only sessions, or the Mermaid failure fallback changed | Pre-existing entries render identically, every record shape is byte-identical to before, the bundle stays lazy, the Mermaid fallback is untouched, and no existing test was relaxed |
| Meets the plan goal | ×2 | An author still cannot attach a diagram Mermaid cannot express, or doing so puts the surrounding dashboard at risk | The escape hatch works but a security check fails — a style rule escapes its figure, a remote request fires, or an unrewritable rule passes through | An author can attach raw SVG end to end; author styles are provably confined to their figure, no remote request fires on render, script surfaces are stripped, and the pass drops what it cannot rewrite |
| Consistency across layers | ×2 | A documented token, message, or policy does not exist in the code, or the worked example fails the project's own lint | Documentation is accurate but drifted in detail — a stale hex value, a paraphrased lint message, or Mermaid no longer framed as the default | Tokens, lint messages, and sanitize policy match the code exactly; the worked example lints clean; Mermaid is still framed as the default with SVG as a listed-case escape hatch |

## Out of scope

- **Re-scoring the individual units of work.** Deferred. Each carried its own rubric and passed it; this gate scores integration, regressions, consistency, and whether the goal was met.
- **Bumping any `plugin.json` version or writing a `CHANGELOG.md` entry.** Deferred. Releases are cut separately by a human-run release step.
- **Adding a size cap on the diagram argument.** Deferred by an explicit interview decision; revisit only if a real entry makes the log replay visibly slow.
- **Solving global `@keyframes` name collisions between two SVGs.** Deferred. The scoping pass prefixes selectors, not keyframe names; this is documented rather than solved, and no known case exists.
- **Recolouring author SVG to match the theme.** Deferred by an explicit interview decision. The author opts in with `currentColor` or `var(--token)`; no heuristic maps their colours.

# UI-01: SVG render path, sanitize policy and theme tokens

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: cli/01
> **Blocks**: ui/03
> **Status**: todo

## Goal

The diagram renderer accepts a stored format, renders raw SVG without touching Mermaid, sanitizes both paths under one tightened policy, and downloads a standalone file whose theme tokens still resolve.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js` (modify) — format routing in `renderDiagram`, one tightened sanitize config, the new `NIGHT_FLIGHT_TOKENS` export, token injection in `standaloneSvg`.
- `packages/monitor/skills/cockpit/scripts/diagram-theme.test.ts` (modify) — guard the new constant with the same hex-only discipline already applied to the mermaid theme.
- `packages/monitor/skills/cockpit/scripts/diagram-render.test.ts` (new) — every behavioural assertion below that is not about the token constant: format routing, each failure return, the tightened URI policy, mermaid output unchanged under it, and the standalone token injection. The theme test guards a constant; these need their own file rather than being smuggled into it.

## Implementation notes

### Public surface after this task

```js
// format defaults to "mermaid" so every existing call site and every stored
// entry behaves exactly as before.
export async function renderDiagram(text, format = "mermaid")
// → { ok: true, svg } | { ok: false, error }

// custom-property name → concrete hex
export const NIGHT_FLIGHT_TOKENS
```

### Routing

`renderDiagram` gains a second parameter. It defaults to `"mermaid"`, which is what makes this change invisible to callers that pass one argument and to entries stored before the format field existed.

The `"svg"` branch must not touch mermaid **at all**. It must not call the mermaid loader, must not read the cached mermaid promise, and must not cause `../vendor/mermaid.min.js` to be injected. This is a testable claim, not a stylistic preference: the bundle is ~3.3MB, and a session whose diagrams are all SVG should never pay for it. Write the branch so the mermaid loader is unreachable from it, and assert in a test that rendering an SVG leaves no `<script>` pointing at the mermaid bundle in `document.head` and leaves the module's mermaid promise unset.

### The SVG branch

Trim, sanitize, return. Name these failure states explicitly and return `{ ok: false, error }` for each — this function never throws, matching the behaviour the Mermaid path already guarantees:

1. **Empty after trim** — nothing was passed, or only whitespace.
2. **Nothing left after sanitize** — the sanitizer removed everything, which is what happens when the input was not markup at all.
3. **No `<svg>` root in the sanitized result** — the input was markup but not an SVG document, or the root element was stripped.

Each `error` string should be short and say which of the three happened, so the card's failure notice can show it.

The SVG branch does **not** touch the author's markup beyond sanitizing. No recolouring, no attribute rewriting, no re-serialization beyond what the sanitizer performs.

### One sanitize config for both paths

Both formats go through the same call:

```js
DOMPurify.sanitize(svg, {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["foreignObject", "script"],
  ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpe?g|gif|webp|svg\+xml);|#)/i,
});
```

Applying the tightened policy to the Mermaid path too is safe, and keeping one config is why it is worth doing. The policy is strictly narrower than the one in place today, and mermaid running under `securityLevel: "strict"` emits no external references — no remote `<image>`, no remote `<use>`, no remote font. So nothing in mermaid's output can be caught by the new rule. Verify that claim rather than assuming it: render a mermaid diagram before and after the config change and compare the sanitized output.

The limit that must not be forgotten: **`ALLOWED_URI_REGEXP` governs attributes only.** It does not reach `url()` or `@font-face src` inside a `<style>` element. A remote font referenced from CSS passes straight through this config. Stripping those belongs to the style-scoping pass, which is a separate unit of work — do not try to solve it here, and do not leave a comment implying this config covers it.

Keep the sanitize helper lazy: it already imports `../vendor/purify.es.mjs` inside the function, and that must stay inside the function.

### A hook shared across modules must be confirmed, not assumed

`packages/monitor/skills/cockpit/dashboard/dist/modules/transcript.js` imports the **same** `../vendor/purify.es.mjs` module instance and registers a global hook:

```js
DOMPurify.addHook("afterSanitizeAttributes", (node) => { /* forces target="_blank" + safe rel on links */ });
```

Because ES module instances are shared, that hook also runs during diagram sanitization, including on `<a>` elements inside an author's SVG. It is *believed* harmless — it only adds attributes to links — but this task changes the sanitize policy, so the interaction has to be checked rather than inherited as folklore.

Sanitize an SVG containing an `<a>` element, observe what the hook does to it, and record the finding as a comment next to the sanitize helper. State what you observed, not what you expected. If the hook does something the diagram path should not inherit, stop and report it rather than silently working around it.

### Theme tokens

Add exactly this constant:

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

Every value already appears as a hex literal elsewhere in the same file, inside the mermaid theme object or the semantic-node palette. They are the sRGB renderings of the `oklch()` tokens declared on `:root` in `packages/monitor/skills/cockpit/dashboard/dist/style.css`. Drift between the two means an off-theme diagram, never a broken one — say so in a comment so a later reader does not treat a mismatch as a bug to panic about.

The constant exists because it has two consumers that must not disagree: the standalone download below, and the token table published to diagram authors in the reference documentation. A second hand-maintained copy in either place is the failure this constant prevents.

### Standalone download

`standaloneSvg(svg)` today parses the SVG, sets `xmlns`, and sets the root's `backgroundColor` to `#0e101f` so a downloaded file is readable outside the cockpit's dark page. Preserve that behaviour exactly.

Add one thing: inject a `<style>` block into the serialized root that declares every `NIGHT_FLIGHT_TOKENS` entry plus a root `color`. Shape:

```
svg { --space: #0e101f; --hull: #171929; … ; color: #edeef4; }
```

Without it, an author who wrote `fill="var(--aurora)"` or `stroke="currentColor"` gets an uncoloured file, because a downloaded SVG no longer inherits the card's custom properties.

Declaring the tokens is deliberately chosen over the alternative of walking the live SVG, reading each element's computed `fill` / `stroke` / `color`, and baking literal values onto the markup. The declaration is one string that cannot desynchronise from what the card renders, and it leaves the author's markup untouched — which is the same no-rewriting rule the render path follows.

Pick the root `color` value from the tokens map rather than repeating a hex literal.

### Lazy-DOM discipline

Everything DOM-bound stays inside a function. `DOMParser`, `XMLSerializer`, `document`, and the DOMPurify import must not move to module top level. The module's static surface has to remain importable under plain Bun with no DOM, because a test imports it directly to assert exactly that. Adding a plain object constant does not threaten this, but a helper that touches `document` at module scope would.

## Acceptance criteria

- [ ] `renderDiagram(text)` called with one argument behaves exactly as it does today — same mermaid render, same return shape, same stray-node cleanup on parse failure.
- [ ] Rendering with `format` set to `"svg"` never loads the mermaid bundle. Assert this on the externally observable effect only: after the render resolves, `document.querySelectorAll("script")` contains no element whose `src` ends in `mermaid.min.js`, and `globalThis.mermaid` is still undefined. Do not assert on the module's private cached promise — it is not exposed, and adding a seam just to observe it would widen the public surface for a test.
- [ ] The SVG branch returns `{ ok: false, error }` — never throws — for each of: empty after trim, nothing left after sanitize, and a sanitized result with no `<svg>` root. The `error` string identifies which case occurred.
- [ ] An SVG containing `<image href="https://example.com/x.png">` comes back with that remote reference stripped, while an `<image href="data:image/png;base64,…">` survives.
- [ ] Mermaid output is unchanged under the tightened sanitize config, demonstrated by comparing sanitized output before and after the change across a spread wide enough to exercise the parts of mermaid's output the policy could touch: a flowchart with `:::class` markers, a `stateDiagram-v2`, a `sequenceDiagram` with a note, a `classDiagram`, and one diagram carrying an edge label with punctuation. Record in the test file what the spread covers and, explicitly, that it is a sample rather than every supported diagram type — a reader must not mistake it for exhaustive.
- [ ] The behaviour of the shared `afterSanitizeAttributes` hook on an `<a>` inside an SVG has been observed and recorded in a comment beside the sanitize helper, stating what was observed.
- [ ] `NIGHT_FLIGHT_TOKENS` is exported, every value is a concrete hex string, no value contains `oklch` or `var(`, and a test in `packages/monitor/skills/cockpit/scripts/diagram-theme.test.ts` asserts this.
- [ ] A downloaded standalone file carries a `<style>` block declaring every `NIGHT_FLIGHT_TOKENS` entry plus a root `color`, and still sets the `#0e101f` background on the root.
- [ ] `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js` still imports cleanly under plain Bun with no DOM present.

## Verification

- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/diagram-theme.test.ts` — passes, including the new constant guard.
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/diagram-render.test.ts` — the routing, failure-return, URI-policy and standalone-injection assertions all pass. Stand up happy-dom the same way `diagram-lint.ts` does when a check needs a DOM.
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` — the whole suite is green, with no change in the count of pre-existing failures.
- [ ] Start an isolated daemon with `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999`, open a card carrying an SVG that uses `fill="var(--aurora)"` and `stroke="currentColor"`, download it from the lightbox, then open the saved file directly in a browser and confirm both colours still resolve. Do not touch the daemon on port 5858.
- [ ] Run `git status --short` and quote the output. Expect `packages/monitor/skills/cockpit/dashboard/dist/modules/diagram.js`, `packages/monitor/skills/cockpit/scripts/diagram-theme.test.ts`, `packages/monitor/skills/cockpit/scripts/diagram-render.test.ts`, plus at most this task file. Any OTHER path is a real scope violation — judge those entries, not these.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average >= 4.0 to pass. Correctness < 4 is an automatic veto, and Sanitize & scoping boundary < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | one-argument `renderDiagram` behaves differently than before, or the SVG branch throws | SVG renders but a named failure state is unhandled, or the SVG branch still reaches the mermaid loader | routing, all three failure returns, and the untouched mermaid path all match the spec |
| Sanitize & scoping boundary | ×3 | a remote URI survives sanitization, or a `<script>` or event handler survives | the tightened config is in place but was never tested against a hostile input, or the shared hook was assumed harmless rather than observed | remote URIs stripped, `data:` images kept, hostile input covered by a test, shared-hook behaviour observed and recorded |
| Test coverage | ×2 | no test for the SVG branch | happy-path SVG only | failure returns, the remote-URI strip, the no-mermaid-load claim, and the token constant are all asserted |
| Interface & readability | ×1 | DOM-bound work moved to module top level, breaking the plain-Bun import | works but the token map is duplicated, or the sanitize config is copied per branch | one sanitize config, one token map, all DOM work lazy, rationale comments explain the non-obvious constraints |

## Out of scope

- **Scoping an author's `<style>` element.** Deferred. Reason: it is a separate module with its own CSS-rewriting contract and its own tests; this task's sanitize config deliberately does not reach inside `<style>`.
- **Card markup, the failure notice UI, and the stylesheet.** Deferred. Reason: this task ends at the renderer's return value; how a card presents that value is a later unit of work.
- **Recolouring an author's SVG onto the palette.** Rejected during design, not merely deferred. Reason: the author opts into the theme by writing `currentColor` or `var(--token)`, and a heuristic recolour would break layered fills, gradients, and masks with no escape hatch for the author.

# UI-03: Card integration, failure fallback and lightbox

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: ui/01, ui/02
> **Blocks**: docs/01
> **Status**: todo

## Goal

A decision card carrying a raw SVG renders it scoped inside its figure, enlarges and downloads like a Mermaid diagram, and degrades to a compact collapsed fallback when it cannot be shown.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/modules/decision-log.js` (modify) — format-aware card markup and mount.
- `packages/monitor/skills/cockpit/dashboard/dist/style.css` (modify) — the SVG figure and the collapsed fallback.

## Implementation notes

### What exists today, exactly

Card HTML is built once and never re-run — the same discipline as the rest of `decision-log.js`. Around line 394, when a record carries a diagram, the card builder emits one figure holding the escaped source:

```js
const diagram = rec.diagram
  ? `<figure class="decision-card__diagram" data-pending>
       <pre class="decision-card__diagram-src">${esc(rec.diagram)}</pre>
     </figure>`
  : "";
```

That string is interpolated into `card.innerHTML`, and immediately after the assignment the builder calls `mountDiagram(card, rec.diagram)`.

`mountDiagram(card, source)` (around line 422) then does this:

```js
async function mountDiagram(card, source) {
  const figure = card.querySelector(".decision-card__diagram");
  if (!figure) return;
  const result = await renderDiagram(source);
  if (result.ok) {
    figure.innerHTML = result.svg;
    figure.removeAttribute("data-pending");
    figure.classList.add("is-zoomable");
    figure.setAttribute("role", "button");
    figure.setAttribute("tabindex", "0");
    figure.setAttribute("aria-label", "Enlarge diagram");
    const title =
      card.querySelector(".decision-card__decision")?.textContent || "";
    figure.addEventListener("click", () => openDiagramLightbox(result.svg, title));
    figure.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDiagramLightbox(result.svg, title);
      }
    });
    requestAnimationFrame(updateCompactDecisionSize);
  } else {
    figure.removeAttribute("data-pending");
    figure.setAttribute("data-failed", "");
  }
}
```

Two details in there are easy to drop and both matter. The `requestAnimationFrame(updateCompactDecisionSize)` call reflows the compact decision layout once the figure has real dimensions; keep it on the success path for both formats. And `title` seeds the lightbox's download filename, so it must still be read from the card headline on the SVG path.

The relevant CSS lives around lines 1707–1790 of `style.css`:

- `.decision-card__diagram` — the recessed instrument panel: `padding: 12px`, `background: var(--space)`, `border: 1px solid var(--edge)`, `overflow-x: auto`.
- `.decision-card__diagram svg` — `display: block; max-width: 100%; height: auto; margin-inline: auto`.
- `.decision-card__diagram::before` — the `DIAGRAM` caption.
- `.decision-card__diagram-src` — the monospace source block.
- `.decision-card__diagram[data-failed]` — a danger-tinted border, plus a `::after` whose literal content is `Couldn’t render — showing source`.
- `.decision-card__diagram.is-zoomable` — `cursor: zoom-in` plus an `::after` `⤢` hint revealed on hover and focus.

### Route on the stored format, never on the content

The record's stored format field decides the path. An **absent** field means Mermaid. Detection already happened once, at write time, in the CLI; the card renderer must never inspect the diagram text to guess what it is. Every entry written before this feature existed carries no format field and must therefore render exactly as it does today.

### The Mermaid path is untouched

Leave the Mermaid branch — its markup, its pre-JS `<pre>` fallback, its failure presentation — byte-for-byte as it is. The temptation to unify the two paths into one code path is the single largest regression risk in this task. Two branches that share a helper are fine; one branch that "handles both" by conditionals sprinkled through the Mermaid logic is not.

### The SVG path

Give the SVG figure an empty body:

```html
<figure class="decision-card__diagram decision-card__diagram--svg" data-pending></figure>
```

No `<pre>` in the initial markup. Several hundred lines of escaped XML sitting in the card until the render resolves is not a graceful fallback; it is a flash of a wall of text.

**The unique id goes on the `<svg>` root element, not on the figure.** Set it on the rendered root before scoping, from a module-level monotonic counter — `cockpit-svg-3`, `cockpit-svg-4`, and so on. Use no `Math.random()`. This mirrors the id generator the Mermaid renderer already uses, for the same reason: an id-scoped style block must not collide across cards, and a deterministic id keeps the markup reproducible between runs.

The choice of the root rather than the figure is load-bearing, not cosmetic. The download button serialises the SVG element on its own — the figure does not travel with it. Scoping to the figure's id would produce rules like `#cockpit-svg-3 rect { … }` that match nothing once the file is opened standalone, and the author's styling would silently vanish from every downloaded diagram. With the id on the root, the same selector resolves in both places.

### Ordering is load-bearing: scope before the styles can take effect

After the renderer returns sanitized markup, the style-scoping pass must rewrite every rule in the SVG's `<style>` elements to be prefixed by that SVG root's own id selector **before** the markup is live in the document.

The current line `figure.innerHTML = result.svg` attaches immediately. By the time the render promise resolves the card is already in the DOM, so assigning `innerHTML` and *then* scoping leaves a window — however brief — in which an author's `rect { fill: red }` is a live, document-wide rule repainting every other card.

Build the markup in a detached element, run the scoping pass over it, and only then move it into the attached figure. Any other approach is acceptable only if it guarantees the same ordering. Encode the reason in a comment; a future reader who reorders these two lines for tidiness reintroduces the hole.

Pass the SVG root's own id selector — `#cockpit-svg-3`, matching the id set above — as the scope.

### Failure UI: a notice, with the source folded away

On the SVG path, a failed render shows a one-line notice plus the source inside a **collapsed** `<details>`:

```html
<div class="decision-card__diagram-notice">Couldn’t render this SVG</div>
<details class="decision-card__diagram-details">
  <summary>Show source</summary>
  <pre class="decision-card__diagram-src">…escaped source…</pre>
</details>
```

Escape the source with the module's existing `esc()` helper. The `<details>` must have no `open` attribute.

The split from the Mermaid path is deliberate. Mermaid source is a dozen readable lines, so showing it directly is a genuine fallback that an author can act on at a glance. Several hundred lines of XML in a decision column is not a fallback; it is a wall that buries every card below it. The Mermaid path therefore keeps showing its source directly, and only the SVG path folds.

The existing `[data-failed]::after` content string reads `Couldn’t render — showing source`. That sentence is false on the SVG path, where the source is hidden until the reader opens the disclosure. Scope the existing rule so it no longer applies to an SVG figure, and let the new notice element carry the SVG wording instead. Do not change the Mermaid wording.

### Lightbox and download need no special-casing

The overlay already accepts a sanitized SVG string plus a title, and the download path already serializes whatever string it was handed. Pass the scoped SVG markup — the exact markup in the card, not a re-render — so what is saved matches what is displayed.

One behaviour to confirm rather than assume: to blow the diagram up, the overlay strips the SVG's inline `width`, `height` and `max-width` and lets CSS scale it. That only works when the SVG has a `viewBox` to scale by. The write-time lint requires one outright — a width/height pair is not accepted as a substitute — so this shape should never reach the dashboard through the CLI. Confirm the enlarge path works on a `viewBox`-carrying SVG, and note in a comment that the affordance depends on that attribute, so a future loosening of the lint does not quietly break enlargement.

### CSS

- The figure must contain its content. An oversized SVG must not overflow the card or force the decision column to scroll horizontally. `overflow-x: auto` and `max-width: 100%` already exist on the figure and its `svg` child; confirm they still win for an author SVG. Note that an inline `style="width:2000px"` on the author's root element beats a stylesheet rule, so the containment may need an explicit override on the SVG-figure variant.
- Style the notice and the disclosure so they read as an instrument readout, not an error dump: monospace at the same 11px scale as the existing source block, muted ink for the summary, the danger token used only for the border tint and the notice line.
- Reuse the Night Flight custom properties already declared on `:root` — `--space`, `--edge`, `--ink-muted`, `--ink-faint`, `--danger`, `--font-mono`, `--radius-sm`. Define no new colours and add no new token.

## Acceptance criteria

- [ ] A stored entry with no format field renders through the Mermaid path, and its markup, fallback `<pre>`, and failure presentation are unchanged from before this task.
- [ ] The rendered `<svg>` root — not the figure — carries a unique `id` produced by a monotonic counter, with no `Math.random()` anywhere in its generation; two SVG cards on one page have different ids.
- [ ] The scoping pass runs against that SVG root's id selector while the markup is still detached, so no author rule is ever live against the document.
- [ ] An SVG whose `<style>` contains a bare `rect { fill: red }` leaves a sibling card's rendered diagram visually unaffected.
- [ ] A failed SVG render shows a one-line notice and a `<details>` that is collapsed by default, with the escaped source inside it.
- [ ] The Mermaid failure state still shows its source directly and still reads `Couldn’t render — showing source`; that string does not appear on an SVG figure.
- [ ] Clicking or pressing Enter on a rendered SVG figure opens the lightbox, and the download button saves the same markup shown in the card.
- [ ] An SVG declaring a width far wider than the card neither overflows the card nor makes the decision column scroll horizontally.

## Verification

- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` — the whole suite is green, including the pre-existing `diagram-lint.test.ts` and `diagram-theme.test.ts`.
- [ ] Start an isolated daemon — never the user's real one on port 5858:
      `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999`
- [ ] Write three entries through the CLI against that daemon and open the dashboard: one Mermaid diagram, one clean SVG, and one SVG carrying a global `<style>` rule such as `rect { fill: red }`. Confirm the Mermaid card is unchanged, the clean SVG renders and enlarges, and the hostile rule does not repaint the Mermaid card.
- [ ] Verify the failure state by appending an entry **directly** as a JSON line to that isolated home's `.cockpit/logs/<session>.jsonl`, with `diagram_format` set to `"svg"`. The write-time lint rejects bad SVG by design, so a CLI-written entry can never reach the dashboard in this state — appending the line is the only way to exercise the renderer's own failure path. Set `diagram` to markup that cannot survive as an SVG root; `<div>not a diagram</div>` is the reliable choice. Merely malformed XML is not: the sanitizer may repair it into something with an `<svg>` root, which then renders successfully and proves nothing. Confirm the card shows the one-line notice with a `<details>` that is collapsed by default.
- [ ] Enlarge the clean SVG and use the download button. Open the saved file and confirm it is the same drawing shown in the card. Use an SVG whose own `<style>` colours a shape, so the saved file proves the scoped selector still resolves once the figure is gone.
- [ ] Run `git status --short` and quote the output. Expect `packages/monitor/skills/cockpit/dashboard/dist/modules/decision-log.js`, `packages/monitor/skills/cockpit/dashboard/dist/style.css`, and this task file. Any OTHER path is a real scope violation.

## Eval rubric

> Each dimension is scored 0–5. Weighted average must be >= 4.0 to pass. Hard-fail veto: Correctness < 4 is an automatic veto, and Sanitize & scoping boundary < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A stored Mermaid entry renders differently than before, or the format routing inspects the diagram text instead of the stored field | SVG renders but a detail drifts — the reflow call is dropped, the lightbox title is lost, or the `<details>` ships open | Both paths behave exactly as specified, Mermaid is untouched, and the SVG failure state is collapsed with its source inside |
| Sanitize & scoping boundary | ×3 | Markup is attached before scoping, so a global rule is briefly live; or an author `<style>` rule matches outside its own SVG | Scoping runs before attachment but the id is unsound — reused across cards, or drawn from `Math.random()` — so collisions or non-reproducible markup are possible | Markup is scoped while detached, the id is set on the SVG root and unique on the page, and a hostile rule provably cannot reach a sibling card |
| Test coverage | ×2 | No check that a hostile `<style>` is contained | Only the benign SVG is exercised; the hostile and the malformed cases are untested | The live check covers the clean, hostile, malformed, and oversized cases, and the existing suite still passes |
| Interface & readability | ×1 | The two format paths are fused into one conditional-riddled function | Paths are separate but the ordering constraint is undocumented, inviting a future reorder | Branches are cleanly separated, and the scope-before-attach ordering carries a comment naming what it prevents |

## Out of scope

- The diagram renderer itself and the sanitize configuration it applies — Deferred. Reason: that is a separate unit of work in this bucket; this task consumes its `{ ok, svg }` result and does not change how the markup is produced or cleaned.
- The style-scoping algorithm — Deferred. Reason: also a separate unit of work; this task only calls it, against the right selector, at the right moment.
- A size cap on diagram source — Deferred by an explicit product decision. Reason: no cap exists anywhere in the pipeline, and adding one here would put the limit in the wrong layer.
- Any change to the CLI, the record shape, or the write-time lint — Deferred. Reason: this task touches only the two frontend files listed above.

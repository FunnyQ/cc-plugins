# UI-02: Scope author SVG styles to their figure

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: ui/03
> **Status**: todo

## Goal

Author CSS inside a supplied SVG — in a `<style>` element or an inline `style` attribute — can only ever match elements inside that one SVG, and can never fetch a remote resource.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/modules/svg-scope.js` (new) — the scoping pass.
- `packages/monitor/skills/cockpit/scripts/svg-scope.test.ts` (new) — tests, run under happy-dom.

## Implementation notes

### The hazard this task exists to prevent

A `<style>` element inside inline SVG is a **document-level** style element once the SVG is inserted into an HTML page. It is not scoped to the SVG subtree. That is a property of HTML, not a bug in any library.

Mermaid's output is immune because mermaid emits id-scoped rules:

```css
#cockpit-mmd-3 .node rect { fill: #222537; }
```

A hand-authored or Excalidraw-exported SVG carries no such discipline. One decision card holding this:

```html
<style>rect { fill: #fff }</style>
```

repaints every `rect` in the dashboard — other cards, the transcript, the chrome. DOMPurify's SVG profile **permits** the `style` tag, so sanitization alone does not stop this. Nothing in the existing pipeline closes this hole. This pass is the thing that closes it.

### The function

```js
// Rewrites every <style> inside `svgEl` in place so its rules can only match
// inside `scopeSelector` (e.g. "#cockpit-svg-3"). Mutates and returns svgEl.
export function scopeSvgStyles(svgEl, scopeSelector)
```

`svgEl` is a live element, already sanitized, not yet attached to the card. `scopeSelector` is the id selector of **`svgEl` itself** — the caller sets a unique id on the SVG root before calling, and passes `#<that-id>`. Mutate in place and return the same element, so the caller can chain or ignore the return value.

The scope anchor is the SVG root rather than the surrounding figure for a reason worth keeping: the download button serialises the SVG element alone, without the figure. Rules anchored to a figure id would resolve inside the card and match nothing in the saved file, so an author's styling would silently disappear from every download. Anchored to the root, the same selector works in both places.

### The contract — behaviour, not mechanism

Pick whichever mechanism satisfies these. The tests assert the behaviour.

- **Prefix every rule's selector with `scopeSelector`.** `rect { … }` becomes `#cockpit-svg-3 rect { … }`.
- **Rewrite a selector list member by member.** `rect, circle { … }` becomes `#cockpit-svg-3 rect, #cockpit-svg-3 circle { … }`. Prefixing the list as a whole would produce `#cockpit-svg-3 rect, circle`, silently leaving `circle` global — the exact leak this task prevents, hidden behind a rule that looks scoped.
- **Rewrite rules nested inside `@media` in place.** The `@media` wrapper survives; its inner rules are prefixed like any other.
- **Fail closed, against an explicit grammar.** "Cannot confidently rewrite" is not a testable condition, so enumerate what survives and drop everything else. This is a security boundary; an evaluator needs an unambiguous pass condition.

  **Survives** — and only this:
  - A style rule whose selector is a comma-separated list of compound selectors built from element names, `.class`, `#id`, `[attr]` / `[attr=value]`, and the descendant, `>`, `+` and `~` combinators, optionally with pseudo-classes and pseudo-elements attached.
  - `@media`, whose inner rules are each rewritten by the rule above.

  **Dropped, without exception:**
  - `@keyframes`, `@font-face` with a non-`data:` `src`, `@import`, `@supports`, `@namespace`, `@layer`, `@container`, `@scope`, `@property`, and any at-rule not named above. An unknown at-rule is dropped precisely *because* it is unknown.
  - Any rule whose selector text the pass cannot fully tokenise — this includes a selector containing an unbalanced bracket or paren, a CSS escape sequence (`\`), or a string literal.
  - Any rule reached only through a construct the pass does not model, such as a nested rule inside a style rule.

  Adversarial cases the tests must cover, because each is browser-valid and each is a plausible way to slip a rule past a naive implementation: a comment splitting a selector (`re/*x*/ct { … }`), a string containing a brace (`[title="a{b"] { … }`), a nested function in a value (`fill: var(--x, url(https://…))`), a selector using an escape (`.a\.b { … }`), and an `@supports` block wrapping an otherwise ordinary rule. Each must end up **absent** from the output — not present unchanged, not partially rewritten.

  Dropping a rule costs the author some styling on their own diagram. Passing one through costs every other card on the page.
- **Remove any `url()` in a declaration that is not a `data:` URI or a `#` fragment.** This belongs here, not in the sanitizer: DOMPurify's `ALLOWED_URI_REGEXP` governs **URI-valued attributes only** and never reaches CSS text, so a `url()` inside `<style>` sails straight through sanitization. Relative counts as removable, not just remote — it would resolve against the dashboard's own origin.
- **Apply the same `url()` rule to every inline `style` attribute in the subtree.** `<rect style="fill:url(https://example.com/x.svg)">` is CSS living in an attribute: `ALLOWED_URI_REGEXP` does not inspect it because `style` is not a URI-valued attribute, and a pass that only walks `<style>` elements never sees it. That leaves a remote fetch on card render — the one thing this feature promises cannot happen. Walk `svgEl.querySelectorAll("[style]")` as well, and strip disallowed `url()` values from each. Scoping does not apply here (an inline style cannot leak past its element); only the URI rule does.
- **Apply it a third time, to SVG presentation attributes that take a `url()` value.** `<rect fill="url(https://example.com/p.svg#g)">` is the same fetch through yet another door: `fill` is a presentation attribute, not a URI-valued one, so the sanitizer's URI policy does not govern it either. Walk this attribute set on every element in the subtree and strip any `url()` that is not a `#` fragment: `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-start`, `marker-mid`, `marker-end`, `marker`, `fill-opacity`-adjacent paint servers via `paint-order` are not URL-bearing and need no check. A `url(#gradient)` fragment — the overwhelmingly common legitimate use, pointing at a `<linearGradient>` in the same document — must survive untouched.

Three surfaces, three doors, one rule. Write the URI predicate once and call it from all three walks; three copies of the same regex is how one of them ends up looser than the others.
- **Drop `@font-face` entirely when its `src` is not a `data:` URI.** A remote font is a remote fetch from a decision card.
- **Remove a `<style>` element that ends up with no surviving rules.** An empty `<style>` is noise in the DOM and reads as though something survived.

One consequence of prefixing as a descendant combinator: a rule targeting the root element itself, such as `svg { background: … }`, becomes `#cockpit-svg-3 svg` and matches nothing, because the root is not its own descendant. That is a silent no-op, not a leak, so it is acceptable. Record it in the module comment and let the authoring documentation tell authors to style a wrapping `<g>` rather than the root.

### Resolve this before choosing an implementation

The natural implementation is CSSOM: build a stylesheet from the `<style>` text, walk `cssRules`, rewrite each `selectorText`, serialize back. Whether happy-dom's CSSOM is complete enough to drive that **in a test** is unverified — check it first.

Write a throwaway probe under Bun that constructs a stylesheet from a small CSS string containing a plain rule, a selector list, an `@media` block, and an `@font-face`, then inspect what `cssRules` actually exposes. Decide from the result:

- **happy-dom's CSSOM is sufficient** — use it. `selectorText` rewriting is the least error-prone route and inherits the browser's own parsing.
- **happy-dom's CSSOM is too thin** — implement a conservative text pass instead. Split on rule boundaries, rewrite what it can parse with confidence, and drop everything else. Do not attempt a general CSS parser.

The fail-closed requirement makes the contract testable either way, so this decision changes the implementation but not one acceptance criterion. Record which way it went, and why, in a comment at the top of the module.

### Test with a hostile case, not only a benign one

A test that inspects the rewritten CSS string proves the string changed. It does not prove nothing escaped. Build the real situation:

1. Stand up a document with happy-dom.
2. Insert the SVG, carrying the scope id on its root and its `<style>` inside it.
3. Insert a sibling element **outside** that SVG which the unscoped rule would match — for the `rect { fill: red }` case, an element the selector reaches.
4. Assert the sibling is unaffected.

`scripts/diagram-lint.ts` already stands up happy-dom via `new Window({ url: "http://localhost" })` and assigns the globals it needs; reuse that shape rather than inventing another. happy-dom is already a resolved dependency — add nothing.

Also cover, in the same file: the selector-list case (assert each member carries the prefix independently), the `@media` case, an unparseable rule (assert it is absent from the output, not merely altered), a `url()` that is neither `data:` nor a `#` fragment (assert removal), an `@font-face` with a non-`data:` `src` (assert the whole rule is gone), an `@keyframes` rule (assert the whole rule is gone), and a `<style>` emptied by the pass (assert the element itself is gone).

### `@keyframes` is dropped — it is a global escape, not a limitation

An animation name is not a selector, so prefixing does nothing to it: `@keyframes spin { … }` inside a card SVG registers `spin` **globally** and can retime an animation in the dashboard chrome or in another card. That is the same escape this whole pass exists to close, arriving through a different door.

So drop every `@keyframes` rule, and any declaration that references one, on the same fail-closed rule as everything else. The alternative — renaming the keyframe to `#id`-prefixed and rewriting every reference — means correctly handling both `animation-name` and the `animation` shorthand's ordering, and a rename that misses one reference produces a silently dead animation while leaving the global registration in place. Dropping is one rule and cannot be half-right.

Cost to the author: an animated SVG renders as its static first frame. That is acceptable — a decision-card diagram is a glance-sized instrument, and no shipped diagram animates today.

## Acceptance criteria

- [ ] `scopeSvgStyles(svgEl, scopeSelector)` is exported from `packages/monitor/skills/cockpit/dashboard/dist/modules/svg-scope.js`, mutates `svgEl` in place, and returns it.
- [ ] A single-selector rule `rect { fill: red }` becomes a rule whose selector begins with the passed scope selector.
- [ ] A selector list `rect, circle { … }` is rewritten so **each** member independently carries the scope prefix.
- [ ] Rules inside an `@media` block are prefixed, and the `@media` wrapper survives.
- [ ] A rule the pass cannot confidently rewrite is absent from the output entirely — not present unchanged, not present partially rewritten.
- [ ] A declaration inside a `<style>` element whose `url()` is neither a `data:` URI nor a `#` fragment has that `url()` removed — relative as well as remote.
- [ ] An inline `style` attribute carrying a disallowed `url()`, for example `<rect style="fill:url(https://example.com/x.svg)">`, has that `url()` removed too; a `url(#gradient)` fragment in the same position survives.
- [ ] A presentation attribute carrying a disallowed `url()`, for example `<rect fill="url(https://example.com/p.svg#g)">` or a remote `filter` / `mask` / `clip-path` / `marker-*`, has that `url()` removed; `fill="url(#gradient)"` survives untouched.
- [ ] Each of the five adversarial CSS cases — a comment inside a selector, a string containing a brace, a nested function in a value, an escaped selector, and an `@supports` wrapper — is absent from the output.
- [ ] An `@font-face` rule whose `src` is not a `data:` URI is dropped in full.
- [ ] An `@keyframes` rule is dropped in full, and a test asserts the animation name is not registered against the document after the pass runs.
- [ ] A `<style>` element left with no surviving rules is removed from the DOM.
- [ ] A test proves a hostile rule cannot reach an element outside the SVG: with the scoped SVG mounted, a matching sibling outside it is unaffected.
- [ ] The prefix anchors to the id passed in, which the caller sets on the SVG root — so the same selector still resolves when the SVG is serialized on its own, with no surrounding figure.

## Verification

- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/svg-scope.test.ts` — all tests pass.
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` — the whole suite is still green, including `diagram-lint.test.ts` and `diagram-theme.test.ts`.
- [ ] Run `git status --short` and quote it. Expect `packages/monitor/skills/cockpit/dashboard/dist/modules/svg-scope.js`, `packages/monitor/skills/cockpit/scripts/svg-scope.test.ts`, plus at most this task file. Any OTHER path is a real scope violation.
- [ ] Confirm the module's top comment records which mechanism was chosen (CSSOM or conservative text pass) and what the happy-dom probe showed.

## Eval rubric

> Scale and shared dimension definitions: see `../_context/rubric.md`. Each dimension is scored 0–5; weighted average >= 4.0 to pass. Correctness < 4 is an automatic veto, and Sanitize & scoping boundary < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | prefixing is wrong or absent; the function does not mutate and return `svgEl` | plain rules are prefixed but selector lists, `@media`, or emptied `<style>` removal drift | every listed behaviour holds, including selector lists rewritten member by member and emptied `<style>` elements removed |
| Sanitize & scoping boundary | ×3 | a rule matches outside the figure, or an unparseable rule is emitted unchanged, or a remote `url()`/`@font-face src` survives | scoping holds for the simple cases but an unhandled construct is passed through rather than dropped | fail-closed throughout: anything not confidently rewritten is dropped, and no remote reference survives in CSS text |
| Test coverage | ×2 | no test, or only a string-shape assertion | benign cases covered; no adversarial case | asserts a hostile rule fails to reach a sibling element outside the figure, not merely that the output string looks right; covers dropped rules, remote `url()`, `@font-face`, and the emptied-`<style>` case |
| Interface & readability | ×1 | mixes unrelated concerns into the module, or hard-codes the scope selector | works but the mechanism choice is undocumented and the drop conditions are implicit | one exported function with a clear contract; a top comment records the happy-dom probe result and why the chosen mechanism won; each drop condition is commented with the leak it prevents |

## Out of scope

- **Calling this pass from the card renderer.** Deferred. Wiring the pass into the render path is a separate unit of work; this task delivers and proves the pass itself.
- **Sanitization.** Deferred. This pass runs on already-sanitized markup and complements it — it strips what a sanitizer structurally cannot reach (CSS text), and it does not replace or duplicate the sanitizer's job.
- **Renaming `@keyframes` instead of dropping them.** Deferred. A rename would preserve author animations, but it means rewriting the `animation-name` property and the `animation` shorthand correctly, and one missed reference leaves the global registration in place — the escape this pass exists to close. Dropping is the fail-closed answer; revisit only if a real diagram needs animation.

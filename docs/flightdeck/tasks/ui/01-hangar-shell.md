# UI-01: Hangar design system and page shell

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/hangar.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: server/02, ui/02, ui/03
> **Status**: todo

## Goal

The Hangar design system exists as a written direction and as a working token layer, with an empty page
shell that already has the right ground, type, grid, and header — ready for panels to drop into.

## Files to create / modify

- `packages/dispatch/skills/autopilot/PRODUCT.md` (new) — the design direction document.
- `packages/dispatch/skills/autopilot/dashboard/dist/index.html` (new) — the page shell. This task
  **creates** `dashboard/dist/`; later ui tasks add modules and extend these files, but nothing outside
  the ui bucket ever writes there.
- `packages/dispatch/skills/autopilot/dashboard/dist/style.css` (new) — tokens plus shell layout.
- `packages/dispatch/skills/autopilot/dashboard/dist/app.js` (new) — petite-vue bootstrap, header state.
- `packages/dispatch/skills/autopilot/dashboard/dist/vendor/petite-vue.es.js` (new) — copied verbatim.

## Implementation notes

The complete palette, type scale, spacing steps, radii, motion rules, component specs, anti-goals, and
accessibility floor are all in the Hangar context file listed in Required reading. Treat that file as
authoritative and transcribe it exactly. Do not invent values, and do not "improve" a colour.

### `PRODUCT.md`

This is the document a future contributor reads before touching the screen, so it must argue the
direction, not just list hex codes. Cover, in this order:

1. The one-line idea, and what it is reacting against.
2. Why dark only.
3. The palette, with what each colour *means*. Semantics first, hex second.
4. Type: why monospace is the body face here rather than an accent.
5. The anti-goals list, verbatim. This is the section that keeps the screen from drifting into generic
   dark-mode UI.

Keep it under 150 lines. Sibling design docs in this repo (`PRODUCT.md` under the monitor plugin's
skills) are the tone to match: opinionated, concrete, short.

### Tokens

Every value from the context file becomes a custom property on `:root`. The rule to enforce is that no
rule elsewhere in the stylesheet may contain a raw hex colour, a raw pixel font size, or a spacing value
outside the 4px steps. That constraint is what makes the system real rather than decorative, and it is
mechanically checkable — see Verification.

Include the `prefers-reduced-motion` block from the start. Retrofitting it is how it gets forgotten.

### The shell

```
index.html
└── #app
    ├── header.deck-header      title · slug · progress ring · counts · view toggle
    ├── section.deck-top        empty; the lanes and graph mount here
    └── section.deck-fleet      empty; the fleet table mounts here
```

Grid on `#app`: `grid-template-rows: auto minmax(40vh, 1fr) 1fr`, full viewport height, with the two
sections scrolling independently and the page body never scrolling horizontally. Below 900px the rows
stack into one scrolling column.

### Bootstrap

`app.js` is an ES module. Import petite-vue from the vendor copy and mount a store that fetches
`/api/tree` once on load and exposes:

```js
{
  planTitle: "",
  slug: "",
  counts: { total: 0, done: 0, inProgress: 0, ready: 0, blocked: 0 },
  errors: [],
  view: "lanes",      // "lanes" | "graph" — the header toggle
  loading: true,
  loadError: null,
}
```

Render the header from that store, including the progress ring driven by `done / total`. Draw the ring
as an inline SVG circle with `stroke-dasharray`; it needs no library.

Assign the store to `window.__flightdeck` after mounting. That one line is what makes the header
verifiable before any API exists, and it stays useful afterwards for inspecting live state:

```js
const store = reactive({ /* the shape above */ });
window.__flightdeck = store;   // test + debug handle; petite-vue reactivity applies to assignments
```

Three states must be visible, not silent:

- **loading** — before the first response.
- **load error** — the fetch failed or the daemon is gone. Show the message, not a blank page.
- **tree errors** — the payload's `errors` array is non-empty. Show a count and the reasons in ember;
  a malformed task file must be visible.

The panels themselves stay empty in this task. Leaving them as labelled empty regions is correct.

## Acceptance criteria

- [ ] `PRODUCT.md` exists, argues the direction, and includes the anti-goals list verbatim.
- [ ] Every colour, font size, radius, and spacing token from the design context file is declared on
      `:root`.
- [ ] No rule outside `:root` contains a raw hex colour.
- [ ] The `prefers-reduced-motion` block is present and disables animation and transition.
- [ ] The shell renders header, top section, and fleet section in the specified grid.
- [ ] The two sections scroll independently and the page body never scrolls horizontally.
- [ ] Below 900px the layout stacks into a single column.
- [ ] The store is reachable as `window.__flightdeck` after mount, so the header can be exercised without
      an API.
- [ ] The header renders the plan title, slug, counts, and a progress ring from a tree payload, verified
      against a stubbed payload since no API exists yet.
- [ ] Loading, load-error, and tree-error states each render something visible.
- [ ] petite-vue is the only file in `vendor/`.
- [ ] Every file under `dashboard/dist/` at the end of this task was created here — no task outside the
      ui bucket contributed to that directory.

## Verification

- [ ] The daemon does not exist yet, so serve the directory with any trivial static server and open it:
      `python3 -m http.server 8899 --directory packages/dispatch/skills/autopilot/dashboard/dist`
      then visit `http://localhost:8899/`.
- [ ] With no API behind it, `/api/tree` 404s. Confirm the **load-error** state renders a visible message
      rather than a blank page — that is exactly the path this setup exercises.
- [ ] Confirm the shell itself: header, top section, and fleet section present, in the specified grid,
      with the two sections scrolling independently.
- [ ] Stub the payload to check the populated header without a server. In the browser console:
      ```js
      Object.assign(window.__flightdeck, {
        planTitle: "Waypoints skill", slug: "waypoints-skill", loading: false, loadError: null,
        counts: { total: 6, done: 6, inProgress: 0, ready: 0, blocked: 0 },
      });
      ```
      Then assert the DOM: the header shows `Waypoints skill`, the counts read 6 of 6, and the progress
      ring's `stroke-dasharray` shows a full circle with no remaining gap.
- [ ] Confirm no stray hex outside the token block:
      `rg -n "#[0-9a-fA-F]{3,8}\b" packages/dispatch/skills/autopilot/dashboard/dist/style.css | rg -v "^\s*\d+:\s*--"` returns only lines inside `:root`.
- [ ] Confirm the reduced-motion block exists:
      `rg -n "prefers-reduced-motion" packages/dispatch/skills/autopilot/dashboard/dist/style.css`
- [ ] Confirm the vendor directory holds one file:
      `ls packages/dispatch/skills/autopilot/dashboard/dist/vendor/` → `petite-vue.es.js` only.
- [ ] Resize the window below 900px and confirm the sections stack with no horizontal page scrollbar.
- [ ] Stop the static server and reload; the page still fails visibly rather than rendering blank.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Shell does not render, or the grid and scroll behaviour are wrong | Renders but a required state is silent, or the responsive break is missing | Grid, independent scroll, responsive stack, and all three states behave as specified |
| Design fidelity | ×2 | Invents colours or spacing, or violates a stated anti-goal | Tokens declared but raw values still appear in rules | Every token transcribed exactly, no raw hex outside `:root`, spacing on the 4px steps, radius ceiling respected |
| Test coverage | ×2 | No verification performed | Loads once, states unchecked | Every Verification step run, including the mechanical hex and vendor checks |
| Interface & readability | ×1 | Styles and markup tangled, store shape undocumented | Works but the store carries ad-hoc extra keys | Store matches the specified shape, stylesheet ordered tokens then layout then components |
| Assumptions & docs | ×1 | `PRODUCT.md` is a hex list | Documents values without arguing the direction | Argues the direction, explains dark-only and monospace-body, anti-goals verbatim |

## Out of scope

- Rendering tasks, agents, or the graph. Those are separate tasks in this bucket; the panels stay empty
  here on purpose.
- Consuming the SSE stream. The header's one-shot fetch is all this task needs.
- A light theme. Deferred permanently: this is an operations surface watched beside a terminal, and a
  second theme would double the token surface for no reader.
- Web fonts. The type stack is system-only, so nothing is downloaded.

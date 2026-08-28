# WORK-04: Dashboard Rendering

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/types.md`
>
> **Depends on**: work/03
> **Blocks**: review/01
> **Status**: done

## Goal

Render token usage in three places — a column on every fleet row, a total on every lanes card, and a plan-wide total in the header — all fed by the usage rollup that already arrives on the fleet event stream.

## Files to create / modify

All paths are relative to the repo root `/Users/funnyq/Projects/q-lab/cc-plugins`, under `packages/dispatch/skills/autopilot/dashboard/dist/`:

- `modules/format.js` (modify) — add and export one compact token formatter
- `modules/format.test.js` (new) — cover that formatter
- `modules/fleet.js` (modify) — the Tokens column
- `modules/lanes.js` (modify) — the per-task total on each card
- `app.js` (modify) — hold the rollup in the reactive store and expose the header total
- `index.html` (modify) — the header markup
- `style.css` (modify) — the grid track and the styles for the above

This directory is **committed as-is with no build step**. Edits to these files are the shipped artifact; there is no source tree that compiles into it.

## Implementation notes

### The data this task consumes

The fleet event stream delivers a `fleet` event whose JSON body carries three fields this task reads:

```js
{
  rows: [ /* … each row may carry an optional `usage` */ ],
  usage: {                       // the plan-wide rollup, always present
    byTask: { "<a task ref>": { input, output, cacheRead, cacheWrite }, … },
    unattributed: { input, output, cacheRead, cacheWrite },
    totals:       { input, output, cacheRead, cacheWrite },
    agentCount: 0,
  },
}
```

A row's `usage` is **optional**. Its absence means no transcript paired to that row — an external-engine agent, or a run whose transcripts are gone. The rollup's `usage` object is **always present**; when nothing was found every counter is `0` and `agentCount` is `0`.

### 1. `formatTokens(value)` in `modules/format.js`

Export it alongside the helpers already there (`SCORE_MAX`, `escapeHtml`, `percent`, `scoreClass`, `formatScore`, `renderDimensions`, `compareTaskOrder`). One definition, shared by both panels — a private copy in each would drift the first time either changed.

```js
export function formatTokens(value)
```

Rules, in evaluation order:

| Input | Output | Why |
|---|---|---|
| `undefined`, `null` | `"N/A"` | no measurement exists |
| not a finite number | `"N/A"` | garbage in, no claim out |
| negative | `"N/A"` | a token count cannot be negative; a negative one means the pipeline is broken, not that zero tokens were spent |
| `0` | `"0"` | a real, measured zero |
| `1`–`999` | the plain integer, e.g. `999` | |
| `1_000`–`999_999` | one decimal with a `K` suffix | |
| `1_000_000` and up | one decimal with an `M` suffix | |

Worked examples to assert directly: `999` → `"999"`, `1000` → `"1.0K"`, `8545` → `"8.5K"`, `278146` → `"278.1K"`, `7183857` → `"7.2M"`.

**The `undefined` → `N/A` branch is the most important behaviour in this task.** A row with no matched transcript is not a row that burned zero tokens. Rendering `0` there is a quiet lie: it looks like a measurement, reads like a measurement, and is not one. Nothing in the UI can tell the user it was wrong. Prefer the visibly missing value over the plausible false one.

Do not throw for any input. A formatter that throws takes down the whole panel it is rendering.

### 2. Fleet column in `modules/fleet.js`

The fleet panel renders a header row of column labels (`.fleet-columns`, seven `columnheader` spans) and one `.fleet-cell` per column in `renderRow`. Add a **Tokens** column **between the verdict column and the message column**, in both places, keeping the two in the same order.

The cell:

```js
`<span class="fleet-cell -tokens" role="cell" title="${escapeHtml(tokenTitle(row.usage))}">${escapeHtml(formatTokens(row.usage?.output))}</span>`
```

Output tokens are the headline. The `title` attribute carries the input count too, so hovering reveals both. This is a **tooltip, not an expandable region** — it needs no interaction code, no expanded-state set, and no click handler.

Say the limitation out loud rather than implying an affordance that is not there: a native `title` is reachable by mouse hover only, so keyboard and touch users cannot see the input figure. That is accepted for this version. The input count is secondary information that no decision depends on, and building a keyboard-reachable disclosure is a larger interaction change than this feature justifies. Do not describe it anywhere as "expand".

Title text: `input 352 · output 3465` when usage is present, and `no transcript matched this agent` when it is absent. Keep the helper that builds it local to this module; it has one caller.

**Every interpolated value goes through the existing `escapeHtml` helper before it reaches a template string**, including the formatter's own output. This module builds raw HTML strings and assigns them to `innerHTML`; an unescaped value is an injection.

Add `formatTokens` to the existing import list from `./format.js`.

### 3. The grid track in `style.css`

`.c-fleet` defines the row grid as a custom property:

```css
--fleet-columns: 18px minmax(96px, 0.7fr) minmax(72px, 0.6fr) 48px 76px
  minmax(160px, 1fr) minmax(160px, 2fr);
```

Seven tracks: status, role, task, try, elapsed, verdict, message. Insert one fixed track for Tokens **before the last one**, sized like the elapsed track since the content is a short right-leaning figure. The row and the column header share this one property, so a single edit moves both — do not add a second declaration.

Style `.fleet-cell.-tokens` as secondary information: quieter than the score meters and the status dots. Use the variables already defined in this file; find each definition before using it rather than guessing a name. **Do not add a new colour, a new font, or an animation.**

### 4. The store and the lanes card

`app.js` keeps two separate things, and the difference matters here:

- `fleetState` — a **plain, non-reactive** object holding `rows`, `entryCount`, `logPresent`, `connection`. The fleet panel is redrawn imperatively from it by `drawFleet()`.
- `store` — the **`reactive()`** object petite-vue is mounted on. The header template and the lanes view read from it.

The fleet column in step 2 is drawn imperatively and needs nothing new. **The lanes card and the header are reactive and do**, so the rollup has to land in `store`, exactly as `store.elapsed` and `store.elapsedLive` already do — those are written from the same `onFleet` callback and are the pattern to copy.

Add a `usage` field to the `store` initialiser with a zeroed rollup as its starting value, and guard the incoming `payload.usage` the same way the neighbouring lines guard `payload.rows` and `payload.entryCount`.

**Update that rollup in place. Never reassign `store.usage`.**

The lanes view is mounted through `insertAdjacentHTML` with `v-scope="Lanes({ tree })"`, and the factory destructures what it is handed. A destructured binding captures **the object that existed at mount time**. So `store.usage = payload.usage` swaps in a new object that the lanes scope is no longer holding, and the card totals freeze at whatever they were on the first frame — silently, with no error, and only on the lanes view, so it survives a casual check of the header.

This is the same trap `store.tree` already avoids: the tree loader calls `Object.assign(store.tree, payload, …)` rather than replacing the object. Copy that. Mutate the fields of the existing rollup — `byTask`, `unattributed`, `totals`, `agentCount` — and leave the identity alone.

Then widen both the injected scope expression and the factory's destructured parameter to hand the lanes view that same stable rollup object.

In `modules/lanes.js`, each task card gains a small token figure inside the existing `.summary` button, near the score meter. It shows that task's total **output**, looked up in the rollup's per-task map by the task's `ref`:

```
formatTokens(usage.byTask[task.ref]?.output)
```

An absent key therefore renders `N/A` through the same formatter — a task nobody has worked yet reads `N/A`, never `0`. **Do not add a new expandable region**; the card already has one and a second would compete with it. Expose `formatTokens` on the returned scope object alongside `scoreClass` / `percent` / `formatScore`, which is how this template already reaches shared helpers.

### 5. The header figure in `index.html`

Add one figure beside the existing `.plan-elapsed` block, following its shape: a `.label` span and a `.value` span.

Gate it on the rollup reporting work, not on the number being truthy:

```html
<div class="plan-tokens" v-if="usage.agentCount">
```

A zero-agent rollup renders nothing at all. An empty header slot labelled "Tokens" with no value is worse than no slot — it reads as a broken panel rather than an idle one.

The value is the plan-wide output total, through the same formatter. petite-vue escapes `{{ }}` interpolation, so no manual escaping is needed in the template — unlike the string-building modules above.

## Acceptance criteria

- [x] `formatTokens` is exported from the shared format module and returns `"N/A"` for `undefined`, `null`, `NaN`, `Infinity`, and negatives; `"0"` for `0`; and the `K` / `M` forms for the worked examples above.
- [x] A fleet row whose `usage` is absent renders a Tokens cell reading `N/A`; a row with usage renders its output through the formatter.
- [x] The fleet column header and the row cells stay in the same order, and the grid track count in the stylesheet matches the number of columns rendered.
- [x] A lanes card for a task absent from the rollup's per-task map renders `N/A`, and one present renders that task's output figure.
- [x] The rollup object held on the reactive store is **mutated in place** on every frame and never reassigned, so a lanes card's figure updates on the second and later frames rather than freezing at its first value. Grep the frame handler for an assignment to the store's rollup field: there must not be one.
- [x] The header figure is absent from the DOM when the rollup reports zero agents, and shows the plan-wide output total otherwise.
- [x] Every value interpolated into an HTML string in the fleet module passes through the existing escaping helper.
- [x] No new colour, font, or animation is introduced in the stylesheet.

## Verification

- [x] Run `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/` — every test passes, including the existing fleet and lanes suites.
- [x] Generate the scenario rather than hunting for one. Run the fixture generator described in `../_context/shared.md`, capture the `planDir`, `projectsRoot`, and `expected` it prints, and start the flightdeck server against that plan directory with `--projects-root` pointing at that projects tree. Read the port from the server's own startup output rather than assuming one, open that URL in a browser, and confirm three things: the fleet panel shows a Tokens column with figures, at least one lanes card shows a task total, and the header shows a plan total matching the token formatter applied to `expected.totals.output`.
- [x] In that same session, confirm the row the fixture deliberately left without a transcript reads `N/A` and not `0`. The fixture guarantees exactly one such row, which is why this check does not depend on finding an external-engine agent in whatever data happens to be lying around.
- [x] Run `bun test packages/dispatch/skills/autopilot/scripts/` — the server-side suite still passes, proving nothing outside the dashboard bundle was touched.
- [x] Run `git status --short -- packages/dispatch/skills/autopilot/dashboard/dist/modules/format.js packages/dispatch/skills/autopilot/dashboard/dist/modules/format.test.js packages/dispatch/skills/autopilot/dashboard/dist/modules/fleet.js packages/dispatch/skills/autopilot/dashboard/dist/modules/lanes.js packages/dispatch/skills/autopilot/dashboard/dist/app.js packages/dispatch/skills/autopilot/dashboard/dist/index.html packages/dispatch/skills/autopilot/dashboard/dist/style.css` and confirm every one of those paths is dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | a missing measurement renders as `0` anywhere, or the formatter throws on a bad input | the `N/A` case is handled in one panel but not the others, or the header shows an empty slot at zero agents | absent and zero are visibly different in all three places; every formatter branch behaves as tabulated; the grid track count matches the rendered columns |
| Test coverage | ×2 | no tests for the formatter | happy-path numbers only | every formatter branch asserted including null, non-finite, and negative; row rendering asserted for both the absent-usage and present-usage cases; the lanes absent-key case asserted |
| Interface & readability | ×1 | a second copy of the formatter in a panel module, or usage derivation duplicated in the browser | the formatter is shared but the title-building logic is inlined twice | one exported formatter, one local title helper with its single caller, panels that render what they are handed |
| Assumptions & docs | ×1 | the `N/A`-versus-zero distinction is nowhere explained | a comment says what the code does | a one-line comment says why absent must not render as zero, so the next reader does not "simplify" it away |

## Out of scope

- **Cache-read and cache-write figures.** Present in the data and deliberately not rendered — cache-read runs roughly 260× output, so putting it on the panel would flatten every other number into noise. Deferred.
- **Any dollar or currency figure.** No pricing table is available to this code, and inventing one is a separate decision nobody has made. Deferred.
- **A new view, tab, chart, or role-rollup panel.** The three placements above are the whole ask. Deferred.
- **Any change to server-side code.** Everything this task touches ships in the committed dashboard bundle; the rollup arrives already computed on the fleet event stream.
- **A per-row expanded token breakdown.** The `title` attribute is the agreed affordance. Deferred.

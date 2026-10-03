# MOD-01: Pane layout rows

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: data/01
> **Blocks**: mod/02
> **Status**: todo

## Goal

Pure functions turn a `DeckSnapshot` plus a width into the docked and inline line models the flightdeck pane draws, so all of the pane's layout is covered by `bun test`.

## Files to create / modify

- `packages/dispatch/hooks/flightdeck/rows.ts` (new) — the pure layout functions below.
- `packages/dispatch/hooks/flightdeck/rows.test.ts` (new) — `bun test` cases for them.

## Implementation notes

### Imports

- `rows.ts` imports types from `./types.ts` and nothing else. It must not import from `claude-code` or from any `node:` module. The mod draws these lines, and a mod has no `node:`; keeping `claude-code` out keeps the file under `bun test` and `tsc`.
- `types.ts` already exists, created by the snapshot CLI work, and holds exactly the types in `../_context/shared.md` → "The `DeckSnapshot` contract". Do not edit it.

### Types and signatures

```ts
import type { DeckAgent, DeckSnapshot, DeckState, DeckTask } from "./types.ts";

// `ref` is set only on card segments; the mod makes those pressable
export type Seg = { text: string; color?: string; dim?: boolean; ref?: string };
export type Line = Seg[];

export const GLYPH: Record<DeckState, string>;
// done "✓", in-progress "●", ready "○", blocked "·", invalid "✗"

export const COLOR: Record<DeckState, string | undefined>;
// done "#3fb950", in-progress "#d29922", ready undefined, blocked undefined (rendered dim), invalid "#f85149"

export function card(task: DeckTask): Seg;
export function summary(s: DeckSnapshot, stale: boolean): Line[]; // exactly 2 lines
export function compactSummary(s: DeckSnapshot, stale: boolean): Line;
export function bucketBars(s: DeckSnapshot, width: number): Line[];
export function waveRows(s: DeckSnapshot, width: number): Line[];
export function agentLines(s: DeckSnapshot, now: number): Line[];
export function formatElapsed(ms: number): string;
export function docked(s: DeckSnapshot, width: number, now: number, stale: boolean): Line[];
export function inline(s: DeckSnapshot, width: number, stale: boolean): Line[];
export function clip(line: Line, width: number): Line;
export function endState(s: DeckSnapshot): "wave" | "done" | "stuck";
```

Width counts characters: every glyph above, `█`, `░`, `…`, and `—` count as one column. A line's width is the sum of its segments' `text.length`.

### `card(task)`

- Text: `<ref> <glyph>`, plus the attempt count when `attempts > 1`. Examples, for a task whose ref is `<ref>`: `<ref> ✓` (done), `<ref> ●2` (in progress, attempt 2), `<ref> ○` (ready).
- `color` = `COLOR[state]`. `dim: true` only for `blocked`. `ref` = `task.ref`.

### `summary(s, stale)`

Two lines, diagnostics placed first so a right-edge clip never hides them. The slug is not here: the mod puts it in the pane title.

- **Line 1**: `<done>/<total> done · <wave part>`. The wave part is `wave <currentWave> of <waves.length>`; when `currentWave` is `null` it is `all done` if `counts.done === counts.total` (even when done tasks sit in `unschedulable`), else `stuck · <n> unschedulable` coloured `#f85149`, where `n` counts the `unschedulable` refs whose task is not `done`. `export function endState(s: DeckSnapshot): "wave" | "done" | "stuck"` holds this rule once; `summary`, `compactSummary`, and `inline` all call it. Example: `12/20 done · wave 3 of 6` (24 columns); worst case `12/20 done · stuck · 3 unschedulable` (36).
- **Line 2**: the diagnostic segments first, each followed by ` · `: dim `stale` when `stale`; `<errors> errors` coloured `#f85149` when `s.errors > 0`. Then the state counts as glyph pairs separated by one space: `●<inProgress> ○<ready> ·<blocked> ✗<invalid>`, each coloured like its card state (`✗` pair red only when `invalid > 0`). Example: `stale · 2 errors · ●2 ○3 ·3 ✗0` (30 columns).

### `compactSummary(s, stale)`

- One line, diagnostics first: dim `stale · ` when `stale`, red `<errors> errors · ` when `s.errors > 0`, then `<done>/<total> · W<currentWave>/<waves.length>` — `all done` or red `stuck` replaces the `W…` part by the same rule as `summary` — then ` · <slug>` last, so a clip drops the slug before anything else.

### `bucketBars(s, width)`

- One line per entry of `s.buckets`, in that order.
- Layout: `<name padded to the longest bucket name> <bar> <done>/<total>`.
- The bar fills the width left over after the name, the two separating spaces, and the count; filled cells `█` = `round(done / total × barWidth)`, the rest `░`. Bar width never drops below 1; a bucket with `total` 0 draws all `░`.
- Filled cells use the done colour `#3fb950`.

### `waveRows(s, width)`

- One group per entry of `s.waves` (`waves[0]` is wave 1), then a final group labelled `W?` for `s.unschedulable` when it is non-empty.
- Label: `W<n>` padded to the longest label in the snapshot (including `W?`), followed by one space.
- Cards are `card(s.tasks[ref])`, in the order the wave lists them, separated by two spaces.
- Wrap: when the next card would push the line past `width`, start a continuation line indented with spaces to the label width plus one. A card wider than a whole continuation line goes on its own line; `docked` then clips that line by the clip rule below.
- A ref missing from `s.tasks` renders as a dim `<ref> ?` segment rather than throwing.

### `agentLines(s, now)`

- One line per entry of `s.agents`, in order.
- Layout: `<role padded to the longest role> <ref, or label when ref is null> #<attempt>  <elapsed>`. Omit ` #<attempt>` when `attempt` is `null`.
- Elapsed is `formatElapsed(now - Date.parse(startedAt))`, or `—` when `startedAt` is `null`.

### `formatElapsed(ms)`

- Under 60 s: `<s>s` (`42s`, `59s`).
- Under 1 h: `<m>m<ss>s` (`1m00s`, `3m12s`).
- From 1 h: `<h>h<mm>m` (`1h00m`, `1h04m`).
- Floor every unit. A negative `ms` (clock skew) renders as `0s`.

### `docked(s, width, now, stale)`

- In order: the two `summary` lines, `bucketBars`, one blank line, `waveRows`, then — only when `s.agents` is non-empty — one blank line and `agentLines`.
- The `Open flightdeck` button is drawn by the mod, not here.
- Every returned line must fit in `width`. Apply one clip rule to every line through `export function clip(line: Line, width: number): Line`:
  - A line already within `width` is returned unchanged (the same segments).
  - Otherwise keep the first `width - 1` columns across the segments in order, append `…` to the segment holding the last kept column, and drop every later segment. Each kept segment keeps its `color`, `dim`, and `ref`, so a cut card stays pressable.
  - When `width - 1` is 0, the result is one segment `…` carrying the first segment's attributes. A `width` below 1 returns an empty line.
  - Exact outputs: `[{text:"1234"},{text:"x"}]` at width 4 → `[{text:"123…"}]`; `[{text:"ab"},{text:"cd"}]` at width 3 → `[{text:"ab…"}]`; `[{text:"ab"},{text:"cd"}]` at width 4 → unchanged; any overflowing line at width 1 → `[{text:"…"}]`.

### `inline(s, width, stale)`

- Exactly 2 lines.
- Line 1: `clip(compactSummary(s, stale), width)`.
- Line 2 is built whole, then passed through `clip(…, width)` — the same single clip rule as every other line, with no card-dropping rule of its own:
  - `endState(s)` `"wave"`: `W<currentWave> ` followed by that wave's cards separated by two spaces.
  - `"stuck"`: `W? ` followed by the cards of the not-done unschedulable refs.
  - `"done"`: the single segment `all done`.
- Exact outputs for line 2 with one current-wave card `task-1 ✓` and a second `task-2 ○`: width 40 → `W1 task-1 ✓  task-2 ○`; width 13 → `W1 task-1 ✓ …`; width 2 → `W…`; width 1 → `…`; width 0 → an empty line.

### Test fixture

Build fixtures in the test file with a small helper, for example `snap(overrides)` and `task(ref, state, attempts?)`. One 20-task fixture across 3 buckets and 4 waves, with 2 in-flight agents and 1 unschedulable ref, serves the width checks.

## Acceptance criteria

- [ ] `card` gives each of the 5 states its glyph and colour from the table in `../_context/shared.md`, and `blocked` is dim.
- [ ] `card` appends the attempt count only when `attempts > 1` (`<ref> ●` at 1, `<ref> ●2` at 2).
- [ ] `waveRows` on a snapshot with one wave of six done tasks with graph-style refs `task-1`…`task-6` (attempts 1, no unschedulable) at width 40 returns exactly `W1 task-1 ✓  task-2 ✓  task-3 ✓` and `   task-4 ✓  task-5 ✓  task-6 ✓`.
- [ ] `clip` returns the four exact outputs listed under `docked`, and on a line holding a 60-character slug or a 50-character graph ref at width 24 returns a line exactly 24 wide ending in `…`, and a clipped card keeps its `ref`.
- [ ] `waveRows` adds a final `W?` group holding exactly the `unschedulable` refs, and none when the list is empty.
- [ ] `inline` returns exactly 2 lines; line 2 matches the five exact outputs listed under `inline` (widths 40, 13, 2, 1, 0); line 2 follows `endState`: `all done` when every task is done (including a fixture whose done tasks form a cycle in `unschedulable`), `W? ` plus the not-done unschedulable cards when stuck.
- [ ] On a fixture with `slug` `demo`, `counts` `{ total: 20, done: 19, inProgress: 0, ready: 0, blocked: 1, invalid: 0 }`, `currentWave` `null`, one unschedulable ref, `errors` 2 and `stale` true, at width 40: `summary` lines are exactly `19/20 done · stuck · 1 unschedulable` and `stale · 2 errors · ●0 ○0 ·1 ✗0`, and `compactSummary` is exactly `stale · 2 errors · 19/20 · stuck · demo` (39 columns; inline uses the short `stuck`, never the count). With `stale` false and `errors` 0, none of `stale` or `errors` appears.
- [ ] `formatElapsed` returns `59s` for 59 000, `1m00s` for 60 000, and `1h00m` for 3 600 000.
- [ ] No line returned by `docked` on the 20-task fixture is wider than the width, for widths 24, 40, and 80.

## Verification

- [ ] `bun test packages/dispatch/hooks/flightdeck/rows.test.ts` passes.
- [ ] `! (bunx --bun tsc --noEmit | grep hooks/flightdeck/rows)` exits 0.
- [ ] `! grep -E 'from "(claude-code|node:)' packages/dispatch/hooks/flightdeck/rows.ts` exits 0.

## Eval rubric

> Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Shared bands: `../_context/rubric.md`.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Glyphs, colours, or wave grouping disagree with `shared.md`; lines overflow the width | Happy path right, but wrapping, `W?`, `all done`, or truncation drift | Every function matches the spec above at every tested width, edges included |
| Test coverage | ×2 | No tests, or only a smoke test | Each function covered on one fixture; no width sweep or null cases | Width sweep (24/40/80), null `currentWave`, missing ref, stale, elapsed boundaries all covered |
| Interface & readability | ×1 | Imports `claude-code` or `node:`, or mixes I/O in | Pure, but types loose or helpers duplicated | Pure functions over `DeckSnapshot`, exported signatures exactly as above |
| Assumptions & docs | ×1 | Unnamed magic numbers and colours | Constants named but the one-column glyph assumption unstated | Colours and glyphs come from `GLYPH`/`COLOR`; the one-column assumption is stated in a single comment |

## Out of scope

- Drawing with `Box` / `Text` / `Button` and the `Open flightdeck` button. Deferred. Reason: the mod turns these `Line`s into components.
- The text of the toast shown when a card is pressed. Deferred. Reason: the mod builds it from `DeckTask` at press time.
- Producing the snapshot. Deferred. Reason: a separate bun CLI prints the `DeckSnapshot` this file consumes.

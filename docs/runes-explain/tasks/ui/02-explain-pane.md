# UI-02: explain-pane

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/design.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/03
> **Blocks**: docs/01
> **Status**: todo

## Goal

The `runes-explain` side pane shows the session's explanations: a selectable history, the selected entry
drawn by kind, its token cost, the last error, and a follow-up `Input`.

## Files to create / modify

- `packages/runes/hooks/explain/pane.tsx` (new) — `explainPane(on)`: one `ui.render` hook on
  `{ component: "Pane", requestId: "runes-explain" }`.
- `packages/runes/hooks/explain/pane.test.tsx` (new) — its tests.
- `packages/runes/hooks/register.tsx` (modify) — import `explainPane` and call `explainPane(on)` in
  `register()` beside the other rune calls (`mascot(on); band(on); …`). The orchestrator already added
  `explainHooks(on)` and `registerChecker` there; add one import and one call, nothing else.

## Implementation notes

### What already exists

- The orchestrator `packages/runes/hooks/explain/explain.ts` exports `PANE = "runes-explain"` and
  the `function` declarations `explainPress`, `explainAsk`, `explainPick`, `explainSelect`, `explainReopen`
  (signatures in `protocol.md` → Orchestrator). The pane calls them by bare name from `onPress` / `onSubmit`
  with the hook's `$`, returning their promise. `explainPress`, `explainAsk` and `explainPick` are no-ops while `isRunning`; the pane does not need to guard them again.
- `packages/runes/hooks/explain/state.ts` exports `selectedOf(view)` (the entry whose id is `selected`,
  else the newest). Import it; do not re-implement it.
- The `view` atom's value is `ExplainView` (`protocol.md` → State). The pane reads it with the literal key
  in this file, because the engine's state scan needs the literal where the atom is read:

```tsx
import { read } from "claude-code";
const VIEW = { plugin: "runes", key: "explain" } as const;
// inside the hook:
const v = (await read($, VIEW)) as ExplainView;
```

### The hook

Follow the Pane pattern the flightdeck mod uses:

```tsx
export const explainPane = (on: On) => {
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const width = e.props.bodyColumns ?? 64;
    // …
    return <Box flexDirection="column">…</Box>;
  });
};
```

`64` is the `columns` the orchestrator opens the pane with; name it `COLUMNS` once. The hook does not check
`config.enabled.explain`: the pane exists only after a press, and a pane left open after `/runes explain off`
still draws its history.

### Layout, top to bottom

1. **History** — each entry one `Button` row, newest first (the order `entries` already holds), every
   stored entry drawn (state keeps at most `MAX_ENTRIES` = 12, so every explanation still held is reachable). Label `› <title>` for the
   selected entry (`selectedOf(v)?.id`), `  <title>` (two spaces) otherwise; `key={`explain-entry:${id}`}`,
   `plain`, `onPress={() => explainSelect($, id)}`. Clip each label to `width`.
2. **A rule** — one dim `Text` of `─` repeated `width` times.
3. **The selected entry**, by kind (below).
4. **Usage** — when the entry has `usage`, one dim line
   `<input> in · <cacheRead> cached · <output> out`. Format each number with `kilo(n)`: below 1,000 as the
   integer (`812`), else one decimal plus `k` (`12345` → `12.3k`, `1000` → `1.0k`).
5. **Error** — when `v.error` is set, one `Text` with `color={ERROR_COLOR}` holding it. `ERROR_COLOR =
"#cc6666"`, the dark-theme deletion red the Edit card already uses in `hooks/transcript/edit.tsx`
   (the teacher rune has no red; its colour is green `#4f9a6a`).
6. **Input** — always last:
   `<Input key="explain-ask" placeholder="ask a follow-up, or name what to explain" submitLabel="ask" onSubmit={(value) => explainAsk($, value)} />`.
   Real `InputProps` on build 2.1.310: `key`, `label?`, `placeholder?`, `value?`, `submitLabel?`, `rows?`,
   `autoFocus?: true`, `onInput?`, `onSubmit(value, e)`. There is no `onChange`; pass neither `rows` nor `onInput`.
   Ignore a submit whose trimmed value is empty (do not call `explainAsk`).

While `v.isRunning`, draw one dim line `explaining…` directly above the Input.

**Empty view** (no entries): the single dim line `Press "hey mate, explain please" under the minimap.`,
then the error line if any, then the Input (so a free question works before any press).

### Entry kinds

- **text** — `glow.view(width, body, `explain:${id}`)` from `../transcript/glow`. Real signature:
  `view(width: number, text: string, owner?: string): Run[][] | null`, where `Run` (from
  `../transcript/ansi`) is `{ text, color?, backgroundColor?, bold?, italic?, underline?, strikethrough? }`.
  It returns `null` while glow renders in the background (the worker calls `redraw` when it lands) or when
  glow is missing. Draw each `Run[]` as a `Box flexDirection="row"` of `Text` runs carrying the run's style
  props; draw an empty line as `<Text> </Text>`. On `null`, draw `body` as plain wrapped text: split on
  `\n`, word-wrap each line to `width`.
- **ask** — the `question` as a `Text`, then one `Button` per option:
  `key={`explain-pick:${id}:${i}`}`, `label={option}`, `onPress={() => explainPick($, option)}`.
- **html** — the `summary` through the same glow path as text, then the `path` as one dim line, then the
  check status line, then a `Button key={`explain-open:${id}`} label="open again"
onPress={() => explainReopen($, id)}`. Status text by `check`:

  | `check`   | line                                                                          |
  | --------- | ----------------------------------------------------------------------------- |
  | `pending` | `checking layout…`                                                            |
  | `ok`      | `layout ok`                                                                   |
  | `fixed`   | `fixed <n>` — `n` is the leading number of `note` (`"2 fix(es)"` → `fixed 2`) |
  | `failed`  | `not checked: <note>`                                                         |
  | `skipped` | `not checked: <note>`                                                         |

  A `failed` or `skipped` entry with no `note` draws `not checked`.

Every title in an entry's header is the history row's job; the selected entry draws no second title.

### Keys

Every `Button` and the `Input` need a stable, unique `key` (they are the element addresses). Use the
prefixes above; never key by array index alone.

### Tests (`pane.test.tsx`)

Use `startSession` / `fakeHost` / `CONFIG` from `../transcript/test-session` and the kit's `mock`. Seed the
view by writing the atom before rendering (`update($, view, …)` through a stubbed press is not needed —
seed state directly as `fakeHost` allows, or drive `explainPress` with a stubbed `model.fork`). Render the
pane with `{ component: "Pane", requestId: "runes-explain", props: { bodyColumns: 64 } }` and assert on the
returned tree. Stub `process.run` so glow either returns rendered output or is absent.

## Acceptance criteria

- [ ] An empty view draws `Press "hey mate, explain please" under the minimap.` and the `explain-ask` Input.
- [ ] With 12 entries, exactly 12 history Buttons draw, newest first, and only the selected one starts `› `.
- [ ] Pressing a history Button calls `explainSelect` with that entry's id.
- [ ] A text entry draws glow's runs when glow has rendered, and the plain wrapped body when `glow.view`
      returns `null`.
- [ ] An ask entry draws its question and one Button per option; pressing one calls `explainPick` with
      that option's text.
- [ ] An html entry draws its summary, its path dim, the status line for each of the five `check` values
      exactly as tabled, and an `open again` Button that calls `explainReopen` with its id.
- [ ] The usage line reads `12.3k in · 812 cached · 1.0k out` for usage `{ input: 12345, cacheRead: 812, output: 1000 }`.
- [ ] `error` draws in `#cc6666`; no error, no error line.
- [ ] Submitting `why?` in the Input calls `explainAsk($, "why?")`; submitting `   ` calls nothing.
- [ ] `register.tsx` calls `explainPane(on)`, and no other line of it changed.
- [ ] (human) In a real session, press the button and see one text, one html and one ask entry in the pane; submit one follow-up.

## Verification

- [ ] `claude plugin test packages/runes` passes, including `hooks/explain/pane.test.tsx`.
- [ ] `claude plugin validate packages/runes` reports no refusal.
- [ ] `git diff -- packages/runes/hooks/register.tsx` shows only the `explainPane` import and call.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                              | 2–3 (below bar)                                                                                           | 4–5 (pass)                                                                                    |
| ----------------------- | ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | an entry kind missing or a handler wired to the wrong orchestrator call | every kind draws, but a history row missing, the status table, the empty-submit guard or the glow fallback drifts | every line, label, key and status string matches this file exactly                            |
| Test coverage           | ×2     | no pane tests                                                           | happy-path render of one kind                                                                             | every acceptance criterion above has a test, including glow absent and each `check` value     |
| Interface & readability | ×1     | state or orchestrator logic re-implemented in the pane                  | works, but keys by index or duplicates `selectedOf`                                                       | pure drawing over the view; one named constant each for `COLUMNS`, `ERROR_COLOR` |
| Assumptions & docs      | ×1     | invented Input props                                                    | engine behaviour relied on without a test or a why                                                        | the glow-null redraw and the literal state key carry a one-line why where needed              |

## Out of scope

- The button and the band row — deferred. Reason: another task owns `band.tsx`.
- Persisting history across sessions — deferred. Reason: needs a store and a size bound nobody asked for.
- Any desktop / vscode / mobile drawing — deferred. Reason: the feature is terminal-only.

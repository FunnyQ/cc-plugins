# UI-01: band-button

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/design.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/03
> **Blocks**: docs/01
> **Status**: done

## Goal

On the terminal, Clawd's band draws a `hey mate, explain please` Button on its own row under the map/Clawd row, so one press starts an explanation, and it reads `explaining…` and ignores presses while a fork runs.

## Files to create / modify

- `packages/runes/hooks/band.tsx` (modify) — read the explain view, draw the button row, stop falling through to `next(e)` when the button is the only thing to draw.
- `packages/runes/hooks/explain/button.test.tsx` (new) — the band button's tests.

`design.md` describes the HTML explainer page, not the terminal; it is listed so the button's voice matches the brand ("hey mate", warm, informal, never childish). The band takes no colour or token from it.

## Implementation notes

### What already exists when this task starts

- `config.enabled.explain: boolean` in `hooks/config.ts`, default `true`, toggled by `/runes explain on|off`.
- `hooks/explain/explain.ts` exports the `function` declaration `explainPress($: EngineInterface): Promise<void>`. It clears `error`, sets `isRunning`, opens the pane `runes-explain`, forks, and stores the entry; it already does nothing while `view.isRunning` is true. The band only calls it.
- The `explain` atom holds `ExplainView = { entries, selected?, isRunning: boolean, error? }` (`protocol.md` → State).

### Reading the view

`band.tsx` reads the atom while drawing, so it names the key as a literal in this file, beside the existing `FRAME`, `MAP_ROWS`, `MAP_SHOWN`, in the file's own style (single quotes, no semicolons):

```tsx
const VIEW = { plugin: "runes", key: "explain" } as const;
```

Read it with `read($, VIEW)` inside the existing `Promise.all`, only when the button draws (`hasButton ? read($, VIEW) : undefined`), the same way `hasMap` gates `MAP_ROWS`.

### The early return to change

Today the hook opens with:

```tsx
const hasMap = config.enabled.minimap && e.surface === "terminal";
const lesson = e.surface === "terminal" ? teacher.latest() : undefined;
if ((!config.enabled.clawd && !hasMap && !lesson) || e.props.hasSurvey)
  return next(e);
```

Add `const hasButton = config.enabled.explain && e.surface === 'terminal'` and widen the condition to `(!config.enabled.clawd && !hasMap && !lesson && !hasButton) || e.props.hasSurvey`. A survey still wins: with `hasSurvey` the band returns `next(e)` and draws no button.

The two returns at the end change the same way:

```tsx
if (!config.enabled.clawd) return map ? withNotice(row()) : notice || next(e);
return withNotice(row(sprite(ui, e.surface === "desktop", frame)));
```

With Clawd off, no map and no lesson, the band now returns the button row alone instead of `next(e)`. With Clawd off and no map but a lesson, it returns the notice above the button row. Never draw an empty `clawd-row` just to hold the button: the row with Clawd and/or the map draws only when it did before.

### The button row

Under the map/Clawd row (and under the teacher notice, which stays on top), add one row:

```tsx
<Box key="explain-row" flexDirection="row" width={e.props.bodyColumns}>
  <term.Button
    key="explain"
    plain
    onPress={() => (view?.isRunning ? undefined : explainPress($))}
  >
    {view?.isRunning ? "explaining…" : "hey mate, explain please"}
  </term.Button>
</Box>
```

- Use the terminal-resolved `term` (the file already resolves it once for the notice), since the desktop's `Button` is another type.
- The labels are byte-exact: `hey mate, explain please` and `explaining…` (U+2026, one character).
- The press is ignored while `isRunning` in the band too, so a press in the frame before the atom redraws cannot double-fork through a stale closure; `press` guards again on its side.
- Wrap the result in a column `Box` (key `teacher-band` when the notice draws, else a new key `explain-band`) holding, top to bottom: notice (if any), the map/Clawd row (if it draws), the button row (if `hasButton`).
- On the desktop nothing changes: `hasButton` is false there, every existing desktop path returns exactly what it returns today.

Import `{ explainPress }` from `./explain/explain` and call it by bare name (`protocol.md` → "Passing `$` across files").

### Tests — `hooks/explain/button.test.tsx`

Follow `clawd/mascot.test.tsx`'s band setup: the `BAND` mount props (`component: 'AbovePrompt'`, `bodyColumns: 80`, `hasSurvey: false`), `fakeHost(on, { files: new Map([[CONFIG, '…']]) })` from `../transcript/test-session` to set the config, an engine fallback `on('ui.render', …)` returning `<Text key="engine">engine</Text>`, and `$.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })`. Press with the mounted tree's `press({ key: 'explain' })`, as `transcript/agent.test.tsx` does. Stub `model.fork` to answer a text reply (`<mode>text</mode><title>T</title><body>b</body>`) and record each call; stub `ui.open` to record its argument and answer `{ isPlaced: true }`.

Cases:

1. Default config (`explain` on, Clawd on): the band holds `{ key: 'explain' }` reading `hey mate, explain please`, below `clawd-row` (the button row comes after `clawd-row` among the column's children).
2. Pressing it calls `model.fork` once and `ui.open` with `id: 'runes-explain'`.
3. With `explain:\n  enabled: false\n`, no `{ key: 'explain' }` draws and the existing Clawd row is unchanged.
4. With `clawd:\n  enabled: false\n` and the minimap off (its default) and no lesson: the band draws the button row alone, not the engine's `engine` text, and no `clawd-row`.
5. While a fork is in flight (a `model.fork` stub that resolves only when the test releases it), the label reads `explaining…`; a second press does not call `model.fork` again; after release the label returns to `hey mate, explain please`.
6. `hasSurvey: true` → the engine's `engine` text draws, no button.
7. Desktop mount with the default config → no `{ key: 'explain' }`.

Every existing test in `clawd/mascot.test.tsx` and `runes.test.tsx` must stay green. If one asserts the band falls through to `next(e)` with everything off, give its fake `config.yaml` `explain:\n  enabled: false\n` rather than changing what it asserts.

## Acceptance criteria

- [x] On the terminal with `explain` on, the band draws a Button keyed `explain` labelled `hey mate, explain please` on a row keyed `explain-row` below the map/Clawd row.
- [x] Pressing it returns the promise `explainPress($)` gives (the handler never drops it with `void`), so `$` stays inside the press's hook until the fork returns; it calls one `$.model.fork` call and `$.ui.open` with `id: 'runes-explain'`.
- [x] While `isRunning` is true the label is `explaining…` and a press does not fork again.
- [x] With Clawd off, the minimap off and no lesson, the band draws the button row instead of returning `next(e)`.
- [x] With `explain` off, a survey showing, or on the desktop, the band draws no button and is otherwise unchanged.
- [x] (human) In a real terminal session, the button draws under the map/Clawd row and reads explaining… while a fork runs.

## Verification

- [x] `claude plugin test packages/runes` passes, including every case in `hooks/explain/button.test.tsx` and the existing band tests in `hooks/clawd/mascot.test.tsx`.
- [x] `claude plugin validate packages/runes` reports no refused `$.state` key (the `explain` key read in `band.tsx` is declared in `types/index.d.ts`).
- [x] `rg -n "explaining…|hey mate, explain please" packages/runes/hooks/band.tsx` finds both labels.

## Eval rubric

> Scale 0–5, shared dimensions in `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                              | 2–3 (below bar)                                                                                  | 4–5 (pass)                                                                                        |
| ----------------------- | ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | No button, wrong label, or a press does not fork        | Button draws, but a fall-through path (Clawd off, survey, desktop) or the running state is wrong | Every case above matches, labels byte-exact, desktop and survey untouched                         |
| Test coverage           | ×2     | No new tests                                            | Draw and press only                                                                              | All seven cases, including the in-flight press and the Clawd-off path; existing band tests green  |
| Interface & readability | ×1     | Band logic restructured or duplicated beyond the button | Works, but the column assembly is hard to follow                                                 | Smallest change to `band.tsx`, file style kept (single quotes, no semicolons), no new indirection |
| Assumptions & docs      | ×1     | Unmarked behaviour change to existing returns           | Changed returns, no test pins them                                                               | Every changed return is pinned by a test; no comment restates code                                |

## Out of scope

- The pane, its history list and Input — Deferred. Reason: the pane is its own `ui.render` hook on `{ component: "Pane", requestId: "runes-explain" }`, written separately.
- The fork, parsing, HTML writing and the layout check — Deferred. Reason: `explainPress` owns them; the band only calls it.
- A desktop, vscode or mobile button — Deferred. Reason: terminal only, like the minimap.
- A keyboard shortcut for the button — Deferred. Reason: not asked for.

# CORE-03: orchestrator

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01, core/02, html/01, html/02
> **Blocks**: ui/01, ui/02
> **Status**: todo

## Goal

A press, a typed question, or an ask-option press forks the session once, stores the parsed reply as a pane
entry, and for an html reply writes the explainer, has it layout-checked, then opens it in the system browser.

## Files to create / modify

- `packages/runes/hooks/explain/explain.ts` (new) — `PANE`, the five handler `function` declarations (`explainPress` … `explainReopen`), `explainHooks(on)`.
- `packages/runes/hooks/explain/explain.test.ts` (new) — its tests in the plugin test kit.
- `packages/runes/hooks/register.tsx` (modify) — call `explainHooks(on)` in `register()`.

The layout checker already wired `registerChecker($)` and `checker(on)` into `register.tsx`; do not add them
again. This task edits `register.tsx` next; the pane runs after it and adds its own `explainPane(on)` line. Do not
touch `band.tsx`, `config.ts`, `types/index.d.ts`, `state.ts`, `protocol.ts`, `html.ts` or `checker.ts`.

## Implementation notes

### What already exists (call exactly as `protocol.md` writes it)

- `state.ts`: `view` atom (`{ plugin: "runes", key: "explain" }`), `withEntry`, `patchEntry`, `selectedOf`,
  `usageOf`, `MAX_ENTRIES`.
- `protocol.ts`: `type Ask`, `buildPrompt(ask)`, `parseReply(raw): Reply`.
- `html.ts`: `writeExplainer(io, root, home, { title, main, project }, at)` → absolute path.
- `checker.ts`: `registerChecker($)`, `startCheck($, entryId, path)`, `checker(on)`, `type CheckResult`. The
  checker settles the entry itself (patches `check`/`note`, then runs `open`), so this file passes no callback.

### Exported surface

```ts
export const PANE = "runes-explain";
export async function explainPress($: EngineInterface): Promise<void>;
export async function explainAsk($: EngineInterface, text: string): Promise<void>;
export async function explainPick($: EngineInterface, topic: string): Promise<void>;
export async function explainSelect($: EngineInterface, id: string): Promise<void>;
export async function explainReopen($: EngineInterface, id: string): Promise<void>;
export function explainHooks(on: On): void; // checker(on), nothing else
```

Each is a `function` declaration because the band and the pane call it with `$` from another file; an object
method or an exported arrow fails `claude plugin validate` (`protocol.md` → "Passing `$` across files"). The
three that fork share one same-file helper (an arrow is fine there).

```ts
```

Every handler gets the `$` of the Button `onPress` / Input `onSubmit` that calls it. `$` never leaves the call.

### One run (`press`, `ask`, `pick` share it)

`press` → `Ask { kind: "press" }`. `ask(text)`: trim; empty → return; with `selectedOf(view)` present →
`{ kind: "follow", previous: { title, text }, question }` where `text` is the entry's `body` (text),
`summary` (html), or `question` plus each option on its own line (ask); with no entry →
`{ kind: "free", question }`. (`buildPrompt` does the 4,000-character clip.) `pick(topic)` →
`{ kind: "pick", topic }`.

Then, in order:

1. If `view.isRunning` is true, return without doing anything.
2. `update` the view: `error` cleared, `isRunning: true`.
3. `const { isPlaced } = await $.ui.open({ id: PANE, title: "hey mate", columns: 64 })`. When `isPlaced` is
   false, `$.ui.toast("hey mate needs a wider terminal; the answer is in the pane once it fits")` and carry on.
4. `const r = await $.model.fork({ prompt: buildPrompt(ask) })`.
5. `r.isAnswered === false`: set `error` to `nothing to explain yet` when `r.reason === "nothing-to-fork"`,
   else `` `the fork failed: ${r.reason}` `` (for `api-error` append ` ${r.status}` when present). No entry.
6. Answered: `const reply = parseReply(r.text)`; `at = await $.clock.now()`; id `` `x${at}` `` with `-2`, `-3`…
   on a clash with an existing entry id; `usage: usageOf(r.usage)`.
   - `text` → entry `{ kind: "text", body }`.
   - `ask` → entry `{ kind: "ask", question, options }`.
   - `html` → write the file (below) and store `{ kind: "html", summary, path, check: "pending" }`, keeping
     its `path` and `id` for step 8.
     Store with `withEntry`, which also selects it.
7. Steps 2–6 sit in one `try`; its `finally` sets `isRunning: false`, so a throw anywhere in them still clears
   it. A thrown error (not an `isAnswered: false`) sets `error` to `` `the fork failed: ${message}` ``.
8. After that `try`/`finally`, and only for an html entry: `await startCheck($, id, path)`. It returns once the
   checker started; the checker settles the entry and opens the file later, from its own hook. Nothing after
   step 7 touches `isRunning`.

`isRunning` covers the fork alone. `startCheck` returns once the checker has started, so the press returns
too; the checker settles the entry later. A new press works while a check runs, and a finishing check cannot
clear a newer press's `isRunning`, since only that press's own `finally` writes it.

### Writing the html file

- `home = (await $.env.get("HOME")) ?? ""`.
- `project`: `$.process.run(["git", "rev-parse", "--show-toplevel"], { env: { HOME: home } })` in the session
  cwd; exit 0 → basename of the trimmed stdout, else the basename of the cwd. The cwd comes from the module value
  `where.cwd` (`hooks/transcript/where.ts`, set by `register.tsx`'s `session.start`). Pass it as the process
  cwd if `$.process.run` accepts one in the typings; otherwise run `git -C <cwd> rev-parse --show-toplevel`.
- `io` adapts `$.fs`: `read: (p) => $.fs.read(p).then(String)`, `write: $.fs.write`, `exists: $.fs.exists`,
  `mkdir: (d) => $.process.run(["mkdir", "-p", d]).then(() => {})` unless the typings offer a `$.fs` mkdir —
  check `packages/runes/.claude-plugin/types/claude-code/index.d.ts` and use the engine's when it exists.
- `root = $.plugin.root`; `at = new Date(<the clock's now>)`.
- A write that throws sets `error` to `` `could not write the explainer: ${message}` `` and stores the reply as a
  `text` entry of its `summary`, so the answer is not lost.

### `select` and `reopen`

- `select(id)`: `update` the view, `selected: id`. No fork.
- `reopen(id)`: the entry with that id, when `kind === "html"`, → `$.process.run(["open", path])`. No state
  change. Any other id does nothing.

### `register.tsx` edits

- Import `{ explainHooks }` from `./explain/explain`.
- In `register()`, add `explainHooks(on);` after `checker(on);`.

### Tests (`explain.test.ts`)

Use `startSession` / `fakeHost` from `hooks/transcript/test-session.ts`, a fake `config.yaml` with
`explain:\n  enabled: true\n`, and stubs for `model.fork`, `agent.spawn`, `agent.list`, `process.run`,
`fs.read/write/exists`, `env.get`, `ui.open`, `ui.toast`, `clock` (`mock.clock(on)`). Read state through the
`{ plugin: "runes", key: "explain" }` atom.

## Acceptance criteria

- [ ] `press` with a `text` reply: `ui.open` called with `{ id: "runes-explain", title: "hey mate", columns: 64 }`, one `model.fork` whose prompt equals `buildPrompt({ kind: "press" })`, one `text` entry stored first and selected, its `usage` from `usageOf`, `isRunning` false after.
- [ ] `press` with an `ask` reply stores an `ask` entry with its question and options.
- [ ] `press` with an `html` reply writes one file under `~/.local/share/q-lab/runes/explain/<project>/`, stores `check: "pending"`, spawns the checker; after the checker's `turn.complete` answers `FIXED 2` the entry reads `check: "fixed"`, `note: "2 fix(es)"`, and `process.run` received `["open", <that path>]`.
- [ ] A denied checker spawn still runs `open` and leaves `check: "failed"`.
- [ ] `isPlaced: false` raises the toast `hey mate needs a wider terminal; the answer is in the pane once it fits` and the fork still runs.
- [ ] `{ isAnswered: false, reason: "nothing-to-fork" }` sets `error` to `nothing to explain yet`, stores nothing, and clears `isRunning`; `api-error` sets an error starting `the fork failed: api-error`.
- [ ] A fork that throws clears `isRunning` and sets `error`.
- [ ] A second `press` while the first fork is pending makes no second `model.fork` call.
- [ ] Press A returns html and its check stays pending; press B starts and its fork stays pending; A's check then answers: `isRunning` is still true, and a third press makes no `model.fork` call. B's fork then resolves and `isRunning` turns false.
- [ ] `explainPress` resolves before the checker answers; the checker's later `turn.complete` patches the entry and runs `open`.
- [ ] `ask("why?")` with a text entry selected forks with `buildPrompt({ kind: "follow", previous: { title, text: body }, question: "why?" })`; with no entries, with `{ kind: "free", question: "why?" }`; an empty or whitespace `ask` forks nothing.
- [ ] `pick("the parser")` forks with `buildPrompt({ kind: "pick", topic: "the parser" })`.
- [ ] Two entries in the same millisecond get ids `x<at>` and `x<at>-2`.
- [ ] `select(id)` sets `selected`; `reopen(id)` on an html entry runs `open` with its path and on a text entry runs nothing.
- [ ] `register.tsx` calls `explainHooks(on)` in `register()`, and still calls `registerChecker($)` and `checker(on)` exactly once each.
- [ ] With the whole runes plugin loaded through `register.tsx` (so Clawd's unmatched and fold's `{ reason }` `turn.complete` hooks run too), `claude plugin validate packages/runes` passes and a checker answer still settles its html entry.

## Verification

- [ ] `claude plugin test packages/runes` passes, including `hooks/explain/explain.test.ts`.
- [ ] `claude plugin validate packages/runes` reports no refusal.
- [ ] `grep -n "explainHooks(on)" packages/runes/hooks/register.tsx` prints one line.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                               | 2–3 (below bar)                                                                             | 4–5 (pass)                                                                |
| ----------------------- | ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Correctness             | ×3     | a run leaves `isRunning` true, or an html reply never opens              | happy paths work; a failure path (no fork, denied spawn, write throw) drifts from the notes | every path in the notes behaves as written, strings byte for byte         |
| Test coverage           | ×2     | no `explain.test.ts`                                                     | text/ask/html happy paths only                                                              | every acceptance criterion has a test, failure paths included             |
| Interface & readability | ×1     | `$` stored in a module value, or a second hook on an event that collides | works, but the shared run is copied per handler                                             | one run function shared by press/ask/pick; signatures match `protocol.md` |
| Assumptions & docs      | ×1     | an engine behaviour relied on silently                                   | assumptions made, not explained                                                             | any engine quirk relied on is tested or has a one-line why                |

## Out of scope

- The band Button and the pane rendering — Deferred. Reason: they only call these handlers and own their own files.
- Cancelling a running fork — Deferred. Reason: `$.model.fork` takes no signal; not asked for.
- Cost estimates before a press — Deferred. Reason: cost is shown after, by decision.

# MOD-02: Flightdeck pane mod

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: data/01, mod/01
> **Blocks**: mod/03
> **Status**: done
> **Models**: dev=opus/high

## Goal

The Claude Code mod feature that opens, refreshes, and draws the flightdeck pane, and auto-opens it in the session that just launched flightdeck.

## Files to create / modify

- `packages/dispatch/hooks/flightdeck/deck-command.ts` (new) — pure: the Bash matcher regex and the `--plan` extractor.
- `packages/dispatch/hooks/flightdeck/deck-command.test.ts` (new) — `bun test` cases for both.
- `packages/dispatch/hooks/flightdeck/flightdeck.tsx` (new) — the mod feature: command, pane, ticker, auto-open, render.
- `packages/dispatch/hooks/register.ts` (modify) — call `flightdeck(on)` after the existing lint hook.
- `packages/dispatch/hooks/flightdeck.mod.test.ts` (new) — `claude-code/testing` cases.
- `packages/dispatch/tsconfig.json` (new) — `{ "extends": "./.claude-plugin/types/tsconfig.json" }`, giving the `.tsx` its JSX and mod types, as runes does.
- `.gitignore` (modify) — add `packages/dispatch/.claude-plugin/types/` beside the existing `packages/runes/.claude-plugin/types/` line.

## Implementation notes

**Load the `plugin-authoring` skill before writing the mod.** It is the authority on the mod API; the notes below fix this feature's behaviour, not the API's spelling. Where the skill and these notes disagree on an API name, follow the skill and keep the behaviour.

### Things already built (inline contracts)

- **The snapshot CLI `deck-snapshot.ts`** — run as `bun <plugin root>/skills/autopilot/scripts/deck-snapshot.ts <planDir>`, where `<plugin root>` is `$.plugin.root`.
  - Exit 0: stdout is one `DeckSnapshot` JSON (type in `packages/dispatch/hooks/flightdeck/types.ts`, shape in `shared.md`).
  - Exit 2: the dir holds no plan; stderr carries one line saying so.
  - `--latest <dir>`: exit 0 prints `{"plan":"<abs plan dir>"}`; exit 3 means no run log under `<dir>/docs/*/`.
- **The pure layout module `rows.ts`** (`packages/dispatch/hooks/flightdeck/rows.ts`):
  ```ts
  export type Seg = { text: string; color?: string; dim?: boolean; ref?: string };
  export type Line = Seg[];
  export function docked(s: DeckSnapshot, width: number, now: number, stale: boolean): Line[];
  export function inline(s: DeckSnapshot, width: number, stale: boolean): Line[];
  export function clip(line: Line, width: number): Line;
  ```
  A `Seg` with `ref` is a task card and must render pressable. The mod maps segs to `Text` / `Button`; it does no layout of its own.

### `deck-command.ts` (pure, imports nothing from `claude-code`)

```ts
// tool.call matcher: a command that runs flightdeck.ts and passes --plan
export const FLIGHTDECK_COMMAND: RegExp;
// the --plan value: "--plan \"/a b\"", "--plan '/a'", "--plan=/a", "--plan /a"; null when absent
export function planArg(command: string): string | null;
```

- `FLIGHTDECK_COMMAND` must match `flightdeck.ts` as a word followed somewhere by `--plan`, and must not match `flightdeck.test.ts`.
- Test cases, each pinned:
  - `bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"` → matches, `planArg` = `/abs/docs/x` (the exact `/autopilot` SKILL.md form).
  - `bun "/abs/autopilot/scripts/flightdeck.ts" --plan "/abs/run"` → matches, `/abs/run` (the deckplan form).
  - `bun flightdeck.ts --plan=/abs/y` → `/abs/y`; `bun flightdeck.ts --plan '/a b'` → `/a b`.
  - `bun flightdeck.test.ts` → no match; `bun flightdeck.ts` (no `--plan`) → `planArg` null.

### `flightdeck.tsx` (the mod feature)

Export `flightdeck = (on: On) => { … }` returning nothing; `register.ts` calls it. Never pass `$` to another file's function. No `Bun`, no `node:`, no global `fetch`.

State: a module-level `atom` (or atoms) holding `{ plan: string | null; snapshot: DeckSnapshot | null; stale: boolean; message: string | null }`, written only from the ticker, command handler, or tool hook — never from `ui.render`. Keep the ticker handle in a module variable.

1. **Command registration.** Hook `session.start` with a matcher of its own (`{ isInteractive: true }`), so it cannot collide with another unmatched `session.start` hook in the same module. Call `$.command.register({ name: "flightdeck", description: "Open the flightdeck overview pane", argumentHint: "[planDir|close]" })`.
2. **`command.run` `{ command: "flightdeck" }`**, on `e.args.trim()`:
   - `close` → **Close** (below), reply `Flightdeck closed.`
   - empty and pane open (`$.ui.panes()` lists `flightdeck`) → same as `close`.
   - empty and closed → capture `generation`, then resolve: repo root from `$.process.run(["git", "rev-parse", "--show-toplevel"])` (trimmed stdout on exit 0), else the session cwd; run the CLI with `--latest <root>`. Exit 3 → reply `No flightplan run found under <root>/docs`. Exit 0 → open on the printed `plan` only if `generation` is still the captured value; a close or another open during the lookup wins, and the lookup result is dropped.
   - anything else → treat it as the plan dir and open on it.
3. **Lifecycle rule — only open and close touch the ticker, each in one synchronous step that bumps `generation` first.** Snapshot work never starts, replaces, or cancels a ticker; it only writes the snapshot, guarded by `generation`. A command may await (`--latest`, `git rev-parse`) before calling open; open itself does its ticker work before its own first `await`.
   - **Open on `<plan>`** (synchronous part first): increment the module-level `generation`, set `plan`, clear `snapshot`/`stale`/`message`, cancel any previous ticker, start the new ticker, and run its first tick immediately. Then `await $.ui.open({ id: "flightdeck", title, columns: 40, rows: 2, focus: false })` with `title` = `"Flightdeck · " + <last path segment of plan>` (the snapshot's `slug` is that same basename). Opening while already open on another plan is the same call: it switches the plan in place.
   - **Close**: increment `generation`, cancel the ticker, then `await $.ui.close({ id: "flightdeck" })`.
4. **Snapshot** (one tick's work) = `$.process.run(["bun", `${$.plugin.root}/skills/autopilot/scripts/deck-snapshot.ts`, plan])`.
   - Capture `generation` before spawning. When the child returns and `generation` has moved on (switched or closed meanwhile), discard the result: an earlier plan's late snapshot must never overwrite the current one.
   - Skip a tick while a snapshot is still running, so a slow child never stacks a second one.
   - Exit 0 → store the parsed snapshot, `stale = false`, `message = null`.
   - Non-zero → keep the last snapshot, `stale = true`, `message` = first stderr line.
5. **Ticker** = `$.clock.every(2000, …)`. Each tick after the first: if `$.ui.panes()` no longer lists `flightdeck` (the user closed it by hand), increment `generation`, cancel, and stop — this is the one cancel outside open/close, and it runs inside the tick, never after awaiting a snapshot. Otherwise run a snapshot, then `$.ui.invalidate("ui.render")` so elapsed times advance even when the snapshot is unchanged.
6. **Auto-open** — `on("tool.call", { tool: "Bash", command: FLIGHTDECK_COMMAND }, …)`. The existing lint hook uses `{ tool: ["Edit", "Write"], file_path: TASK_PATH }`, so the matchers are distinct.
   ```ts
   const ran = await next(e);
   if (ran.deny !== undefined || ran.isError) return ran;
   const plan = planArg(e.command);
   if (plan) await openOn(plan);  // same open path as the command
   return ran;                     // unchanged
   ```
7. **`ui.render` `{ component: "Pane", requestId: "flightdeck" }`**:
   - No snapshot → one dim line, `message ?? "Loading…"`, passed through the layout module's `clip(line, width)` with the same width the layouts use, so a long stderr path never overflows.
   - `e.props.placement === "inline"` → `inline(snapshot, e.props.bodyColumns ?? 40, stale)`.
   - Else → `docked(snapshot, e.props.bodyColumns ?? 40, Date.now(), stale)`, then an `Open flightdeck` `Button`.
   - Each `Line` → a row `Box`; each `Seg` → `Text` with `color` / `dimColor`, or, when `ref` is set, a `Button` whose `onPress` toasts the card text below.
   - **Card toast**: `ref · title · state · attempt N · score W/T passed|failed`, from `snapshot.tasks[ref]`; drop the score part when `score` is null. Example, for a task ref `<ref>`: `<ref> · Add token route · in-progress · attempt 2 · score 3.8/4.0 failed`.
   - **Open flightdeck** `onPress`: `$.process.run(["bun", `${$.plugin.root}/skills/autopilot/scripts/flightdeck.ts`, "--plan", plan])`; on non-zero exit, toast its first stderr line. The launcher reuses a live server or starts one and opens the browser itself. A different plan's launch SIGTERMs the running server — existing launcher behaviour; do not change it.

### `register.ts`

Keep the file as `.ts` and import `{ flightdeck } from "./flightdeck/flightdeck.tsx"`; call `flightdeck(on)` inside `register`. Rename to `register.tsx` only if the runtime refuses the import. Then update `hooks.json` (`{ "modules": ["./register.tsx"] }`), the root `tsconfig.json` `exclude` entry `packages/dispatch/hooks/register.ts`, and the copy command's file list to match.

### Root `tsconfig.json` and `bunfig.toml` — no change expected

The root `tsconfig.json` includes only `packages/**/*.ts` and already excludes `packages/dispatch/hooks/register.ts` and `packages/dispatch/hooks/*.mod.test.ts`; nothing else included imports `flightdeck.tsx`, so tsc never sees it. `bunfig.toml` already ignores `packages/dispatch/hooks/*.mod.test.ts`. `deck-command.ts`, `rows.ts`, and `types.ts` stay in tsc and bun on purpose. Add an exclusion only if the typecheck below reports a `claude-code` import.

### `packages/dispatch/tsconfig.json`

Mirror runes: `packages/runes/tsconfig.json` is `{ "extends": "./.claude-plugin/types/tsconfig.json" }`. Claude Code writes that types dir beside the plugin on load (it is gitignored), with `"jsx": "react"`, `"jsxFactory": "h"`, `"jsxFragmentFactory": "Fragment"` and `types: ["claude-code", …]`. Add the same file for dispatch and the `.gitignore` line for its types dir.

### Mod test (`flightdeck.mod.test.ts`)

Import `On` from `claude-code` and `expect, test` from `claude-code/testing`. The kit has no real store, fs, env, or process, so stub each noun; a stub for a noun answers `{ value }`:

```ts
on("process.run", (_$, e) => {
  runs.push(e.argv);
  return { value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } as never;
});
on("tool.call", () => ({ result: {}, text: "ok" }) as never);   // the tool's answer beneath the mod
```

Stub `ui.panes`, `ui.open`, `ui.close`, and `clock` (`mock.clock(on)` for `$.clock`) the same way. Cover:

- `/flightdeck <dir>` opens the pane and runs `deck-snapshot.ts <dir>`; a second bare `/flightdeck` closes it.
- A successful Bash call to `bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"` opens the pane on `/abs/docs/x`; the same call answering `isError` opens nothing.
- A snapshot child exiting non-zero after a good one keeps the good snapshot and sets `stale`.
- A tick that finds no `flightdeck` in `ui.panes` cancels the ticker and runs no child.

## Acceptance criteria

- [x] `planArg` returns the plan dir for the autopilot form, the deckplan form, `--plan=`, and single-quoted values, and `FLIGHTDECK_COMMAND` rejects `bun flightdeck.test.ts`.
- [x] `/flightdeck <dir>` opens pane `flightdeck` (40 columns, 2 inline rows) and a bare `/flightdeck` toggles it closed; `/flightdeck close` closes it.
- [x] A successful Bash `flightdeck.ts --plan <dir>` call opens the pane on `<dir>` and returns the tool result unchanged; an errored or denied call opens nothing.
- [x] A failing snapshot keeps the last good snapshot and marks it stale; the ticker cancels when the pane is gone.
- [x] With a delayed `--latest` stub: `/flightdeck close` or `/flightdeck <planB>` issued before the lookup returns leaves the pane closed, or on plan B, respectively.
- [x] With a delayed `process.run` stub for plan A: switching to plan B, or closing, before A's first snapshot returns leaves exactly one live ticker (B's, or none after close), and A's late result is discarded.
- [x] `flightdeck.tsx` imports no `node:` module, uses no `Bun` global, and passes `$` to no other file's function.
- [x] (human) In a real Claude Code session, the docked pane shows the summary line, bucket bars, wave rows with coloured cards, in-flight agents, and the `Open flightdeck` button; pressing a card toasts its details.
- [x] (human) In a narrow terminal the pane sits above the prompt as two lines: the summary and the current wave's cards.
- [x] (human) A real `/autopilot` launch opens the pane by itself, and it refreshes about every 2 s while agents run.

## Verification

- [x] `bun test packages/dispatch/hooks/flightdeck/deck-command.test.ts` passes.
- [x] The mod test on a copy exits 0:
  ```sh
  (d=$(mktemp -d) && mkdir "$d/hooks" && cp -R packages/dispatch/.claude-plugin "$d" && (cd packages/dispatch/hooks && cp -R hooks.json register.ts task-path.ts flightdeck flightdeck.mod.test.ts flightplan-lint.mod.test.ts "$d/hooks") && rm -f "$d"/hooks/flightdeck/*.test.ts && claude plugin test "$d"; s=$?; rm -rf "$d"; exit $s)
  ```
- [x] `bunx --bun tsc --noEmit | grep -E 'hooks/flightdeck|hooks/register'` prints nothing.
- [x] `rg -n 'from "node:|\bBun\.' packages/dispatch/hooks/flightdeck/flightdeck.tsx` prints nothing.
- [x] `grep -n 'packages/dispatch/.claude-plugin/types/' .gitignore` finds the line.

## Eval rubric

> Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Shared bands: `../_context/rubric.md`.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Hands `$` to another file, imports `node:`, writes state in `ui.render`, or a matcher collides with the lint hook | Pane opens and draws, but auto-open fires on errored calls, stale is lost, or the ticker outlives the pane | Every pane decision in `shared.md` holds, including toggle, auto-open, stale, ticker cancel, and the button |
| Test coverage | ×2 | No mod test | Happy-path open only | Toggle, auto-open success and error, stale, and ticker cancel each have a case; `planArg` covers every quoting form |
| Interface & readability | ×1 | Layout logic duplicated in the `.tsx` | Mod mixes parsing with rendering | Pure parsing in `deck-command.ts`, layout only through `rows.ts`, the `.tsx` is wiring |
| Assumptions & docs | ×1 | Magic `2000` / `40` unnamed | Named, but corner-cuts unexplained | Constants named; one-line why comments on the matcher choice and the per-tick invalidate |

## Out of scope

- Token counts in the pane — Deferred. Reason: attribution reads transcripts, too costly at a 2 s refresh.
- Any change to the flightdeck server, its SPA, or `daemon.json` — Deferred. Reason: the pane reads files and never talks to the server.
- Codex and OpenCode — Deferred. Reason: neither runtime has function hooks.
- Editing `CLAUDE.md` or the autopilot / deckplan SKILL.md files — Deferred to a follow-up task in the same bucket.

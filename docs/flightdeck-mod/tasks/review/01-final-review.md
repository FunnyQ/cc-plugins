# REVIEW-01: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: data/01, mod/01, mod/02, mod/03
> **Status**: done
> **Final review**: true

## Goal

Confirm that the snapshot CLI, the pure pane layout, the flightdeck mod feature, and the docs fit together into the pane `../_context/shared.md` describes, and that nothing that worked before is broken.

## Files to create / modify

- None expected. Fix integration defects in place, in whichever file holds them, and stay within the files the plan already created or modified.

## Implementation notes

### What to check

- **One contract.** `DeckSnapshot` and its member types are defined once, in `packages/dispatch/hooks/flightdeck/types.ts`. Both `packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts` and `packages/dispatch/hooks/flightdeck/rows.ts` import them from there. A second copy of the type anywhere else is a defect.
- **Mod constraints.** Nothing under `packages/dispatch/hooks/` that loads into the mod (`register.ts`, `flightdeck/flightdeck.tsx`, `flightdeck/rows.ts`, `flightdeck/deck-command.ts`, `flightdeck/types.ts`) imports a `node:` module or uses the `Bun` global, and no function receives `$` from another file. `register.ts` only calls the feature function with `on`.
- **The existing hook still works.** The flightplan-lint `tool.call` hook on `Edit|Write` still fires, and its mod test `flightplan-lint.mod.test.ts` still passes. The new `tool.call` hook on `Bash` uses a matcher distinct from the lint hook's.
- **The server is unchanged.** The flightdeck server, its routes, and its SPA are not touched.
- **The pane matches the decisions.** The pane uses the id `flightdeck`, has a docked layout and a 2-row inline layout, uses the card glyphs and colours in the table, refreshes every 2000 ms only while the pane is open, keeps the last good snapshot marked `stale` when a refresh fails, auto-opens only after a successful `flightdeck.ts … --plan <dir>` Bash call, and has an `Open flightdeck` button that runs the launcher.
- **Waves are static depth.** Done tasks keep their wave. Cycles and dangling dependencies go to `unschedulable`.
- **Exclusions.** Every new file that imports `claude-code` stays out of the root bun and tsc runs: a `.tsx` file is outside the root `tsconfig.json` `include` (`packages/**/*.ts`), and a `*.mod.test.ts` file is covered by the existing `exclude` and `bunfig.toml` `pathIgnorePatterns` entries. No pure file (`rows.ts`, `deck-command.ts`, `types.ts`) is excluded.
- **No release work.** No version file moves and no `CHANGELOG.md` entry is added.

### Changed-file checks use `git diff`

Autopilot commits between waves, so `git status` no longer lists earlier tasks' edits. Use `git diff --name-only <baseRef> -- <paths>`. Autopilot substitutes `<baseRef>` with the commit the run started from.

## Acceptance criteria

- [x] `grep -rn "type DeckSnapshot" packages/dispatch` prints exactly one line, in `packages/dispatch/hooks/flightdeck/types.ts`.
- [x] `grep -n 'hooks/flightdeck/types.ts' packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts` and `grep -n '"./types.ts"' packages/dispatch/hooks/flightdeck/rows.ts` each print at least one import line.
- [x] `grep -rnE "from \"node:|\\bBun\\." packages/dispatch/hooks/register.ts packages/dispatch/hooks/flightdeck/ --include='*.ts' --include='*.tsx' --exclude='*.test.ts'` prints nothing.
- [x] `git diff --name-only <baseRef> -- packages/dispatch/skills/autopilot/scripts/flightdeck.ts packages/dispatch/skills/autopilot/scripts/tree-api.ts packages/dispatch/skills/autopilot/scripts/events-api.ts packages/dispatch/skills/autopilot/dashboard` prints nothing.
- [x] `git diff --name-only <baseRef> -- packages/dispatch tsconfig.json bunfig.toml CLAUDE.md` lists `packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts`, `packages/dispatch/hooks/flightdeck/types.ts`, `packages/dispatch/hooks/flightdeck/rows.ts`, `packages/dispatch/hooks/flightdeck/deck-command.ts`, `packages/dispatch/hooks/flightdeck/flightdeck.tsx`, `packages/dispatch/hooks/flightdeck.mod.test.ts`, and `CLAUDE.md`.
- [x] `git diff <baseRef> -- packages/dispatch/.claude-plugin/plugin.json packages/dispatch/.codex-plugin/plugin.json CHANGELOG.md` prints nothing.
- [x] (human) Q runs `/flightdeck docs/flightdeck-mod` in a real Claude Code session and confirms the pane shows the summary line, the bucket bars, one row group per wave, the agent lines, and the `Open flightdeck` button as `../_context/shared.md` describes.

## Verification

- [x] `bun test packages/dispatch/` passes.
- [x] The mod test on a copy passes, including both `flightdeck.mod.test.ts` and `flightplan-lint.mod.test.ts`:
  ```sh
  (d=$(mktemp -d) && mkdir "$d/hooks" && cp -R packages/dispatch/.claude-plugin "$d" && (cd packages/dispatch/hooks && cp -R hooks.json register.ts task-path.ts flightdeck flightdeck.mod.test.ts flightplan-lint.mod.test.ts "$d/hooks") && rm -f "$d"/hooks/flightdeck/*.test.ts && claude plugin test "$d"; s=$?; rm -rf "$d"; exit $s)
  ```
- [x] `bunx --bun tsc --noEmit | grep -E 'deck-snapshot|hooks/flightdeck|hooks/register'` prints nothing.
- [x] `bun packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts docs/flightdeck-mod` exits 0 and prints JSON with `deckSource`, `waves`, `tasks`, and `agents` keys.

## Eval rubric

> Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Shared bands: `../_context/rubric.md`.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | The pane does not open, or shows data that contradicts the plan files and run log | The pane works for a tasks tree but a graph run, a stale refresh, or auto-open fails | The plan goal is met end to end: command, auto-open, refresh, both layouts, and graph runs all behave as `shared.md` says |
| Integration | ×2 | The CLI output and the pane disagree on the contract | One contract, but a field `../_context/shared.md` lists as rendered or used is not consumed, or the pane reads a field the CLI never produces | One `DeckSnapshot` definition, every field `../_context/shared.md` lists as rendered or used has a consumer; identification-only fields (`deckSource`, `planTitle`) only need to be produced correctly |
| Consistency with shared.md | ×1 | Glyphs, colours, ids, or intervals differ from `shared.md` | One or two values drift | Every pane decision matches `shared.md` exactly |
| No regressions | ×2 | The flightplan-lint hook or the dispatch bun suite fails | Suites pass but a server file or version file changed | All suites pass; server, SPA, and version files untouched |
| Leanness | ×1 | Re-implements task parsing or fleet aggregation, or adds unused options | One abstraction with a single caller, or a config nobody sets | Reuses the existing flightdeck data code; nothing beyond what `shared.md` names |

## Out of scope

- Releasing dispatch — Deferred. Reason: the version bump and tag happen in a separate `/chronicle:release` run.
- `CHANGELOG.md` entry — Deferred. Reason: the release run writes it.

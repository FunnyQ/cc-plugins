# SHIP-01: Wire callers to the shim and migrate the statusline

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: server/02, cli/01
> **Blocks**: ship/02
> **Status**: todo
> **Models**: dev=opus/high

## Goal

Every caller of the usage-dashboard runs `cockpit atlas …` through the shim `packages/monitor/skills/cockpit/bin/cockpit`, and an existing `bun …statusline-collector.ts` statusline is rewritten to `… cockpit atlas statusline` once per plugin version by `setup.ts --session-check`.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/SKILL.md` (modify) — background launch becomes `<plugin-root>/skills/cockpit/bin/cockpit atlas serve`; the "Live Usage Limits" section names `cockpit atlas statusline`. The precheck line (`bun <plugin-root>/skills/install/scripts/install.ts`) stays.
- `packages/monitor/skills/usage-dashboard/references/opencode.md` (modify) — `~/.config/opencode/skills/cockpit/bin/cockpit atlas serve … &`, and the `bun …/usage-dashboard/scripts/…` sentence reworded.
- `packages/monitor/skills/install/scripts/install.ts` (modify) — collector resolution and `COLLECTOR_COMMAND` point at the shim; the dashboard-precheck hint lines.
- `packages/monitor/skills/install/scripts/statusline-decision.ts` (modify) — recognizes old and new forms; pure.
- `packages/monitor/skills/install/scripts/setup-statusline.ts` (modify) — messages only; wiring logic stays delegated to the decision.
- `packages/monitor/skills/install/scripts/setup.ts` (modify) — `migrate()` statusline rewrite, drift watch, `statuslineReferencedCollector()`, stale comment.
- `packages/monitor/skills/install/scripts/reap-stale.ts` (modify) — comment only: the atlas exclusion now names the `cockpit atlas serve` command line as well.
- `packages/monitor/skills/install/scripts/statusline-decision.test.ts` (modify)
- `packages/monitor/skills/install/scripts/setup.test.ts` (modify)
- `packages/monitor/skills/install/scripts/reap-stale.test.ts` (modify) — an `atlas serve` row that is excluded like the TS one.

## Implementation notes

### The two command forms

- **Old form**: `bun <path>/statusline-collector.ts`, where `<path>` ends `/skills/usage-dashboard/scripts`. Detected today by `/(\S*statusline-collector\.ts)/` in `setup.ts`, `install.ts`, and `statusline-decision.ts`.
- **New form**: `<path>/skills/cockpit/bin/cockpit atlas statusline`. Detect with one regex, e.g. `/(\S*\/skills\/cockpit\/bin\/cockpit) atlas statusline\b/`, exported from `statusline-decision.ts` so `setup.ts` and `install.ts` import it rather than holding a copy (the file's own comment explains why a second literal drifts).
- Either form may carry a wrapped user command in front: `TOKEN_ATLAS_STATUSLINE_COMMAND='<cmd>' <collector command>`. Migration keeps that prefix byte-for-byte and replaces only the collector part.

### `install.ts`

Today `marketplaceCollector()` resolves `<marketplace clone>/<source>/skills/usage-dashboard/scripts/statusline-collector.ts` through `known_marketplaces.json`, falling back to `LIVE_COLLECTOR` in this install; `COLLECTOR_COMMAND = "bun " + COLLECTOR_SCRIPT`. Keep the marketplace-clone resolution (the plugin cache path encodes the version and goes stale) and only change the target:

- `COLLECTOR_SCRIPT` → `<clone>/<source>/skills/cockpit/bin/cockpit` when that file exists, else this install's `skills/cockpit/bin/cockpit`.
- `COLLECTOR_COMMAND` → `` `${COLLECTOR_SCRIPT} atlas statusline` `` (no `bun`: the shim is `#!/bin/sh` with mode 100755).
- "Wired" means the new-form path equals `COLLECTOR_SCRIPT`. An old-form reference yields a hint that session-check or `/monitor:install` will rewrite it.
- The final `All checks passed. Run: …` hint names `skills/cockpit/bin/cockpit atlas serve`.

No new `permissions.allow` entry is needed: `SCRIPT_PERMISSIONS` in `setup.ts` already holds `Bash(**/q-lab-marketplace/*/skills/cockpit/bin/cockpit *)`.

### `statusline-decision.ts`

`decideStatusLine(statusLine, collectorCommand)` keeps its `skip | write` result and adds nothing to its signature:

| Existing `statusLine.command` | Result |
|---|---|
| New form whose path equals the live shim | `skip` |
| New form at another path (older clone, other cache root) | `write`, collector part re-pointed, wrapped prefix kept |
| Old form, any path | `write`, collector part replaced by `collectorCommand`, wrapped prefix kept, `preserved: null` |
| Non-collector command | `write`, wrapped as `TOKEN_ATLAS_STATUSLINE_COMMAND='<cmd>' <collectorCommand>`, `preserved: <cmd>` (unchanged behavior) |
| Missing | `write`, bare `collectorCommand` (unchanged) |

Examples to pin as tests:

```
bun /x/marketplaces/q-lab-marketplace/packages/monitor/skills/usage-dashboard/scripts/statusline-collector.ts
→ /x/marketplaces/q-lab-marketplace/packages/monitor/skills/cockpit/bin/cockpit atlas statusline

TOKEN_ATLAS_STATUSLINE_COMMAND='npx claude-powerline' bun /x/…/usage-dashboard/scripts/statusline-collector.ts
→ TOKEN_ATLAS_STATUSLINE_COMMAND='npx claude-powerline' /x/…/cockpit/bin/cockpit atlas statusline
```

Add one exported pure helper for the session-check path, e.g. `migrateCollectorCommand(command: string, collectorCommand: string): string | null` — returns the rewritten command for an old-form command whose path ends `/skills/usage-dashboard/scripts/statusline-collector.ts`, and `null` for anything else (new form, foreign `statusline-collector.ts` elsewhere, non-collector, missing).

### `setup.ts` session-check

- Replace the comment above `migrate()` ("Never touches the statusline: any collector path keeps working across plugin updates…"). That stopped being true when the TS collector was deleted: an old-form path no longer exists after the marketplace clone updates, so every statusline tick fails. New rule, one line of why: `migrate()` rewrites an *existing* old-form collector command to the shim; it still never fresh-wires, because wiring is the user's opt-in via `/monitor:install`.
- `migrate()` calls `migrateCollectorCommand(cmd, COLLECTOR_COMMAND)`. On a non-null result: back up `settings.json` to `settings.json.bak` and write it the way `applyStatusline()` in `setup-statusline.ts` already does (`JSON.stringify(settings, null, 2) + "\n"`; reuse that writer or extract the shared part — do not add a second format), then push `"statusline collector"` onto `changed`. Unparseable `settings.json` → untouched (the drift watch already reports it). Missing `statusLine` → untouched.
- It runs inside the existing once-per-version gate (`$CLAUDE_PLUGIN_DATA/.wired-version`), so a second session of the same version changes nothing; a second `migrate()` call on already-migrated settings also returns no change (idempotent).
- Output: nothing prints directly. `migrate()` reports through the existing `captureLogs` path, so the only stdout of `--session-check` stays the single `{"systemMessage": …}` JSON line.
- `statuslineReferencedCollector()` and the drift watch accept the new form. An old-form command seen by the drift watch (a version where migration already ran, then a restored backup) reports a new item `{ key: "statusline-old-collector", message: "statusLine still runs the removed TS collector … run the /monitor:install skill" }`. The existing `statusline-missing` item fires only when neither form is present.

### `reap-stale.ts`

The exclusion is by omission (only cockpit channel/daemon command lines are selected), so no regex changes. Update the comment that says `atlas-server` is out of scope so it also names `cockpit atlas serve`, and add a `reap-stale.test.ts` row with command `…/skills/cockpit/bin/cockpit atlas serve --no-open`, PPID 1, asserting it is not selected. Check that the cockpit selection regex cannot match `cockpit atlas serve` (it must select `cockpit server`/`cockpit channel` only); if it can, tighten it and say so in the report.

## Acceptance criteria

- [ ] `decideStatusLine` returns `skip` for the live new form and rewrites old-form and drifted new-form commands with any `TOKEN_ATLAS_STATUSLINE_COMMAND='…'` prefix preserved byte-for-byte; the five table rows are unit tests.
- [ ] `migrateCollectorCommand` rewrites the two pinned examples exactly, and returns `null` for the new form, a foreign `statusline-collector.ts` path, a non-collector command, and an empty string.
- [ ] `setup.ts --session-check` with an old-form `settings.json` under a temp `HOME` rewrites `statusLine.command`, writes `settings.json.bak`, prints exactly one JSON line to stdout whose `systemMessage` names the statusline update, and a second run changes nothing.
- [ ] Session-check leaves an unparseable `settings.json` byte-identical and never adds a `statusLine` block that was absent.
- [ ] The drift watch reports `statusline-old-collector` for an old-form command, nothing for the live new form, and `statusline-missing` only when neither form is present.
- [ ] `COLLECTOR_COMMAND` equals `<shim path> atlas statusline` with no `bun` prefix, and `install.ts` reports the statusline wired when `settings.json` holds exactly that command.
- [ ] SKILL.md and `references/opencode.md` launch the dashboard with `cockpit atlas serve`; the TS script names survive only in the old-form detection code.
- [ ] (human) Q only, under the statusline exception in `../_context/shared.md` (settings backed up to `~/.claude/settings.json.pre-atlas` first): after `bun packages/monitor/skills/install/scripts/setup.ts --session-check` against Q's real settings (with `CLAUDE_PLUGIN_DATA` set to the monitor data dir), a fresh Claude Code session renders the statusline through `cockpit atlas statusline` and `~/.cache/token-atlas/rate-limits.json` gets a new mtime.

## Verification

- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/` passes — every subcommand the wiring points at is now whole.

- [ ] `bun test packages/monitor/skills/install/scripts/` passes.
- [ ] `bunx --bun tsc --noEmit | grep install/scripts` prints nothing.
- [ ] `rg -ln 'atlas-server\.ts|statusline-collector\.ts' packages/monitor/skills/usage-dashboard/SKILL.md packages/monitor/skills/usage-dashboard/references packages/monitor/skills/install/scripts | grep -vE 'install/scripts/(statusline-decision|setup|reap-stale)(\.test)?\.ts$'` prints nothing (the allowed legacy references in `../_context/contracts.md` §7).
- [ ] `git status --short -- packages/monitor/skills/usage-dashboard/SKILL.md packages/monitor/skills/install/scripts/setup.ts packages/monitor/skills/install/scripts/statusline-decision.ts` lists all three as modified.
- [ ] (human) The live statusline check from the acceptance criteria.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Migration drops a wrapped user command, fresh-wires a statusline that was absent, or prints extra stdout from the hook | Old form migrates, but a drifted new-form path or the drift watch disagrees with what `install.ts` calls wired | Every row of the decision table, both pinned examples, idempotence, and the single-JSON stdout rule hold |
| Test coverage | ×2 | No new tests | Happy-path migration only | Old/new/drifted/foreign/missing forms, invalid JSON untouched, idempotent second run, drift items, and the reap-stale exclusion row |
| Interface & readability | ×1 | Detection regex copied into several files | One regex, but migration logic lives in `setup.ts` untested | One exported regex and one pure `migrateCollectorCommand` helper, both unit-tested; `setup.ts` only wires them |
| Assumptions & docs | ×1 | The stale "never touches the statusline" comment remains | Comment updated without the reason | The comment states the new rule and why (the collector file is gone after an update), and SKILL.md explains the new command |

## Out of scope

- Deleting the TS scripts, CLAUDE.md, and README — Deferred. Reason: the deletion task removes the TS and updates the docs in one pass after the whole Rust suite is green.
- `opencode/install.ts` — Deferred. Reason: it symlinks whole skill dirs, so the cockpit shim is already reachable at `~/.config/opencode/skills/cockpit/bin/cockpit`.
- Porting the `install.ts` precheck to Rust — Deferred. Reason: the install skill stays TypeScript; only the dashboard server and collector move.
- Closing the gap between a marketplace `git pull` and the next SessionStart, when statusline ticks fail — Deferred. Reason: it is accepted and recorded as a known gap; migration fixes it on the next session start.

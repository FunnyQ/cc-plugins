# MODELS-02: Per-role model and effort map in the orchestrator

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/models.md`
> - `../_context/rubric.md`
>
> **Depends on**: models/01
> **Blocks**: worktree/02
> **Status**: done

## Goal

Every autopilot pipeline role runs on the model and effort from the default map in `models.md`. A task's `> **Models**:` header overrides dev, verify, judge, and fix for that task. The last Claude dev rung raises the effort one step instead of switching model.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — the Workflow script: the `MODEL` table, every `agent()` call's model and effort, `resilient`, the scout prompt and validation, the dev ladder, and the resume item.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — make the stub record `effort`, and add the role-map tests.
- `packages/dispatch/skills/autopilot/SKILL.md` (modify) — the `## Model policy` table, and the resume step that assembles `CFG`.

## Implementation notes

### Where things are today

- `MODEL` is one line (around line 102 of `orchestrator.md`) mapping roles to model alias strings: `{ dev: 'sonnet', devEscalated: 'opus', devExternal: 'haiku', verify: 'haiku', judge: 'opus', reviewExternal: 'haiku', reviewLens: CFG.reviewLensModel ?? 'opus', fix: 'opus', commit: 'haiku', structuredRetry: 'sonnet' }`. The comment block above it describes each role. Rewrite that comment so it matches the new map.
- `MODEL.verify` is used by verify, requalify, `done:` (mark-done), `block:` (park), and `scout-wave-N`. Only verify and requalify move to opus/low. Park, mark-done, and scout get their own entry, for example `mechanical: { model: 'haiku', effort: null }`.
- `resilient(make, retryModel)` (around line 642) calls `make(null)`, then `make(retryModel)` on a throw, and the call sites read `model: retryModel ?? MODEL.x`. The retry target is now `{model, effort}`, so `resilient` and every call site must carry both. A retried call runs `structuredRetry` (opus/medium) for both model and effort, and never mixes the retry model with the original effort.
- The dev ladder is around lines 807–829. `claudeCap = last - (lastShotEngine ? 1 : 0)`, then `attempt >= claudeCap ? MODEL.devEscalated : MODEL.dev`. Keep `claudeCap` and the `vendorRung` / `devEngine && !lastShot` branches exactly as they are. Only the Claude branch changes: rung = the task's dev choice, with effort raised one step when `attempt >= claudeCap`. `devEscalated` disappears, because the last rung is derived. `attemptModel` (recorded into `attempts[]` and the rejection history) should carry both parts, for example `opus/high`, so the history shows what ran.
- The final-review lenses (`MODEL.reviewLens`, `MODEL.reviewExternal`) keep today's behaviour: no effort, same models. The fixer `fix:${ref}#${attempt}` uses the fix role (opus/high, or the Final review task's `fix=` override).
- Commit agents (`commit-wave-N`, `commit-post-loop`) move to opus/low.

### Passing effort

- Workflow `agent(prompt, opts)` accepts `opts.effort` with the values `'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
- Omit the key entirely when a choice's effort is `null`. Do not pass `effort: null` or `effort: undefined`.
- Build the options in one small helper so every call site reads the same way:

```js
// Spreads a {model, effort} choice into agent() opts; a null effort is omitted, never sent.
const pick = (choice) => choice.effort ? { model: choice.model, effort: choice.effort } : { model: choice.model }
```

- The effort ladder raises one step at a time, and `max` stays `max`. A choice with no effort stays without effort:

```js
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const raise = (choice) => choice.effort
  ? { ...choice, effort: EFFORTS[Math.min(EFFORTS.indexOf(choice.effort) + 1, EFFORTS.length - 1)] }
  : choice
```

### Resolving a task's choice

- A ready item carries `modelsRaw: string | null`, the `> **Models**:` header value with only its outer whitespace trimmed, or `null` when the task has no such header. `next-ready.ts` emits no parsed map.
- The orchestrator parses `modelsRaw` itself, with a small in-script copy of the parser, because a Workflow script cannot import. Parse rules (the header was already linted before the run):
  - Implement exactly the grammar that `parse-task.ts` implements. Lint accepts whatever that parser accepts, so any difference turns a linted header into a runtime `(scout)` failure:
    1. Split the value on `,`.
    2. Trim each piece, and drop pieces that are empty, so a trailing comma is allowed.
    3. Each remaining piece must match `^([a-z]+)\s*=\s*([a-z]+)(?:\s*/\s*([a-z]+))?$`: role, model, optional effort, with whitespace allowed around `=` and `/`.
    4. An empty value is a parse failure.
  - Roles are `dev`, `verify`, `judge`, and `fix`. Models are `haiku`, `sonnet`, `opus`, and `fable`. Efforts are `low`, `medium`, `high`, `xhigh`, and `max`. A role may appear once.
  - The result is `{ dev?, verify?, judge?, fix? }`, where each value is `{model, effort}` and a missing effort is `null`.
  - Anything the grammar or the value sets reject is a parse failure.
- For those four roles, the task's entry wins when it is present; otherwise the default applies. Resolve once at the top of `executeTask`. Other roles (scout, commit, lenses, park, mark-done, structuredRetry, devExternal) never read the task's parsed models.
- An override replaces the whole choice. `verify=sonnet` means sonnet with no effort, not sonnet/low. Do not merge the default's effort into it.

### The scout trap — do not default a dropped field

- A cheap scout transcribing `next-ready.ts --summary` output has dropped a trailing field before. That is why `maxParallel` is carried as its own structured field. See the design note that begins **"The scout copies `maxParallel` out of the blob…"** near the end of `orchestrator.md`.
- A plain-object check cannot tell a dropped override from a task with no override: both arrive as "no models". So `modelsRaw` follows the `maxParallel` pattern exactly.
  - Add a required per-ready-item structured field to `SCOUT_SCHEMA`, for example `readyModels: [{ ref, modelsRaw }]` with `modelsRaw` typed `string | null`. The scout copies each ready item's `modelsRaw` out of the blob into it.
  - A ready ref with no entry in the structured field, or an entry without `modelsRaw`, derails the wave as a `(scout)` failure. The message names the ref. It never falls back to defaults.
  - When the verbatim stdout still carries that item's `modelsRaw` key, the two values must be equal. A disagreement is a `(scout)` failure that names the ref and both values.
  - A `modelsRaw` the in-script parser rejects is a `(scout)` failure.
  - Place these checks next to the existing `maxParallel` checks in the scout validation (around lines 1100–1130).
- `null` means "all defaults" and is valid.
- Add one sentence to the `maxParallel` design note, or a sibling note beside it, that records the residual. A scout that drops the value from stdout and also invents `null` for the structured field still runs that task on defaults. No check here can catch two coordinated errors, which is the same residual `maxParallel` documents.

### Resume

- A single-task resume runs no scout, and builds its item from `CFG` (around lines 179–195 and 1319).
- Add `resumeModelsRaw: null` to `CFG`. It holds the task's `> **Models**:` header value, written as a literal string exactly as it appears in the file, or `null` when the header is absent.
- Put it on the resume item as `modelsRaw`, and parse it with the same in-script parser. A parse failure throws before any agent runs, the same way an empty `resumeTaskPath` throws.
- `SKILL.md`'s resume steps already have a numbered list that reads the task header for `CFG.resumeFinalReview`. Add one step to it: read the task's `> **Models**:` line and write its value as the string `CFG.resumeModelsRaw`, or `null` when the line is absent. The main agent copies the value verbatim; it does not parse it.

### `SKILL.md` Model policy table

Rewrite the `## Model policy` table rows to state the new model and effort per role, with a one-line why each. The roles are dev, the dev last rung (effort +1), dev external driver (haiku), binary gate (opus/low), rubric judge (opus/medium), commit (opus/low), cross-vendor lens (haiku), quality lenses (`CFG.reviewLensModel`), fixer (opus/high), and scout / mark-done / park (haiku). Add one sentence below the table: a task's `> **Models**:` header overrides dev, verify, judge, and fix for that task.

### Tests

The stub `agent()` in `orchestrator-script.test.ts` records `opts.model` into `models[]` (around lines 204–245, read back through `modelFor(log, label)`).
- Record `opts.effort` into a parallel `efforts[]`, and add an `effortFor(log, label)` beside `modelFor`.
- Existing assertions on `'sonnet'` for dev and `'haiku'` for verify change to the new defaults. Update them; do not delete them.
- **Parity fixtures.** Add one table-driven test that runs the in-script parser over this exact list. `parse-task.ts` pins the same list, so the two parsers cannot drift. Reach the in-script parser through the scout path: a ready item whose `modelsRaw` is the fixture either runs with the stated roles or derails as a `(scout)` failure.

  | # | `modelsRaw` | Result |
  |---|---|---|
  | 1 | `dev=opus/high, verify=sonnet` | dev opus/high, verify sonnet with no effort |
  | 2 | `judge = opus / xhigh` | judge opus/xhigh |
  | 3 | `dev=opus,` | dev opus with no effort |
  | 4 | ` dev=sonnet/low , verify=haiku ` | dev sonnet/low, verify haiku with no effort |
  | 5 | `dev=opus, dev=sonnet` | rejected |
  | 6 | `dev=gpt5` | rejected |
  | 7 | `dev=Opus` | rejected |
  | 8 | *(empty string)* | rejected |
  | 9 | `dev=opus/high/max` | rejected |

- The scout stub builds ready items and the structured scout result. Give each ready item `modelsRaw: null` by default, in both the stdout blob and the structured `readyModels` field, so existing scenarios keep passing. Let a scenario set `modelsRaw` per item, and let it drop or alter either copy on its own.

## Acceptance criteria

- [x] The `MODEL` table in `orchestrator.md` maps each role to `{model, effort}` and matches the default table in `models.md`. `devEscalated` is gone, and scout, mark-done, and park have their own haiku entry.
- [x] No `agent()` call in the script passes `effort: null` or `effort: undefined`. Choices with a null effort omit the key.
- [x] A ready item with `modelsRaw: 'dev=sonnet/low'` and a 3-attempt Claude ladder runs its dev rungs on sonnet/low, sonnet/low, and sonnet/medium.
- [x] A ready item with `modelsRaw: 'dev=opus/max'` keeps `max` on the last rung.
- [x] Each of these derails the wave as a `(scout)` failure that names the ref: a ready ref missing from the structured `readyModels`; structured and stdout `modelsRaw` values that disagree; and a `modelsRaw` the in-script parser rejects.
- [x] The in-script parser implements the four-step grammar and gives the stated result for all nine parity fixtures.
- [x] `modelsRaw: null` runs every role on its default. `verify=sonnet` runs verify on sonnet with the `effort` key omitted.
- [x] A retried structured call (for example, a verify that throws once) runs its retry on opus/medium.
- [x] `devEngine` and `lastShotEngine` rungs still run their haiku driver with no effort, on the same attempts as before.
- [x] `SKILL.md`'s Model policy table matches the new map, and the resume steps set `CFG.resumeModelsRaw`. A resume with `resumeModelsRaw: 'dev=sonnet/low'` runs its dev on sonnet/low.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes. It includes new tests asserting model and effort for each of these labels: `dev:`, `verify:`, `judge:`, `fix:`, `done:`, `block:`, `scout-wave-`, `commit-wave-`, and a retried call.
- [x] That same test file has tests for these: the `dev=sonnet/low` ladder, the `max` ceiling, each of the three `modelsRaw` `(scout)` derails, the `null` defaults, a `resumeModelsRaw` override, and the nine-row parity fixture table. Each test fails when its behaviour is reverted.
- [x] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` prints nothing.
- [x] `git status --short -- packages/dispatch/skills/autopilot/references/orchestrator.md packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts packages/dispatch/skills/autopilot/SKILL.md` shows all three paths modified.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Defaults differ from `models.md`, or an override is ignored | Defaults right, but a dropped or mismatched `modelsRaw` silently falls back to defaults, the retry mixes model and effort, or `effort: null` reaches `agent()` | Every role matches the map. Overrides replace whole choices. The last rung raises effort only. A missing, mismatched, or unparseable `modelsRaw` is a `(scout)` failure. |
| Test coverage | ×2 | No effort assertions | Default map asserted, but the override ladder, `max` ceiling, or a scout derail is untested | Every role label, the override ladder, `max`, all three derails, `null` defaults, the resume override, and a retried call are pinned |
| Interface & readability | ×1 | Model/effort logic scattered as ad-hoc ternaries per call site | One helper, but call sites inconsistent | One `pick`/`raise` pair used everywhere; the `MODEL` comment block describes the new map |
| Assumptions & docs | ×1 | `SKILL.md` still says Sonnet → Opus | Table updated, but the resume step, the override sentence, or the residual note is missing | Table, override sentence, `CFG.resumeModelsRaw` step, and the two-coordinated-errors residual note are all present |

## Out of scope

- Per-task worktrees, land, and cleanup — Deferred. Reason: a separate change reshapes the pipeline on top of this map.
- The flightplan docs that teach authors the `Models` header — Deferred. Reason: flightplan's own docs change separately.
- Linting the `Models` header and emitting `modelsRaw` from `next-ready.ts`. That work is already done before this task.
- Per-task overrides for scout, commit, lenses, park, mark-done, or the external driver — Deferred. Reason: those roles are run-wide or mechanical, and the frozen decision limits overrides to dev, verify, judge, and fix.

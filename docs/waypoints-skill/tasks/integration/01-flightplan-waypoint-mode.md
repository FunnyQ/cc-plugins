# INTEGRATION-01: flightplan waypoint mode + lint-hook widen

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: scripts/01, scripts/02
> **Blocks**: integration/02
> **Status**: done

## Goal

Teach `flightplan` a "waypoint mode" that scopes an interview to the active leg and writes the leg's
flightplan tree under `docs/<proj>/legs/NN-slug/`, and widen the lint hook so nested leg task files are
auto-linted.

## Files to create / modify

- `packages/dispatch/skills/flightplan/SKILL.md` (modify) — add a "Waypoint mode" section; bump `version` 0.5.0 → 0.6.0.
- `packages/dispatch/hooks/flightplan-lint.sh` (modify) — widen the path regex to match nested leg task files.

## Implementation notes

### flightplan `SKILL.md` — add "Waypoint mode"

Add a focused section (do not rewrite the existing flow). **Entry must be narrow** — see the entry rules in
`../_context/shared.md`: enter waypoint mode only when the request targets a specific waypointed project
(the user names it / points at a `docs/<proj>/` with `WAYPOINTS.md` / references a leg), or when exactly one
roadmap exists and the request is clearly to plan its next leg; if several roadmaps exist and none is named,
**ask which**; an ordinary "spec this out" with no roadmap intent stays in normal flightplan mode even if a
`WAYPOINTS.md` exists elsewhere. Once the project `<proj>` is resolved:

1. Run `bun packages/dispatch/skills/waypoints/scripts/waypoints.ts active <proj>` to get the active leg's
   `NN-slug`, its `DONE-STATE`, and the `PRIOR LANDED LEGS` digest. The output shape is:
   ```
   ACTIVE: 02-profile
   DONE-STATE: <leg acceptance summary>
   PRIOR LANDED LEGS:
   - 01-auth — <done-state>
     outcome: <what shipped>
     goal: <prior leg PLAN overview line>
   ```
2. Interview **only** for that leg's done-state, using the prior-legs digest as rolling-wave context.
   Do not re-plan the whole project.
3. Scaffold with `bun packages/dispatch/skills/waypoints/scripts/waypoints.ts leg-scaffold <proj> <NN-slug> <buckets>`
   **instead of** `scaffold.ts` (scaffold.ts's slug regex rejects a digit-led `01-auth`).
4. Write the leg's flightplan spec + `tasks/` into `docs/<proj>/legs/<NN-slug>/`. Run the existing `lint-task.ts`,
   `build-readme.ts`, and `review-plan.ts` pointed at that leg path — they already accept arbitrary paths,
   so no change to those scripts.
5. Note that execution is unchanged: `/autopilot docs/<proj>/legs/<NN-slug>`, and after it lands the human
   lands the leg with the two-step `advance` interface (`--dry-run` to preview, then
   `--outcome "..." --date ...` to write — see `../_context/shared.md`).

Keep the normal (non-waypoint) flightplan flow exactly as-is; waypoint mode is an additive branch gated on
the **narrow entry conditions above** (a request targeting a specific waypointed project), not on the mere
presence of some `WAYPOINTS.md` in the repo.

### `flightplan-lint.sh` — widen the regex

Current gate (around line 26):

```bash
if ! [[ "$file_path" =~ /docs/[^/]+/tasks/[a-z][a-z0-9]*/[0-9]{2}-.+\.md$ ]]; then
  exit 0
```

`[^/]+` matches a single segment, so `docs/<proj>/legs/01-auth/tasks/<bucket>/02-foo.md` is skipped.
Change the pre-`/tasks/` portion from `/docs/[^/]+/tasks/` to `/docs/.+/tasks/` so both the flat
`docs/<slug>/tasks/...` and nested `docs/<proj>/legs/NN-slug/tasks/...` shapes match. **Do not touch** the
content sniff on the following line (the file must contain `> **Required reading**:`) — it is the guard
that keeps the looser path regex from linting unrelated markdown.

## Acceptance criteria

- [x] `flightplan/SKILL.md` has a "Waypoint mode" section describing detect → `active` → scoped interview → `leg-scaffold` → write into `legs/NN-slug/`, and its `version` is `0.6.0`.
- [x] The waypoint-mode instructions invoke the CLI verbs with the exact signatures from `../_context/shared.md`.
- [x] Waypoint-mode **entry is narrow**: it triggers only for a request targeting a specific waypointed project (named / pointed-at / single-roadmap-clear-intent), asks which when several roadmaps exist, and does not hijack an ordinary "spec this out" request just because some `WAYPOINTS.md` exists elsewhere.
- [x] The change to `flightplan/SKILL.md` is minimal: the only diff is the new "Waypoint mode" section (pure addition) plus the single `version: 0.5.0` → `0.6.0` line replacement — no existing non-waypoint flow prose is edited, reworded, or removed.
- [x] `flightplan-lint.sh` matches both flat and nested leg task-file paths, and still requires the `> **Required reading**:` content marker.

## Verification

- [x] A file at `docs/demo/legs/01-x/tasks/work/02-y.md` containing `> **Required reading**:` and a lint violation makes the hook exit 2 (previously exit 0). Test by sourcing the regex or invoking the hook with a crafted `file_path`.
- [x] An unrelated markdown file (no Required-reading marker) still exits 0 under the widened regex.
- [x] `grep -n "version: 0.6.0" packages/dispatch/skills/flightplan/SKILL.md` matches.
- [x] `git diff packages/dispatch/skills/flightplan/SKILL.md` shows only the added waypoint-mode section plus the one version-line change — no other deletions or edits to existing flow prose.
- [x] `bun test packages/dispatch/skills/flightplan/scripts/` stays green (the flightplan scripts are untouched — this is a regression guard).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md` (dimension set B — docs/integration tasks). Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | regex still misses nested paths, or waypoint-mode steps are wrong | regex works but a mode step drifts from the CLI, or content sniff weakened | regex matches both shapes with sniff intact; mode steps match the CLI exactly |
| Completeness | ×2 | missing the mode section or the regex change | one of the two edits incomplete | both edits done, version bumped, autopilot note included |
| Clarity & consistency | ×1 | mode section clashes with flightplan's structure | readable but bolted-on | reads as a natural additive branch in flightplan |
| Conventions | ×1 | breaks the existing flow or hook contract | minor deviation | additive only, hook contract (path + sniff) preserved |

## Out of scope

- Plugin version bump / CHANGELOG — Deferred to the metadata task in this bucket.
- Any change to `lint-task.ts` / `next-ready.ts` / `build-readme.ts` / `review-plan.ts` — Deferred/unnecessary; they already accept nested paths.

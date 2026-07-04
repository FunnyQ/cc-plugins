# INTEGRATION-03: final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: scripts/01, scripts/02, skill/01, integration/01, integration/02
> **Status**: todo
> **Final review**: true

## Goal

The holistic closing gate: verify the three skills compose into a working rolling-wave loop end-to-end,
the pieces are internally consistent, nothing regressed, and the PLAN goal was actually met.

## Files to create / modify

- None expected. This task reviews the whole deliverable and only edits files to fix defects it finds
  (each such fix should also re-satisfy the relevant per-task rubric).

## Implementation notes

Exercise the full loop against a throwaway `docs/demo/` roadmap — do not rely on unit tests alone.

### End-to-end walk

1. Produce a minimal `docs/demo/WAYPOINTS.md` (two legs, leg 1 `[~]`, leg 2 `[ ]`, both with `→ legs/NN-slug/`
   pointers) **by following the `waypoints` SKILL.md process and its `references/waypoints-template.md`** — do
   not free-hand a format the skill wouldn't produce. Then confirm the produced file parses: `waypoints.ts
   active demo` exits 0. Also paste the template's own example roadmap into a temp file and confirm it parses
   (guards against a template that the CLI can't read).
2. `waypoints.ts active demo` → prints the active leg + (empty) prior digest, exits 0.
3. **Drive `flightplan` waypoint mode for real** — follow the updated `flightplan/SKILL.md` "Waypoint mode"
   section against `docs/demo`: it must run `active demo`, scaffold via `leg-scaffold demo 01-auth work`
   (not `scaffold.ts`), and write the leg's flightplan spec + `tasks/` **into `docs/demo/legs/01-auth/`** —
   confirm the files actually land at that nested path. Then confirm the existing analysis scripts accept
   the leg dir: `lint-task.ts docs/demo/legs/01-auth/tasks`, `build-readme.ts docs/demo/legs/01-auth/tasks`,
   and `review-plan.ts docs/demo/legs/01-auth` all run against the nested tree. This is the step that catches
   a waypoint-mode instruction that points flightplan at the wrong path.
4. Confirm the widened `flightplan-lint.sh` lints a nested leg task file: a `docs/demo/legs/01-auth/tasks/work/*.md`
   containing `> **Required reading**:` exits 2 on a crafted violation (previously exit 0) and 0 when clean.
5. Fabricate a `docs/demo/legs/01-auth/.flightlog/RUNLOG.md` + a flightplan spec, then preview with
   `waypoints.ts advance demo --dry-run` (prints the drafted outcome, writes nothing) and commit with
   `waypoints.ts advance demo --outcome "<confirmed line>" --date 2026-07-04` → flips leg 1 `[x]`
   (with landed/outcome) and leg 2 `[~]`.
6. Confirm `serializeRoadmap(parseRoadmap(...))` round-trips the resulting `WAYPOINTS.md`.
7. Delete `docs/demo/` when done — it is a scratch fixture, not a committed artifact.

### Consistency & regression checks

- The verb signatures in `waypoints/SKILL.md`, its references, and `flightplan/SKILL.md`'s waypoint mode
  all match the actual `waypoints.ts` behavior (no drift between docs and code).
- The non-waypoint flightplan flow is unchanged; the flightplan test suite still passes:
  `bun test packages/dispatch/skills/flightplan/scripts/`.
- Both `plugin.json` files are valid JSON at 3.13.0; marketplace registries untouched. The marketplace-visible
  metadata actually names `waypoints`: the Claude `description` + `keywords`, the Codex `description` +
  `keywords` + `interface.longDescription`, and a `## [dispatch 3.13.0]` `CHANGELOG.md` entry — otherwise the
  new skill ships invisibly.
- Claude auto-discovery + Codex `./skills/` glob will surface `waypoints` (a `SKILL.md` with valid
  frontmatter exists).

## Acceptance criteria

- [ ] The end-to-end walk (active → leg-scaffold → nested-lint → advance → round-trip) works on a scratch `docs/demo/` roadmap.
- [ ] A `WAYPOINTS.md` produced by following the `waypoints` SKILL/template parses under the CLI, and the template's own example roadmap parses (skill output and CLI parser agree).
- [ ] Following `flightplan`'s waypoint-mode instructions actually writes the leg's flightplan spec + `tasks/` into `docs/demo/legs/01-auth/` (the nested path), and `lint-task.ts` / `build-readme.ts` / `review-plan.ts` all run against that leg dir.
- [ ] Docs (both SKILL.mds + references) and the CLI agree on every verb signature, arg, and output block.
- [ ] `bun test packages/dispatch/skills/waypoints/scripts/` and `bun test packages/dispatch/skills/flightplan/scripts/` are both green.
- [ ] Both dispatch manifests parse and read 3.13.0; the marketplace registries are unchanged.
- [ ] Marketplace-visible metadata names `waypoints`: Claude `description`+`keywords`, Codex `description`+`keywords`+`interface.longDescription`, and a `## [dispatch 3.13.0]` `CHANGELOG.md` entry.
- [ ] The PLAN goal is met: a user can plan a milestone roadmap, plan one leg via flightplan waypoint mode, run it with autopilot, and land it with `advance` — with no auto-walk-roadmap and status only in `WAYPOINTS.md`.

## Verification

- [ ] Run the full end-to-end walk above and confirm each step's observed output.
- [ ] `bun test packages/dispatch/skills/waypoints/scripts/ packages/dispatch/skills/flightplan/scripts/` green.
- [ ] `bun -e "JSON.parse(await Bun.file('packages/dispatch/.claude-plugin/plugin.json').text()); JSON.parse(await Bun.file('packages/dispatch/.codex-plugin/plugin.json').text())"` exits 0.
- [ ] `grep -c waypoints` is ≥ 2 for the Claude manifest and ≥ 3 for the Codex manifest; `grep -n "dispatch 3.13.0" CHANGELOG.md` matches.
- [ ] `git status` shows the marketplace registry files unmodified.

## Eval rubric

> Scale: 0–5 per dimension; weighted average > 4.0 to pass; Integration < 4 is an automatic veto. This is the holistic gate — it scores whole-deliverable axes, not a re-score of individual tasks.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration / does it compose | ×3 | the end-to-end loop breaks | loop works but a seam is fragile (e.g. active output flightplan can't consume) | active → leg-scaffold → lint → advance composes cleanly end-to-end |
| Meets the PLAN goal | ×2 | rolling-wave loop not achievable | achievable but awkward or missing a step | full plan-a-leg-at-a-time loop works as designed |
| Consistency | ×1 | docs and CLI disagree | minor doc/code drift | SKILL.mds, references, and CLI all agree |
| No regressions | ×1 | flightplan flow or tests broken | tests pass but a behavior shifted | non-waypoint flow intact, all suites green, marketplaces untouched |

## Out of scope

- The actual git release (tag + branch merges) — Deferred; the human runs it manually.
- Any auto-walk-roadmap capability — an explicit non-goal, not a regression.

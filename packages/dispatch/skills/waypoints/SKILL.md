---
name: waypoints
version: 0.1.0
description: >-
  Interview for a whole-project, multi-milestone roadmap that plans later
  stages as earlier ones land.
when_to_use: >-
  When the user wants a multi-milestone project roadmap ("/waypoints",
  rolling-wave plan) where later legs get planned after earlier ones land. Do
  NOT trigger for a small goal (use hop), a single feature (use
  flightplan), or an existing task tree ready to run (use autopilot).
argument-hint: "[project goal]"
---

# Waypoints

## Why this skill exists

`waypoints` sits above `flightplan` on the dispatch ladder. It creates a whole-project milestone roadmap. Each milestone becomes a detailed flightplan only when that leg is ready.

This is rolling-wave planning. Do not fully decompose a large project up front. Land one leg. Record what actually shipped. Then plan the next leg from reality, not from stale assumptions.

## When to use vs hop / flightplan

- For a small goal with light planning that you execute now, use **hop**.
- For a single feature, or one coherent scope that needs a `PLAN.md` plus a `tasks/` tree, use **flightplan**.
- For a whole project with multiple milestone legs, where later legs get planned after earlier legs land, use **waypoints**.

If a `docs/<slug>/tasks/` tree already exists and the user wants execution, use **autopilot** instead.

## Two non-negotiables

1. **Plan mode.** Enter plan mode before any output. Draft the roadmap there. Then exit plan mode so the user can approve it before `WAYPOINTS.md` is written. The roadmap is the project's source of truth, so it deserves the approval gate.
2. **`AskUserQuestion` for every interview question.** Structured options keep the milestone interview reviewable. Plain text gets lost.

## Process

Resolve the scripts path once. `CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash. Instead, take the skill's load-time *"Base directory for this skill"* banner. Set `SCRIPTS="<base-dir>/scripts"`. Use `bun "$SCRIPTS"/...` in every command below.

**OpenCode only**: there is no banner. Set `SCRIPTS=~/.config/opencode/skills/waypoints/scripts`; `CLAUDE_PLUGIN_ROOT` is empty there.

1. Interview for the roadmap using `references/interview-guide.md`. Elicit milestone legs and each leg's done-state. Do **not** break legs into tasks.
2. After the user approves, write `docs/<proj>/WAYPOINTS.md` using `references/waypoints-template.md`. This skill authors the roadmap. There is no CLI verb for creating it. Mark leg 1 `[~]` and every later leg `[ ]`.
3. To plan a leg, hand off to `flightplan`. It detects the project's `WAYPOINTS.md`, reads the active leg, and runs in waypoint mode.
4. To land a leg after its autopilot run, preview with `advance` (it writes nothing), have the human confirm or edit the drafted one-line outcome, then write it with `advance --outcome`. See [`advance`](#advance-proj) below.

## The three verbs

Run every verb from the project root as `bun "$SCRIPTS"/waypoints.ts <verb> ...`. `<proj>` is the directory under `docs/`, so the roadmap lives at `docs/<proj>/WAYPOINTS.md`. When no leg is `[~]`, `active` and `advance` exit non-zero and say whether the roadmap is complete or no leg has been promoted yet.

### `active <proj>`

```bash
bun "$SCRIPTS"/waypoints.ts active <proj>
```

Prints the active leg plus a rolling-wave digest of prior landed legs:

```text
ACTIVE: 02-profile
DONE-STATE: a logged-in user has a profile page
PRIOR LANDED LEGS:
- 01-auth — users can sign up / sign in with email
  outcome: also added rate-limiting
  goal: <first line of legs/01-auth/PLAN.md Overview, if present>
```

### `leg-scaffold <proj> <NN-slug> <buckets>`

Called by flightplan's waypoint mode, not by this skill. Creates `docs/<proj>/legs/<NN-slug>/tasks/_context/` and one `tasks/<bucket>/` per comma-separated bucket. `<NN-slug>` must match `^\d{2}-[a-z][a-z0-9-]*$`; each bucket is one lowercase token with no dashes. The leg dir is created non-recursively, so an existing leg throws `EEXIST` instead of being reused.

### `advance <proj>`

```bash
bun "$SCRIPTS"/waypoints.ts advance <proj>                                   # preview, never writes
bun "$SCRIPTS"/waypoints.ts advance <proj> --outcome "<confirmed line>" [--date YYYY-MM-DD]
```

The preview drafts one outcome line from `docs/<proj>/legs/<NN-slug>/.flightlog/RUNLOG.md` and the leg's PLAN.md goal, printed as `DRAFT OUTCOME: <line>`. `--dry-run` forces a preview even with `--outcome`.

`--outcome` is the confirmation gate. It flips the active leg `[~]` → `[x]`, appends `· landed <date> · outcome: <line>` (`--date` defaults to today), promotes the next `[ ]` to `[~]` or reports the roadmap complete, and rewrites `WAYPOINTS.md`.

## What waypoints does NOT do

- No task breakdown. Milestones only. `flightplan` owns per-leg tasks.
- No auto-walk-roadmap. A human lands each leg and confirms the outcome before the next leg becomes active.
- No sidecar status. Roadmap state lives only in `docs/<proj>/WAYPOINTS.md`.

## Additional resources

- `references/waypoints-template.md` — canonical `WAYPOINTS.md` shape, legend, and example.
- `references/interview-guide.md` — milestone-level interview guide for building the roadmap.

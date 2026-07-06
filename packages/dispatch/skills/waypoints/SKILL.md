---
name: waypoints
version: 0.1.0
description: Whole-project milestone roadmap interviewer for rolling-wave planning above flightplan. AUTO-TRIGGER when the user wants a multi-milestone project roadmap, asks to "plan this big project in milestones", asks for a rolling-wave plan, or says "/waypoints". Do NOT trigger for a small goal that only needs preflight, a single feature that should become one flightplan, or an existing `docs/<slug>/tasks/` tree that should be run with autopilot.
---

# Waypoints

## Why this skill exists

`waypoints` is the fourth tier above `flightplan`: it creates a whole-project milestone roadmap, then lets each milestone become a detailed flightplan only when that leg is ready.

This is rolling-wave planning. Do not fully decompose a large project up front. Land one leg, record what actually shipped, then plan the next leg from reality instead of stale assumptions.

## When to use vs preflight / flightplan

- Small goal, light planning, execute now → **preflight**.
- Single feature or one coherent scope that needs a `PLAN.md` plus `tasks/` tree → **flightplan**.
- Whole project with multiple milestone legs, where later legs should be planned after earlier legs land → **waypoints**.

If a `docs/<slug>/tasks/` tree already exists and the user wants execution, use **autopilot** instead.

## Two non-negotiables

1. **Plan mode** — enter before any output; draft the roadmap there, then exit so the user approves it before `WAYPOINTS.md` is written. The roadmap is the project's source of truth; it deserves the approval gate.
2. **`AskUserQuestion` for every interview question** — structured options keep the milestone interview reviewable; plain text gets lost.

## Process

Resolve the scripts path once. `CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash, so take the skill's load-time *"Base directory for this skill"* banner, set `SCRIPTS="<base-dir>/scripts"`, and use `bun "$SCRIPTS"/...` in every command below.

1. Interview for the roadmap using `references/interview-guide.md`. Elicit milestone legs and each leg's done-state. Do **not** break legs into tasks.
2. After the user approves, write `docs/<proj>/WAYPOINTS.md` using `references/waypoints-template.md`. This skill authors the roadmap; there is no CLI verb for creating it. Mark leg 1 `[~]` and every later leg `[ ]`.
3. To plan a leg, hand off to `flightplan`. It detects the project's `WAYPOINTS.md`, reads the active leg, and runs in waypoint mode.
4. To land a leg after its autopilot run, use the two-step `advance` write interface (see [`advance`](#advance-proj) below): preview first (writes nothing), the human confirms or edits the one-line outcome, then write it with `--outcome` — the confirmation gate. Never teach a bare writing `advance`.

## The three verbs

All verbs run through:

```bash
bun "$SCRIPTS"/waypoints.ts <verb> ...
```

`<proj>` is the directory under `docs/`, so the roadmap lives at `docs/<proj>/WAYPOINTS.md`. Run every verb from the project root — `docs/<proj>` resolves against the current working directory.

### `active <proj>`

Invocation:

```bash
bun "$SCRIPTS"/waypoints.ts active <proj>
```

Reads `docs/<proj>/WAYPOINTS.md` and prints the active leg plus a rolling-wave digest of prior landed legs:

```text
ACTIVE: 02-profile
DONE-STATE: a logged-in user has a profile page
PRIOR LANDED LEGS:
- 01-auth — users can sign up / sign in with email
  outcome: also added rate-limiting
  goal: <first line of legs/01-auth/PLAN.md Overview, if present>
```

If there is no `[~]` leg, it exits non-zero with a clear message. It distinguishes roadmap complete (every leg is `[x]`) from nothing active yet (pending legs exist but none is promoted). The `goal:` line is best-effort from the landed leg's `PLAN.md` Overview and is omitted when unavailable.

### `leg-scaffold <proj> <NN-slug> <buckets>`

Invocation:

```bash
bun "$SCRIPTS"/waypoints.ts leg-scaffold <proj> <NN-slug> <buckets>
```

`<buckets>` is comma-separated. The command builds a nested leg flightplan tree:

```text
docs/<proj>/legs/<NN-slug>/tasks/_context/
docs/<proj>/legs/<NN-slug>/tasks/<bucket>/     # one per bucket
```

Expected output prints each created directory:

```text
created docs/<proj>/legs/<NN-slug>/
created docs/<proj>/legs/<NN-slug>/tasks/
created docs/<proj>/legs/<NN-slug>/tasks/_context/
created docs/<proj>/legs/<NN-slug>/tasks/<bucket>/
```

Rules:

- `docs/<proj>/legs/` is created recursively; the leg dir itself is created non-recursively so an existing leg throws `EEXIST` instead of being silently reused.
- `<NN-slug>` must match `^\d{2}-[a-z][a-z0-9-]*$`.
- Each bucket must be a single lowercase token with no internal dashes.

### `advance <proj>`

Preview invocations:

```bash
bun "$SCRIPTS"/waypoints.ts advance <proj>
bun "$SCRIPTS"/waypoints.ts advance <proj> --dry-run
```

Preview only, never writes. It drafts one outcome line from `docs/<proj>/legs/NN-slug/.flightlog/RUNLOG.md` plus the leg flightplan's goal, then prints:

```text
DRAFT OUTCOME: <drafted one-line outcome>
```

Write invocation:

```bash
bun "$SCRIPTS"/waypoints.ts advance <proj> --outcome "<confirmed line>" [--date YYYY-MM-DD]
```

The presence of `--outcome` is the confirmation gate. `--date` defaults to today.

On write, the command atomically:

1. Flips the active leg `[~]` → `[x]`, appending `· landed <date> · outcome: <confirmed line>`.
2. Promotes the next `[ ]` → `[~]`; if none remains, reports the roadmap complete.
3. Serializes the result back to `WAYPOINTS.md`.

Expected write output:

```text
Landed 02-profile, promoting 03-billing to active.
```

For the final leg:

```text
Landed 04-admin. Roadmap complete.
```

If there is no active leg, it exits non-zero and distinguishes roadmap complete from nothing active yet.

## What waypoints does NOT do

- No task breakdown. Milestones only; `flightplan` owns per-leg tasks.
- No auto-walk-roadmap. A human lands each leg and confirms the outcome before the next leg becomes active.
- No sidecar status. Roadmap state lives only in `docs/<proj>/WAYPOINTS.md`.

## Additional resources

- `references/waypoints-template.md` — canonical `WAYPOINTS.md` shape, legend, and example.
- `references/interview-guide.md` — milestone-level interview guide for building the roadmap.

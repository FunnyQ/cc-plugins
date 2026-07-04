# Waypoints — a rolling-wave milestone-roadmap skill for dispatch

> **Status**: approved
> **Owner**: unassigned
> **Last updated**: 2026-07-04

## Overview

Add a fourth dispatch skill, `waypoints`, that sits above `flightplan`: it produces only a
milestone **roadmap** (`docs/<proj>/WAYPOINTS.md`), and each milestone's detailed flightplan is
generated just-in-time after the previous one lands. This gives large-project builds a rolling-wave
planning loop instead of one oversized up-front plan that overwhelms executor agents.

## Goals

- A new `waypoints` skill that interviews for and writes a milestone roadmap (`WAYPOINTS.md`) with three-glyph status tracking, no task breakdown.
- A `waypoints.ts` Bun CLI collapsing the rolling-wave lifecycle into three token-cheap verbs: `active`, `leg-scaffold`, `advance`.
- A small `flightplan` integration: a "waypoint mode" that scopes an interview to the active leg and writes the leg's flightplan tree into `docs/<proj>/legs/NN-slug/`, plus a lint-hook regex widened to cover nested leg task files.
- Ships to both Claude and Codex marketplaces with the dispatch plugin version bumped.

## Non-goals

- **auto-walk-roadmap** — autopilot automatically running every leg end-to-end without a human gate between legs. Human-in-loop, one leg at a time, is the whole point.
- Multi-project roadmaps, a roadmap-level GUI, or migrating existing flat flightplans into the waypoints layout.
- A per-project metadata/dotfile. Roadmap state lives **only** in `WAYPOINTS.md`.
- Changing `autopilot` at all — it already takes an arbitrary tasks-dir path.

## Context

Building a large project from scratch degrades agent quality: a single big, detailed plan overwhelms
the executor as context grows. Splitting into sequential milestones and planning the next only after
the previous lands (rolling-wave) produces better results, because the next leg's plan starts from what
was actually built rather than a guess.

The dispatch arc today is `preflight` (small in-conversation spec) → `flightplan` (single-feature
multi-file blueprint) → `autopilot` (execute the tree). The missing tier is the whole-project milestone
map. `waypoints` fills it. An exploration of the existing scripts established two integration facts that
shape this plan:

1. The four TS analysis scripts (`lint-task`, `next-ready`, `build-readme`, `review-plan`) take explicit
   path arguments and already operate on a nested leg tree unchanged.
2. Two places hardcode the flat `docs/<slug>/tasks/` shape: `hooks/flightplan-lint.sh` (its path regex
   won't match nested leg task files) and `scaffold.ts` (single-segment slug, rejects a digit-led name
   like `01-auth`, non-recursive mkdir). So nested legs need a widened lint regex and a purpose-built
   `leg-scaffold` verb rather than reusing `scaffold.ts`.

## Requirements

### MVP

1. **`waypoints.ts` CLI** — three verbs over `docs/<proj>/`.
   - Acceptance: `active`, `leg-scaffold`, `advance` behave per `_context/shared.md`; pure parse/transition helpers are unit-tested with `bun test` and green.
2. **`waypoints` skill** — `SKILL.md` + references that drive the roadmap interview and own status transitions.
   - Acceptance: Claude auto-discovers it and Codex picks it up via the `./skills/` glob; the skill documents the real verb signatures and the `WAYPOINTS.md` format.
3. **flightplan waypoint mode** — detect `WAYPOINTS.md`, scope to the active leg, scaffold + write into `legs/NN-slug/`.
   - Acceptance: with a `WAYPOINTS.md` present, flightplan interviews only the `[~]` leg and writes its tree under `docs/<proj>/legs/NN-slug/`; the widened lint hook fires on nested leg task files.
4. **Plugin metadata** — dispatch version bump + Codex interface prose + CHANGELOG.
   - Acceptance: both `plugin.json` files read `3.13.0`; the Codex `interface` names four skills; `CHANGELOG.md` carries a dispatch 3.13.0 entry.

### Later

- **`advance` outcome distillation quality** — richer synthesis from `RUNLOG.md` than a single line, if the one-liner proves too thin in practice.
- **Scripted status transitions beyond `advance`** — only if hand-editing `WAYPOINTS.md` for edge cases (reorder, insert, drop a leg) proves annoying.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile step (matches the repo). `type` over `interface`. No external npm deps.
- **Storage**: filesystem only — `docs/<proj>/WAYPOINTS.md` + `docs/<proj>/legs/NN-slug/` trees. No DB, no dotfile.
- **Testing**: `bun test`, pure functions extracted for testability, mirroring flightplan's `*.test.ts` layout.
- **Conventions**: see `_context/shared.md`.

## Architecture

`waypoints` is a sibling skill under `packages/dispatch/skills/`. It owns the roadmap; `flightplan`
gains a mode that consumes it; `autopilot` is untouched.

```
preflight → flightplan → autopilot            (existing arc)
                ▲
            waypoints  ── writes WAYPOINTS.md (roadmap only)
                │
                ├─ waypoints.ts active <proj>       → flightplan reads active-leg scope + prior-leg digest
                ├─ waypoints.ts leg-scaffold ...     → builds docs/<proj>/legs/NN-slug/ tree
                └─ waypoints.ts advance <proj> [--dry-run | --outcome "..."]
                                                     preview (bare/--dry-run) · write with --outcome:
                                                     [~]→[x] + outcome + promote next [ ]→[~]

Per leg:  flightplan (waypoint mode) writes docs/<proj>/legs/NN-slug/{PLAN.md,tasks/,...}
          → autopilot docs/<proj>/legs/NN-slug   (unchanged)
          → RUNLOG.md → waypoints advance drafts the outcome line
```

Disk layout produced end-to-end:

```
docs/myapp/
├── WAYPOINTS.md              # roadmap index + [x]/[~]/[ ] status
└── legs/
    ├── 01-auth/              # full flightplan tree, generated just-in-time
    │   ├── PLAN.md
    │   ├── tasks/
    │   └── .flightlog/RUNLOG.md
    └── 02-profile/
```

## Bucketing

- **Strategy**: by layer — the deliverable is a tool (CLI) + a skill (docs) + an integration seam.
- **Why**: the CLI is the foundation both the skill and the integration document against, so it must land first; the skill and the flightplan integration can then proceed in parallel; metadata closes them out.

### Buckets

- **`scripts/`** — the `waypoints.ts` CLI and its tests. Foundation; nothing depends on unwritten docs.
- **`skill/`** — the `waypoints` skill (`SKILL.md` + references). Starts once the CLI signatures are real.
- **`integration/`** — flightplan waypoint-mode + lint-hook widen, plugin metadata, and the closing final review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| scripts | 01 | waypoints-cli-core (parse · active · leg-scaffold) | todo | > 4.0 | — |
| scripts | 02 | waypoints-advance | todo | > 4.0 | scripts/01 |
| skill | 01 | waypoints-skill-md | todo | > 4.0 | scripts/01, scripts/02 |
| integration | 01 | flightplan-waypoint-mode | todo | > 4.0 | scripts/01, scripts/02 |
| integration | 02 | plugin-metadata-bump | todo | > 4.0 | skill/01, integration/01 |
| integration | 03 | final-review | todo | > 4.0 | scripts/01, scripts/02, skill/01, integration/01, integration/02 |

(Mirrors `tasks/README.md`. The last row is the **final review** task, marked `> **Final review**: true`; its `Depends on` reaches every other task.)

## Cross-bucket dependencies

```
scripts/01 ─► scripts/02 ─┬─► skill/01 ────────┐
                          └─► integration/01 ───┴─► integration/02 ─► integration/03 (final review)
```

`skill/01` and `integration/01` both wait for `scripts/02` (they document/consume the `advance` verb), so
they run in parallel once `scripts/02` lands. `integration/02` waits for both of them.

## Open questions

None outstanding — the design tree was fully walked during the interview.

## Known gaps

- The actual git release (scoped tag `dispatch-v3.13.0`, merge develop→main) is out of the executable
  task set; Q runs it manually via chronicle / odin-git. `integration/02` only bumps the in-repo version
  fields + CHANGELOG.

## References

- Interview + design decisions: cockpit decision trail (this session).
- Existing arc skills: `packages/dispatch/skills/{preflight,flightplan,autopilot}/`.

# SKILL-01: waypoints skill and references

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: scripts/01, scripts/02
> **Blocks**: integration/02
> **Status**: done

## Goal

The `waypoints` skill itself: a `SKILL.md` that drives the roadmap interview and owns status
transitions, plus references (the `WAYPOINTS.md` template and a roadmap interview guide), documenting the
real CLI verb signatures.

## Files to create / modify

- `packages/dispatch/skills/waypoints/SKILL.md` (new) — the skill entry.
- `packages/dispatch/skills/waypoints/references/waypoints-template.md` (new) — the canonical `WAYPOINTS.md` shape.
- `packages/dispatch/skills/waypoints/references/interview-guide.md` (new) — how to interview for a milestone roadmap.

## Implementation notes

Everything required for correctness is inlined below (frontmatter fields, the body outline, the verb
signatures via `../_context/shared.md`). For tone only, you *may* skim the sibling skills
`packages/dispatch/skills/preflight/SKILL.md` and `.../flightplan/SKILL.md` to match their voice, but it is
not required to complete the task. Do NOT re-derive the CLI behavior — it is fixed in
`../_context/shared.md`; cite the verbs as documented there.

### `SKILL.md` frontmatter (exact fields)

Each dispatch `SKILL.md` opens with a `---` block of exactly three fields:

```markdown
---
name: waypoints
version: 0.1.0
description: <AUTO-TRIGGER sentence(s)>
---
```

Write a `description` in the same AUTO-TRIGGER style as the siblings: state when to trigger (user wants a
whole-project milestone roadmap / "plan this big project in milestones" / "rolling-wave plan" / "/waypoints")
and when NOT to (single feature → flightplan; small goal → preflight; a tasks tree already exists → autopilot).

### `SKILL.md` body — what it must cover

- **Why this skill exists** — the fourth tier above flightplan; rolling-wave (plan the next leg only
  after the previous lands) so each leg's plan starts from reality.
- **When to use vs preflight / flightplan** — scope ladder: small goal → preflight; single feature →
  flightplan; whole multi-milestone project → waypoints.
- **Process**:
  1. Interview for the roadmap (see the interview guide reference) — milestones + each leg's done-state,
     **no task breakdown**.
  2. Write `docs/<proj>/WAYPOINTS.md` directly (the skill Writes it — there is no CLI verb for authoring
     the roadmap), mark leg 1 `[~]`.
  3. To plan a leg: hand off to `flightplan` (it detects `WAYPOINTS.md` and runs its waypoint mode).
  4. To land a leg after its autopilot run, use the two-step `advance` write interface from
     `../_context/shared.md`: first `waypoints.ts advance <proj> --dry-run` to preview the outcome drafted
     from the leg's `RUNLOG.md` (writes nothing), then, after the human confirms/edits it,
     `waypoints.ts advance <proj> --outcome "<confirmed line>" [--date YYYY-MM-DD]` to flip `[~]`→`[x]` and
     promote the next. Never teach a bare writing `advance` — `--outcome` is the confirmation gate.
- **The three verbs** — document `active`, `leg-scaffold`, `advance` exactly as in `../_context/shared.md`
  (invocation, args, output), so the skill is a faithful front for the CLI.
- **What waypoints does NOT do** — no task breakdown, no auto-walk-roadmap, status lives only in
  `WAYPOINTS.md`.

### References

- `waypoints-template.md` — the canonical `WAYPOINTS.md` from `../_context/shared.md`, with a short legend
  and a filled example.
- `interview-guide.md` — how to elicit milestones: vertical slices with a clear done-state, ordered by
  dependency, small enough that one leg is one flightplan. Include a couple of walking-the-tree examples in
  the spirit of flightplan's interview guide (do not copy its task-level depth — this stays milestone-level).

## Acceptance criteria

- [x] `SKILL.md` exists with valid frontmatter (`name: waypoints`, `version: 0.1.0`, an AUTO-TRIGGER `description`).
- [x] The body covers why/when-vs-siblings/process/the three verbs/non-goals, and documents verb signatures matching the CLI exactly.
- [x] `references/waypoints-template.md` and `references/interview-guide.md` exist and are self-consistent with the `WAYPOINTS.md` format in `../_context/shared.md`.
- [x] Nothing in the skill contradicts the CLI (verb names, args, output blocks all match).

## Verification

- [x] `grep -n "^name: waypoints" packages/dispatch/skills/waypoints/SKILL.md` matches; the frontmatter has exactly the three fields.
- [x] Manual read-through: the documented `active`/`leg-scaffold`/`advance` invocations match `../_context/shared.md` verbatim in shape.
- [x] The `WAYPOINTS.md` example in the template parses under the CLI's `parseRoadmap` (paste it into a temp file and run `active`).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md` (dimension set B — docs tasks). Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | documents verbs/format that don't match the CLI | mostly right but an arg or output block drifts from the CLI | every verb signature, arg, and format matches the CLI and shared context exactly |
| Completeness | ×2 | missing process or verbs | covers process but thin on when-vs-siblings or non-goals | why/when/process/verbs/non-goals + both references all present |
| Clarity & consistency | ×1 | tone/structure clashes with sibling skills | readable but inconsistent framing | reads as a natural fourth sibling to preflight/flightplan |
| Conventions | ×1 | wrong frontmatter shape | frontmatter ok but stray fields | exactly the three frontmatter fields, AUTO-TRIGGER description style |

## Out of scope

- Editing `flightplan/SKILL.md` to add waypoint mode — Deferred to the integration bucket.
- Any plugin.json / marketplace change — Deferred; none is needed for skill discovery (auto-discovery + `./skills/` glob).

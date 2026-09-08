---
name: preflight
version: 1.0.0
description: >-
  Short interview that captures what you want as docs/<slug>/INTENT.md, before
  anyone decides how to build it. Minutes, one file, no solution.
when_to_use: >-
  When the user wants an idea recorded without committing to a solution —
  "capture this", "write down what I want", "just note the idea", "I don't
  have time to spec this now". Do NOT trigger when the user wants the work
  planned and done in this session (use hop), when they want a full spec and
  task tree frozen to disk (use flightplan), or for a roadmap of milestones
  (use waypoints).
argument-hint: "[topic]"
---

# Preflight

Capture what the user wants *before* anyone decides how to build it. One file, `docs/<slug>/INTENT.md`, then stop.

This is the first tier of the dispatch ladder:

```
preflight   → what you want, no solution        (INTENT.md)
hop         → interview, plan, execute now      (in conversation)
flightplan  → full spec + task tree on disk     (PLAN.md + tasks/)
autopilot   → flies that tree
```

## Route first

**If the user wants the work done, this is the wrong skill.** Preflight refuses to decide *how* and never executes, so a request that means "figure this out and build it" gets a file and no code — a silent no-op from the user's point of view.

Check before Step 1. Hand off by name, in one line, and stop:

- Wants it planned and built now, this session → **`hop`** *(this is what `preflight` did before dispatch 4.0.0)*
- Wants a full spec and a task tree frozen to disk → **`flightplan`**
- Wants a multi-milestone roadmap → **`waypoints`**
- Wants the want written down and nothing else → stay here.

Ambiguous? Ask once: *"record the idea, or spec it out properly now?"*

## Setup

`CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash. Take the skill's load-time *"Base directory for this skill"* banner and set `SCRIPTS="<base-dir>/../flightplan/scripts"` — the collision check is flightplan's script, shared rather than duplicated.

**OpenCode only**: there is no banner. Set `SCRIPTS=~/.config/opencode/skills/flightplan/scripts`.

## Why this exists

PLAN.md already has `Overview`, `Goals`, `Non-goals`, `Context`, and `Open questions`, so an INTENT.md that only restates them is dead weight. Two things it does that PLAN.md structurally cannot:

1. **Capture now, spec later.** Minutes, when there is no time for a full interview. The idea survives without committing to a solution.
2. **Ordering.** PLAN.md's `Overview` / `Goals` are written *after* the solution is already in the author's head, so they get retro-fitted to it and goal drift becomes invisible. A frozen INTENT.md is the only baseline that catches it.

**The value is the timestamp, not the file.** Everything below protects that.

## Process

Follow `references/intent-template.md`. Its capture rules are the contract, not advice.

### Step 1 — Enter plan mode, agree the slug

Call `EnterPlanMode` before any text output. Then agree a kebab-case topic slug and check it:

```bash
bun "$SCRIPTS"/scaffold.ts --check <slug>
```

- `OK` → proceed.
- `INTENT: <path>` → an intent already exists for this slug. Read it, then ask: update it, or pick another slug.
- `EXISTS: <alt>` → a real plan tree is already there. Ask before going further.

### Step 2 — Interview short

Three to six `AskUserQuestion` rounds, one to two questions each. Cover problem, outcome, who and what it touches, constraints, and the boundary as it looks today.

**Refuse to answer *how*.** Stack, architecture, file layout, API shape, and task breakdown are all out of scope here. Every one that surfaces goes into `Open questions` as a question — never into the body as an answer. Recommend an answer to every question you *do* ask, first option marked `(Recommended)`, so the user reacts instead of designing from scratch.

**This is minutes, not an interview.** Depth is `flightplan`'s job, and paying for it twice is how the second pass gets skipped.

### Step 3 — Draft INTENT.md inside plan mode

Show it in full so the user can read what you understood, then call `ExitPlanMode`.

**Ship it with `Open questions` still open.** That section is the deliverable. An empty one is a failed capture, not a clean one — it means a vague idea got rendered as confident structure and the user is about to sign off on precision they never had.

### Step 4 — On approval, write exactly one file

```bash
mkdir -p docs/<slug>
```

Then write `docs/<slug>/INTENT.md`.

**Do not run `scaffold.ts`.** A `tasks/` tree here would make the directory read as a real plan, and `--check` would stop reporting it as an intent.

Then stop. No PLAN.md, no task files, no implementation. Tell the user that `/flightplan <slug>` picks it up later and reads this file as its baseline.

## Rules that outlive the capture

- **INTENT.md is never edited to match a later plan.** It is the baseline; rewriting it destroys the only record of the drift. A PLAN.md that contradicts it records the contradiction in its own `## Context`.
- **Update it only when the underlying want changes** — not when the solution does.
- **It seeds the interview; it never replaces it.** Architecture, bucketing, dependencies, verification, and rubrics are absent by design, so generating a task tree from INTENT.md alone means inventing all of them. flightplan's Step 3 reads it and interviews the gaps.
- **Write it in English**, like every other dispatch artifact — a later session or sub-agent picks it up cold. Interview in whatever language the user prefers.

## Additional resources

- `references/intent-template.md` — the INTENT.md template and the five capture rules

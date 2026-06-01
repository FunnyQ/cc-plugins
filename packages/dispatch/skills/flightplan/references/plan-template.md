# PLAN.md Template

PLAN.md is the master spec. It carries every decision, every constraint, and an index of tasks. When a decision changes, PLAN.md and the relevant `_context/` file get updated; individual task files rarely change.

## Template

```markdown
# <Topic Title>

> **Status**: draft | approved | in-progress | shipped
> **Owner**: <name or "unassigned">
> **Last updated**: YYYY-MM-DD

## Overview

<1–2 sentences. What is being built / written and why.>

## Goals

- <Concrete outcome 1>
- <Concrete outcome 2>
- <Concrete outcome 3>

## Non-goals

<What is explicitly out of scope. Critical for keeping executors focused.>

- <Thing we are NOT doing>
- <Thing we are NOT doing>

## Context

<Background a stranger needs to understand the rest of this doc. Current state, prior decisions, stakeholders.>

## Requirements

Mark each as **MVP** or **Later** to keep scope honest.

### MVP

1. **<Requirement name>** — <one-line description>
   - Acceptance: <how we know it's done>
2. **<Requirement name>** — <one-line description>
   - Acceptance: <how we know it's done>

### Later

- **<Requirement name>** — <why deferred>
- **<Requirement name>** — <why deferred>

## Tech decisions

Freeze the choices that affect more than one task. These flow into `_context/shared.md`.

- **Stack**: <languages / frameworks>
- **Storage**: <DB / cache / files>
- **Deployment**: <target>
- **Conventions**: <commit style, branching, code style — point to `_context/shared.md`>

## Architecture

<Diagram or prose. How the pieces fit. Where the new code lives. What it talks to.>

```
<ascii diagram if helpful>
```

## Bucketing

Tasks live under `tasks/<bucket>/`. Bucketing strategy and rationale:

- **Strategy**: <layer / phase / feature / single-bucket>
- **Why**: <what this strategy unlocks — parallel work, clear sequence, etc.>

### Buckets

- **`<bucket-name>/`** — <what lives here, when it starts, when it ends>
- **`<bucket-name>/`** — <what lives here, when it starts, when it ends>

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| ui | 01 | <slug> | todo | > 4.0 | — |
| ui | 02 | <slug> | todo | > 4.0 | ui/01 |
| backend | 01 | <slug> | todo | > 4.0 | — |
| api | 01 | <slug> | todo | > 4.0 | ui/02, backend/01 |
| review | 01 | final review 🏁 | todo | > 4.0 | api/01, ui/02, backend/01 |

(Mirrors the table in `tasks/README.md` — keep them in sync. The last row is the **final review** task, marked `> **Final review**: true` in its file; its `Depends on` must reach every other task.)

## Cross-bucket dependencies

<For multi-bucket plans. Which buckets can advance in parallel, which must wait.>

```
ui/01 → ui/02 ──┐
                ├── api/01 → api/02
backend/01 ─────┘
```

## Open questions

<Unknowns that surfaced during the interview but didn't block writing the plan. Each entry is a decision waiting to be made; resolving one may add or change task files.>

1. **<Question>** — <context, who can answer, blocker scope>
2. **<Question>** — <context, who can answer, blocker scope>

## Known gaps

<Differences between PLAN.md and the task files — usually because a sub-task was inlined into another, or a fork agent simplified something. List them so reviewers aren't surprised.>

## References

- <Link to design doc, ticket, slack thread, etc.>
```

## Tailoring rules

- **Small feature**: skip "Architecture", combine "Goals" and "Requirements", omit "Cross-bucket dependencies" if single-bucket.
- **Writing topic**: replace "Architecture" and "Bucketing" with "Outline" (the section structure). Replace "Tech decisions" with "Style decisions".
- **Migration**: add a "Migration phases" section between "Architecture" and "Bucketing" with the phase definitions.
- **Greenfield project**: keep all sections; this is what they're designed for.

Do not omit "Non-goals" — it is the single best lever against scope creep.

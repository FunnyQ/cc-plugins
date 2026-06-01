# Example Flow

A concrete end-to-end invocation showing the interview → plan → write tree pattern. Use this as a mental model when running the skill; the real flow will have more rounds and per-topic variations.

```
User: /flightplan want to add a course player to the site, will hand off to sub-agents

Claude: [calls EnterPlanMode]
        [calls AskUserQuestion: topic slug + scope — what does "course player"
         cover here, and what's out of scope for v1?]

User: slug "course-player", in: video playback + progress tracking. Out: admin tools.

Claude: [checks docs/course-player/ — does not exist, continues]
        [calls AskUserQuestion: who's the user, and what's the tech stack?]

User: members only. Nuxt 3 frontend, Rails API backend.

Claude: [3–6 more rounds walking the design tree — bucketing, acceptance criteria,
         conventions, dependencies, failure modes]

Claude: [drafts PLAN.md content: overview, goals, non-goals, requirements,
         tech decisions, bucket layout, task index, open questions]
        [calls ExitPlanMode]

User: [approves explicitly — "yes, ship it"]

Claude: [writes docs/course-player/PLAN.md]
        [writes docs/course-player/tasks/_context/shared.md]
        [writes docs/course-player/tasks/_context/api-contract.md]
        [writes docs/course-player/tasks/ui/01-fixture-shell.md, ui/02-..., ...]
        [writes docs/course-player/tasks/backend/01-..., ...]
        [writes docs/course-player/tasks/api/01-..., ...]
        [writes docs/course-player/tasks/README.md]
        "Spec written to docs/course-player/. Start a new session and point
         a sub-agent at docs/course-player/tasks/ui/01-fixture-shell.md to begin."
```

## What to notice

- **Slug collision check is in Step 2**, immediately after the slug is agreed — not after approval.
- **Approval is explicit** — "yes, ship it" works; silence does not.
- **All files are written together** — PLAN.md, every `_context/*.md`, every task file, and README.md, in one batch. No partial writes.
- **The skill stops after writing.** It does not begin implementing `ui/01-fixture-shell.md`; that belongs to a future session with a fresh context budget.
- **The hand-off message names a specific starting task file.** The executor doesn't have to guess where to begin.

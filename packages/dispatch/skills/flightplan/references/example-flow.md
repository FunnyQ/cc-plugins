# Example Flow

This is a concrete end-to-end invocation of the interview → plan → write
tree pattern. Use it as a mental model when you run the skill. The real
flow has more rounds, with variations per topic.

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

- **The slug collision check happens in Step 2**, immediately after the
  slug is agreed. It does not happen after approval.
- **Approval must be explicit.** "yes, ship it" works. Silence does not
  count as approval.
- **All files are written together, in one batch:** PLAN.md, every
  `_context/*.md` file, every task file, and README.md. The skill makes no
  partial writes.
- **The skill stops after writing.** It does not begin implementing
  `ui/01-fixture-shell.md`. That work belongs to a future session with a
  fresh context budget.
- **The hand-off message names a specific starting task file.** The
  executor does not have to guess where to begin.

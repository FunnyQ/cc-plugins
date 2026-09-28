# Example Flow

This is a concrete end-to-end invocation of the interview → plan → write
tree pattern. Use it as a mental model when you run the skill. The real
flow has more rounds, with variations per topic.

```
User: /flightplan want to add a course player to the site, will hand off to sub-agents

Claude: [calls EnterPlanMode]
        [calls AskUserQuestion: run options — which review engine for the
         written tree (Codex (Recommended) / OpenCode / Opus), and which
         review depth (Light / Standard (Recommended) / Deep)?]

User: codex, standard

Claude: [calls AskUserQuestion: topic slug + scope — what does "course player"
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

Claude: [bun scaffold.ts course-player ui,backend,api,review]
        [writes docs/course-player/PLAN.md and every tasks/_context/*.md itself]
        [forks one agent per task file in one message; joins and checks every path]
        [bun lint-task.ts docs/course-player/tasks; bun build-readme.ts docs/course-player/tasks]
        [review loop with codex until a P1-clean pass at or past the floor]
        "Plan written to docs/course-player/ (3 buckets + review/01). Run
         /autopilot course-player to execute it."
```

## What to notice

- **The run options are settled in Step 2**, before the interview starts.
  Nothing after the approval asks the user anything, except an impeccable
  design phase or a non-converged review.
- **The slug collision check happens in Step 3**, immediately after the
  slug is agreed. It does not happen after approval.
- **Approval must be explicit.** "yes, ship it" works. Silence does not
  count as approval.
- **PLAN.md and `_context/` are written before any task file**, because the
  forks read them off disk. The write is not transactional; a missing file is
  repaired in place.
- **The skill stops after writing.** It does not begin implementing
  `ui/01-fixture-shell.md`. That work belongs to a future session with a
  fresh context budget.
- **The hand-off message names `/autopilot <slug>` as the next step.**
  Autopilot derives the first ready task from the tree, so nobody has to
  guess where to begin.

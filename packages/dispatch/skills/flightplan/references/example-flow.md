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

Claude: [bun scaffold.ts --check course-player → OK, continues]
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

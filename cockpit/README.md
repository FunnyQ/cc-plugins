# cockpit

A per-project local web **cockpit** (sibling plugin to token-atlas): open a session, set the goal, then watch the decision trail steer toward it in real time — keeping you "in the loop and in control". token-atlas is the rear-view mirror (retrospective, global usage); cockpit is the windshield + control stick (present + goal, per-project). It captures a goal at session start, appends a distilled decision log, streams the live transcript, and — at a `needs_your_call` — turns the LLM's options into buttons whose pick wakes the parked session.

Run the dashboard:

```bash
bun cockpit/skills/cockpit/scripts/serve-dashboard.ts
```

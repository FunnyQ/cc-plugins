---
name: cockpit
description: >-
  Start a per-project cockpit session: propose a project goal + this session's
  goal, confirm them with Q, then capture the goal record and begin a distilled
  decision trail. Trigger phrases include: "/cockpit-start", "start cockpit",
  "set session goal", "開始 cockpit", "設定這次的目標". This skill is
  EXPLICITLY invoked (opt-in) — do NOT auto-fire on every session. Use it when Q
  wants to set a destination for this leg of work and watch the decision trail
  steer toward it in the cockpit dashboard.
---

# /cockpit-start

Capture a goal at session start and open a decision trail for this project — the
data the cockpit dashboard visualizes. This is the windshield: set where we're
going, then log the turns a diff can't explain.

**Opt-in.** Only run when Q invokes it (`/cockpit-start`, "設定這次的目標", …).
Never auto-start on session open — not every session deserves a goal.

## Procedure

Follow this order strictly. **The human holds the stick at goal-setting** — this
mirrors `needs_your_call`: nothing is written until Q confirms.

### 1. Determine the session id

Use the **current Claude Code session uuid** — the same id as the transcript at
`~/.claude/projects/**/<id>.jsonl`. If it can't be determined, generate one
(`crypto.randomUUID()`) and note which id you used.

### 2. Propose goals (don't write yet)

Draft two one-line goals from the conversation + repo state:

- **`project_goal`** — the persistent destination for this project. If
  `<project>/.cockpit/project-meta.md` already exists, reuse / refine its
  frontmatter `project_goal` rather than inventing a new one.
- **`session_goal`** — what *this* leg of the journey achieves.

Keep each to one line. Q reacts and edits; he doesn't write from scratch.

### 3. Human gate — confirm before writing

Present both goals to Q with the **`AskUserQuestion`** tool (or ask plainly).
Q confirms, edits, or rejects. **Do not run any `cockpit` command until Q
confirms.** If Q rejects, stop — write nothing.

### 4. Write (only after confirmation)

Run, substituting the confirmed text and the session id:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts start \
  --session <id> \
  --session-goal "<confirmed session goal>" \
  --project-goal "<confirmed project goal>"
```

This writes `<project>/.cockpit/project-meta.md` (frontmatter `project_goal`),
appends the goal record as line 1 of `<project>/.cockpit/logs/<id>.jsonl`, and
registers the session in `~/.cockpit/registry.json`. The skill's job ends here —
displaying the trail is the dashboard's job (`/token-atlas`-style web view).

## Logging decisions afterward

During implementation, append decisions a **diff can't explain** (skip busywork
like "created the User model"):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts log \
  --session <id> \
  --decision "what was decided / done" \
  --reason   "why — the part a diff can't show" \
  [--tradeoff "what was given up"] \
  [--file path/a.ts --file path/b.ts] \
  [--needs-call --option "A" --option "B"]
```

- `--file` and `--option` are **repeatable**.
- **Handoff (`--needs-call`)** marks the moment autopilot hands the stick back
  to Q. Supply the choices via `--option`, then **immediately run
  `cockpit wait <id>` as a background task** to park for Q's answer — the
  harness wakes you when Q picks an option (or types a reply) in the cockpit UI.
  `cockpit wait` / `cockpit send` live in the bridge bucket of this plugin.

## Notes

- One session = one log file; concurrent sessions never share a file.
- The persistent **project** goal lives only in `project-meta.md` frontmatter
  (single source of truth) — it is *not* duplicated into the log. The log's goal
  record carries only `session_goal`.

---
name: hop
version: 1.0.0
description: >-
  Interactive interviewer that gathers requirements through systematic
  questioning, then writes a lightweight in-conversation plan and executes it.
when_to_use: >-
  When the request is vague/ambiguous and needs clarification, or the user
  wants a spec/PRD/outline before implementing — for a small scope executed
  in this session. Do NOT
  trigger for a clear, directly-executable instruction, for a multi-file spec
  meant for a later session (use flightplan), or when the user wants only to
  record what they want without deciding how to build it (use preflight).
argument-hint: "[topic]"
---

# Hop

A short flight you fly yourself: interview, plan, execute — all in this session, no handoff. `flightplan` is the long haul, where the plan is frozen to disk and someone else flies it.

`preflight` is the tier above: it captures *what you want* before anyone decides how to build it. If the user wants the work done now, this skill is the right one.

## Why Plan Mode and AskUserQuestion Matter

Hop's entire value comes from two things.

1. **Plan mode.** The interview output goes into the plan file. This gives the user one document to approve or reject. Without plan mode, there is no approval gate and no structured output. The interview results scatter across the chat history and lose their value.

2. **AskUserQuestion tool.** This tool gives structured options and keeps the conversation interactive. A plain text question gets buried in the output and misses the structured response format. Every question in the interview must go through `AskUserQuestion`.

## Process

### Step 1: Enter Plan Mode

Call `EnterPlanMode` immediately. Do this before any text output and before any questions. If you are already in plan mode, skip this step. Everything that follows depends on having a plan file to write to.

### Step 2: Interview

Ask 1-2 questions per turn with `AskUserQuestion`, focused by topic type:

- **Project** (new system or app) — scope a buildable MVP: problem and users, v1 must-haves versus later, stack and deployment constraints, how success is measured.
- **Feature** (addition to an existing system) — pin behavior: who needs it, current versus desired behavior, acceptance criteria and edge cases, what is explicitly out.
- **Writing** (spec, outline, docs) — audience and purpose, the one key message, tone and format, structure.

Stop when you can write actionable acceptance criteria for each requirement: you know the problem and its users, can separate MVP from nice-to-have, know the key constraints, and have at least noted the edge cases.

**Visual design.** When the work builds or reshapes UI and the `impeccable` skill is available, ask whether to design it with impeccable first. Recommend it for a new screen or a layout change, and recommend skipping it for a tweak inside an existing layout. A yes adds Step 5 and a `## Design` line to the plan. Skip the question when either condition fails.

### Step 3: Write Plan

Write the spec and implementation plan to the plan file, using the template below. Size it to the topic, and drop or rename sections that add nothing (a writing task might use "Outline" for "Implementation Plan").

### Step 4: Exit Plan Mode

Call `ExitPlanMode` so the user can review and approve. Wait for their response.

### Step 5: Design with impeccable (only when the interview chose it)

Run this after approval, because plan mode allows no file writes. Record the base commit with `git rev-parse HEAD` first, since impeccable may write `PRODUCT.md` and `.impeccable/` into the repo.

1. Pre-warm the engine: run `<impeccable skill dir>/scripts/impeccable context` once at the maximum Bash timeout, because its first run downloads the engine. When the skill directory is unknown until the skill loads, make this the first Setup command, at the same timeout. When that run fails or times out, take impeccable's own "Launcher unavailable" path. Never re-run it in a loop.
2. Invoke the `impeccable` skill with `shape <feature>`, followed by the interview's summary: goal, users, states, constraints, and the existing visual world. Answer its questions with the user.
3. Draw the approved direction yourself as one self-contained `mock.html`, since shape returns a brief and never code. Ground it in the real UI first: a screenshot, the real colours, the real assets. Load impeccable's `reference/craft-floor.md` before drawing. Draw every state the plan builds, and use the target's real values. Write it under a `mktemp -d` leaf in `/tmp/q-lab/dispatch/hop/`.
4. Render the mock in a browser (`herdr-browser` when Herdr runs) and inspect the screenshot before showing it. Open the page for the user. Re-render after every revision until the user approves the mock.
5. When the approved mock changes a plan decision or adds work, list each change and get the user's yes before Step 6.

### Step 6: Execute

After approval, record the base commit with `git rev-parse HEAD` before the first edit, unless Step 5 already recorded it. Step 7 reviews everything since that commit. After a design phase, build the UI to the mock's values, and end by opening the built UI and the mock side by side for the user to compare. Then implement the plan. For larger plans, remind the user to commit after each meaningful stage.

### Step 7: Verify at high effort (optional)

Execution ran at the session's effort, with the user in the loop. A fresh reviewer at high effort hunts the edge cases the loop missed. It does not fix a wrong approach, so run it only after the user agrees the direction is right.

Ask via `AskUserQuestion` whether to run the review. Recommend running it when the change has hidden edge cases: parsing, concurrency, security, data migration, or a bug fix in existing code. Recommend skipping it for docs, config, and mechanical edits.

When the user accepts, ask two more `AskUserQuestion` rounds. First ask the harness: `claude` (recommended), `codex`, or `opencode`. Then ask the model, with options for the chosen harness:

| Harness | Command | Model options | Extra flag |
| --- | --- | --- | --- |
| claude | `/relay:claude-cli` | `opus` (recommended), `sonnet` | `--effort high` |
| codex | `/relay:codex` | `default` (recommended) | none |
| opencode | `/relay:opencode` | `default` (recommended) | none |

`default` means omit `--model`, so relay resolves the model from its own config and suggestions. A model typed through "Other" passes through verbatim.

Invoke the chosen command with this argument, filling in the plan file path, the base commit, and the flags:

```
review "Review every change since <base> (run git diff <base>, and list untracked files with git status --short) against the plan at <plan file>. Hunt edge cases the acceptance criteria miss. Run the tests. Report each finding with file:line and the concrete fix." [--model <model>] [--effort high] --headless
```

Pass `--effort high` only to claude: relay refuses `--effort` on codex and opencode. Skip relay's save-to-config question: the pick is for this review, not relay's default. When relay rejects `--model` or `--effort` as an unknown flag, tell the user to update relay; do not rerun without the flag.

Fix every finding you can confirm. Report the rest to the user with your reason for leaving each one.

## Plan File Template

```markdown
# <Topic>

## Overview
[1-2 sentence summary of what we're building/writing and why]

## Context
[Problem being solved, current situation]

## Requirements
[Structured list from interview — mark MVP vs later if applicable]

## Constraints
[Technical limitations, timeline, scope boundaries]

## Design
[impeccable → mock.html before execution — omit this section when the interview skipped it]

## Implementation Plan
[Step-by-step plan with enough detail to execute — file names, key decisions, order of operations]

## Open Questions
[Unknowns that surfaced during interview, if any — omit this section if none]
```

---
name: autopilot
version: 0.3.0
description: Execute a flightplan task tree end-to-end with a multi-agent quality loop. For each ready task it runs Dev → an independent binary gate → a rubric judge → a deterministic score gate, retrying until the task passes its own `## Eval rubric`, then runs the closing `Final review` task as the whole-tree gate. AUTO-TRIGGER when the user says "/autopilot", "execute the flightplan", "run the task tree", "build out docs/<slug>", "work through the tasks", "fly the plan", or points at a `docs/<slug>/tasks/` tree and asks to implement it. Do NOT trigger when there is no flightplan on disk (use flightplan first), or when the user wants to do a single task by hand.
---

# Autopilot

## Why this skill exists

`flightplan` writes the blueprint; `autopilot` flies it. It walks a `docs/<slug>/tasks/` tree, executes each task with a dev→review→score loop that gates on the task's own machine-parseable `## Eval rubric`, and finishes with the one `Final review` task as the holistic closing gate. The output is working, reviewed code plus an audit trail (`RUNLOG.md`) of every verdict.

It is the third skill in the arc:

```
preflight  → lightweight in-conversation spec
flightplan → multi-file blueprint to disk (PLAN.md + tasks/)
autopilot  → execute the tree with a quality loop   ← you are here
```

## When to use vs doing it by hand

- A `docs/<slug>/tasks/` tree exists and you want it executed with a real quality gate, possibly many tasks in parallel → **autopilot**.
- One small task, or no flightplan on disk → do it directly (or run `flightplan` first).

## How orchestration works (read this before running)

Autopilot uses the **Workflow tool**. A skill whose instructions tell the agent to call Workflow is a *sanctioned opt-in* — so invoking `/autopilot` lets you call Workflow directly **without the user typing "workflow"**.

Use the **hybrid shape**: scout inline first to discover the work-list, *then* hand the fan-out to a Workflow script.

Three hard constraints shape the design — internalize them:

1. **The Workflow orchestrator script has no filesystem access** and **cannot `import`** our scripts. So anything that reads/writes disk (running `next-ready.ts`, editing a task's `Status`, appending to the flightlog) must be done by a tool-capable **agent** inside the workflow, never by the orchestrator JS.
2. **The pass/fail gate is pure arithmetic** (weighted average + hard-fail veto). Because the orchestrator can't import `scoreTask`, **inline that arithmetic in the orchestrator JS** from the judge's structured per-dimension scores. The `score-task.ts` CLI stays for the *logging* path (an agent runs it to persist the verdict). The inline formula must mirror `scoreTask()` exactly — see `references/orchestrator.md`.
3. **The orchestrator can't pause for input.** On a task that can't pass, it parks the task and keeps going; escalation to the user happens *after* the workflow returns (see Escalation below).

## Step 1 — Scout inline

Before touching Workflow, gather the work-list in the main conversation:

1. Resolve the plan dir. The user names a slug or path; the tree lives at `docs/<slug>/tasks/`.
2. Read `docs/<slug>/PLAN.md` for the overall goal and the bucketing — the Final review task scores against "did we meet the PLAN goal", so the orchestrator needs the goal in hand.
3. Confirm there is ready work:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/next-ready.ts docs/<slug>/tasks
   ```
   (autopilot reuses flightplan's scripts — they are siblings under `skills/`.) If it errors, the tree is malformed; run `lint-task.ts` and fix before flying. If it prints nothing and no task is `in-progress`, the tree is already done.
4. Decide `MAX_ATTEMPTS` (default **3**) and confirm the model policy below with the user only if they want to change it.

## Step 2 — Confirm the flight with the user

Show a one-screen brief and get a go: the slug, how many tasks, `MAX_ATTEMPTS`, the model policy, and that capped tasks will be parked + escalated (not silently skipped). This is real compute and real edits — get an explicit go before calling Workflow.

## Step 3 — Call Workflow with the wave-loop orchestrator

Adapt `references/orchestrator.md` — it is the canonical script. Pass the scouted values via Workflow's `args`:

```
args: { slug, tasksDir: "docs/<slug>/tasks", planPath: "docs/<slug>/PLAN.md",
        logFile: "docs/<slug>/.flightlog/run.jsonl", maxAttempts: 3, planGoal: "<one line from PLAN.md>" }
```

The orchestrator runs a **wave loop**: each wave asks an agent to run `next-ready.ts` (status changes only happen *inside* the run, so the ready set must be re-scouted every wave — a static list misses tasks unblocked mid-flight), then executes the wave's ready tasks **in parallel**. Each task is a retry pipeline:

```
Dev (Sonnet) ─ implements + edits Status, logs a note
   │
   ▼
Binary gate (Haiku) ─ INDEPENDENTLY re-runs the task's ## Verification commands
   │                   + checks ## Acceptance criteria. Cheap filter, runs first.
   ├─ fail → loop back to Dev with the failure output
   ▼ pass
Rubric judge (Opus) ─ scores each ## Eval rubric dimension, runs score-task --log
   │
   ▼
Score gate (inline arithmetic in the orchestrator) ─ weighted avg + veto
   ├─ fail → loop back to Dev with the judge's rationale
   ▼ pass
done → Status: done   (next wave's next-ready will see it)
```

The `Final review` task (`> **Final review**: true`) depends transitively on every other task, so the wave loop **naturally schedules it last** — it only becomes ready once everything else is `done`. No special phase needed; just bump its Dev and judge to Opus (the orchestrator detects the marker).

## Model policy

Encoded as a constant table at the top of the orchestrator so it's tunable in one place. The dev≠judge split is deliberate: a model judging its own output is biased toward passing.

| Role | Model | Why |
|---|---|---|
| **Dev** | Sonnet → **Opus on the last attempt** | Workhorse coder. On the final attempt before the cap, escalate to Opus — a model that failed N times rarely clears it by retrying as itself; the last shot gets the stronger model before we bother the user. |
| **Binary gate (Acceptance / Verification)** | Haiku | Mechanical: re-run the task's concrete `## Verification` commands and report pass/fail + raw output. Keep its job narrow — *run and report*, never subjective judgement. Runs first as a cheap filter so Opus never scores code that doesn't even build/test. |
| **Rubric judge** | Opus | The graded gate that decides loop-or-pass; judgement quality is paramount (a weak judge ships bad code or loops forever). |
| **Final review** | Opus (dev + judge) | Highest-stakes holistic gate: integration, consistency, regressions, did we meet the PLAN goal. |

## Grounding the score (do not skip)

The **correctness** dimension must be grounded in **real verification**, not the judge's vibe. The binary gate agent actually runs the task's `## Verification` commands and `## Acceptance criteria`; its pass/fail and raw output are handed to the rubric judge, which scores correctness against *that evidence*. A judge scoring correctness high while the binary gate failed is a contradiction the orchestrator rejects (the binary gate must pass before the judge even runs).

## Escalation — park & continue, then resume

When a task exhausts `MAX_ATTEMPTS`:

1. The orchestrator **parks** it (records an escalation; the dev agent sets its `Status: blocked` so the parked state is visible) and **keeps flying** the other independent tasks. Dependents of a parked task simply never become ready, so they wait.
2. When the workflow returns, it hands back `{ completed: [...], escalations: [{ task, attempt, reason, lastVerdict }] }`.
3. **You** (the main agent) surface the escalations to the user. In an active cockpit session, hand the stick back via `needs_your_call` + `cockpit wait`; otherwise use `AskUserQuestion`. Show the task, the last verdict, and the judge's rationale.
4. After the user unblocks it (a decision, a spec fix, a manual nudge), **resume**: reset the parked task's `Status` to `todo` and re-run autopilot. The wave loop picks up where it left off — completed tasks stay `done`, so `next-ready` only re-offers the unblocked work.

The orchestrator never asks the user anything mid-run — Workflow can't pause for input. Escalation is always post-return.

## Step 4 — Report

After the workflow returns:

1. Run the flightlog report to render the audit trail:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/flightlog.ts report docs/<slug>/.flightlog/run.jsonl
   ```
   This writes `docs/<slug>/.flightlog/RUNLOG.md` — every attempt, every verdict, each linked to its agent label for drill-down.
2. Tell the user: tasks completed, tasks escalated (with why), and where `RUNLOG.md` lives. If everything passed including Final review, say so plainly and point at what to verify/ship.

## The flightlog (audit trail)

Everything lands in `docs/<slug>/.flightlog/`, **gitignored** via a self-ignore (`.flightlog/.gitignore` containing `*`) — created automatically on first write, no user setup.

- **Score verdicts** — the rubric-judge agent runs `score-task.ts <taskfile> <scores.json> --log docs/<slug>/.flightlog/run.jsonl --attempt N --agent <its-label>`. Deterministic, guaranteed each cycle.
- **Narrative** — Dev / judge / final-review agents run `flightlog.ts log <run.jsonl> --task <ref> --role <role> --attempt N --agent <label> --message "..."` to record what they did.
- **Report** — `flightlog.ts report <run.jsonl>` renders `RUNLOG.md`, grouped by task in chronological order.

Each entry records an `agentLabel` so a suspicious verdict can be traced back to that agent's raw `agent-<id>.jsonl` in the harness transcript.

## Bundled scripts (shared with flightplan)

autopilot ships no scripts of its own — it reuses flightplan's, which are siblings under `skills/flightplan/scripts/`:

- `next-ready.ts <tasks-dir>` — the per-wave ready-set scout.
- `score-task.ts <task> <scores.json> [--log <file>] [--attempt N] [--agent <label>]` — `scoreTask(rubric, scores)` exported; the inline orchestrator gate mirrors it. `--log` persists the verdict to the flightlog.
- `flightlog.ts log|report` — narrative entries + `RUNLOG.md`.
- `lint-task.ts <tasks-dir>` — run during scout if `next-ready` reports a malformed tree.

## Additional resources

- `references/orchestrator.md` — the canonical Workflow script (wave loop, per-task retry pipeline, inline score gate, agent prompts + schemas). Adapt this; don't write one from scratch.

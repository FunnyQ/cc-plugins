---
name: autopilot
version: 0.5.0
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
2. **There is exactly one scoring implementation.** The rubric judge runs `score-task.ts --json --log`, and the orchestrator gates on that printed verdict object. Do not duplicate the weighted-average / hard-fail arithmetic in the Workflow script.
3. **The orchestrator can't pause for input.** On a task that can't pass, it parks the task and keeps going; escalation to the user happens *after* the workflow returns (see Escalation below).

## Step 1 — Scout inline

Before touching Workflow, gather the work-list in the main conversation:

1. **Resolve the scripts path once.** autopilot reuses flightplan's scripts (siblings under the plugin). `CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash — so don't `${CLAUDE_PLUGIN_ROOT}/...` your way to them. Take the skill's load-time *"Base directory for this skill"* banner and resolve `<base>/../flightplan/scripts` to an absolute path; call it `$SCRIPTS` and use it in every `bun` command below. (This is the same value you'll bake into `CFG.scriptsDir` in Step 3.)
2. Resolve the plan dir **as an absolute path**. The user names a slug or path; the tree lives at `docs/<slug>/tasks/`. Capture the real repo root with `git rev-parse --show-toplevel` (it can be anywhere — `/Users/<name>/Projects/...`, `/opt/temp/project-repo`, `/workspace/...`) and build absolute paths for `tasksDir` / `planPath` / `logFile` from it (`<root>/docs/<slug>/...`) to bake into `CFG` in Step 3 — these MUST be absolute. Workflow agents don't share a cwd, so a *relative* `logFile` resolves against whichever agent's working directory; an agent that `cd`s into the tree writes the flightlog to a nested `docs/<slug>/tasks/docs/<slug>/.flightlog/` and splits the audit trail. `~/...` is an optional shorthand **only when the repo is under `$HOME`** (Bash + the file tools expand a leading `~`, avoids leaking the username) — for a repo outside `$HOME` use the full path; never invent a `~` form.
3. Read `docs/<slug>/PLAN.md` for the overall goal and the bucketing — the Final review task scores against "did we meet the PLAN goal", so the orchestrator needs the goal in hand.
4. Confirm there is ready work:
   ```bash
   bun $SCRIPTS/next-ready.ts docs/<slug>/tasks
   ```
   If it errors, the tree is malformed; run `lint-task.ts` and fix before flying. If it prints nothing and no task is `in-progress`, the tree is already done.
5. **Capture the base ref** for the Final review diff scope:
   ```bash
   git rev-parse HEAD
   ```
   Bake this as `CFG.baseRef` — the Final review lenses use `git diff <baseRef>..HEAD` to see all committed task changes, rather than the working-tree diff (which would be empty after inter-wave commits).
6. Decide `maxAttempts` (default **3**, the per-task cap) and `finalReviewMaxAttempts` (default **2**, the Final review round's cap). The dev engine (Claude / codex / opencode) is chosen with the user in Step 2; confirm the rest of the model policy only if they want to change it.
7. Confirm the selected external CLI(s) are available — the dev step (when its engine is external) and the closing cross-vendor review round shell out to them. Version-check whichever engines Step 2 will offer or the user picks:
   ```bash
   codex --version      # needed if devEngine or reviewEngine is 'codex'
   opencode --version   # needed if devEngine or reviewEngine is 'opencode'
   ```
   If a selected engine isn't installed, tell the user before flying (the per-task Claude work still runs; the external dev engine and the closing cross-vendor review round are what need it).

## Step 2 — Confirm the flight with the user

**Ask which dev engine, which cross-vendor reviewer, and which final-review lens model to fly with — don't silently default.** These are **independent** choices; use `AskUserQuestion`:

- **Dev engine** (`CFG.devEngine`) — **Claude** (default; Sonnet writes, Opus on the last attempt), **Codex** (`'codex'` — the OpenAI codex CLI writes each task via `codex-run.ts`), or **OpenCode** (`'opencode'` — the opencode CLI writes each task via `opencode-run.ts`). With Codex/OpenCode the dev step is a cheap Haiku driver and Claude still judges, giving a cross-vendor dev≠judge split.
- **Cross-vendor reviewer** (`CFG.reviewEngine`) — **Codex** (default) or **OpenCode** — the external bug/correctness lens in the closing Final review.
- **Final-review lens model** (`CFG.reviewLensModel`) — **Opus** (default) or **Fable 5** (`'fable'`) — the model for the four Claude `/simplify` lenses (reuse / simplification / efficiency / altitude) in the closing Final review. Affects **only** those four lenses; the fixer and rubric judge stay Opus regardless.

The picks set `CFG.devEngine` + `CFG.reviewEngine` + `CFG.reviewLensModel` in Step 3. Whichever external engines get chosen make their `--version` check from Step 1 load-bearing — if a picked engine is unreachable, say so and offer to fall back before flying (Claude for the dev engine; the other CLI for the reviewer).

Then show a one-screen brief and get a go: the slug, how many tasks, the chosen dev engine + cross-vendor reviewer + final-review lens model, the two caps (`maxAttempts` / `finalReviewMaxAttempts`), the model policy, that capped tasks will be parked + escalated (not silently skipped), and that the closing Final review round runs the chosen external CLI review — which **sends the branch diff to an external service** (OpenAI for codex; the configured opencode provider for opencode). This is real compute, real edits, and an external code review — get an explicit go before calling Workflow.

## Step 3 — Call Workflow with the wave-loop orchestrator

Adapt `references/orchestrator.md` — it is the canonical script. Copy its `CFG` block and fill these scouted values as literals; do not rely on the Workflow `args` global:

- `slug`
- absolute `tasksDir`, `planPath`, and `logFile`
- `planGoal`
- `maxAttempts` and `finalReviewMaxAttempts`
- absolute `scriptsDir`
- `baseRef`
- `commitBetweenWaves`
- `devEngine` and `reviewEngine`
- `opencodeDevModel` and `opencodeReviewModel`
- `reviewLensModel`

Then call `Workflow({ script: <the adapted script> })` — no `args` needed.

**Dev engine (`CFG.devEngine`) + cross-vendor reviewer (`CFG.reviewEngine`) are independent axes.** `devEngine` controls who writes non-final tasks; `reviewEngine` controls the external bug/correctness lens in the closing Final review. The full external-engine behavior and failure handling live in `references/orchestrator.md`.

**Picking the opencode model.** Leave `CFG.opencodeDevModel` / `CFG.opencodeReviewModel` empty for wrapper defaults, or set either to a `provider/model` override for that role. These fields are opencode-only; codex ignores them.

The orchestrator runs a **wave loop**: each wave asks an agent to run `next-ready.ts` (status changes only happen *inside* the run, so the ready set must be re-scouted every wave — a static list misses tasks unblocked mid-flight), then executes the wave's ready tasks **in parallel**. Each task is a retry pipeline:

```
Dev (Sonnet) ─ implements + edits Status, logs a note
   │
   ▼
Binary gate (Haiku) ─ INDEPENDENTLY re-runs the task's ## Verification commands
   │                   + checks ## Acceptance criteria. Cheap filter, runs first.
   ├─ fail → loop back to Dev with the failure output
   ▼ pass
Rubric judge (Opus) ─ scores each ## Eval rubric dimension, runs score-task --json --log
   │
   ▼
Score gate ─ consumes score-task.ts --json verdict
   ├─ fail → loop back to Dev with the judge's rationale
   ▼ pass
done → mark-done.ts: Status: done + tick ## Acceptance criteria / ## Verification boxes   (next wave's next-ready will see it)

[between waves, wave > 1 — inside the scout agent before next-ready.ts runs]
   atomic-commit (inline git, NOT the skill) ─ commits all changes from the completed wave
   │   (CFG.commitBetweenWaves must be true; skipped for wave 1 — nothing to commit yet)
   ▼
[post-loop — after the wave loop exits]
   final atomic-commit (inline git) ─ commits Final review's changes (or any tail changes from the last wave)
```

The `Final review` task (`> **Final review**: true`) depends transitively on every other task, so the wave loop **naturally schedules it last** — it only becomes ready once everything else is `done`. No special phase needed. Its dev step is **not** a Claude self-review: the orchestrator runs a **multi-lens review fan-out** (see below). The binary gate, rubric judge, and score gate are identical to every other task — they grade that round against the Final review task's own `## Eval rubric`.

### The closing multi-lens review round

The Final review's "dev" step fans out independent record-only reviewers, then a single Opus fixer applies the real fixes and re-runs verification:

- `<reviewEngine>`: codex/opencode CLI bug and correctness review.
- `reuse`: duplicated logic and missed existing helpers.
- `simplification`: dead code, needless complexity, clearer equivalents.
- `efficiency`: redundant work, N+1s, recomputation, avoidable allocation/IO.
- `altitude`: over- or under-engineered abstraction level.

The fan-out happens at orchestrator level because Workflow agents cannot spawn other agents. See `references/orchestrator.md` for the full rationale, failure handling, and exact prompts.

## Step 4 — Report

After the workflow returns:

1. Run the flightlog report to render the audit trail (`$SCRIPTS` is the path you resolved in Step 1):
   ```bash
   bun $SCRIPTS/flightlog.ts report docs/<slug>/.flightlog/run.jsonl
   ```
   This writes `docs/<slug>/.flightlog/RUNLOG.md` — every attempt, every verdict, each linked to its agent label for drill-down.
2. Tell the user: tasks completed, tasks escalated (with why), and where `RUNLOG.md` lives. If everything passed including Final review, say so plainly and point at what to verify/ship.

The rest of this doc is reference — model policy, scoring, escalation handling, the flightlog, and the shared scripts.

## Model policy

Encoded as a constant table at the top of the orchestrator so it's tunable in one place. The dev≠judge split is deliberate: a model judging its own output is biased toward passing.

| Role | Model | Why |
|---|---|---|
| **Dev** | Sonnet → **Opus on the last attempt** | Workhorse coder. On the final attempt before the cap, escalate to Opus — a model that failed N times rarely clears it by retrying as itself; the last shot gets the stronger model before we bother the user. |
| **Dev — external engine** (`CFG.devEngine: 'codex'`/`'opencode'`) | Haiku driver → **Opus on the last attempt** | When an external dev engine is on, the dev step is a cheap Haiku driver that runs the `<engine>-run.ts delegate` wrapper to have that CLI write the code — the coding intelligence is the external CLI's, so the driver just invokes + verifies. The last attempt still falls back to Claude-Opus (a cross-vendor final try). |
| **Binary gate (Acceptance / Verification)** | Haiku | Mechanical: re-run the task's concrete `## Verification` commands and report pass/fail + raw output. Keep its job narrow — *run and report*, never subjective judgement. Runs first as a cheap filter so Opus never scores code that doesn't even build/test. |
| **Rubric judge** | Opus | The graded gate that decides loop-or-pass; judgement quality is paramount (a weak judge ships bad code or loops forever). |
| **Commit (inter-wave + post-loop)** | Haiku | Commits the wave's changes with **inline git** (the `COMMIT_INSTRUCTIONS` block — atomic principles + commit template baked into the prompt), NOT the `odin-git:atomic-commit` skill: a Workflow agent has no `Agent` tool, so that skill's vör/bragi sub-agents can't spawn. A wave's changes are usually one coherent set, so grouping + message-writing is within Haiku's reach. |
| **Final review — cross-vendor lens** (`CFG.reviewEngine`) | Haiku | Only *drives* the chosen external CLI (codex or opencode, via `<engine>-run.ts review`) and records its output — the review intelligence lives in that CLI, so a cheap model to invoke + capture is all that's needed. |
| **Final review — /simplify lenses** (`CFG.reviewLensModel`) | Opus × 4 (parallel), default — or **Fable 5** (`'fable'`) | reuse / simplification / efficiency / altitude. These must genuinely *understand* the code to judge quality, so they get a strong model. Tunable via `CFG.reviewLensModel` (`'opus'` default, or `'fable'`) — this affects **only** these four lenses; the fixer and judge stay Opus. They only *record* findings; they don't edit. |
| **Final review — fixer** | Opus | Reads every lens's findings and applies them; highest-stakes holistic gate (integration, consistency, regressions, met the PLAN goal). Capped at `finalReviewMaxAttempts` (default 2). |

## Grounding the score (do not skip)

The **correctness** dimension must be grounded in **real verification**, not the judge's vibe. The binary gate agent actually runs the task's `## Verification` commands and `## Acceptance criteria`; its pass/fail and raw output are handed to the rubric judge, which scores correctness against *that evidence*. A judge scoring correctness high while the binary gate failed is a contradiction the orchestrator rejects (the binary gate must pass before the judge even runs).

## Escalation — park & continue, then resume

When a task exhausts its cap (`maxAttempts`, or `finalReviewMaxAttempts` for the Final review):

1. The orchestrator **parks** it (records an escalation; the dev agent sets its `Status: blocked` so the parked state is visible) and **keeps flying** the other independent tasks. Dependents of a parked task simply never become ready, so they wait.
2. When the workflow returns, it hands back `{ slug, completed: [...], escalations: [{ task, attempt, reason }] }`. The `reason` string already embeds the last verdict — the judge's rationale, or the binary gate's output, or the scout error.
3. **You** (the main agent) surface the escalations to the user. In an active cockpit session, hand the stick back via `needs_your_call` + `cockpit wait`; otherwise use `AskUserQuestion`. Show the task and its `reason`.
4. After the user unblocks it (a decision, a spec fix, a manual nudge), **resume**: reset the parked task's `Status` to `todo` and re-run autopilot. The wave loop picks up where it left off — completed tasks stay `done`, so `next-ready` only re-offers the unblocked work.

Crash recovery note: an interrupted run can leave task files at `Status: in-progress`; `next-ready` only offers `todo`, so reset stale `in-progress` tasks to `todo` before re-running autopilot.

The orchestrator never asks the user anything mid-run — Workflow can't pause for input. Escalation is always post-return.

## The flightlog (audit trail)

Everything lands in `docs/<slug>/.flightlog/`, **gitignored** via a self-ignore (`.flightlog/.gitignore` containing `*`) — created automatically on first write, no user setup.

- **Score verdicts** — the rubric-judge agent runs `score-task.ts <taskfile> <scores.json> --log docs/<slug>/.flightlog/run.jsonl --attempt N --agent <its-label>`. Deterministic, guaranteed each cycle.
- **Narrative** — Dev / judge / final-review agents run `flightlog.ts log <run.jsonl> --task <ref> --role <role> --attempt N --agent <label> --message "..."` to record what they did.
- **Review findings** — the Final review lenses write their raw findings to `.flightlog/review/attempt-N/<lens>.md` (`<reviewEngine>` / reuse / simplification / efficiency / altitude). These persist as the artifact behind each closing-round verdict.
- **Report** — `flightlog.ts report <run.jsonl>` renders `RUNLOG.md`, grouped by task in chronological order.

Each entry records an `agentLabel` so a suspicious verdict can be traced back to that agent's raw `agent-<id>.jsonl` in the harness transcript.

## Bundled scripts (shared with flightplan)

autopilot ships no scripts of its own — it reuses flightplan's, which are siblings under `skills/flightplan/scripts/`:

- `next-ready.ts <tasks-dir> [--json]` — the per-wave ready-set scout. `--json` emits `[{ref,finalReview,path}]` (or `[]` when none ready); the scout echoes it verbatim so an empty set can't be misread as "everything is ready".
- `score-task.ts <task> <scores.json> [--json] [--log <file>] [--attempt N] [--agent <label>]` — `scoreTask(rubric, scores)` exported. `--json` prints the machine verdict the orchestrator gates on; `--log` persists the same verdict to the flightlog.
- `mark-done.ts <task>` — the done-transition: sets `Status: done` and ticks every `## Acceptance criteria` / `## Verification` checkbox. Run when a task passes the gate.
- `flightlog.ts log|report` — narrative entries + `RUNLOG.md`.
- `lint-task.ts <tasks-dir>` — run during scout if `next-ready` reports a malformed tree.
- `codex-run.ts <delegate|review> [--prompt-file <path>]` — thin wrapper over the `codex` CLI used by the codex dev engine + the codex review lens. `delegate` runs `codex exec -s workspace-write` and appends a `git status --short`; `review` runs `codex exec -s read-only`. Captures codex's clean last message, prints it, and deletes its own scratch (no temp left to mine). Exits non-zero with a `CODEX UNREACHABLE` stderr line when the CLI is missing/fails. Prompt from `--prompt-file` or stdin.
- `opencode-run.ts <delegate|review> [--prompt-file <path>] [--model <m>]` — the opencode counterpart of `codex-run.ts`, used when `devEngine`/`reviewEngine` is `'opencode'`. `delegate` runs `opencode run -m <model> --format json` (write-capable) and appends a `git status --short`; `review` prepends a hard read-only guard (opencode has no sandbox read-only). Parses the JSONL `text` parts, prints the clean answer, exits non-zero with an `OPENCODE UNREACHABLE` stderr line when the CLI is missing/fails. Model: `--model` > `OPENCODE_MODEL` env > per-mode default (delegate `opencode-go/kimi-k2.7-code`, review `opencode-go/qwen3.7-max`). Prompt from `--prompt-file` or stdin.

## Additional resources

- `references/orchestrator.md` — the canonical Workflow script (wave loop, per-task retry pipeline, inline score gate, agent prompts + schemas). Adapt this; don't write one from scratch.

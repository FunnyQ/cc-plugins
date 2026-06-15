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
2. **The pass/fail gate is pure arithmetic** (weighted average + hard-fail veto). Because the orchestrator can't import `scoreTask`, **inline that arithmetic in the orchestrator JS** from the judge's structured per-dimension scores. The `score-task.ts` CLI stays for the *logging* path (an agent runs it to persist the verdict). The inline formula must mirror `scoreTask()` exactly — see `references/orchestrator.md`.
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
6. Confirm the selected external CLI(s) are available — the dev step (when its engine is external) and the closing cross-vendor review round shell out to them. Version-check whichever engines Step 2 will offer or the user picks:
   ```bash
   codex --version      # needed if devEngine or reviewEngine is 'codex'
   opencode --version   # needed if devEngine or reviewEngine is 'opencode'
   ```
   If a selected engine isn't installed, tell the user before flying (the per-task Claude work still runs; the external dev engine and the closing cross-vendor review round are what need it).

## Step 2 — Confirm the flight with the user

**Ask which dev engine and which cross-vendor reviewer to fly with — don't silently default.** These are two **independent** choices; use `AskUserQuestion`:

- **Dev engine** (`CFG.devEngine`) — **Claude** (default; Sonnet writes, Opus on the last attempt), **Codex** (`'codex'` — the OpenAI codex CLI writes each task via `codex-run.ts`), or **OpenCode** (`'opencode'` — the opencode CLI writes each task via `opencode-run.ts`). With Codex/OpenCode the dev step is a cheap Haiku driver and Claude still judges, giving a cross-vendor dev≠judge split.
- **Cross-vendor reviewer** (`CFG.reviewEngine`) — **Codex** (default) or **OpenCode** — the external bug/correctness lens in the closing Final review.

The picks set `CFG.devEngine` + `CFG.reviewEngine` in Step 3. Whichever external engines get chosen make their `--version` check from Step 1 load-bearing — if a picked engine is unreachable, say so and offer to fall back before flying (Claude for the dev engine; the other CLI for the reviewer).

Then show a one-screen brief and get a go: the slug, how many tasks, the chosen dev engine + cross-vendor reviewer, the two caps (`maxAttempts` / `finalReviewMaxAttempts`), the model policy, that capped tasks will be parked + escalated (not silently skipped), and that the closing Final review round runs the chosen external CLI review — which **sends the branch diff to an external service** (OpenAI for codex; the configured opencode provider for opencode). This is real compute, real edits, and an external code review — get an explicit go before calling Workflow.

## Step 3 — Call Workflow with the wave-loop orchestrator

Adapt `references/orchestrator.md` — it is the canonical script. **Bake the scouted values into the `CFG` block at the top of the script as literals; do NOT rely on the Workflow `args` global** (it does not reliably reach the orchestrator — an unset value surfaces as `undefined`, e.g. `bun undefined/next-ready.ts`, which fails the scout and silently looks like "no work to do"). You already know every value from Step 1's scout, so write them in directly:

```javascript
const CFG = {
  slug:                  '<slug>',
  tasksDir:              '<repo-root>/docs/<slug>/tasks',          // ABSOLUTE (git rev-parse --show-toplevel) — NOT relative; see Step 1.2
  planPath:              '<repo-root>/docs/<slug>/PLAN.md',        // ABSOLUTE
  logFile:               '<repo-root>/docs/<slug>/.flightlog/run.jsonl',  // ABSOLUTE — relative splits the flightlog across agent cwds
  planGoal:              '<one line from PLAN.md>',
  maxAttempts:           3,
  finalReviewMaxAttempts: 2,   // the closing cross-vendor review round loops at most this many times
  scriptsDir:            '<abs path to skills/flightplan/scripts>',  // ABSOLUTE, from the skill load-time base dir
  baseRef:               '<output of `git rev-parse HEAD` captured in Step 1>',
  commitBetweenWaves:    true,   // set false to skip inter-wave atomic-commits
  devEngine:             'claude',  // 'claude' (default), 'codex', or 'opencode' — see "Dev engine" below
  reviewEngine:          'codex',   // 'codex' (default) or 'opencode' — cross-vendor reviewer in the Final review
  opencodeDevModel:      '',        // optional opencode model for the dev engine (empty → default opencode-go/kimi-k2.7-code); opencode-only
  opencodeReviewModel:   '',        // optional opencode model for the review lens (empty → default opencode-go/qwen3.7-max); opencode-only
}
```

Then call `Workflow({ script: <the adapted script> })` — no `args` needed.

**Dev engine (`CFG.devEngine`) + cross-vendor reviewer (`CFG.reviewEngine`) — two independent axes.** Default dev engine `'claude'` writes code with Sonnet (→ Opus on the last attempt). Set it to `'codex'` or `'opencode'` to hand each task's implementation to that external CLI: the dev step becomes a cheap Haiku *driver* that runs the `<engine>-run.ts delegate` wrapper (reachable from a Workflow agent's Bash — the same wrapper the closing cross-vendor review lens uses), so the external CLI does the coding. The wrapper prints the CLI's summary + a `git status --short` and cleans up its own scratch, so the driver never mines a transcript. The independent verify → judge → score pipeline stays Claude, turning the dev≠judge split into a **cross-vendor** one (the external CLI writes, Claude-Opus judges). The last attempt before the cap still falls back to Claude-Opus — a final try before the task is parked — and if the CLI is unreachable the wrapper exits non-zero (the driver never fabricates), so the gate fails the attempt cleanly. `CFG.reviewEngine` (`'codex'` default, or `'opencode'`) **independently** picks the external bug/correctness lens in the closing Final review — so you can have opencode write and codex review, or any mix. Only the dev step changes with `devEngine`; the finalReview round's other lenses and everything else are identical. (codex review is sandbox-enforced read-only; opencode review is prompt-enforced read-only — its wrapper prepends a hard "analyze only" guard, since opencode has no `-s read-only` equivalent yet.)

**Picking the opencode model.** opencode requires a `-m provider/model`. Leave `CFG.opencodeDevModel` / `CFG.opencodeReviewModel` empty to use the wrapper defaults (`opencode-go/kimi-k2.7-code` for dev, `opencode-go/qwen3.7-max` for review); set either to override just that role (the orchestrator threads it through as `opencode-run.ts … --model <value>`). These are **opencode-only** — codex uses its own configured model and ignores `-m`, so they have no effect when an engine is codex. When the user names a specific opencode model in Step 2, bake it into the matching field; otherwise leave them empty.

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

The dev and rubric judge are both Claude, so they share blind spots. The Final review's "dev" step instead fans out **independent review lenses**, then a single Opus **fixer** reads all their findings and applies them. On the `finalReview` marker the orchestrator runs (capped at `finalReviewMaxAttempts`, default **2**):

```
parallel reviewers — each writes findings to .flightlog/review/attempt-N/<lens>.md, edits nothing
   ├─ <reviewEngine> → <engine>-run.ts review (codex/opencode CLI over Bash): cross-vendor bug/correctness
   ├─ reuse          → duplicated logic, missed reuse of existing helpers     ┐
   ├─ simplification → dead code, needless complexity, clearer equivalents     │ the four
   ├─ efficiency     → redundant passes, N+1s, recomputation, allocations      │ /simplify
   └─ altitude       → over-/under-engineering (wrong abstraction level)       ┘ lenses
   │
   ▼
Opus fixer — reads every findings file, applies the real fixes (Edit/Write), re-runs ## Verification
   │
   ▼
the normal binary gate + rubric judge + score gate
   ├─ rubric fail → re-loop (fresh review fan-out + fixes), up to finalReviewMaxAttempts
   ▼ pass
done
```

**Why this exact shape** — it's dictated by what a **Workflow agent** can do (verified empirically): it has `Skill` + `Bash` (the external CLI is reachable) but **no `Agent` tool**, so a single agent can't fan out reviewers itself, and fan-out skills like `/simplify` and Claude's own `/code-review` can't run inside it. The orchestrator sidesteps both: it issues one `agent()` **per lens** via `parallel()`, recovering the cross-vendor external review + `/simplify` multi-agent power at the orchestrator level. **The external engine (codex/opencode) owns bugs** (where a non-Claude vendor catches what an all-Claude pipeline can't); **the four Claude lenses own quality** (they are exactly `/simplify`'s reuse / simplification / efficiency / altitude axes, one agent each). Splitting reviewers (record-only) from the fixer (edits) keeps the fixer **≠** the judge, so the dev≠judge anti-bias split still holds. If the external CLI is unreachable its reviewer writes its `<ENGINE> UNREACHABLE` token instead of findings, so the fixer flags it and the gate fails the task rather than rubber-stamping an un-reviewed deliverable.

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
| **Final review — /simplify lenses** | Opus × 4 (parallel) | reuse / simplification / efficiency / altitude. These must genuinely *understand* the code to judge quality, so they get the strongest model. They only *record* findings; they don't edit. |
| **Final review — fixer** | Opus | Reads every lens's findings and applies them; highest-stakes holistic gate (integration, consistency, regressions, met the PLAN goal). Capped at `finalReviewMaxAttempts` (default 2). |

## Grounding the score (do not skip)

The **correctness** dimension must be grounded in **real verification**, not the judge's vibe. The binary gate agent actually runs the task's `## Verification` commands and `## Acceptance criteria`; its pass/fail and raw output are handed to the rubric judge, which scores correctness against *that evidence*. A judge scoring correctness high while the binary gate failed is a contradiction the orchestrator rejects (the binary gate must pass before the judge even runs).

## Escalation — park & continue, then resume

When a task exhausts its cap (`maxAttempts`, or `finalReviewMaxAttempts` for the Final review):

1. The orchestrator **parks** it (records an escalation; the dev agent sets its `Status: blocked` so the parked state is visible) and **keeps flying** the other independent tasks. Dependents of a parked task simply never become ready, so they wait.
2. When the workflow returns, it hands back `{ slug, completed: [...], escalations: [{ task, attempt, reason }] }`. The `reason` string already embeds the last verdict — the judge's rationale, or the binary gate's output, or the scout error.
3. **You** (the main agent) surface the escalations to the user. In an active cockpit session, hand the stick back via `needs_your_call` + `cockpit wait`; otherwise use `AskUserQuestion`. Show the task and its `reason`.
4. After the user unblocks it (a decision, a spec fix, a manual nudge), **resume**: reset the parked task's `Status` to `todo` and re-run autopilot. The wave loop picks up where it left off — completed tasks stay `done`, so `next-ready` only re-offers the unblocked work.

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

- `next-ready.ts <tasks-dir> [--json]` — the per-wave ready-set scout. `--json` emits `[{ref,finalReview}]` (or `[]` when none ready); the scout echoes it verbatim so an empty set can't be misread as "everything is ready".
- `score-task.ts <task> <scores.json> [--log <file>] [--attempt N] [--agent <label>]` — `scoreTask(rubric, scores)` exported; the inline orchestrator gate mirrors it. `--log` persists the verdict to the flightlog.
- `mark-done.ts <task>` — the done-transition: sets `Status: done` and ticks every `## Acceptance criteria` / `## Verification` checkbox. Run when a task passes the gate.
- `flightlog.ts log|report` — narrative entries + `RUNLOG.md`.
- `lint-task.ts <tasks-dir>` — run during scout if `next-ready` reports a malformed tree.
- `codex-run.ts <delegate|review> [--prompt-file <path>]` — thin wrapper over the `codex` CLI used by the codex dev engine + the codex review lens. `delegate` runs `codex exec -s workspace-write` and appends a `git status --short`; `review` runs `codex exec -s read-only`. Captures codex's clean last message, prints it, and deletes its own scratch (no temp left to mine). Exits non-zero with a `CODEX UNREACHABLE` stderr line when the CLI is missing/fails. Prompt from `--prompt-file` or stdin.
- `opencode-run.ts <delegate|review> [--prompt-file <path>] [--model <m>]` — the opencode counterpart of `codex-run.ts`, used when `devEngine`/`reviewEngine` is `'opencode'`. `delegate` runs `opencode run -m <model> --format json` (write-capable) and appends a `git status --short`; `review` prepends a hard read-only guard (opencode has no sandbox read-only). Parses the JSONL `text` parts, prints the clean answer, exits non-zero with an `OPENCODE UNREACHABLE` stderr line when the CLI is missing/fails. Model: `--model` > `OPENCODE_MODEL` env > per-mode default (delegate `opencode-go/kimi-k2.7-code`, review `opencode-go/qwen3.7-max`). Prompt from `--prompt-file` or stdin.

## Additional resources

- `references/orchestrator.md` — the canonical Workflow script (wave loop, per-task retry pipeline, inline score gate, agent prompts + schemas). Adapt this; don't write one from scratch.

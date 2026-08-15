---
name: autopilot
version: 0.5.0
description: >-
  Execute a flightplan task tree end-to-end with a multi-agent dev → review →
  score quality loop.
when_to_use: >-
  When a docs/<slug>/tasks/ flightplan tree exists and should be executed
  ("/autopilot", "fly the plan", "work through the tasks"). Do NOT trigger
  when no flightplan exists on disk yet (use flightplan first), or for a
  single task done by hand.
argument-hint: "<slug|path>"
---

# Autopilot

## Why this skill exists

`flightplan` writes the blueprint. `autopilot` flies it.

`autopilot` walks a `docs/<slug>/tasks/` tree, executing each task with a dev→review→score loop gated on that task's own machine-parseable `## Eval rubric`, and finishing on the one `Final review` task as the holistic closing gate. The output is working, reviewed code, plus an audit trail (`RUNLOG.md`) of every verdict.

It is the third skill in the arc:

```
preflight  → lightweight in-conversation spec
flightplan → multi-file blueprint to disk (PLAN.md + tasks/)
autopilot  → execute the tree with a quality loop   ← you are here
```

## How orchestration works (read this before running)

Autopilot uses the **Workflow tool**. A skill whose instructions tell the agent to call Workflow is a *sanctioned opt-in*. Invoking `/autopilot` lets you call Workflow directly, **without the user typing "workflow"**.

> **Under OpenCode**: there is no Workflow tool. Skip the rest of this section and read `#### Under OpenCode` at the end of it instead.

Use the **hybrid shape**. Scout inline first to discover the work-list. Then hand the fan-out to a Workflow script.

Three hard constraints shape the design. Internalize them:

1. **The Workflow orchestrator script has no filesystem access.** It also **cannot `import`** our scripts. Anything that reads or writes disk — running `next-ready.ts`, editing a task's `Status`, appending to the flightlog — must run inside a tool-capable **agent** in the workflow. The orchestrator JS must never do this work.
2. **There is exactly one scoring implementation.** The rubric judge runs `score-task.ts --json --log`. The orchestrator gates on that printed verdict object. Do not duplicate the weighted-average or hard-fail arithmetic in the Workflow script.
3. **The orchestrator can't pause for input.** On a task that can't pass, it parks the task and keeps going. Escalation to the user happens *after* the workflow returns. See Escalation below.

#### Under OpenCode

**Two different things share the name "OpenCode" in this skill. This section is only the first one.** Running autopilot **under** the OpenCode harness — the OpenCode agent is the one invoking `/autopilot` — is what this section documents. Delegating **out to** the `opencode` CLI (`CFG.devEngine: 'opencode'`, `CFG.reviewEngine: 'opencode'`, `opencode-run.ts`, Step 2 and the Model policy table) is a Claude Code flight that shells out to an external engine. This section changes none of that, and none of that applies here.

OpenCode exposes no Workflow tool and no equivalent (runtime fact **S10**: the primary agent's full tool list is `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write`; `task` is the only spawn mechanism). Autopilot therefore runs there as a **hand-driven wave loop over the task tool**.

**Read this before the steps.** The loop below is behaviorally close to the Claude Code flight but **not identical**: there is **no automatic parallel-wave scheduling** and **no orchestrator process**. The waves are driven **by hand, one at a time, by whoever invoked the skill**, who must stay at the keyboard between waves. Autopilot under OpenCode is not the same unattended flight — do not report it to the user as one.

**Script root.** OpenCode prints no *"Base directory for this skill"* banner (runtime fact **S16** — invoking a skill returns `# Skill: <name>` followed by the SKILL.md body and nothing else), so the paths are stated literally rather than read from a banner. Skills install at `~/.config/opencode/skills/<name>/`, symlinked by `opencode/install.ts`:

- `$SCRIPTS` = `~/.config/opencode/skills/flightplan/scripts` — the shared tools autopilot borrows: `next-ready.ts`, `lint-task.ts`, `score-task.ts`, `mark-done.ts`, `flightlog.ts`.
- `$OWN` = `~/.config/opencode/skills/autopilot/scripts` — autopilot's own, `flightdeck.ts`.

`CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it, for either path.

The sibling-relative form `<base>/../flightplan/scripts` survives this install layout too: each skill is symlinked separately into the OpenCode skills root, so `<base>/../flightplan/scripts` resolves to the flightplan skill either way — through the symlink root, where both siblings are installed side by side, or through the realpath, where both siblings live beside each other in the repo.

**The wave loop.** Repeat these steps by hand, one wave at a time:

1. Run the ready-task lister `bun $SCRIPTS/next-ready.ts <tasks-dir> --summary` against the tasks directory to get the current wave. Re-run it every wave — a static list misses tasks unblocked mid-flight.
2. For each ready task in the wave, spawn a subagent through the **task tool** in the **dev role**, giving it the task file path and the instruction to implement that task.
3. Run that task's own `## Verification` commands yourself, and check its `## Acceptance criteria`.
4. Spawn a second subagent through the **task tool** in the **judge role**, to score the task against its `## Eval rubric`.
5. Run `bun $SCRIPTS/score-task.ts <taskfile> <scores.json> --json --log <run.jsonl> --attempt N --agent <label>` and gate on the printed verdict object. Do not re-derive the weighted average or the hard-fail arithmetic by hand — there is exactly one scoring implementation.
6. Retry the task until its rubric passes or the attempt cap is reached. Park a capped task at `Status: blocked` and escalate it to the user; never silently skip it.
7. Make one atomic commit **between** waves, never inside one — the tasks of a wave share a working tree, so a mid-wave commit sweeps a sibling's half-finished edits into it.
8. Run the closing `Final review` task last, after every other task is done.

**Both spawns use `subagent_type: general`**, with the dev and judge roles carried entirely by the inline prompt (runtime fact **S17**: `opencode agent list` reports `explore` and `general` as the built-in subagents). There is no `dev` agent and no `judge` agent in this build, and none is needed — both roles are leaves that never spawn anything themselves.

**`general` has no `task` tool and cannot spawn further**, at any `subagent_depth` (also **S17** — raising the depth does not grant it). That is harmless for the dev and judge roles, but it means the wave loop's driver must stay the one doing the spawning. There is no way to delegate the loop itself to a `general` subagent.

**Spawn depth.** Because the loop spawns through the task tool, the driver needs `subagent_depth` at or above the installed value of `2` in `~/.config/opencode/opencode.json`; a fresh install defaults to `1` (runtime fact **S14**), which `opencode/install.ts --apply` raises. Below the required depth a spawn fails with no error naming the config, so it reads as a plugin bug. This is the OpenCode counterpart of Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`.

## Step 1 — Scout inline

Before touching Workflow, gather the work-list in the main conversation:

1. **Resolve both scripts paths once**, from the skill's load-time *"Base directory for this skill"* banner: `<base>/../flightplan/scripts` is `$SCRIPTS` (the shared tools autopilot borrows), `<base>/scripts` is `$OWN`. Both must be absolute. `CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash — never use it for either path. `$SCRIPTS` is also what you bake into `CFG.scriptsDir` in Step 3.
2. Resolve the plan dir **as an absolute path**. The user names a slug or a path; the tree lives at `docs/<slug>/tasks/`. Capture the real repo root with `git rev-parse --show-toplevel`, and build `tasksDir`, `planPath`, and `logFile` from it (`<root>/docs/<slug>/...`). Bake them into `CFG` in Step 3. These paths MUST be absolute — Workflow agents share no cwd. See "Why every path is absolute" in `references/orchestrator.md`.
3. Read `docs/<slug>/PLAN.md` for the goal and the bucketing. Final review scores against "did we meet the PLAN goal", so the orchestrator needs that goal in hand as `CFG.planGoal`.
4. Confirm there is ready work, and read the whole-tree shape at the same time:
   ```bash
   bun $SCRIPTS/next-ready.ts docs/<slug>/tasks --summary
   ```
   A non-zero exit means the tree is malformed — the printed `invalid` array names each offending task and why; run `lint-task.ts` and fix it before flying. If `counts.done === counts.total`, the tree is already done — report that and stop before Step 2. If `ready` is empty while tasks remain unfinished, reset any stale `in-progress` task to `todo` first.
5. **Lint the whole tree before flying:**
   ```bash
   bun $SCRIPTS/lint-task.ts docs/<slug>/tasks
   ```
   The in-flight lint at `orchestrator.md` step 6 only ever sees one task file, and the flightplan Edit/Write hook only ran on files written in this repo — neither reaches a plan authored by an older flightplan or by hand. Run it here so a defect fails in the conversation instead of parking a correct task three attempts later.

   **`scope-git-status` is the one to expect on an older plan.** Flightplan used to recommend a whole-tree `git status` gate, and that gate fails a correct task the moment a sibling in the same wave leaves its own legitimate edits uncommitted. Fix it in the task file — narrow the command with a `--` pathspec listing that task's own files — before flying. Do not fly a tree with violations outstanding.
6. **Capture the base ref** for the Final review diff scope:
   ```bash
   git rev-parse HEAD
   ```
   Bake this as `CFG.baseRef`. The Final review lenses read `git diff <baseRef>..HEAD`, because the working-tree diff is empty after inter-wave commits.
7. Decide `maxAttempts` (default **3**, per task) and `finalReviewMaxAttempts` (default **2**, the Final review round). Confirm the rest of the model policy only if the user wants to change it.
8. Version-check whichever external CLIs Step 2 will offer — an external dev engine and the closing review round both shell out to them:
   ```bash
   codex --version      # needed if devEngine or reviewEngine is 'codex'
   opencode --version   # needed if devEngine or reviewEngine is 'opencode'
   ```
   If a selected engine is not installed, tell the user before flying. Only that engine's step needs it; the per-task Claude work still runs.
9. Probe whether live panes are available: `HERDR_ENV=1` **and** relay's `relay.ts` resolves. Probe on every flight, not only an external-dev one — the closing review lens can run live even when Claude writes every task. Resolve `relay.ts` as relay's own live locator does: the repo-sibling path first, then the newest relay version's `skills/relay/scripts/relay.ts` under `~/.claude/plugins/cache` or `~/.codex/plugins/cache`. Capture the absolute path as `CFG.relayPath`, or `''` when it is not found.

## Step 2 — Confirm the flight with the user

**Ask the user three things: which dev engine, which cross-vendor reviewer, and which final-review lens model — plus a fourth, live panes, when the env allows it.** Do not silently default. These are **independent** choices. Use `AskUserQuestion`:

- **Dev engine** (`CFG.devEngine`) — **Claude** (default; Sonnet writes, Opus on the last attempt), **Codex** (`'codex'` — the OpenAI codex CLI writes each task via `codex-run.ts`), or **OpenCode** (`'opencode'` — the opencode CLI writes each task via `opencode-run.ts`). With Codex or OpenCode, the dev step is a cheap Haiku driver, and Claude still judges. This gives a cross-vendor dev≠judge split.
- **Cross-vendor reviewer** (`CFG.reviewEngine`) — **Codex** (default) or **OpenCode** — the external bug/correctness lens in the closing Final review.
- **Final-review lens model** (`CFG.reviewLensModel`) — **Opus** (default) or **Fable 5** (`'fable'`) — the model for the three Claude quality lenses (reuse / leanness / efficiency) in the closing Final review. This choice affects **only** those three lenses. The fixer and rubric judge stay Opus regardless. **Fable 5 is Anthropic's most capable model and is priced above Opus** ($10/$50 per MTok vs Opus's $5/$25) — pick it for maximum lens quality on a hard review, not to save cost. Never describe it to the user as the cheaper option.
- **Live panes** (`CFG.liveDevEngine`, `CFG.liveReviewEngine`) — only when `HERDR_ENV=1` + `relay.ts` resolved, ask this fourth question, `multiSelect`: which steps run in a visible herdr live pane via relay, defaulting to neither (headless). Offer the **dev delegate** option only when the chosen dev engine is external — a Claude dev step has no delegate to make live. Always offer the **closing cross-vendor review** option; the review lens is external on every flight. Each picked step sets its own flag.

The picks set `CFG.devEngine`, `CFG.reviewEngine`, `CFG.reviewLensModel`, `CFG.liveDevEngine`, and `CFG.liveReviewEngine` in Step 3. Whichever external engines get chosen, their `--version` check from Step 1 becomes load-bearing. If a picked engine is unreachable, say so before flying. Offer to fall back: Claude for the dev engine, the other CLI for the reviewer.

When the user picks live, leave `CFG.liveCollectRounds` at its default `3`, and lower it only when a fast fail matters more than finishing a slow task. Both live steps pass `--dangerous`; `references/orchestrator.md` carries the reasoning for that and for the collect rounds.

If the live-pane env is not fulfilled, do not ask the fourth question. Set `CFG.liveDevEngine = false`, `CFG.liveReviewEngine = false`, and `CFG.relayPath = ''`. The same fallback applies when the user is not in herdr, when `relay.ts` did not resolve, or when the user picks neither step. In every one of these cases, the headless wrapper path is exactly today's behavior. The three Claude quality lenses always stay headless — they are Claude agents, with no external CLI to put in a pane.

Then show the user a one-screen brief. State the slug and how many tasks there are. State the chosen dev engine, cross-vendor reviewer, and final-review lens model. State the two caps (`maxAttempts` and `finalReviewMaxAttempts`) and the model policy. State that capped tasks will be parked and escalated, not silently skipped. State that Final review ends with the chosen external CLI review. This step **sends the branch diff to an external service** — OpenAI for codex, the configured opencode provider for opencode.

This is real compute, real edits, and an external code review. Get an explicit go from the user before calling Workflow.

## Launch flightdeck after confirmation

After the user confirms the flight, launch flightdeck once:

```bash
bun "$OWN"/flightdeck.ts --plan "<the absolute plan dir resolved during scout>"
```

Pass the plan directory, not the tasks directory. The daemon expects the parent and reads the tasks tree and flightlog beneath it.

The command spawns the server detached, waits for readiness itself, prints the URL, and exits — add no wait, poll, or health check around it. Tell the user the URL so they can reopen flightdeck later.

If the command exits non-zero, note that the monitor is unavailable and fly anyway. A broken monitor must never block a run.

## Step 3 — Call Workflow with the wave-loop orchestrator

Adapt `references/orchestrator.md`; it is the canonical script. **Copy its `CFG` block field-for-field** — that block is the authoritative field list — and replace each placeholder with the value you scouted, as a literal. Do not rely on the Workflow `args` global. Every path field must be absolute. Keep any field you did not scout at the default the block already carries.

Then call `Workflow({ script: <the adapted script> })`. No `args` needed.

**`CFG.devEngine` and `CFG.reviewEngine` are independent axes.** `devEngine` controls who writes non-final tasks. `reviewEngine` controls the external bug/correctness lens in the closing Final review. The full external-engine behavior, the opencode model fields, and failure handling live in `references/orchestrator.md`.

The orchestrator runs a **wave loop**. Each wave asks an agent to run `next-ready.ts --summary`, then executes the wave's ready tasks **in parallel**. Status changes only happen *inside* the run, so the snapshot must be re-scouted every wave — a static list misses tasks unblocked mid-flight. Each task is a retry pipeline:

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
done → mark-done.ts: Status: done + tick ## Acceptance criteria / ## Verification boxes
   │      in ONE transition, then reread and confirm a bare `Status: done`
   ├─ not confirmed → infrastructure failure: park + escalate (never retried)
   ▼ confirmed
completed   (next wave's next-ready will see it)

[between waves, wave > 1] atomic-commit (inline git) ─ commits the completed wave
[post-loop]              final atomic-commit ─ commits Final review's changes
```

### Scout result and termination rules

The scout runs `next-ready.ts --summary` and echoes its `{ready, counts, unfinished, invalid, errors}` snapshot verbatim; the script does every interpretation. **`references/orchestrator.md` owns the nine terminal conditions and their guards** — do not restate or re-derive them here.

The `Final review` task (`> **Final review**: true`) depends transitively on every other task, so the wave loop **naturally schedules it last** — no special phase is needed. Its dev step is **not** a Claude self-review but the multi-lens fan-out below; the binary gate, rubric judge, and score gate are unchanged, grading that round against the Final review task's own `## Eval rubric`.

### The closing multi-lens review round

The Final review's "dev" step fans out independent record-only reviewers. Then a single Opus fixer applies the real fixes and re-runs verification:

- `<reviewEngine>`: codex/opencode CLI bug and correctness review.
- `reuse`: duplicated logic, missed existing helpers, copy-paste that wants one. On the abstraction axis, the only lens that may ask for more code — `leanness` is its counterweight.
- `leanness`: over-engineering only — what to delete. Tags each finding `delete:` / `stdlib:` / `native:` / `yagni:` / `shrink:` on one line, and closes with `net: -N lines possible.`
- `efficiency`: redundant work, N+1s, recomputation, avoidable allocation/IO.

The fan-out happens at the orchestrator level. See `references/orchestrator.md` for the full rationale, failure handling, and exact prompts.

## Step 4 — Report

After the workflow returns:

1. Run the flightlog report to render the audit trail. (`$SCRIPTS` is the path you resolved in Step 1.)
   ```bash
   bun $SCRIPTS/flightlog.ts report docs/<slug>/.flightlog/run.jsonl
   ```
   This writes `docs/<slug>/.flightlog/RUNLOG.md`: every attempt and verdict, each linked to its agent label for drill-down.
2. Tell the user: tasks completed, tasks escalated and why, and where `RUNLOG.md` lives. If everything passed, including Final review, say so plainly and point at what to verify or ship.

The rest of this document is reference material.

## Model policy

This policy is encoded as a constant table at the top of the orchestrator, so it stays tunable in one place. The dev≠judge split is deliberate: a model that judges its own output is biased toward passing.

| Role | Model | Why |
|---|---|---|
| **Dev** | Sonnet → **Opus on the last attempt** | A model that failed N times rarely clears it by retrying as itself, so the last shot gets the stronger model before we bother the user. |
| **Dev — external engine** (`CFG.devEngine: 'codex'`/`'opencode'`) | Haiku driver → **Opus on the last attempt** | The coding intelligence is the external CLI's, so the driver only has to invoke `<engine>-run.ts delegate` and verify. |
| **Binary gate (Acceptance / Verification)** | Haiku | Its job is mechanical — re-run the `## Verification` commands and report pass/fail + raw output — and it runs first so Opus never scores code that doesn't build. |
| **Rubric judge** | Opus | It decides loop-or-pass, and a weak judge either ships bad code or loops forever. |
| **Commit (inter-wave + post-loop)** | Haiku | A wave's changes are usually one coherent set, so grouping + message-writing over the inlined `COMMIT_INSTRUCTIONS` is within Haiku's reach. |
| **Final review — cross-vendor lens** (`CFG.reviewEngine`) | Haiku | The review intelligence lives in the external CLI, so the agent only invokes `<engine>-run.ts review` and records its output. |
| **Final review — quality lenses** (`CFG.reviewLensModel`) | Opus × 3 (parallel), default — or **Fable 5** (`'fable'`) | reuse / leanness / efficiency must genuinely *understand* the code to judge quality, so they get a strong model; they record findings and never edit. See Step 2 before offering Fable 5. |
| **Final review — fixer** | Opus | It is the highest-stakes holistic gate — integration, consistency, regressions, met the PLAN goal — capped at `finalReviewMaxAttempts`. |

## Grounding the score (do not skip)

The **correctness** dimension must be grounded in **real verification**, not the judge's vibe. The binary gate agent actually runs the task's `## Verification` commands and checks its `## Acceptance criteria`; its pass/fail result and raw output go to the rubric judge, which scores correctness against *that evidence*. The gate must pass before the judge runs at all, so a high correctness score can never sit on top of a failed verification.

## Escalation — park & continue, then resume

A task escalates for one of two reasons: it exhausted its cap (`maxAttempts`, or `finalReviewMaxAttempts` for the Final review), or an infrastructure failure stopped it from being judged at all. Either way:

1. The orchestrator **parks** the task at `Status: blocked`, records an escalation, and **keeps flying** the other independent tasks. Dependents of a parked task never become ready, so they wait.
2. The workflow returns `{ slug, completed: [...], escalations: [{ task, attempt, infrastructure, parked, reason }] }`. The `reason` already embeds the last verdict — the judge's rationale, the binary gate's output, the infrastructure cause, or the scout error.
3. **You** (the main agent) surface each escalation with its `reason`. In an active cockpit session, hand the stick back via `needs_your_call` + `cockpit wait`; otherwise use `AskUserQuestion`.
4. After the user unblocks a task, **resume**: reset its `Status` to `todo` and re-run autopilot. Completed tasks stay `done`, so `next-ready` only re-offers the unblocked work.

**Read the two flags before you report.** `infrastructure: true` means nothing was judged — say that verification did not run or returned no verdict, not that the work was rejected. `parked: false` means the park itself failed, so the file still reads `in-progress` and `next-ready` will not re-offer it; tell the user to reset that Status by hand before resuming.

**A `(divergence)` escalation is not a park.** It means a task passed, was confirmed `done`, and then something rewrote its file back to unfinished — a parallel task running `git checkout`/`git restore`, or a hand edit. Do not just reset and re-run: find what rolled the file back first, or the next run loses the same work again. The `reason` names the affected refs, and their code changes are often already committed, so check that before deciding whether to restore each `Status` to `done` or reset it to `todo`.

Crash recovery note: an interrupted run can leave task files at `Status: in-progress`. `next-ready` only offers `todo`. Reset stale `in-progress` tasks to `todo` before re-running autopilot.

How the orchestrator decides to park — the quality-vs-infrastructure split, the reread that confirms each status transition, and the guards around a schema'd `agent()` — lives in `references/orchestrator.md`.

## The flightlog (audit trail)

Everything lands in `docs/<slug>/.flightlog/`. It is **gitignored** via a self-ignore (`.flightlog/.gitignore` containing `*`). This directory is created automatically on first write; no user setup is needed.

- **Score verdicts** — the rubric-judge agent runs `score-task.ts <taskfile> <scores.json> --log docs/<slug>/.flightlog/run.jsonl --attempt N --agent <its-label>`. Deterministic, guaranteed each cycle.
- **Narrative** — Dev / judge / final-review agents run `flightlog.ts log <run.jsonl> --task <ref> --role <role> --attempt N --agent <label> --message "..."` to record what they did.
- **Review findings** — the Final review lenses write their raw findings to `.flightlog/review/attempt-N/<lens>.md` (`<reviewEngine>` / reuse / leanness / efficiency). These persist as the artifact behind each closing-round verdict.
- **Report** — `flightlog.ts report <run.jsonl>` renders `RUNLOG.md`, grouped by task in chronological order.

Each entry records an `agentLabel` so a suspicious verdict can be traced back to that agent's raw `agent-<id>.jsonl` in the harness transcript.

## Bundled scripts

You run three of them yourself, all in the sibling `skills/flightplan/scripts/` directory (`$SCRIPTS`):

- `next-ready.ts <tasks-dir> [--json | --summary]` — the scout of Step 1 and of every wave. **`--summary` is what the orchestrator uses**: one `{ready, counts, unfinished, invalid, errors}` object, printed even when the command exits 1, so a malformed tree still names its refs. It exits non-zero rather than return a ready set that would unlock work behind a fake `done`.
- `lint-task.ts <tasks-dir | task-file>` — run it during scout when `next-ready` reports a malformed tree, and fix the tree before flying.
- `flightlog.ts report <run.jsonl>` — Step 4's audit render. `flightlog.ts log` is the in-run narrative entry point.

Plus `bun "$OWN"/flightdeck.ts` for the monitor — the one file the launch step runs from autopilot's own `scripts/` directory, whose other modules are flightdeck's server, launcher, and pure derivations, each with a `.test.ts` beside it.

The remaining shared tools — `score-task.ts`, `mark-done.ts`, `codex-run.ts`, `opencode-run.ts` — are called only from inside the workflow. `references/orchestrator.md` carries their signatures and contracts.

## Additional resources

- `references/orchestrator.md` — the canonical Workflow script (wave loop, per-task retry pipeline, inline score gate, agent prompts and schemas). Adapt this. Do not write one from scratch.

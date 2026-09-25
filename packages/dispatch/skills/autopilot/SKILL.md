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
argument-hint: "<slug|path> [--task <ref> --from dev|verify|judge] [--attest <file>]"
---

# Autopilot

## Why this skill exists

`flightplan` writes the blueprint. `autopilot` flies it.

`autopilot` walks a `docs/<slug>/tasks/` tree, executing each task with a dev→review→score loop gated on that task's own machine-parseable `## Eval rubric`, and finishing on the one `Final review` task as the holistic closing gate. The output is working, reviewed code, plus an audit trail (`RUNLOG.md`) of every verdict.

It is the last rung of the ladder:

```
preflight  → what you want, no solution            (INTENT.md)
hop        → interview, plan, execute now           (in conversation)
flightplan → multi-file blueprint to disk (PLAN.md + tasks/)
autopilot  → execute the tree with a quality loop   ← you are here
```

## How orchestration works (read this before running)

Autopilot uses the **Workflow tool**. A skill whose instructions tell the agent to call Workflow is a *sanctioned opt-in*. Invoking `/autopilot` lets you call Workflow directly, **without the user typing "workflow"**.

> **OpenCode only**: there is no Workflow tool. Skip the rest of this section and follow `~/.config/opencode/skills/autopilot/references/opencode.md` instead — a hand-driven wave loop over the task tool. The path is absolute because OpenCode prints no skill base-directory banner.

Use the **hybrid shape**. Scout inline first to discover the work-list. Then hand the fan-out to a Workflow script.

Three hard constraints shape the design. Internalize them:

1. **The Workflow orchestrator script has no filesystem access.** It also **cannot `import`** our scripts. Anything that reads or writes disk — running `next-ready.ts`, editing a task's `Status`, appending to the flightlog — must run inside a tool-capable **agent** in the workflow. The orchestrator JS must never do this work.
2. **There is exactly one scoring implementation.** The rubric judge runs `score-task.ts --json --log`. The orchestrator gates on that printed verdict object. Do not duplicate the weighted-average or hard-fail arithmetic in the Workflow script.
3. **The orchestrator can't pause for input.** On a task that can't pass, it parks the task and keeps going. Escalation to the user happens *after* the workflow returns. See Escalation below.

## Resume one task at a chosen step (`--task <ref> --from <step>`)

When the user names a task and a step, **do not run the flight above**. Run a single-task resume instead: one pipeline, no scout, no wave loop.

```
/autopilot <slug> --task review/01 --from verify --attest docs/<slug>/.flightlog/attested.md
```

For a task parked with its expensive work already correct in the kept worktree, use `--from` to resume below the completed steps. For Final review, use the main tree instead. When only verification remains after the four lenses and fixer, resume at the Opus/low binary gate to avoid repeating that round.

`--from` takes `dev`, `verify`, or `judge`. Everything before that step is taken as already satisfied, **on the resumed attempt only** — if that attempt fails its gate, the next one runs the whole pipeline, because a red verify means the skipped work genuinely does need redoing.

**Derive the step and the attempt from the trail; do not ask the user to remember them.** The flightlog records every role's start and end plus each attempt's verdict, so where the run stopped is on disk:

```bash
bun $SCRIPTS/flightlog.ts progress docs/<slug>/.flightlog/run.jsonl --task <ref>
```

It prints `resume --from <step> --attempt <n>` with the evidence that chose it. Use those values unless the user names their own. Run it with no `--task` to see every task's resume point at once, which is how you pick the ref when the user says only "resume".

Two rules govern what it will and will not suggest, and both are deliberate:

- **It never suggests `judge`.** Skipping the binary gate means a person performed it and signed for it — a human decision no trail can make. And the judge grounds correctness in the verifier's *raw* evidence, which lives only in the orchestrator's memory and dies with the run; the trail keeps the verifier's one-line message, not its output. So `verify` is the earliest point the trail can honestly support.
- **It restarts at `dev` when a gate or judge rejected the work.** That is not the run dying — it is a verdict on real code, and restarting above it would take rejected work as satisfied. The output says so on a `note` line. Only a person who has since satisfied the failing items may override, with `--from verify --attest <file>`.

Then scout what a single task needs and bake it into `CFG`:

1. Resolve `$SCRIPTS` and `$OWN` exactly as Step 1 does, and the repo root with `git rev-parse --show-toplevel`.
2. Resolve the task file itself — `<root>/docs/<slug>/tasks/<bucket>/<NN>-*.md` — as an absolute path, into `CFG.resumeTaskPath`. There is no scout to derive it, so the orchestrator throws on an empty one rather than letting an agent read a file that is not there.
3. Read that file's header. Set `CFG.resumeFinalReview` from its `> **Final review**:` line.
4. Read the task's `> **Models**:` line and write its value as the string `CFG.resumeModelsRaw`, or `null` when the line is absent.
5. Set `CFG.resumeAttempt` to the `--attempt` the progress command printed. The numbering must keep rising: `score-task.ts --log` keys its verdict rows on ref plus attempt, and `fleet.ts` keeps the first row for a key, so reusing a number leaves the trail contradicting the run.
6. Set `CFG.resumeTask` to the ref and `CFG.resumeFrom` to the step. Leave every other field as a normal flight would have it — `baseRef`, `planGoal`, and the engine picks all still apply, because a failed resumed attempt runs the full round.
7. Launch flightdeck as usual, and report as Step 4 does.

**Carrying what a person checked.** `--attest <file>` sets `CFG.attestationFile` to an absolute path. Write the file first, or point at one the user already wrote. It must name **which gate items** a person performed, quoting each item as the task file writes it, plus when. The verifier reads it, treats only the items it names as satisfied, and rejects any entry that is not an item of that task. It is not a blanket pass: every unnamed item is still run, and a red command still fails the attempt however the attestation is worded.

`--from judge` **requires** `--attest`. It skips the binary gate entirely, so a person performed that gate and has to sign for it — without the file the judge would score correctness against no evidence at all, and the orchestrator throws at script start rather than let that run.

## Step 1 — Scout inline

Before touching Workflow, gather the work-list in the main conversation:

1. **Resolve both scripts paths once**, from the skill's load-time *"Base directory for this skill"* banner: `<base>/../flightplan/scripts` is `$SCRIPTS` (the shared tools autopilot borrows), `<base>/scripts` is `$OWN`. Both must be absolute. `CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash — never use it for either path. `$SCRIPTS` is also what you bake into `CFG.scriptsDir` in Step 3.
2. Resolve the plan dir **as an absolute path**. The user names a slug or a path; the tree lives at `docs/<slug>/tasks/`. Capture the real repo root with `git rev-parse --show-toplevel`, and build `tasksDir`, `planPath`, and `logFile` from it (`<root>/docs/<slug>/...`). Bake them into `CFG` in Step 3. These paths MUST be absolute — Workflow agents share no cwd. See "Why every path is absolute" in `references/orchestrator.md`.
   Set `CFG.repoRoot` to the absolute repo root already captured by `git rev-parse --show-toplevel`.
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

   **Act on a `[serial-undeclared]` advisory before flying.** Check PLAN.md and `_context/` for serial execution or lock requirements without a `> **Max parallel**:` header. Under Claude Code, lower **Max parallel** only when tasks share an **external live resource** that a worktree cannot isolate: a live device, a LaunchAgent or service that a verification reinstalls, or a local database that a migration rewrites. For that external live resource, set `> **Max parallel**: 1`. Under Claude Code, keep a shared build target uncapped because each task builds in its own worktree. When the plan will run under OpenCode, set `> **Max parallel**: 1` for a shared build target that compiles every file: the hand-driven loop still shares one working tree (see `autopilot/references/opencode.md`). When `Depends on` edges already sequence every conflict, write `unlimited` or omit the line. Read the header through the scout every wave.

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

**Ask in two `AskUserQuestion` calls.** The first carries three independent choices: dev engine, cross-vendor reviewer, final-review lens model. The second carries the ones that depend on those answers — the codex dev model, the codex review model, and live panes when the env allows — and is skipped entirely when none applies. Do not silently default.

The split is not cosmetic. Neither codex-model question is worth asking until the first call has said whether codex took that role at all, and the live-panes question offers a dev-delegate option only when the dev engine turned out external. Folding them into one call would ask every dependent question blind, and would also breach `AskUserQuestion`'s four-question cap.

- **Dev engine** (`CFG.devEngine`) — Choose **Claude** (default; Opus/medium, raised to Opus/high on the last Claude rung), **Codex** (`'codex'`, via `codex-run.ts`), or **OpenCode** (`'opencode'`, via `opencode-run.ts`). With Codex or OpenCode, use a Haiku driver for the external CLI. Keep the Claude judge in a separate call.
- **Cross-vendor reviewer** (`CFG.reviewEngine`) — **Codex** (default) or **OpenCode** — the external bug/correctness lens in the closing Final review.
- **Final-review lens model** (`CFG.reviewLensModel`) — **Opus** (default) or **Fable 5** (`'fable'`) — the model for the three Claude quality lenses (reuse / leanness / efficiency) in the closing Final review. This choice affects **only** those three lenses. Keep the fixer and rubric judge on their per-role model choices, including task header overrides. **Fable 5 is Anthropic's most capable model and is priced above Opus** ($10/$50 per MTok vs Opus's $5/$25) — pick it for maximum lens quality on a hard review, not to save cost. Never describe it to the user as the cheaper option.
- **Codex dev model** (`CFG.codexDevModel`) — **gpt-5.6-sol** (default) or **gpt-6-astra** — ask **only when the dev engine resolved to codex**. This is the model that writes each task.
- **Codex review model** (`CFG.codexReviewModel`) — **gpt-6-astra** (default) or **gpt-5.6-sol** — ask **only when the cross-vendor reviewer resolved to codex**, which is the default, so a default flight does get asked. This is the model that reviews the branch diff.

  The two defaults differ on purpose: the cheap model writes, the strong one reviews. That is the same dev≠reviewer asymmetry autopilot already builds across vendors, applied inside codex — a reviewer weaker than the author rubber-stamps its own blind spots. Leaving either field unset takes `codex-run.ts`'s matching default, so the fields exist to repin a single flight without the user retuning `~/.codex/config.toml`. Offering astra for dev costs real money at a higher rate; never present it as the cheaper pick.
- **Live panes** (`CFG.liveDevEngine`, `CFG.liveReviewEngine`) — only when `HERDR_ENV=1` + `relay.ts` resolved, ask this in the second call, `multiSelect`: which steps run in a visible herdr live pane via relay, defaulting to neither (headless). Offer the **dev delegate** option only when the chosen dev engine is external — a Claude dev step has no delegate to make live. Always offer the **closing cross-vendor review** option; the review lens is external on every flight. Each picked step sets its own flag.

The picks set `CFG.devEngine`, `CFG.reviewEngine`, `CFG.codexDevModel`, `CFG.codexReviewModel`, `CFG.reviewLensModel`, `CFG.liveDevEngine`, and `CFG.liveReviewEngine` in Step 3. Whichever external engines get chosen, their `--version` check from Step 1 becomes load-bearing. If a picked engine is unreachable, say so before flying. Offer to fall back: Claude for the dev engine, the other CLI for the reviewer.

When the user picks live, leave `CFG.liveCollectRounds` at its default `3`, and lower it only when a fast fail matters more than finishing a slow task. Both live steps pass `--dangerous`; `references/orchestrator.md` carries the reasoning for that and for the collect rounds.

If the live-pane env is not fulfilled, omit the live-panes question from the second call. Set `CFG.liveDevEngine = false`, `CFG.liveReviewEngine = false`, and `CFG.relayPath = ''`. The same fallback applies when the user is not in herdr, when `relay.ts` did not resolve, or when the user picks neither step. In every one of these cases, the headless wrapper path is exactly today's behavior. The three Claude quality lenses always stay headless — they are Claude agents, with no external CLI to put in a pane.

Then show the user a one-screen brief. State the slug and how many tasks there are. State that non-final tasks run in isolated worktrees at `<repo-parent>/.<repo-name>-autopilot/<slug>/<bucket>-<NN>`. State the per-role model map and any task whose `> **Models**:` header overrides it. State the chosen dev engine, cross-vendor reviewer, and final-review lens model. State each codex model whose role resolved to codex. State the two caps (`maxAttempts` and `finalReviewMaxAttempts`) and the model policy. State the plan's `Max parallel` when it is declared. State that capped tasks will be parked and escalated, not silently skipped. State that Final review ends with the chosen external CLI review. This step **sends the branch diff to an external service** — OpenAI for codex, the configured opencode provider for opencode.

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

Run the orchestrator's **wave loop** with a fresh `next-ready.ts --summary` scout every wave to discover tasks unblocked by Status changes. When PLAN.md declares `> **Max parallel**:`, execute ready tasks **in parallel** at most `maxParallel` at a time. Hold each `Max parallel` slot for the whole pipeline, including land and drift re-verify. Run each non-final task's whole pipeline (dev, verify, judge) in its own git worktree at `<repo-parent>/.<repo-name>-autopilot/<slug>/<bucket>-<NN>`. Run the Final review task (`> **Final review**: true`) in the main tree. For each non-final task, follow this retry pipeline:

```
create worktree
   │
   ▼
Dev (Opus/medium; Opus/high on the last Claude rung) ─ implements + edits Status, logs a note
   │
   ▼
Binary gate (Opus/low) ─ INDEPENDENTLY re-runs the task's ## Verification commands
   │                      + checks ## Acceptance criteria before scoring
   ├─ fail → loop back to Dev with the failure output
   ▼ pass
Rubric judge (Opus/medium) ─ scores each ## Eval rubric dimension, runs score-task --json --log
   │
   ▼
Score gate ─ consumes score-task.ts --json verdict
   ├─ fail → loop back to Dev with the judge's rationale
   ▼ pass
land (main-tree lock)
   ├─ conflict / failed drift re-verify → rebase worktree → next Dev attempt
   ├─ leak → abort run
   ▼ clean (drift re-verify passed when required)
done → mark-done.ts: Status: done + tick ## Acceptance criteria / ## Verification boxes
   │      in ONE transition, then reread and confirm a bare `Status: done`
   ├─ not confirmed → infrastructure failure: escalate, then remove worktree
   ▼ confirmed
remove worktree
   ├─ removal unconfirmed → completed + cleanupFailures
   ▼ removed
completed   (next wave's next-ready will see it)

[between waves, wave > 1] atomic-commit (inline git) ─ commits the completed wave
[post-loop]              final atomic-commit ─ commits Final review's changes
```

On a **clean** land, merge the result into the main tree. On a **conflict**, count the attempt as failed after rebasing the worktree with conflict markers. On **drift** because something else landed since the task started, re-run the task's Verification in the main tree as `reverify:<ref>#<attempt>`, whose failure undoes the land and rebases the worktree as a failed attempt that supersedes the judge's passing score. On a **leak** because the main tree changed outside a land, abort the run with every task stopped before its next slot, attempt, or land, no further commits or end sweep, and no changes reverted.

After a leak abort, report the leaked paths plus every worktree still in `live` and every still-blocked leftover kept by the start sweep. For a task whose land was clean before the abort, finish mark-done because its work is already in the main tree. Then run `remove` for that task. Preserve worktrees with unlanded work for inspection. Report unconfirmed removal separately as `cleanupFailures`.

Hold one main-tree lock around every `worktree.ts` call and drift re-verify, including the snapshot a new worktree starts from, so no worktree starts from a half-applied land and no two calls rewrite `state.json` at once.

Repeat a completed `worktree.ts` call safely with identical arguments: `land`, `unland`, and `rebase` take attempt-and-step `--op <id>` values (`a<attempt>-land`, `a<attempt>-unland`, `a<attempt>-rebase`), record their results under those ids, and return the recorded result on repetition. Route each `worktree.ts` call and `reverify` through a wrapper that throws on a `null` result, because `resilient(...)` retries only on a throw. After a second `null`, treat the missing result as an infrastructure failure for the task, or for the run when the call is a sweep or baseline. For a drift re-verify with no result after its retry, undo the land before parking with the worktree kept.

Write every source file under the task's worktree, with only three write exemptions: `flightlog.ts log` into the main-tree flightlog, the task file's Status line, and the judge's scratch files under `/tmp`.

### Scout result and termination rules

The scout runs `next-ready.ts --summary` and echoes its `{ready, counts, unfinished, invalid, errors}` snapshot verbatim; the script does every interpretation. **`references/orchestrator.md` owns the nine terminal conditions and their guards** — do not restate or re-derive them here.

The `Final review` task (`> **Final review**: true`) depends transitively on every other task, so the wave loop **naturally schedules it last** — no special phase is needed. Its dev step is **not** a Claude self-review but the multi-lens fan-out below; the binary gate, rubric judge, and score gate are unchanged, grading that round against the Final review task's own `## Eval rubric`.

### The closing multi-lens review round

For Final review's "dev" step, fan out independent record-only reviewers. Then use one fixer (default Opus/high, subject to the task's `fix` override) to apply fixes. Re-run verification after the fixes:

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
3. **Report `needsHuman` separately from `escalations`.** It lists `{ task, criteria }` for every `(human)` gate item that passed without a machine check and without an attestation. Those tasks are genuinely `done` — nothing is parked and nothing needs resetting — so print them as a closing checklist of what the user still owes, quoting each criterion. Say plainly that `mark-done.ts` ticked those boxes like any other, so the task file alone no longer shows the check is outstanding.

The rest of this document is reference material.

## Model policy

Tune the default choices in the orchestrator's `MODEL` table. Keep dev and judge in separate agent calls so scoring uses independent context.

| Role | Model / effort | Why |
|---|---|---|
| **Dev** | opus / medium | Implement the task with enough reasoning for normal attempts. |
| **Dev — last Claude rung** | Task's dev choice, effort +1 (default opus / high) | Raise reasoning effort after earlier attempts fail; keep max at max and omitted effort omitted. |
| **Dev — external driver** | haiku / no effort | Drive the external CLI that writes the implementation. |
| **Binary gate and drift re-verify** | opus / low | Check acceptance criteria and command output before scoring. |
| **Rubric judge** | opus / medium | Score the rubric against the gate's evidence. |
| **Commit (inter-wave + post-loop)** | opus / low | Group changes and write the commit message. |
| **Final review — cross-vendor lens** | haiku / no effort | Drive the external CLI that performs the review. |
| **Final review — quality lenses** | `CFG.reviewLensModel` (default opus) / no effort | Inspect reuse, leanness, and efficiency with independent context. |
| **Final review — fixer** | opus / high | Reconcile the findings and apply integration fixes. |
| **Scout / mark-done / park** | haiku / no effort | Run the fixed readiness or status transition command. |
| **Structured retry** | opus / medium | Recover a failed structured call with a complete model and effort choice. |

A task's `> **Models**:` header overrides dev, verify, judge, and fix for that task.

On the last Claude dev rung, raise the task's dev effort one step on the same model, leaving `max` at `max` and omitted effort omitted.

## Grounding the score (do not skip)

The **correctness** dimension must be grounded in **real verification**, not the judge's vibe. The binary gate agent actually runs the task's `## Verification` commands and checks its `## Acceptance criteria`; its pass/fail result and raw output go to the rubric judge, which scores correctness against *that evidence*. The gate must pass before the judge runs at all, so a high correctness score can never sit on top of a failed verification.

**Two carve-outs, both declared by a person, never decided by an agent.** A gate item tagged `(human)` in the task file is skipped by the verifier, reported as pending, and surfaced at the end of the run — the plan's author declared that no command can perform it, and `lint-task.ts` refuses a gate section whose items are *all* tagged, so the verifier always keeps real work. A `--from judge` resume replaces the verifier's evidence with a signed attestation file, and the judge is told to treat every item that file does not name as unverified. An agent may never widen either carve-out: a verifier that finds an item hard to run must let it fail, because an item nobody can check is a plan defect.

## Escalation — park & continue, then resume

A task escalates for one of two reasons: it exhausted its cap (`maxAttempts`, or `finalReviewMaxAttempts` for the Final review), or an infrastructure failure stopped it from being judged at all. Either way:

1. The orchestrator **parks** the task at `Status: blocked`, records an escalation, and **keeps flying** the other independent tasks. Dependents of a parked task never become ready, so they wait.
2. The workflow returns `{ slug, completed: [...], escalations: [{ task, attempt, infrastructure, parked, reason }] }`. The `reason` already embeds the last verdict — the judge's rationale, the binary gate's output, the infrastructure cause, or the scout error.
3. **You** (the main agent) surface each escalation with its `reason`. In an active cockpit session, hand the stick back via `needs_your_call` + `cockpit wait`; otherwise use `AskUserQuestion`.
4. After the user unblocks a task, **resume**. Run `flightlog.ts progress --task <ref>` first — it names which of these two the trail supports:
   - **Re-enter at a step** — When the work before that step is already correct in the kept worktree, use `--task <ref> --from verify|judge`. Leave `Status` at `blocked` for the resume to mark `done`. For Final review, resume in the main tree. See "Resume one task at a chosen step" above.
   - **Re-run the whole task** — reset its `Status` to `todo` and re-run autopilot. Completed tasks stay `done`, so `next-ready` only re-offers the unblocked work. Use this when what failed is the work itself.

For a parked non-final task, keep its unlanded work in its worktree outside the main tree. Include the kept worktree's path in the escalation's `reason`. To inspect or hand-fix the task, work inside that worktree. For `--task <ref> --from verify|judge`, look up the kept worktree. When it exists, run the resumed steps there. If the worktree is gone, halt with a message naming the missing path. At the start of a non-final resume, take a fresh main-tree baseline for the land's leak check. When a drift re-verify failed after a passing judge, resume from `dev` on the next attempt. For a resume from `dev`, look up the worktree first. When it exists, reuse it because it may hold unlanded work from a failed drift re-verify. Only when none exists, create a fresh worktree from the current main tree. In the run that finally passes the task, land its work. For Final review, resume in the main tree without a worktree lookup or resume baseline.

### Worktree cleanup

Apply these rules to the wave-loop run; for a single-task resume, run no sweeps.

1. At run start, sweep the slug's worktree root to remove this slug's leftovers from a previous run, except those whose task `Status` is `blocked`.
2. After each clean land and mark-done, remove that task's worktree.
3. At run end, sweep again while keeping every worktree still in the `live` map, including parked tasks, plus every worktree the start sweep kept whose task `Status` is still `blocked`. Keep a still-blocked task's worktree even when this run never touched it.
4. If a leak aborted the run, skip the end sweep to keep every worktree with unlanded work for inspection. For a task that landed cleanly before the abort, still remove its worktree.
5. On a clean end or abort, report every kept worktree path in the run result. Build the list from the orchestrator's `live` map, set on create or resume and cleared on remove, plus each `{ref, path}` the start sweep kept whose task `Status` is still `blocked`. Never read the kept list from the end sweep.
6. After a clean run, confirm that no worktree for the slug remains: `git worktree list` must show no path under `.<repo-name>-autopilot/<slug>/`.
7. For every sweep, touch only paths under the slug's worktree root, `<repo-parent>/.<repo-name>-autopilot/<slug>/`. Leave worktrees outside that root untouched.
8. If the first scout fails, list every worktree under the root without sweeping. If a later scout fails, skip the end sweep. After a scout failure, report the returned kept list without filtering it further.
9. When a landed task's worktree removal cannot be confirmed, report its path in `cleanupFailures` separately from the kept list so the user can delete it. Keep the task counted as completed. Treat the run as not clean.
10. To discard a kept worktree by hand, run `git worktree remove --force <path>`. Then run `git worktree prune`.

**Read the two flags before you report.** `infrastructure: true` means nothing was judged — say that verification did not run or returned no verdict, not that the work was rejected. `parked: false` means the park itself failed, so the file still reads `in-progress` and `next-ready` will not re-offer it; tell the user to reset that Status by hand before resuming.

**A `(divergence)` escalation is not a park.** It means a task passed, was confirmed `done`, and then something rewrote its file back to unfinished — a parallel task running `git checkout`/`git restore`, or a hand edit. Do not just reset and re-run: find what rolled the file back first, or the next run loses the same work again. The `reason` names the affected refs, and their code changes are often already committed, so check that before deciding whether to restore each `Status` to `done` or reset it to `todo`.

Crash recovery note: an interrupted run can leave task files at `Status: in-progress`. `next-ready` only offers `todo`. Reset stale `in-progress` tasks to `todo` before re-running autopilot.

How the orchestrator decides to park — the quality-vs-infrastructure split, the reread that confirms each status transition, and the guards around a schema'd `agent()` — lives in `references/orchestrator.md`.

## The flightlog (audit trail)

Everything lands in `docs/<slug>/.flightlog/`. It is **gitignored** via a self-ignore (`.flightlog/.gitignore` containing `*`). This directory is created automatically on first write; no user setup is needed.

- **Score verdicts** — the rubric-judge agent runs `score-task.ts <taskfile> <scores.json> --log docs/<slug>/.flightlog/run.jsonl --attempt N --agent <its-label> --rationale-file <its-rationale.md>`. Deterministic, guaranteed each cycle. The rationale file is why a *passing* verdict keeps its evidence — without it the trail records a weighted number and nothing that justifies it.
- **Narrative** — Dev / judge / final-review agents run `flightlog.ts log <run.jsonl> --task <ref> --role <role> --attempt N --agent <label> --message "..."` to record what they did.
- **Review findings** — the Final review lenses write their raw findings to `.flightlog/review/attempt-N/<lens>.md` (`<reviewEngine>` / reuse / leanness / efficiency). These persist as the artifact behind each closing-round verdict.
- **Report** — `flightlog.ts report <run.jsonl>` renders `RUNLOG.md`, grouped by task in chronological order. A verdict that carries a rationale folds it into a collapsed `<details>` block under its line.

Each entry records an `agentLabel` so a suspicious verdict can be traced back to that agent's raw `agent-<id>.jsonl` in the harness transcript.

## Bundled scripts

You run three of them yourself, all in the sibling `skills/flightplan/scripts/` directory (`$SCRIPTS`):

- `next-ready.ts <tasks-dir> [--json | --summary]` — the scout of Step 1 and of every wave. **`--summary` is what the orchestrator uses**: one `{ready, counts, unfinished, invalid, errors}` object, printed even when the command exits 1, so a malformed tree still names its refs. It exits non-zero rather than return a ready set that would unlock work behind a fake `done`.
- `lint-task.ts <tasks-dir | task-file>` — run it during scout when `next-ready` reports a malformed tree, and fix the tree before flying.
- `flightlog.ts report <run.jsonl>` — Step 4's audit render. `flightlog.ts log` is the in-run narrative entry point.
- `flightlog.ts progress <run.jsonl> [--task <ref>] [--json]` — where a task stopped, and the `--from` / `--attempt` a resume should use. Read it before every resume; never hand-count attempts out of the JSONL.

Plus `bun "$OWN"/flightdeck.ts` for the monitor — the one file the launch step runs from autopilot's own `scripts/` directory, whose other modules are flightdeck's server, launcher, and pure derivations, each with a `.test.ts` beside it.

The remaining shared tools — `score-task.ts`, `mark-done.ts`, `codex-run.ts`, `opencode-run.ts` — are called only from inside the workflow. `references/orchestrator.md` carries their signatures and contracts.

## Additional resources

- `references/orchestrator.md` — the canonical Workflow script (wave loop, per-task retry pipeline, inline score gate, agent prompts and schemas). Adapt this. Do not write one from scratch.

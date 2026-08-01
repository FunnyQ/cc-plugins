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

`autopilot` walks a `docs/<slug>/tasks/` tree. It executes each task with a dev→review→score loop. The loop gates on the task's own machine-parseable `## Eval rubric`. It finishes with the one `Final review` task as the holistic closing gate.

The output is working, reviewed code, plus an audit trail (`RUNLOG.md`) of every verdict.

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

Autopilot uses the **Workflow tool**. A skill whose instructions tell the agent to call Workflow is a *sanctioned opt-in*. Invoking `/autopilot` lets you call Workflow directly, **without the user typing "workflow"**.

Use the **hybrid shape**. Scout inline first to discover the work-list. Then hand the fan-out to a Workflow script.

Three hard constraints shape the design. Internalize them:

1. **The Workflow orchestrator script has no filesystem access.** It also **cannot `import`** our scripts. Anything that reads or writes disk — running `next-ready.ts`, editing a task's `Status`, appending to the flightlog — must run inside a tool-capable **agent** in the workflow. The orchestrator JS must never do this work.
2. **There is exactly one scoring implementation.** The rubric judge runs `score-task.ts --json --log`. The orchestrator gates on that printed verdict object. Do not duplicate the weighted-average or hard-fail arithmetic in the Workflow script.
3. **The orchestrator can't pause for input.** On a task that can't pass, it parks the task and keeps going. Escalation to the user happens *after* the workflow returns. See Escalation below.

## Step 1 — Scout inline

Before touching Workflow, gather the work-list in the main conversation:

1. **Resolve both scripts paths once.** autopilot reuses flightplan's scripts; they are siblings under the plugin. Take the skill's load-time *"Base directory for this skill"* banner. Resolve `<base>/../flightplan/scripts` to an absolute path, and call it `$SCRIPTS`. Then resolve autopilot's own scripts directory at `<base>/scripts`, and call it `$OWN`. Resolving `$OWN` is simpler because it needs no parent traversal. `CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash. Do not use `${CLAUDE_PLUGIN_ROOT}/...` for either path. Use `$SCRIPTS` in every shared-tool `bun` command below. This is the same value you bake into `CFG.scriptsDir` in Step 3.
2. Resolve the plan dir **as an absolute path**. The user names a slug or a path; the tree lives at `docs/<slug>/tasks/`. Capture the real repo root with `git rev-parse --show-toplevel` — it can be anywhere, for example `/Users/<name>/Projects/...`, `/opt/temp/project-repo`, or `/workspace/...`. Build absolute paths for `tasksDir`, `planPath`, and `logFile` from this root (`<root>/docs/<slug>/...`). Bake them into `CFG` in Step 3. These paths MUST be absolute. Workflow agents do not share a cwd, so a *relative* `logFile` resolves against whichever agent's working directory is current. An agent that `cd`s into the tree writes the flightlog to a nested `docs/<slug>/tasks/docs/<slug>/.flightlog/` and splits the audit trail. `~/...` is an optional shorthand, but only when the repo is under `$HOME`: Bash and the file tools expand a leading `~`, which avoids leaking the username. For a repo outside `$HOME`, use the full path. Never invent a `~` form.
3. Read `docs/<slug>/PLAN.md` for the overall goal and the bucketing. The Final review task scores against "did we meet the PLAN goal". The orchestrator needs the goal in hand.
4. Confirm there is ready work, and read the whole-tree shape at the same time:
   ```bash
   bun $SCRIPTS/next-ready.ts docs/<slug>/tasks --summary
   ```
   A non-zero exit means the tree is malformed — the printed `invalid` array names each offending task and why. Run `lint-task.ts` and fix the tree before flying. If `counts.done === counts.total`, the tree is already done. If `ready` is empty while tasks remain unfinished, the tree is stalled: reset any stale `in-progress` task to `todo` before flying.
5. **Capture the base ref** for the Final review diff scope:
   ```bash
   git rev-parse HEAD
   ```
   Bake this as `CFG.baseRef`. The Final review lenses use `git diff <baseRef>..HEAD` to see all committed task changes. This scope matters because the working-tree diff would be empty after inter-wave commits.
6. Decide `maxAttempts` (default **3**, the cap per task) and `finalReviewMaxAttempts` (default **2**, the cap for the Final review round). You choose the dev engine (Claude, codex, or opencode) with the user in Step 2. Confirm the rest of the model policy only if the user wants to change it.
7. Confirm the selected external CLI(s) are available. The dev step, when its engine is external, and the closing review round both shell out to them. Version-check whichever engines Step 2 will offer or the user picks:
   ```bash
   codex --version      # needed if devEngine or reviewEngine is 'codex'
   opencode --version   # needed if devEngine or reviewEngine is 'opencode'
   ```
   If a selected engine is not installed, tell the user before flying. The per-task Claude work still runs without it. Only the external dev engine and the closing review round need it.
8. Probe whether live panes are available: check that `HERDR_ENV=1` **and** relay's `relay.ts` resolves. Probe this on every flight, not only an external-dev one — the closing cross-vendor review lens can run live even when Claude writes every task. Resolve `relay.ts` the same way relay's live locator resolves herdr. Try the repo-sibling path first. Then scan both harness plugin caches (`~/.claude/plugins/cache` and `~/.codex/plugins/cache`) for the newest relay version's `skills/relay/scripts/relay.ts`. Capture the absolute path as `CFG.relayPath`. Use `''` when `relay.ts` is not found.

## Step 2 — Confirm the flight with the user

**Ask the user three things: which dev engine, which cross-vendor reviewer, and which final-review lens model — plus a fourth, live panes, when the env allows it.** Do not silently default. These are **independent** choices. Use `AskUserQuestion`:

- **Dev engine** (`CFG.devEngine`) — **Claude** (default; Sonnet writes, Opus on the last attempt), **Codex** (`'codex'` — the OpenAI codex CLI writes each task via `codex-run.ts`), or **OpenCode** (`'opencode'` — the opencode CLI writes each task via `opencode-run.ts`). With Codex or OpenCode, the dev step is a cheap Haiku driver, and Claude still judges. This gives a cross-vendor dev≠judge split.
- **Cross-vendor reviewer** (`CFG.reviewEngine`) — **Codex** (default) or **OpenCode** — the external bug/correctness lens in the closing Final review.
- **Final-review lens model** (`CFG.reviewLensModel`) — **Opus** (default) or **Fable 5** (`'fable'`) — the model for the four Claude `/simplify` lenses (reuse / simplification / efficiency / altitude) in the closing Final review. This choice affects **only** those four lenses. The fixer and rubric judge stay Opus regardless.
- **Live panes** (`CFG.liveDevEngine`, `CFG.liveReviewEngine`) — only when `HERDR_ENV=1` + `relay.ts` resolved, ask this fourth question, `multiSelect`: which steps run in a visible herdr live pane via relay, defaulting to neither (headless). Offer the **dev delegate** option only when the chosen dev engine is external — a Claude dev step has no delegate to make live. Always offer the **closing cross-vendor review** option; the review lens is external on every flight. Each picked step sets its own flag.

The picks set `CFG.devEngine`, `CFG.reviewEngine`, `CFG.reviewLensModel`, `CFG.liveDevEngine`, and `CFG.liveReviewEngine` in Step 3. Whichever external engines get chosen, their `--version` check from Step 1 becomes load-bearing. If a picked engine is unreachable, say so before flying. Offer to fall back: Claude for the dev engine, the other CLI for the reviewer.

When the user picks live, leave `CFG.liveCollectRounds` at its default `3`: a delegate or reviewer that outlives relay's watch window is still working, so the agent reattaches with `relay collect` up to that many more times (~32 min total) instead of failing the attempt and putting a second writer on the same files. Lower it only when a fast fail matters more than finishing a slow task. The same rounds apply to both live steps.

The live review lens passes `--dangerous`, same as the live dev delegate. A live pane carries no sandbox flag of its own, so an approval prompt with nobody watching stalls the lens for the full wait plus every collect round and then reports a false `UNREACHABLE`. Read-only stays prompt-enforced — relay's review contract plus the lens prompt's own "record, never edit" — and the fixer's verification catches a reviewer that edits anyway.

If the live-pane env is not fulfilled, do not ask the fourth question. Set `CFG.liveDevEngine = false`, `CFG.liveReviewEngine = false`, and `CFG.relayPath = ''`. The same fallback applies when the user is not in herdr, when `relay.ts` did not resolve, or when the user picks neither step. In every one of these cases, the headless wrapper path is exactly today's behavior. The four Claude `/simplify` lenses always stay headless — they are Claude agents, with no external CLI to put in a pane.

Then show the user a one-screen brief. State the slug and how many tasks there are. State the chosen dev engine, cross-vendor reviewer, and final-review lens model. State the two caps (`maxAttempts` and `finalReviewMaxAttempts`) and the model policy. State that capped tasks will be parked and escalated, not silently skipped. State that Final review ends with the chosen external CLI review. This step **sends the branch diff to an external service** — OpenAI for codex, the configured opencode provider for opencode.

This is real compute, real edits, and an external code review. Get an explicit go from the user before calling Workflow.

## Launch flightdeck after confirmation

After the user confirms the flight, launch flightdeck once:

```bash
bun "$OWN"/flightdeck.ts --plan "<the absolute plan dir resolved during scout>"
```

Pass the plan directory, not the tasks directory. The daemon expects the parent. It reads the tasks tree and flightlog beneath it.

The command returns on its own. It spawns the server detached, polls until the server answers, prints the URL, and exits. It takes a few seconds and then hands control back. It does not run the server in the foreground.

The flight does not depend on flightdeck. If the command exits non-zero, note that the monitor is unavailable and fly anyway. A broken monitor must never block a run.

The command opens the browser by default. `/autopilot` is human-invoked and needs an interactive user, so there is no headless case to detect. Use `--no-open` for manual testing only.

Running the command twice is safe. The daemon is a singleton. A second launch for the same plan from the same install reuses the running daemon and opens the page again.

Do not add a skill-level wait, poll, sleep, or health check around the command. Readiness is already the launcher's job. A second check would duplicate it and slow this step.

Tell the user the URL in the confirmation output. They can use it to reopen flightdeck after closing the tab.

## Step 3 — Call Workflow with the wave-loop orchestrator

Adapt `references/orchestrator.md`; it is the canonical script. Copy its `CFG` block, and fill in these scouted values as literals. Do not rely on the Workflow `args` global:

- `slug`
- absolute `tasksDir`, `planPath`, and `logFile`
- `planGoal`
- `maxAttempts` and `finalReviewMaxAttempts`
- absolute `scriptsDir`
- `baseRef`
- `commitBetweenWaves`
- `devEngine` and `reviewEngine`
- `liveDevEngine`, `liveReviewEngine`, absolute `relayPath`, and `liveCollectRounds`
- `opencodeDevModel` and `opencodeReviewModel`
- `reviewLensModel`

Then call `Workflow({ script: <the adapted script> })`. No `args` needed.

**`CFG.devEngine` and `CFG.reviewEngine` are independent axes.** `devEngine` controls who writes non-final tasks. `reviewEngine` controls the external bug/correctness lens in the closing Final review. The full external-engine behavior and failure handling live in `references/orchestrator.md`.

**Picking the opencode model.** Leave `CFG.opencodeDevModel` and `CFG.opencodeReviewModel` empty for wrapper defaults. Or set either to a `provider/model` override for that role. These fields are opencode-only. codex ignores them.

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

[at ANY step above — an agent returns no structured result, or the pipeline throws]
   infrastructure failure ─ park the task, escalate immediately, do NOT rerun dev

[between waves, wave > 1 — inside the scout agent before next-ready.ts runs]
   atomic-commit (inline git, NOT the skill) ─ commits all changes from the completed wave
   │   (CFG.commitBetweenWaves must be true; skipped for wave 1 — nothing to commit yet)
   ▼
[post-loop — after the wave loop exits]
   final atomic-commit (inline git) ─ commits Final review's changes (or any tail changes from the last wave)
```

### Scout result and termination rules

`next-ready.ts --summary` prints one whole-tree snapshot, and the scout echoes it verbatim:

```json
{
  "ready": [{ "ref": "ui/03", "finalReview": false, "path": "/abs/.../ui/03-build.md" }],
  "counts": { "total": 8, "todo": 5, "inProgress": 0, "done": 2, "blocked": 0, "invalid": 1 },
  "unfinished": [{ "ref": "ui/03", "state": "todo" }],
  "invalid": [{ "ref": "api/01", "rule": "completion-state", "reason": "…" }],
  "errors": [{ "file": "…/ui/09-broken.md", "reason": "missing H1" }]
}
```

`invalid` tasks parsed but hold a malformed execution state; they ARE counted (as `invalid`). `errors` files did not parse at all; they are **not** in `counts`.

The command prints this JSON **before** exiting non-zero on a malformed tree, so the scout reads stdout either way.

The wave loop terminates on exactly one of these, and only the first is clean:

| Condition | Outcome |
|---|---|
| `done === total` | clean completion — the whole tree is done |
| `errors` non-empty | scout failure — some task file did not parse at all |
| `total !== todo + inProgress + done + blocked + invalid` | scout failure — the snapshot is incoherent |
| `invalid > 0` | scout failure, naming every invalid ref |
| ready set non-empty | start the next wave |
| ready set empty with unfinished tasks | **stalled** — escalate with the counts and every remaining `ref (state)` |
| a wave in which no task passed | stop; nothing new can unblock |

**Why `counts`, not `completed.length`.** The run's `completed` array only covers *this* invocation. A resumed run inherits `done` tasks from earlier runs, so comparing `completed.length` with the tree size reports a false stall on every resume. `counts.done` reads the tree on disk, which is where completion actually lives.

**Why `errors` is checked before completion.** A file that fails to parse never enters the task map, so it never enters `counts`. `counts` describes what *parsed*, not the tree. Break four files in a five-task tree and `counts` reads `{total: 1, done: 1}` — `done === total` holds and the run reports success over a tree it could not read. The `errors` gate sits ahead of the completion test for exactly that reason.

The `Final review` task (`> **Final review**: true`) depends transitively on every other task. The wave loop **naturally schedules it last**; it only becomes ready once everything else is `done`. No special phase is needed.

Its dev step is **not** a Claude self-review. Instead, the orchestrator runs a **multi-lens review fan-out** (see below). The binary gate, rubric judge, and score gate are identical to every other task: they grade that round against the Final review task's own `## Eval rubric`.

### The closing multi-lens review round

The Final review's "dev" step fans out independent record-only reviewers. Then a single Opus fixer applies the real fixes and re-runs verification:

- `<reviewEngine>`: codex/opencode CLI bug and correctness review.
- `reuse`: duplicated logic and missed existing helpers.
- `simplification`: dead code, needless complexity, clearer equivalents.
- `efficiency`: redundant work, N+1s, recomputation, avoidable allocation/IO.
- `altitude`: over- or under-engineered abstraction level.

The fan-out happens at the orchestrator level. Workflow agents cannot spawn other agents. See `references/orchestrator.md` for the full rationale, failure handling, and exact prompts.

## Step 4 — Report

After the workflow returns:

1. Run the flightlog report to render the audit trail. (`$SCRIPTS` is the path you resolved in Step 1.)
   ```bash
   bun $SCRIPTS/flightlog.ts report docs/<slug>/.flightlog/run.jsonl
   ```
   This writes `docs/<slug>/.flightlog/RUNLOG.md`: every attempt, every verdict, each linked to its agent label for drill-down.
2. Tell the user: tasks completed, tasks escalated and why, and where `RUNLOG.md` lives. If everything passed, including Final review, say so plainly, and point at what to verify or ship.

The rest of this document is reference material: model policy, scoring, escalation handling, the flightlog, and the shared scripts.

## Model policy

This policy is encoded as a constant table at the top of the orchestrator, so it stays tunable in one place. The dev≠judge split is deliberate: a model that judges its own output is biased toward passing.

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

The **correctness** dimension must be grounded in **real verification**, not the judge's vibe. The binary gate agent actually runs the task's `## Verification` commands and checks its `## Acceptance criteria`. Its pass/fail result and raw output go to the rubric judge, which scores correctness against *that evidence*.

A judge cannot score correctness high while the binary gate failed; the orchestrator rejects that contradiction. The binary gate must pass before the judge even runs.

## Escalation — park & continue, then resume

A task escalates for one of two reasons: it exhausted its cap (`maxAttempts`, or `finalReviewMaxAttempts` for the Final review), or an infrastructure failure stopped it from being judged at all. Either way:

1. The orchestrator **parks** the task by setting its `Status: blocked`, records an escalation, and **keeps flying** the other independent tasks. Dependents of a parked task simply never become ready, so they wait.
2. When the workflow returns, it hands back `{ slug, completed: [...], escalations: [{ task, attempt, infrastructure, parked, reason }] }`. The `reason` string already embeds the last verdict: the judge's rationale, the binary gate's output, the infrastructure cause, or the scout error.
3. **You** (the main agent) surface the escalations to the user. In an active cockpit session, hand the stick back via `needs_your_call` + `cockpit wait`. Otherwise, use `AskUserQuestion`. Show the task and its `reason`.
4. After the user unblocks the task — a decision, a spec fix, a manual nudge — **resume**: reset the parked task's `Status` to `todo`, and re-run autopilot. The wave loop picks up where it left off. Completed tasks stay `done`, so `next-ready` only re-offers the unblocked work.

**Read the two flags before you report.** `infrastructure: true` means nothing was judged — say that verification did not run or returned no verdict, not that the work was rejected. `parked: false` means the park itself failed, so the file still reads `in-progress` and `next-ready` will not re-offer it; tell the user to reset that Status by hand before resuming.

**Both status transitions are confirmed by a reread.** `mark-done` and the park step each return `{ ok, status, error }`, and each must reopen the file and read the Status line back before claiming success. An agent can return a fluent summary having edited nothing — and for parking that is the likely case, since the task is often parked *because* its header was malformed. So `parked: true` means the file was verified to read a bare `Status: blocked`, never that an agent said so.

**Quality failure vs infrastructure failure.** A verifier returning `passed: false` is a quality failure: real work was judged, so the dev loop retries. A verifier or judge returning *no structured result*, a thrown task pipeline, or a `mark-done` that does not confirm a bare `Status: done` is an infrastructure failure: nothing was judged, so the task parks and escalates on the spot and dev is **not** rerun in that invocation. The attempt number is reported as it actually was — compute was consumed. When the harness exposes no original cause for a null agent result, the escalation says exactly that instead of inventing one.

**A schema'd agent has two failure modes.** `agent(prompt, {schema})` returns `null` on a terminal API failure, and **throws** when the subagent never calls the StructuredOutput tool. A null-guard cannot see a throw. Every schema'd call inside a task is already covered by the task-pipeline catch; the wave-loop scout and the two commit agents are wrapped in the orchestrator's `settled()` helper for the same reason. Keep both guards on any schema'd call you add — an unguarded throw at the top of the wave loop discards the results of every wave that already finished, so the run reports nothing while the tree on disk reads `done`.

Crash recovery note: an interrupted run can leave task files at `Status: in-progress`. `next-ready` only offers `todo`. Reset stale `in-progress` tasks to `todo` before re-running autopilot.

The orchestrator never asks the user anything mid-run; Workflow cannot pause for input. Escalation is always post-return.

## The flightlog (audit trail)

Everything lands in `docs/<slug>/.flightlog/`. It is **gitignored** via a self-ignore (`.flightlog/.gitignore` containing `*`). This directory is created automatically on first write; no user setup is needed.

- **Score verdicts** — the rubric-judge agent runs `score-task.ts <taskfile> <scores.json> --log docs/<slug>/.flightlog/run.jsonl --attempt N --agent <its-label>`. Deterministic, guaranteed each cycle.
- **Narrative** — Dev / judge / final-review agents run `flightlog.ts log <run.jsonl> --task <ref> --role <role> --attempt N --agent <label> --message "..."` to record what they did.
- **Review findings** — the Final review lenses write their raw findings to `.flightlog/review/attempt-N/<lens>.md` (`<reviewEngine>` / reuse / simplification / efficiency / altitude). These persist as the artifact behind each closing-round verdict.
- **Report** — `flightlog.ts report <run.jsonl>` renders `RUNLOG.md`, grouped by task in chronological order.

Each entry records an `agentLabel` so a suspicious verdict can be traced back to that agent's raw `agent-<id>.jsonl` in the harness transcript.

## Bundled scripts

autopilot has its own `scripts/` directory — the flightdeck monitor. Each name below is a `.ts` module in `skills/autopilot/scripts/`, with a `.test.ts` beside it:

- `flightdeck` — the server process and its route table. The launch step above runs this file.
- `launch` — the CLI, singleton decision use, detached spawn, and readiness.
- `daemon-decision` — the pure start, reuse, or supersede decision.
- `daemon-record` — the daemon record's shape, path, and I/O.
- `fleet` — pure derivation: task state, agent labels, and fleet rows.
- `static-serve` — pure path resolution, MIME handling, and the file response.
- `tree-api` — plan loading and the pure tree payload builder.

It still borrows these shared tools from the sibling `skills/flightplan/scripts/` directory:

- `next-ready.ts <tasks-dir> [--json | --summary]` — the per-wave scout. **`--summary` is what the orchestrator uses**: one object `{ready, counts, unfinished, invalid, errors}`, printed even when the command exits 1, so a malformed tree still names its refs. `--json` remains the older ready-only array `[{ref,finalReview,path}]` (or `[]`) for any other consumer. Both exit non-zero on a parse error or an invalid completion state rather than returning a ready set that would unlock work behind a fake `done`.
- `score-task.ts <task> <scores.json> [--json] [--log <file>] [--attempt N] [--agent <label>]` — `scoreTask(rubric, scores)` exported. `--json` prints the machine verdict the orchestrator gates on; `--log` persists the same verdict to the flightlog.
- `mark-done.ts <task>` — the done-transition, as ONE state change: validates the header first, then sets `Status: done` and ticks every `## Acceptance criteria` / `## Verification` checkbox together. It exits non-zero and writes nothing when the header is missing, duplicated, or decorated, so the file never lands half-transitioned. Run when a task passes the gate, then reread and confirm.
- `flightlog.ts log|report` — narrative entries + `RUNLOG.md`.
- `lint-task.ts <tasks-dir | task-file>` — run during scout if `next-ready` reports a malformed tree, and inside the external-engine dev driver after the delegate returns (that engine writes outside the harness, so the Edit/Write lint hook never sees its work).
- `codex-run.ts <delegate|review> [--prompt-file <path>]` — thin wrapper over the `codex` CLI used by the codex dev engine + the codex review lens. `delegate` runs `codex exec -s workspace-write` and appends a `git status --short`; `review` runs `codex exec -s read-only`. Captures codex's clean last message, prints it, and deletes its own scratch (no temp left to mine). Exits non-zero with a `CODEX UNREACHABLE` stderr line when the CLI is missing/fails. Prompt from `--prompt-file` or stdin.
- `opencode-run.ts <delegate|review> [--prompt-file <path>] [--model <m>]` — the opencode counterpart of `codex-run.ts`, used when `devEngine`/`reviewEngine` is `'opencode'`. `delegate` runs `opencode run -m <model> --format json` (write-capable) and appends a `git status --short`; `review` prepends a hard read-only guard (opencode has no sandbox read-only). Parses the JSONL `text` parts, prints the clean answer, exits non-zero with an `OPENCODE UNREACHABLE` stderr line when the CLI is missing/fails. Model: `--model` > `OPENCODE_MODEL` env > per-mode default (delegate `opencode-go/kimi-k2.7-code`, review `opencode-go/qwen3.7-max`). Prompt from `--prompt-file` or stdin.

## Additional resources

- `references/orchestrator.md` — the canonical Workflow script (wave loop, per-task retry pipeline, inline score gate, agent prompts and schemas). Adapt this. Do not write one from scratch.

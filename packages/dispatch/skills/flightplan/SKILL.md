---
name: flightplan
version: 0.8.0
description: >-
  Heavyweight interviewer that writes a multi-file spec artifact to disk —
  docs/<topic>/PLAN.md plus a tasks/ tree for sub-agents to execute later.
when_to_use: >-
  When the work should be frozen to disk for a later/different session or
  sub-agent to execute — decomposing into a task tree, "/flightplan". Do NOT
  trigger for a lightweight in-conversation spec (use preflight instead), for
  an existing task tree ready to run (use autopilot), or when a clear
  instruction can just be executed directly.
argument-hint: "[topic]"
---

# Flightplan

Interview thoroughly, then commit a complete blueprint to disk so a *different* session — possibly a sub-agent — executes each piece cold. `preflight` is the lighter sibling: it plans and executes in this conversation.

- Executing now, single session, small scope → **`preflight`**.
- Multi-stage, multi-file, handed to a sub-agent, or decisions frozen in version-controlled docs → **`flightplan`**.
- Unsure? Ask *"executing now, or saving for later?"* Later = `flightplan`.

The output is three layers:

1. **`docs/<topic>/PLAN.md`** — master spec, single source of truth for decisions and scope.
2. **`docs/<topic>/tasks/_context/*.md`** — shared context every task references.
3. **`docs/<topic>/tasks/<bucket>/NN-<slug>.md`** — one file per executable unit, self-contained. `_context/` plus the task file is everything an executor needs.

**Two non-negotiables**, because the whole artifact depends on them: enter plan mode before any output, and ask every interview question through `AskUserQuestion` — structured options stay reviewable, plain text gets lost.

## Setup

`CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash. Take the skill's load-time *"Base directory for this skill"* banner and set `SCRIPTS="<base-dir>/scripts"`. Every command below uses `bun "$SCRIPTS"/...`.

**Waypoint mode**: if the request targets a specific waypointed project (`docs/<proj>/WAYPOINTS.md`, a named leg, or a roadmap), read `references/waypoint-mode.md` and follow it instead of the steps below. An ordinary "spec this out" stays in normal mode even when a roadmap exists elsewhere.

## Process

### Step 1 — Enter plan mode

Call `EnterPlanMode` immediately, before any text output or question. Skip if already in plan mode.

### Step 2 — Interview until shared understanding

**Mission**: don't stop until both sides understand every part of the plan. Treat the design as a tree of decisions and walk one branch at a time. There is no round cap — stop when the tree is fully walked, not when a counter expires.

1. **Walk one branch to completion** before its siblings.
2. **Resolve upstream choices first.** Ask in dependency order; surface the dependency when it isn't obvious.
3. **Recommend an answer to every question.** First `AskUserQuestion` option carries `(Recommended)` plus rationale, so the user reacts instead of designing from scratch.
4. **Ask 1–2 questions per turn.** Multi-question calls only for tightly coupled pairs.
5. **Reflect every 4–6 rounds** — 3–5 bullets of what's decided, confirmed.

`references/interview-guide.md` holds the per-topic question banks, tree-walking examples, question-design checklist, and stop criteria.

**Required dimensions** — resolve each, or explicitly defer it to Open Questions:

- **Topic slug** — kebab-case, for `docs/<topic>/`. The moment it's agreed, check collision: `bun "$SCRIPTS"/scaffold.ts --check <slug>` prints `OK` or `EXISTS: <suggested -vN slug>`. On collision, pause and ask: merge, version-bump, or abort.
- **Problem & users** — who it's for, what changes after it ships.
- **Scope boundaries** — the explicit Non-goals list.
- **Tech constraints** — stack, conventions, deployment target, integrations, version pins.
- **Architecture** — how pieces fit, where new code lives, what talks to what.
- **Bucketing** — `ui/backend/api`, by phase, by feature, or a single `work/` bucket for short plans.
- **Cross-bucket dependencies** — which task in A unblocks which task in B.
- **Acceptance criteria & verification** — per requirement, how it gets validated.
- **Eval rubric** — the graded quality bar on top of the binary gate. Recommend the defaults (`Correctness ×3 / Test coverage ×2 / Interface & readability ×1 / Assumptions & docs ×1`, pass `> 4.0`, `Correctness < 4` veto) and adapt. A shared bar goes in `_context/rubric.md`.
- **Final review** — every plan ends with one terminal task marked `> **Final review**: true` whose `Depends on` reaches every other task, transitively. It gates integration, consistency, regressions, and whether the PLAN goal was met — it does not re-score individual tasks. `lint-task.ts` requires it (single-task plans exempt), and requires its `## Verification` to run a test suite whenever the tree runs tests anywhere.
- **Conventions worth freezing** — commit style, code style, file layout, naming. These become `_context/shared.md`.
- **Failure modes & rollback**.

**For writing topics**, translate: Architecture → outline/section structure, Tech constraints → style decisions, Failure modes → revision and review strategy. Drop what doesn't apply.

### Step 3 — Draft PLAN.md inside plan mode

Follow `references/plan-template.md`. PLAN.md carries all decisions, requirements, constraints, bucketing rationale, and the task index. Show its full content via the plan so the user can review it.

### Step 4 — Exit plan mode

Call `ExitPlanMode` once PLAN.md is drafted. Always exit, even with open questions — record those in PLAN.md's "Open Questions".

### Step 5 — On approval, write the files

**Approval** is explicit acceptance: clicks approve, types "yes/approved/go ahead", or equivalent. Silence, "looks ok-ish", and "but can you also…" are **not** approval — keep revising, and write no files until the user accepts.

**Atomicity**: the sequence isn't transactional. Once `scaffold.ts` runs, the tree exists. Two failure classes, two responses:

- **Repairable** (missing task file, lint violation, dead fork) — fix that file in place and re-run the step. Never delete the tree.
- **Unrecoverable** (wrong slug or buckets, tree too damaged to reason about) — `trash docs/<slug>/` and re-run from scaffold. Only ever trash a tree *this run* created; if `docs/<slug>/` predates this run, stop and ask.

Either way, never leave a half-written tree.

**Bucket names are single kebab tokens** with no internal dashes (`ui`, `backend`, `api`, `work`). `lint-task.ts` and `build-readme.ts` parse the H1 `BUCKET` as one uppercase token, so a dashed name scaffolds but fails validation.

1. **Scaffold the tree** — deterministic `mkdir` only, no stub files:
   ```bash
   bun "$SCRIPTS"/scaffold.ts <slug> <bucket1>,<bucket2>,...
   ```
   Creates `tasks/_context/` and one dir per bucket. The root is created non-recursively, so a slug created between the Step 2 check and now throws EEXIST instead of silently overwriting.

2. **Write PLAN.md and every `_context/*.md` yourself** — never delegate these. They are the contract every task file agrees to, and a single author is what keeps them from drifting (PLAN.md is already drafted, so this is transcription). Write `_context/rubric.md` first when the bar is shared. Finish all of them **before** spawning anything: the forks read these files off disk, so the finalized file is the contract, not whatever they inherited from the transcript. Follow `references/plan-template.md` and `references/context-files.md`; don't improvise structure.

3. **Fan the task files out to forked subagents** — one `Agent` per task file, all in a single message so they run concurrently. Use `subagent_type: "fork"` and only that; omitting it starts a fresh, context-less agent that never saw the interview and will invent the decisions.

   **Write them inline and serially instead** when the tree has ≤3 task files (spawn overhead beats the gain), or when the `Agent` tool is unavailable because flightplan is itself running inside a subagent (a fork is a leaf and cannot spawn). Beyond ~10 tasks, spawn one batch per bucket so a failed batch stays contained.

   **Decide the whole task list first** — bucket, `NN`, slug, title, `Depends on`, `Blocks`, and which task carries `> **Final review**: true`. Forks fill in prose only; if they pick numbering or dependency edges, two will collide on the same `NN`.

   Give each fork: the absolute output path `docs/<slug>/tasks/<bucket>/NN-<slug>.md`; the absolute path to `references/task-template.md`; the exact H1 and every header field you decided; the `_context/*.md` files it must list under `Required reading`, by relative path; and the interview substance this task needs — goal, files to create/modify, signatures, schemas, acceptance criteria, verification commands, rubric anchors (or "reuse the shared bar in `../_context/rubric.md`").

   **Tell each fork to read `task-template.md` and every `_context/*.md` it will list, before writing.** A fork inherits the transcript, not the files — relying on the inherited copy is how a task file ends up citing `../_context/shared.md` while contradicting it, and no linter catches that disagreement.

   **Bound each fork explicitly.** A fork inherits full tool access and autonomy, and will overstep a narrow brief unless told:
   - Write exactly that one file. Edit nothing else.
   - Do not run `scaffold.ts`, `lint-task.ts`, `build-readme.ts`, or `review-plan.ts`.
   - Do not implement the work the task describes. This is a spec, not the code.
   - On lint feedback, fix and rewrite that file until clean, then stop.
   - Report one line: the path written, plus any unresolved violation.

   **Join before moving on.** A fork can die on an API error, time out, or claim success without leaving a file, and none of that raises on its own. Keep the expected-path list; once every fork returns:
   ```bash
   ls docs/<slug>/tasks/*/*.md      # every expected path present?
   git status --short               # anything touched outside docs/<slug>/?
   ```
   Write any missing file yourself, inline — don't re-spawn the batch, don't trash the tree (a missing file is repairable). Revert any path a fork touched outside `docs/<slug>/`; the brief forbids it but nothing enforces it.

   Every task file needs a `## Eval rubric` (threshold line + weighted table), and exactly one task carries `> **Final review**: true`. See `references/task-template.md`.

4. **Lint the whole tree** — catches what the per-file hook can't see (duplicate `bucket/NN`, broken cross-bucket deps). Run it yourself after every fork reports, never inside a fork:
   ```bash
   bun "$SCRIPTS"/lint-task.ts docs/<slug>/tasks
   ```
   Pass the **tasks directory**, not a glob; the script walks bucket dirs and auto-skips `_context/` and `README.md`. Violations include PLAN.md refs in any casing, sibling-task refs, missing sections, a missing or unparseable `## Eval rubric`, an out-of-scale pass threshold, no final-review task (or one that doesn't reach every task), broken Required reading paths, an H1-vs-path mismatch, and a bad Status. Fix and re-run. Do not finish with violations outstanding.

5. **Generate `tasks/README.md`** — index, dep graphs, cross-bucket table:
   ```bash
   bun "$SCRIPTS"/build-readme.ts docs/<slug>/tasks
   ```
   It fails loudly on malformed or duplicate-ref tasks rather than dropping them, and preserves the human-authored prologue/epilogue between the generated markers. Two of those sections are yours to fill, and the template ships them as placeholder comments that will otherwise be delivered as-is: **`## Where to start`** (name the first task file) and **`## Known gaps`**. `tasks/README.md` is what an executor opens, so a gap recorded only in PLAN.md never reaches them. Revisit both after Step 6 — most gaps surface during the review loop, not the interview.

### Step 6 — Review the written artifact (engine-selectable; iterate to convergence)

Once lint passes, run an independent review over the whole tree, then **loop**: review → fix → re-review. This is a mandatory content-quality gate, a different lens from `lint-task.ts`'s structural checks. Cross-file inconsistencies, vague acceptance criteria, oversized tasks, and goal drift are real defects here, not nitpicks.

**Pick the engine first** via `AskUserQuestion`. All three share one source of criteria — the 7-point checklist baked into `review-plan.ts`. Only *who critiques* changes.

- **Codex** (default) — the cross-vendor signal an all-Claude author can't produce:
  ```bash
  bun "$SCRIPTS"/review-plan.ts docs/<slug>
  ```
- **OpenCode** — also cross-vendor; pick it to use opencode's models:
  ```bash
  bun "$SCRIPTS"/review-plan.ts docs/<slug> --engine opencode   # optional: --model <provider/model>
  ```
  Both bundle the plan files, so the scope is exactly the tree regardless of other uncommitted changes. If the CLI isn't installed the script exits 0 with a warning — skip the gate, note it as a Known gap in `tasks/README.md`, and go to Step 7.
- **Opus** — a strong Claude reviewer, but **you wrote this plan, so you must not review it yourself**; author bias defeats the gate. Each pass:
  1. Capture the same bundle the CLIs get: `bun "$SCRIPTS"/review-plan.ts docs/<slug> --print`
  2. Spawn an `Agent` (model `opus`) whose prompt is that bundle plus: *"You are an independent reviewer of this flightplan. Apply the review described at the top. Return findings — each with the file, the section/field, and the concrete fix. Edit nothing."* **Omit `subagent_type`** — the reviewer must start context-less. A fork would inherit the interview and review its own reasoning, the exact bias this step exists to defeat (the opposite of Step 5's fan-out).
  3. Take the findings back to the loop. A fresh subagent each pass keeps reviewer ≠ author — the same anti-bias split autopilot uses.

**Act on findings between every pass.** Re-reviewing unchanged files just repeats the same findings; the loop is where most of the quality comes from, because the first pass catches the loud problems and the *revised* plan then exposes what they were masking. Rewrite vague criteria, split tasks that mix concerns, fix goal drift, add missing `Depends on` edges. After any structural change, re-run `lint-task.ts` and `build-readme.ts`. Skip a finding only when it conflicts with an intentional recorded decision — then log it as a Known gap in `tasks/README.md` with the reason, and don't re-fix it when a later pass raises it again.

**How many passes, within bounds:**

- **At least 2** full review→fix cycles. The second, on the improved plan, is the high-value one.
- **Keep going** while a pass still surfaces *material* findings.
- **Stop when a pass comes back clean** — only nitpicks or already-recorded intent. That's the "plan is complete" signal.
- **Ceiling ~4–5.** Past that it's usually over-polishing. Bank remaining real items as Known gaps in `tasks/README.md` and move on.

### Step 7 — Stop. Do not execute.

Tell the user where the files live and which task to start from. Do not start implementing — the whole point is that execution happens elsewhere with fresh context.

**Hand back a short recap in the user's reply language** (the files stay English; only this recap is localized). Glanceable: the goal in one line, the buckets and task counts, the suggested first task, and any Known gaps. It lets the user sanity-check the plan's shape without opening every file — it is not a re-paste of the plan.

The next executor can ask "what should I work on?" — this lists tasks whose dependencies are all `done`:

```bash
bun "$SCRIPTS"/next-ready.ts docs/<slug>/tasks
```

## Core principles for the artifacts

1. **Task files are self-contained.** An executor needs only `_context/` + the task file. Never reference PLAN.md or another task file. → `references/task-template.md`
2. **PLAN.md is the source of truth; `_context/` mirrors it.** When a decision changes, update those two, not the task files. → `references/context-files.md`
3. **A bucket directory is always required.** Never write task files directly under `tasks/`; short plans use a single `tasks/work/`. This keeps every `Required reading` path identical.
4. **Mark unknowns explicitly** as Known gaps in `tasks/README.md`, never as vague tasks. → `references/readme-template.md`
5. **Write the artifacts in English.** A sub-agent picks them up cold, so English keeps them portable regardless of the interview language. (Exception: a writing-topic plan whose deliverable is in another language may use it for content samples.) Interview in whatever language the user prefers; hand back the Step 7 recap in theirs.

## File-writing rules

- All paths are relative to the current working directory unless the user says otherwise.
- Kebab-case for `<topic>` and `<slug>`. Zero-pad `NN` to two digits.
- Never overwrite an existing `docs/<topic>/` without explicit confirmation (collision check happens in Step 2).

## Automatic lint hook

The dispatch plugin registers `hooks/flightplan-lint.sh` as a PostToolUse hook on `Edit|Write`. It lints any file that lives at `docs/<slug>/tasks/<bucket>/NN-*.md` **and** carries a Required-reading header (`> **Required reading**:` or `> **Required reading** (read before starting; do not need to open other files):`). The signature is narrow on purpose — a near miss like `> **Required reading later**:` is a silent no-op, as is anything else.

On a violation it exits 2 with stderr feedback, so the problem surfaces immediately instead of at the Step 5 whole-tree lint. Writing `_context/` before task files keeps it quiet during normal flow.

**It observes harness `Edit|Write` calls only** — it cannot see a file written by an external CLI, by relay, or by Bash. Treat it as early per-file feedback for flightplan authors, not as the gate. Step 5's whole-tree lint is the gate here; `autopilot`'s binary and rubric gates own the execution boundary.

## Additional resources

- `references/interview-guide.md` — per-topic question banks, tree-walking examples, recommendation rules, stop criteria
- `references/plan-template.md` — PLAN.md template
- `references/task-template.md` — task file template + self-containment checklist
- `references/context-files.md` — `_context/` files and the inline-don't-link rule
- `references/readme-template.md` — `tasks/README.md` template
- `references/example-flow.md` — end-to-end example invocation
- `references/waypoint-mode.md` — planning one leg of a `WAYPOINTS.md` roadmap

## Bundled scripts

Reach for these instead of doing the mechanical work by hand. Each exports a tested pure function.

- `scripts/scaffold.ts` — collision check (`--check`) and dir-tree creation
- `scripts/lint-task.ts` — validates task files against the self-containment contract + the mandatory Eval-rubric shape
- `scripts/build-readme.ts` — regenerates `tasks/README.md` index / dep graphs from task headers
- `scripts/review-plan.ts` — Step 6's plan review. `--engine codex|opencode` (default codex; codex uses its native `review`, opencode delegates to `opencode-run.ts`), `--model` overrides the opencode model, `--print` emits the instructions + bundle for the Opus reviewer subagent. Exit code mirrors the reviewer so callers can gate on it; a missing CLI exits 0 with a warning.
- `scripts/next-ready.ts` — lists tasks whose dependencies are all `done` (executor-session helper)
- `scripts/score-task.ts` — executor side: feed it `{ dimension: score }` JSON for a deterministic weighted average + hard-fail verdict against the task's own rubric (`scoreTask(rubric, scores)`). `--log <file>` appends to an audit trail.
- `scripts/mark-done.ts` — the done-transition: sets `> **Status**: done` and ticks every `## Acceptance criteria` / `## Verification` box (`markDone(content)`). Used by `autopilot`.
- `scripts/flightlog.ts` — executor audit trail: `log` appends an agent narrative entry, `report` renders `RUNLOG.md`. Logs live in `docs/<slug>/.flightlog/`, self-gitignored. Driven by `autopilot`.

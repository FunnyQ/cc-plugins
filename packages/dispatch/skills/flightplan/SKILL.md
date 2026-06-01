---
name: flightplan
version: 0.2.0
description: Heavyweight interviewer that writes a multi-file specification artifact to disk — `docs/<topic>/PLAN.md` plus a `tasks/` tree with shared `_context/` files and self-contained task files that sub-agents can pick up in later sessions. AUTO-TRIGGER when the user asks to "fully spec out", "break this down into tasks", "decompose into task files", "prep this for sub-agents", "write PLAN.md and tasks", "draft a project blueprint", "interview me thoroughly", or asks for a multi-file spec artifact written to disk for later execution. Also trigger when the user explicitly says "/flightplan" or mentions they will execute the work in a different session. Do NOT trigger when the user wants a lightweight in-conversation spec (use preflight instead), or when they give a clear, actionable instruction that can be executed directly.
---

# Flightplan

## Why this skill exists

`preflight` gathers just enough context to write a single in-conversation plan and execute. `flightplan` is the heavier sibling: interview thoroughly, then commit a complete blueprint to disk so a different session — possibly with a sub-agent — can execute each piece independently.

The output is three layers:

1. **`docs/<topic>/PLAN.md`** — master spec. Single source of truth for decisions and scope.
2. **`docs/<topic>/tasks/_context/*.md`** — shared context every task references.
3. **`docs/<topic>/tasks/<bucket>/NN-<slug>.md`** — one file per executable unit, self-contained so an executor reading `_context/` plus the task file can finish the work without opening any other file.

## When to use vs preflight

- Will execute now, single session, small scope → **`preflight`**.
- Multi-stage, multi-file, handing off to a sub-agent or freezing decisions in version-controlled docs → **`flightplan`**.

If unsure, ask: *"executing now, or saving for later?"* Saving for later = `flightplan`.

## Two non-negotiables

1. **Plan mode** — enter before any output; PLAN.md is drafted there, then exit so the user can approve.
2. **`AskUserQuestion` for every interview question** — structured options keep the interview reviewable; plain text gets lost.

## Process

### Step 1 — Enter plan mode

Call `EnterPlanMode` immediately, before any text output, before any question. If already in plan mode, skip.

### Step 2 — Interview until shared understanding

**Mission**: Don't stop interviewing the user until both sides fully understand every part of the plan. Treat the design as a tree of decisions — walk one branch at a time, and when one choice depends on another, resolve the upstream one first. For every question, propose the answer you'd pick and explain why; the user reacts to it.

There is no round cap. Stop when the design tree is fully walked, not when a counter expires.

**Operating principles:**

1. **Walk one branch at a time.** Resolve a branch before moving to its siblings.
2. **Resolve upstream choices first.** Some decisions block others — ask in dependency order, and surface the dependency when it isn't obvious.
3. **Recommend an answer for every question.** First `AskUserQuestion` option carries `(Recommended)` plus rationale; the user reacts rather than designing from scratch.
4. **Ask 1–2 questions per turn.** Use multi-question calls only for tightly coupled pairs.
5. **Reflect periodically.** Every 4–6 rounds, summarize what's decided in 3–5 bullets and confirm.

See `references/interview-guide.md` for the canonical walking-the-tree examples, recommendation rules, and stop criteria.

**Required dimensions** (do not stop until each is resolved or explicitly deferred to Open Questions):

- **Topic slug** — a kebab-case identifier for `docs/<topic>/`. The moment a slug is agreed, check for collision with `bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/scaffold.ts --check <slug>`. The script prints `OK` or `EXISTS: <suggested -vN slug>`. If it collides, pause the interview and ask: merge, version-bump, or abort. Resolve before continuing.
- **Problem & users** — who this is for, what changes after it ships.
- **Scope boundaries** — what is explicitly out of scope (the Non-goals list).
- **Tech constraints** — stack, conventions, deployment target, integrations, version pins.
- **Architecture** — how the pieces fit. Where the new code lives. What talks to what.
- **Bucketing** — `ui/backend/api`, by phase, by feature, or single-bucket `work/` for short plans.
- **Cross-bucket dependencies** — which task in bucket A unblocks which task in bucket B.
- **Acceptance criteria & verification** — for every requirement, how it gets validated.
- **Eval rubric** — the graded quality bar for each task (dimensions, weights, pass line, hard-fail veto) on top of the binary acceptance gate. Recommend the defaults (`Correctness ×3 / Test coverage ×2 / Interface & readability ×1 / Assumptions & docs ×1`, pass `> 4.0`, `Correctness < 4` veto) and adapt. A shared bar goes in `_context/rubric.md`. See `references/interview-guide.md` → "Eval rubric (ask per task)".
- **Final review** — every plan ends with one terminal task marked `> **Final review**: true` that depends (transitively) on every other task. It's the holistic gate: integration, consistency, regressions, and whether the PLAN goal was actually met — scored by its own rubric on those axes, not a re-score of individual tasks. `lint-task.ts` requires it (single-task plans exempt).
- **Conventions worth freezing** — commit style, code style, file layout, naming (these become `_context/shared.md`).
- **Failure modes & rollback** — what could go wrong; how to recover.

**For writing topics**, translate the code-oriented dimensions: Architecture → outline / section structure, Tech constraints → style decisions, Failure modes & rollback → revision and review strategy. Drop dimensions that don't apply.

### Step 3 — Draft PLAN.md inside plan mode

Use `references/plan-template.md`. PLAN.md carries all decisions, requirements, constraints, bucketing rationale, and a task index. Show its full content via the plan so the user can review.

### Step 4 — Exit plan mode

Call `ExitPlanMode` once PLAN.md content is drafted. Always exit — even if open questions remain (record them in PLAN.md's "Open Questions" section).

### Step 5 — On approval, write the files

**What counts as approval**: explicit acceptance (clicks approve, types "yes/approved/go ahead", or equivalent). Silence, "looks ok-ish", or "but can you also…" are **not** approval — those mean continue revising. If the user requests any change, do not write any files; revise and re-confirm.

**Atomicity note**: the writing sequence is not transactional. Once `scaffold.ts` runs, the `docs/<slug>/` tree exists; if a later step fails, recover by `trash docs/<slug>/` and re-running from scaffold. Do not leave the user with a half-written tree.

**Bucket names must be single kebab tokens** with no internal dashes (`ui`, `backend`, `api`, `work`) — the H1 parser used by `lint-task.ts` and `build-readme.ts` treats `BUCKET` as one uppercase token. Dashed bucket names will scaffold but fail validation.

**Writing sequence** — use the bundled scripts so the mechanical parts stay deterministic:

1. **Scaffold the tree** (deterministic mkdir only — no stub files):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/scaffold.ts <slug> <bucket1>,<bucket2>,...
   ```
   Creates `docs/<slug>/tasks/_context/` and one dir per bucket. The root `docs/<slug>/` is created non-recursively, so a TOCTOU race (slug created between Step 2's `--check` and now) throws EEXIST instead of silently overwriting.

2. **Write the content in this order** — fill files in dependency order so the automatic lint hook (see below) does not fire false positives on unresolved `Required reading` paths:
   - First: PLAN.md and every `_context/*.md` (especially `_context/shared.md`).
   - Then: each `tasks/<bucket>/NN-<slug>.md`.

   Use the four reference templates listed under "Additional resources". Do not improvise structure. **Every task file must carry a `## Eval rubric`** (threshold line + weighted dimension table) — `lint-task.ts` rejects tasks without a parseable one. If the quality bar is shared, write `_context/rubric.md` first and have each task's rubric reference it. **End the tree with one terminal task marked `> **Final review**: true`** whose `Depends on` reaches every other task — the closing holistic gate (see `references/task-template.md` → "`Final review`").

   **Automatic lint hook**: every time a task file is written, the `flightplan-lint.sh` hook runs `lint-task.ts` on just that file. Violations are surfaced as stderr feedback (exit 2). The hook skips files that don't match flightplan's path + content signature, so it won't false-positive on unrelated Edit/Write calls.

3. **Lint the whole tree** to catch cross-file issues the per-file hook misses (duplicate `bucket/NN`, broken cross-bucket deps):
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/lint-task.ts docs/<slug>/tasks
   ```
   Pass the **tasks directory** (not a glob) — the script walks bucket dirs and auto-skips `_context/` and any `README.md`. If any violation is reported (PLAN.md refs in any casing, sibling-task refs, missing sections, missing/unparseable `## Eval rubric` or a pass threshold outside the scale, no final-review task or one that doesn't reach every task, broken Required reading paths, H1-vs-path mismatch, bad Status), fix and re-run. Do not finish with violations outstanding.

4. **Generate `tasks/README.md`** from the task headers — index, dep graphs, cross-bucket table:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/build-readme.ts docs/<slug>/tasks
   ```
   The script fails loudly on malformed or duplicate-ref tasks rather than silently dropping them. It preserves human-authored prologue/epilogue (e.g. "Known gaps") between the generated markers. Fill the Known gaps section manually if any surfaced during the interview.

### Step 6 — Stop. Do not execute.

Tell the user where the files live and which task to start from. Do not start implementing. The whole point is that execution happens elsewhere with fresh context.

For the next executor: there is a helper they can run to ask "what should I work on?" — it lists tasks whose dependencies are all `done`:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/next-ready.ts docs/<slug>/tasks
```

## Core principles for the artifacts

Four hard rules. Details for each live in the referenced template.

1. **Task files are self-contained** — an executor needs only `_context/` + the task file. Never reference PLAN.md or other task files. See `references/task-template.md`.
2. **PLAN.md is source of truth; `_context/` mirrors it** — when a decision changes, update PLAN.md and `_context/`, not the task files. See `references/context-files.md`.
3. **Bucket directory is always required** — never write task files directly under `tasks/`. Short plans use a single bucket like `tasks/work/`. This keeps every `Required reading` path identical (`../_context/shared.md`).
4. **Mark unknowns explicitly** — unresolved decisions go into `tasks/README.md` as Known gaps, not into vague tasks. See `references/readme-template.md`.

## File-writing rules

- All paths are relative to the current working directory unless the user specifies otherwise.
- Use kebab-case for `<topic>` and `<slug>`. Two-digit zero-padded `NN`.
- Never overwrite an existing `docs/<topic>/` without explicit confirmation (collision check happens during Step 2).

## Additional resources

- `references/interview-guide.md` — topic-specific question banks, walking-the-tree examples, recommendation rules, stop criteria
- `references/plan-template.md` — PLAN.md template
- `references/task-template.md` — task file template + self-containment checklist
- `references/context-files.md` — `_context/` files and the inline-don't-link rule
- `references/readme-template.md` — `tasks/README.md` template (index, dependency graph, status)
- `references/example-flow.md` — end-to-end example invocation

## Bundled scripts

Reach for these instead of doing the mechanical work by hand. Each one has a tested pure function exported for unit testing.

- `scripts/scaffold.ts` — collision check (`--check`) and dir-tree creation
- `scripts/lint-task.ts` — validates one or more task files against the self-containment contract + the mandatory Eval-rubric shape
- `scripts/build-readme.ts` — regenerates `tasks/README.md` index / dep graphs from task headers
- `scripts/next-ready.ts` — lists tasks whose dependencies are all `done` (executor-session helper)
- `scripts/score-task.ts` — for the executor side: feed `{ dimension: score }` JSON, get a deterministic weighted-average + hard-fail verdict against the task's own rubric (`scoreTask(rubric, scores)` exported). This is the gate a dev→review→rate loop scores against. `--log <file>` appends the verdict to an audit trail.
- `scripts/flightlog.ts` — executor audit trail: `log` appends an agent narrative entry, `report` renders `RUNLOG.md`. Logs live in `docs/<slug>/.flightlog/`, self-gitignored. The `autopilot` skill drives these during a run.

## Automatic hook

The dispatch plugin registers `hooks/flightplan-lint.sh` as a PostToolUse hook on `Edit|Write`. It auto-lints any file that (a) lives at `docs/<slug>/tasks/<bucket>/NN-*.md` and (b) contains the `> **Required reading**:` marker. Anything else is a silent no-op.

When a task file violates the self-containment contract or is missing its Eval rubric, the hook exits 2 with stderr feedback, so the violation surfaces to the LLM immediately rather than waiting for the Step 5 whole-tree lint. Write `_context/` files before task files (see Step 5, point 2) to keep the hook quiet during normal flow.

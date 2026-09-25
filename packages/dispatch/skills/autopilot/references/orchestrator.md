# Autopilot orchestrator — canonical Workflow script

This is the script the `autopilot` skill adapts and passes to the **Workflow** tool.
Read the three hard constraints in `SKILL.md` first. They explain every awkward-looking choice in this file.

> **OpenCode only**: this script describes the **Claude Code Workflow path only**. Every spawn path it asserts — the orchestrator JS layer, `agent()`, the parallel wave dispatch — exists only under the Workflow tool, and OpenCode has no Workflow tool and no equivalent orchestrator process. Under OpenCode, the person or agent invoking the `/autopilot` skill performs the orchestrator's role **by hand**, following the eight-step manual wave loop in `~/.config/opencode/skills/autopilot/references/opencode.md`. Read that file for the steps and the runtime prerequisites. Nothing in this file is ported to OpenCode.

The main agent scouts inline. It then calls `Workflow({ script: <this> })`. **Bake the
scouted values into the `CFG` block at the top of the script as literals.**

Wave loop: `scout → tree guards → derive fresh ready tasks → stall guard → inter-wave commit → budget-floor check → parallel task dispatch, capped by the plan's `maxParallel` → reconciliation → no-progress stop`.

Do NOT rely on the Workflow `args` global. It does not reliably reach the orchestrator.
An unset `args` becomes `undefined`. The scout then runs `bun undefined/next-ready.ts`
and fails. The failure looks like "no work to do", so it is silent.

The main agent already knows every value from the inline scout. Write the values in
directly.

> **Why every path is absolute (`tasksDir` / `planPath` / `logFile` / `scriptsDir` / `relayPath`):** Workflow agents do not share a stable working directory. An agent may `cd` into the tasks tree, for example to read task files. That agent then resolves a *relative* `logFile` against *its own* cwd.
>
> A `bun .../flightlog.ts log docs/<slug>/.flightlog/run.jsonl` command run from inside `docs/<slug>/tasks/` lands in a nested `docs/<slug>/tasks/docs/<slug>/.flightlog/`. This splits the audit trail across two directories. `CLAUDE_PLUGIN_ROOT` likewise never reaches agent Bash, so the orchestrator cannot resolve paths itself.
>
> **Bake every path in as an absolute literal.** Then it resolves identically no matter which agent writes it.
>
> Get the real repo root from `git rev-parse --show-toplevel`. It may be anywhere — `/Users/<name>/Projects/...`, `/opt/temp/project-repo`, `/workspace/...`. Build `<root>/docs/<slug>/...` from that root. Resolve `scriptsDir` from the skill's load-time "Base directory for this skill" banner. If live dev panes are available, resolve `relayPath` during scout.
>
> The result is an unambiguous absolute path. Every agent's Bash and file tools (Read/Write/Glob) resolve it identically.
>
> `~/...` is an *optional* shorthand. Use it **only when the repo genuinely lives under `$HOME`** — Bash and the file tools expand a leading `~`, and this also avoids leaking the username. Never invent a `~` form for a repo outside `$HOME`.
>
> Baking these values in, rather than passing them via `args`, is what makes the run reliable.

## The script

When adapting this script for the Workflow call, strip the explanatory comments. They are for the adapter, not the runtime. Keep only the one-line CFG field comments.

```javascript
export const meta = {
  name: 'autopilot-run',
  description: 'Execute a flightplan task tree: per-task dev→verify→judge→score loop, then the final review gate',
  phases: [
    { title: 'Execute', detail: 'wave loop: scout ready tasks, guard the result, commit the prior wave, then run each task through the retry pipeline' },
  ],
}

// ── Config — BAKE THESE IN (do not rely on the Workflow `args` global) ──────
// Fill from the inline scout; do not rely on `args`.
// Every path must be absolute; see "Why every path is absolute" above.
const CFG = {
  slug:                  'my-plan',
  repoRoot:              '/abs/repo',                          // ABSOLUTE (from git rev-parse --show-toplevel)
  tasksDir:              '/abs/repo/docs/my-plan/tasks',          // ABSOLUTE (from git rev-parse --show-toplevel)
  planPath:              '/abs/repo/docs/my-plan/PLAN.md',        // ABSOLUTE
  logFile:               '/abs/repo/docs/my-plan/.flightlog/run.jsonl',  // ABSOLUTE
  planGoal:              '<one-line goal copied from PLAN.md>',
  maxAttempts:           3,
  finalReviewMaxAttempts: 2,   // bounded re-loop for the closing cross-vendor review round
  scriptsDir:            '/abs/.claude/plugins/cache/.../skills/flightplan/scripts',  // ABSOLUTE
  baseRef:               '<output of `git rev-parse HEAD` captured before calling Workflow>',
  commitBetweenWaves:    true,   // set false to skip inter-wave atomic-commits
  budgetFloor:           0,     // output-token floor: below this, stop dispatching new tasks (0 = off)
  devEngine:             'claude',  // 'claude' (default), 'codex', or 'opencode' — who writes code in the dev step; an external engine has each task written by that CLI via its <engine>-run.ts wrapper (last attempt before the cap still falls back to Claude-Opus)
  lastShotEngine:        '',   // 'codex' | 'opencode' | '' (off) — appends ONE external rung to the END of a Claude dev ladder
  liveDevEngine:         false,   // when devEngine is external and HERDR_ENV=1 + relayPath are fulfilled, run the dev delegate in a visible herdr live pane via relay; headless stays default
  relayPath:             '',      // ABSOLUTE path to relay's relay.ts resolved during scout; empty forces headless because Workflow agents share no cwd
  liveCollectRounds:     3,       // live runs only: how many extra `relay collect` windows (8 min each) to keep waiting for a slow delegate or reviewer before failing the attempt; 0 = fail as soon as relay reports pending
  reviewEngine:          'codex',   // 'codex' (default) or 'opencode' — the cross-vendor reviewer in the closing Final review (driven via <engine>-run.ts review)
  liveReviewEngine:      false,   // when HERDR_ENV=1 + relayPath are fulfilled, run the closing cross-vendor review in a visible herdr live pane via relay; headless stays default. Independent of liveDevEngine — the review lens runs whatever devEngine is
  codexDevModel:         '',        // optional codex model for devEngine or lastShotEngine (empty → wrapper default gpt-5.6-sol)
  codexReviewModel:      '',        // optional codex model for the review lens (empty → wrapper default gpt-6-astra); only applies when reviewEngine is 'codex'
  opencodeDevModel:      '',        // optional opencode model for devEngine or lastShotEngine (empty → wrapper default opencode-go/kimi-k2.7-code); ignored when the engine is codex
  opencodeReviewModel:   '',        // optional opencode model for the review lens (empty → wrapper default opencode-go/qwen3.7-max); only applies when reviewEngine is 'opencode'
  reviewLensModel:       'opus',    // 'opus' (default) or 'fable' — model for the 3 final-review Claude lenses (reuse/leanness/efficiency) ONLY; task headers independently override the fixer + rubric judge
  resumeTask:            '',        // '' = normal whole-tree flight. A task ref ('review/01') runs ONLY that task, with no scout and no wave loop
  resumeTaskPath:        '',        // ABSOLUTE path to that task's file; required with resumeTask, because a resume runs no scout to derive it
  resumeModelsRaw:       null,      // verbatim Models header value, or null when absent
  resumeFinalReview:     false,     // true when the resumed task carries `> **Final review**: true` — the scout normally supplies this
  resumeFrom:            'dev',     // 'dev' | 'verify' | 'judge' — the step the FIRST resumed attempt starts at; every later attempt runs the whole pipeline
  resumeAttempt:         1,         // the attempt number the resumed run starts counting at, so the flightlog and the score rows keep rising
  attestationFile:       '',        // ABSOLUTE path to a human attestation naming which gate items a person performed; REQUIRED when resumeFrom is 'judge'
}

// ── Model policy (tune here — one place) ───────────────────────────────────
// dev implements tasks; the last Claude rung raises its effort one step.
// verify runs the binary gate and drift re-verify; judge scores the rubric.
// fix applies Final review findings; commit groups and records wave changes.
// structuredRetry recovers a failed structured call with a complete choice.
// devExternal and reviewExternal drive external CLIs that do the reasoning.
// reviewLens inspects code quality using the configured model without effort.
// scout reads readiness; markDone and park perform fixed status transitions.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODEL = {
  dev: { model: 'opus', effort: 'medium' },
  verify: { model: 'opus', effort: 'low' },
  judge: { model: 'opus', effort: 'medium' },
  fix: { model: 'opus', effort: 'high' },
  commit: { model: 'opus', effort: 'low' },
  structuredRetry: { model: 'opus', effort: 'medium' },
  devExternal: { model: 'haiku', effort: null },
  reviewExternal: { model: 'haiku', effort: null },
  reviewLens: { model: CFG.reviewLensModel ?? 'opus', effort: null },
  scout: { model: 'haiku', effort: null },
  markDone: { model: 'haiku', effort: null },
  park: { model: 'haiku', effort: null },
}
// Null effort must omit the option so the runtime chooses its own default.
const pick = (choice) => choice.effort ? { model: choice.model, effort: choice.effort } : { model: choice.model }
const raise = (choice) => choice.effort
  ? { ...choice, effort: EFFORTS[Math.min(EFFORTS.indexOf(choice.effort) + 1, EFFORTS.length - 1)] }
  : choice

// Keep this grammar aligned with flightplan/scripts/lib/parse-task.ts; Workflow cannot import it.
const parseModels = (raw) => {
  if (raw === null) return {}
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Models: malformed empty or non-string value')
  const models = {}
  for (const entry of raw.split(',').map(piece => piece.trim()).filter(Boolean)) {
    const match = /^([a-z]+)\s*=\s*([a-z]+)(?:\s*\/\s*([a-z]+))?$/.exec(entry)
    if (!match) throw new Error(`Models entry "${entry}": malformed (expected role=model[/effort])`)
    const [, role, model, effort] = match
    if (!['dev', 'verify', 'judge', 'fix'].includes(role)) throw new Error(`Models entry "${entry}": unknown role "${role}"`)
    if (!['haiku', 'sonnet', 'opus', 'fable'].includes(model)) throw new Error(`Models entry "${entry}": unknown model "${model}"`)
    if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`Models entry "${entry}": unknown effort "${effort}"`)
    if (models[role]) throw new Error(`Models entry "${entry}": duplicate role "${role}"`)
    models[role] = { model, effort: effort ?? null }
  }
  return models
}
const MAX = CFG.maxAttempts ?? 3
const FINAL_MAX = CFG.finalReviewMaxAttempts ?? 2   // the Final review round loops at most this many times before parking
const S = CFG.scriptsDir   // abs path to flightplan/scripts

// ── External CLI engines (codex / opencode) ────────────────────────────────
// Both reduce to a thin `<engine>-run.ts` wrapper with the same delegate/review
// contract, so the dev driver + the cross-vendor review lens are parametrized
// over this map — adding an engine is one entry. `CFG.devEngine` picks who writes
// code in the dev step ('claude' = no external engine, the default); the
// `reviewEngine` const picks the cross-vendor lens in the Final review.
// NOTE: codex review is sandbox-enforced read-only (`codex exec -s read-only`);
// opencode has no sandbox equivalent, so its review is prompt-enforced read-only
// (the wrapper prepends a hard "analyze only" guard). Weaker, but reviewers only
// record findings — the fixer is the sole editor and re-verifies after.
const ENGINES = {
  codex:    { wrapper: 'codex-run.ts',    token: 'CODEX UNREACHABLE',    label: 'codex' },
  opencode: { wrapper: 'opencode-run.ts', token: 'OPENCODE UNREACHABLE', label: 'opencode' },
}
// Attach an optional `--model` flag. Spread into a fresh object so dev and review
// never share a mutated entry even when both name the same engine. Empty modelFlag
// → the <engine>-run.ts default is used (codex: gpt-5.6-sol).
// Throws on an unknown key rather than spreading `undefined` — that would yield
// a truthy `{modelFlag}` object whose `label` is undefined, and the run would die
// far away, inside a Final review reviewer prompt.
// Keyed by engine AND role, because the two vocabularies do not overlap
// (`gpt-6-astra` vs `opencode-go/qwen3.7-max`): handing one CLI the other's model
// name fails at the far end of a wave, not here. Taking the role rather than a
// caller-supplied value is what removes that trap — the call sites below can no
// longer pass opencode's field while running codex.
const MODEL_CFG = {
  codex:    { dev: CFG.codexDevModel,    review: CFG.codexReviewModel },
  opencode: { dev: CFG.opencodeDevModel, review: CFG.opencodeReviewModel },
}
const withModel = (key, role) => {
  if (!ENGINES[key]) throw new Error(`unknown engine "${key}" — CFG.devEngine/lastShotEngine/reviewEngine must be codex or opencode`)
  const model = MODEL_CFG[key][role]
  return { ...ENGINES[key], modelFlag: model ? ` --model ${model}` : '' }
}
const devEngine    = CFG.devEngine && CFG.devEngine !== 'claude' ? withModel(CFG.devEngine, 'dev') : null
// Appended, never substituted: replacing the Opus rung would lose every task that
// only Opus clears. Null whenever devEngine is already external — that ladder
// already ends on Claude-Opus, so it is already a vendor switch.
const lastShotEngine = (!devEngine && CFG.lastShotEngine)
  ? withModel(CFG.lastShotEngine, 'dev')
  : null
const reviewEngine = withModel(CFG.reviewEngine ?? 'codex', 'review')
// Gates the dev driver's delegate command below.
const liveDev = !!(devEngine && CFG.liveDevEngine && CFG.relayPath)
// Gates the closing cross-vendor review lens. Deliberately NOT tied to liveDev:
// the review lens runs on every plan, including an all-Claude one where there is
// no dev delegate to make live. Both still need relayPath, because a Workflow
// agent has no cwd from which a relative path could resolve.
const liveReview = !!(CFG.liveReviewEngine && CFG.relayPath)
// Interpolated into a prompt as a countable instruction, so a fractional or
// negative value would render an incoherent one.
const COLLECT_ROUNDS = Math.max(0, Math.trunc(Number(CFG.liveCollectRounds ?? 3)) || 0)
// Interpolated into an operator-facing reason string and compared against a token
// count, so a negative or fractional value would render an incoherent one.
const BUDGET_FLOOR = Math.max(0, Math.trunc(Number(CFG.budgetFloor ?? 0)) || 0)

// ── Single-task resume ──────────────────────────────────────────────────────
// Re-enter ONE task's pipeline at a named step, taking everything before that
// step as already satisfied. The case it exists for: a task parked at its gate
// with the expensive work already correct and on disk — a Final review whose
// four-lens round and Opus fixer both landed, failing only on a criterion a
// person had to walk. Resetting Status to todo and re-flying pays for that whole
// round again to reach one Haiku verify.
//
// Every value is validated HERE rather than at the call site, because a resume
// runs no scout: nothing downstream re-derives the ref, the path, or the step,
// so a typo would otherwise surface as an agent reading a file that is not there.
const RESUME_STEPS = ['dev', 'verify', 'judge']
const RESUME = !CFG.resumeTask ? null : (() => {
  if (!RESUME_STEPS.includes(CFG.resumeFrom)) {
    throw new Error(`unknown resumeFrom "${CFG.resumeFrom}" — must be one of ${RESUME_STEPS.join(', ')}`)
  }
  if (!CFG.resumeTaskPath) {
    throw new Error('resumeTask is set but resumeTaskPath is empty — a resume runs no scout, so it cannot derive the task file path')
  }
  parseModels(CFG.resumeModelsRaw)
  // Skipping the binary gate means a PERSON performed it. Without a signed
  // artifact the judge would score correctness against no evidence at all,
  // which is the one thing `Grounding the score` forbids.
  if (CFG.resumeFrom === 'judge' && !CFG.attestationFile) {
    throw new Error('resumeFrom "judge" skips the binary gate, so CFG.attestationFile is required — the human who ran that gate has to sign it')
  }
  // No `|| 1` fallback: that turns an explicit 0 into 1 instead of rejecting it,
  // and a resume that quietly renumbers itself to attempt 1 collides with the
  // parked run's own attempt 1 in the score rows.
  const attempt = Math.trunc(Number(CFG.resumeAttempt ?? 1))
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new Error(`resumeAttempt must be a whole number 1 or greater (got ${JSON.stringify(CFG.resumeAttempt)})`)
  }
  return { ref: CFG.resumeTask, path: CFG.resumeTaskPath, modelsRaw: CFG.resumeModelsRaw, finalReview: !!CFG.resumeFinalReview, from: CFG.resumeFrom, attempt }
})()

// Returns the remaining budget when it has fallen below the floor, else null.
// Both "no floor configured" and "no budget declared" are null — not a throw and
// not a stop.
const budgetBelowFloor = () => {
  if (BUDGET_FLOOR <= 0) return null
  // `total === null` is the documented "no target declared" value. Do NOT use
  // a falsy test: a legitimate total of 0 would disable a configured floor at
  // exactly the moment it matters most.
  if (typeof budget === 'undefined' || !budget || budget.total === null) return null
  const left = budget.remaining()
  return left < BUDGET_FLOOR ? left : null
}

// ── Schemas ─────────────────────────────────────────────────────────────────
const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    stdout:   { type: 'string' },   // verbatim stdout, uninterpreted
    exitCode: { type: 'number' },
    stderr:   { type: 'string' },
    // Copied apart from stdout: a cheap model transcribing the blob drops its trailing null field.
    maxParallel: { type: ['integer', 'null'] },
    readyModels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, modelsRaw: { type: ['string', 'null'] } },
        required: ['ref', 'modelsRaw'],
      },
    },
  },
  required: ['stdout', 'exitCode', 'stderr', 'maxParallel', 'readyModels'],
}

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },                        // at least one commit was created
    shas:      { type: 'array', items: { type: 'string' } },// the commits actually created
    failed:    { type: 'boolean' },                        // a git command failed
    reason:    { type: 'string' },                         // the git error, or why nothing was committed
  },
  required: ['committed', 'shas', 'failed', 'reason'],
}

// Both status transitions are infrastructure boundaries: each can silently not
// happen. So each reports a verdict instead of a narrative, confirmed by a
// reread rather than by the agent's say-so.
const MARK_DONE_SCHEMA = {
  type: 'object',
  properties: {
    ok:     { type: 'boolean' },   // command exited 0 AND the reread shows a bare `Status: done`
    status: { type: 'string' },    // the Status value actually read back
    error:  { type: 'string' },    // stderr / what went wrong
  },
  required: ['ok', 'status'],
}

// Parking is the SAME boundary. An agent can return a fluent summary having
// changed nothing — most likely exactly when parking matters, because the task
// is being parked for a malformed header in the first place. An unconfirmed
// park that reports success is worse than a failed one: the file still reads
// `in-progress`, next-ready never re-offers it, and the user is never told to
// reset it by hand.
const PARK_SCHEMA = {
  type: 'object',
  properties: {
    ok:     { type: 'boolean' },   // the reread shows a bare `Status: blocked`
    status: { type: 'string' },    // the Status value actually read back
    error:  { type: 'string' },    // what went wrong
  },
  required: ['ok', 'status'],
}

// `humanPending` is deliberately NOT required: a verifier on a plan that tags
// nothing simply omits it, and making it required would turn every pre-tag plan
// into a schema rejection — an infrastructure park on a task that verified fine.
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },     // every MACHINE-CHECKABLE Verification command + Acceptance criterion passed
    deferred: { type: 'boolean' },   // the red output looks like a sibling's in-flight edits
    summary: { type: 'string' },     // raw evidence: commands run, exit codes, failing output
    humanPending: { type: 'array', items: { type: 'string' } },  // `(human)` gate items nobody has attested to yet
  },
  required: ['passed', 'summary'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: { type: 'object', additionalProperties: { type: 'number' } },  // { Correctness: 5, ... }
    verdict: {
      type: 'object',
      properties: {
        weighted: { type: 'number' },
        passed: { type: 'boolean' },
        hardFailed: { type: 'boolean' },
        missing: { type: 'array', items: { type: 'string' } },
      },
      required: ['weighted', 'passed', 'hardFailed', 'missing'],
    },
    rationale: { type: 'string' },
  },
  required: ['scores', 'verdict', 'rationale'],
}

// ── Prompts ───────────────────────────────────────────────────────────────
// Status ownership is one policy shared by every worker prompt: workers may only
// move a task to in-progress; only the post-judge mark-done step writes `done`.
// Single-sourced here so the three prompts below can never drift apart.
const STATUS_RULE = `Set the task header "> **Status**:" to in-progress and leave it in-progress when you finish. Do not set it to done: only the orchestrator's post-judge mark-done step may do that.`

// The schema is invisible to the agent. Nothing else in a prompt says HOW to
// return, so a model that has just finished a long, tool-heavy turn can write
// its payload as message text and genuinely believe it answered — which is the
// failure `resilient` below exists to retry. One explicit sentence makes it
// rarer. Every schema'd prompt closes on it, including the two the retry
// deliberately skips.
const RETURN_CONTRACT = `Return your result by CALLING the StructuredOutput tool. Writing the JSON as message text — including inside <StructuredOutput> tags — does not return it: the harness rejects the call and the work you just did is discarded.`

// The restore-family ban belongs to every prompt whose agent chooses what to run,
// not only to writers, so it stays separate from the commit ownership rule.
const NO_RESTORE_RULE = `Never run \`git checkout\`, \`git restore\`, \`git reset\`, or \`git clean\` either. Those discard working-tree changes instead of changing git state, so the sentence above does not cover them — do not reason your way past this one. Tasks run in PARALLEL in one shared working tree, so the uncommitted changes around you belong to sibling tasks that are still running. Restoring any path to its HEAD version destroys work that was already finished and graded, and nothing detects it until the run dies much later. If your own edit went wrong, fix it forward by editing the file.
Editing a source file that a sibling task also edits is fine — the plan allows it. What you must never touch is another task's file under the tasks/ tree: it carries that task's Status line, and overwriting it un-schedules work that already passed.`

// Every writer in the run — Claude dev, an external dev delegate, the final-review
// fixer — must leave its work unstaged. Only the labeled commit agents commit.
// A task that commits itself breaks two things at once: the wave's history stops
// being one atomic commit per wave, and a task running in parallel gets its
// half-finished edits swept into someone else's commit.
const NO_COMMIT_RULE = `Never run \`git commit\`, \`git add\`, \`git push\`, \`git stash\`, or any other command that changes git state — not even if the task file asks for it. Leave every change unstaged in the working tree. A dedicated commit agent commits each wave; a task that commits itself splits the wave's atomic history and can sweep a parallel task's half-finished edits into its commit.
${NO_RESTORE_RULE}`

const worktreeRules = (wtPath) => wtPath ? `WORKTREE: ${wtPath}
Run cd ${wtPath} before any command. Every source file you create or edit must have an absolute path starting with ${wtPath}/.
Exactly three kinds of write are exempt: flightlog.ts log into the main-tree flightlog, the task file's Status line in the main tree, and the judge's scratch files under /tmp.
Nothing else may be written outside ${wtPath}/.
Keep the task file and flightlog at their main-tree absolute paths given below. Read and log there; never copy them into the worktree.
Run Verification from ${wtPath}; commands are relative to the repo root.
Run external drivers as cd ${wtPath} && <command> in one shell call.
` : ''

const devPrompt = (ref, path, attempt, feedback, wtPath) => `
${worktreeRules(wtPath)}
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

You are implementing flightplan task ${ref} in the tree at ${CFG.tasksDir}.
Read the task file at ${path} and every file in its "Required reading".
Implement the task fully: create/modify the listed files, follow Implementation notes.
${attempt > 1 ? 'This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nAddress that specifically.' : ''}
${STATUS_RULE} When done, run the task's ## Verification commands yourself.
${NO_COMMIT_RULE}
Then log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "<your label>" --phase end --message "<what you changed>"
Return a one-paragraph summary of what you did.`

// External-engine dev driver — used when CFG.devEngine is 'codex' or 'opencode'.
// The agent does NOT hand-write the implementation; it has the external CLI write
// it via our thin `<engine>-run.ts delegate` wrapper, or optionally via relay in a
// visible herdr live pane, then lints the task file and reports what landed. The
// DRIVER does NOT run the task's Verification commands — the independent verify
// agent immediately downstream is the binary gate, the driver's return value is
// discarded, and the driver has no lever to act on red output anyway.
// The DELEGATE does run them, and step 3 hands it the commands to run: it holds
// the shell and the working tree, so it is the only party that can act on red
// output. Copying the Acceptance criteria without the Verification commands used
// to give it the claim it is graded on but not the command that proves it —
// measured over one 47-task flight, 13 of 23 retried tasks failed at the FIRST
// verify, on commands the engine had never been shown. That is also why step 3
// forbids editing a command or a test to reach green: the verifier re-runs the
// same commands, so a weakened test would clear both gates. The driver
// reads the command stdout only — it never mines temp/transcript files. The driver feeds the CLI the full
// task context so it never needs to pause for clarification (it runs non-interactively).
// If the CLI is unreachable the driver must NOT fabricate code — it reports failure
// so the binary gate fails the attempt and the loop proceeds to the next rung when
// one remains, or parks after the cap.
const devExternalPrompt = (engine, ref, path, attempt, feedback, wtPath) => `
${worktreeRules(wtPath)}
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "dev-${engine.label}:${ref}#${attempt}" --phase start
Then proceed.
Use the identical label expression "dev-${engine.label}:${ref}#${attempt}" in both start and end calls. It names this task and attempt, so parallel delegates never close each other's row.

You are the ${engine.label.toUpperCase()} DEV DRIVER for flightplan task ${ref} (tree: ${CFG.tasksDir}). You do NOT write the implementation yourself — you have the ${engine.label} CLI write it, then you report what landed. You do NOT run the task's ## Verification commands: an independent verifier runs them straight after you, and your verdict would carry no weight.
1. Read the task file at ${path} and every file in its "Required reading". Note its "Files to create / modify" list and "Implementation notes".
2. ${STATUS_RULE} Tell the external engine to leave it in-progress too.
${NO_COMMIT_RULE}
3. Build the ${engine.label} instruction from the task file — copy its Goal, "Files to create / modify", Implementation notes, Acceptance criteria, and ## Verification commands across as they are written, and tell ${engine.label} to implement the task fully and stay strictly within the listed files. Tell it to RUN the Verification commands itself and keep working until they pass before it reports back — it holds the shell and the working tree, so it is the only party that can act on red output. Tell it in the same instruction that those commands and the tests they run are FIXED: it fixes the code until a command passes, and never edits, weakens, or skips the command or a test to get there. ${wtPath ? "Include the worktree rules in that instruction, with the exact worktree and main-tree paths. " : ""}Include the no-commit rule in that instruction, in your own words but with the same force: ${engine.label} writes the working tree and would otherwise commit its own work. Give it EVERYTHING up front; the wrapper and the live flag both attach the unattended contract themselves, so the instruction never has to carry it.
   INSTRUCTION SHAPE — three things must never appear in that file. (a) Implementation code you wrote: no ready-to-paste source for the files ${engine.label} is meant to create. A delegate that transcribes your code delivers your solution, and the only reason an external engine writes this task is to get one Claude did not author — pass the task file's notes and let it solve. (b) A softened gate: never reword, weaken, or drop an Acceptance criteria or a Verification command, and never tell ${engine.label} to skip one because it failed or looked unrunnable before. A gate you believe is wrong is a plan defect — leave it standing and let the binary gate judge the result. (c) A claim that existing work is already correct.${attempt > 1 ? `
   RETRY — this is attempt ${attempt}. The previous attempt was rejected:
${feedback}
   Fold that feedback into the instruction so ${engine.label} fixes exactly it. Feedback may only ADD requirements. It may never subtract a verification command, mark a gate optional, or tell ${engine.label} the last attempt's code was already right and only needs re-checking — the rejection means a gate went unmet, and an instruction that opens by excusing the previous attempt reproduces it.` : ''}
4. Write that instruction to a temp file${wtPath ? ` under ${wtPath}/` : ""}, then run this as ONE FOREGROUND Bash call with \`timeout: 600000\` (the Bash tool maximum):
  ${wtPath ? `cd ${wtPath} && ` : ""}${liveDev ? `bun ${CFG.relayPath} ${engine.label} delegate --prompt-file <your-instruction-file> --git-scope none --dangerous --no-ask --wait-timeout 480000` : `bun ${S}/${engine.wrapper} delegate${engine.modelFlag} --prompt-file <your-instruction-file>`}
   WAIT RULE — never improvise a wait. Do NOT set \`run_in_background\`. Do NOT write a shell poll loop (\`while\`, \`jobs\`, \`wait\`, repeated \`tail\`). Every Bash call gets a fresh shell, so \`jobs\` can never see a command an earlier call started: such a loop spins until the 600s cap and burns ten minutes AFTER ${engine.label} has already finished. ${liveDev ? `The \`--wait-timeout 480000\` above is sized to expire inside the 600s cap with margin for relay's pane spawn and cleanup, so this one call normally returns on its own. It can still outrun the cap: when relay cannot spawn a pane it falls back to headless inside the same invocation, and headless has no timeout at all.` : ''} If the harness reports that the call outran the cap and was moved to the background, do not poll: wait for the completion notification, then Read the output file it named, once.
   ${liveDev ? `Relay runs ${engine.label} in a visible herdr live pane, edits the working tree directly, prints the delegate result on stdout, then closes the pane on success. Read that stdout — do NOT go looking for any temp/transcript files.` : `The headless wrapper has ${engine.label} edit the working tree directly, then prints its summary plus a \`git status --short\` of what changed, and cleans up its own scratch. Read that stdout — do NOT go looking for any temp/transcript files.`}
${liveDev && COLLECT_ROUNDS > 0 ? `5. PENDING — relay prints a report starting "Live ... still running after ...". ${engine.label} is NOT finished and has NOT failed: it is still writing the working tree, and the pane is still open. Do NOT retry, do NOT hand-write anything, and do NOT go to step 6 yet. Keep waiting instead: copy the \`relay ... collect --agent <name> --result <path>\` command the report prints, and run it — again ONE foreground Bash call with \`timeout: 600000\`, and the same WAIT RULE. It reattaches to that same pane and watches for another window. Run collect **at most ${COLLECT_ROUNDS} times in total** — the first collect is round 1, so after round ${COLLECT_ROUNDS} you stop. The moment any collect prints the delegate's result, continue at step 6 as a normal success. Only when round ${COLLECT_ROUNDS} still reports pending, go to step 5b.
5b. FAILURE PATH` : `5. FAILURE PATH`} — the command exits non-zero${liveDev ? `, or relay returns an empty/absent result${COLLECT_ROUNDS > 0 ? ', or the last allowed collect is still pending' : ', or relay prints a PENDING report ("still running after ... this is NOT a failure" — relay exits 0, but autopilot counts that delegate as NOT finished)'}` : `, or its output begins with "${engine.token}"`}. Then: do NOT hand-write the implementation yourself, and do NOT return early. Run steps 6 and 7 as usual, then return a summary whose FIRST word is FAILED, stating ${engine.label} was unreachable, failed, or timed out.${liveDev ? ' For a still-pending delegate, name the Agent from relay stdout in the step-7 log and note the pane was LEFT OPEN and is STILL WRITING the working tree.' : ''} Step 6 still runs on this path: the lint keeps the task file well-formed whatever ${engine.label} left behind, and the changed-file check is what tells the flightlog whether anything landed at all. The binary gate then fails this attempt; the loop moves to the next rung when one remains, or parks after the cap.
6. Lint the task file, then note what landed. The lint runs FIRST:
     bun ${S}/lint-task.ts ${path}
   The external engine edits files outside the harness, so the Edit/Write lint hook never saw its work — this call is the only structural check on the task file. A non-zero exit means the engine left the task file malformed (a decorated Status, a hand-ticked gate box, a sibling-task reference). Repair the header yourself until it lints clean: reset "> **Status**:" to a bare \`in-progress\`, and never hand-tick an Acceptance criteria or Verification box. Repair the HEADER only — never reword an Acceptance criteria or Verification item, even when lint names that item (a \`scope-git-status\` violation is a plan defect, not yours to edit). Rewriting a gate to make it pass is the same failure as ticking its box. Leave the violation standing and let the binary gate judge the work.
   Then establish only WHETHER work landed, not whether it is correct: read the changed-file list from the command's stdout, or run \`git status --short\` once if that stdout did not print one. Do NOT run the task's ## Verification commands, do NOT run the test suite, and do NOT edit a source file to make anything pass. An empty changed-file list means ${engine.label} produced nothing and belongs in your step-7 log and your summary. A non-empty one is all you report — the independent verifier downstream runs every command and owns the pass/fail verdict, including any red output you would have seen here.
7. Log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "dev-${engine.label}:${ref}#${attempt}" --phase end --message "<what ${engine.label} changed, or '${engine.label} unreachable'>"
Return a one-paragraph summary: what ${engine.label} implemented and which files changed.`

// ── Final review: orchestrator-level multi-lens review fan-out ──────────────
// The dev and the rubric judge are both Claude, so they share blind spots. The
// Final review task's "dev" step is therefore not a Claude self-review — it is a
// fan-out of independent review lenses, then a single Opus fixer that reads all
// their findings and applies them. The fan-out happens HERE in the orchestrator
// (parallel agent() calls), NOT inside one agent — a Workflow agent has no Agent
// tool, so it can't spawn reviewers itself, but the orchestrator can. This
// recovers the cross-vendor external review + /simplify multi-agent power we couldn't
// run from inside a single workflow agent. Lenses:
//   - <reviewEngine>: cross-vendor (codex/opencode) bug/correctness review via <engine>-run.ts review
//   - reuse         : duplicated logic, missed reuse of existing helpers,    ┐ the three
//                     copy-paste that wants a helper (the ADD direction)     │ Claude
//   - leanness      : what to DELETE — stdlib/native/yagni/dead/shrink       │ quality
//   - efficiency    : wasteful work, N+1s, redundant passes/allocations      ┘ lenses
// The external engine owns bugs (where cross-vendor diversity matters most); the
// three Claude lenses own quality cleanups. Reviewers only record findings to
// files; only the Opus fixer edits code. The fixer ≠ judge, so the dev≠judge
// anti-bias split holds.
//
// `leanness` replaced the old `simplification` + `altitude` pair. Those two
// overlapped each other, and `altitude` was the only lens pointing in BOTH
// directions at once — it flagged over-engineering AND under-engineering, so on
// one span of code it could tell the fixer to inline an abstraction while
// pointing at the same span and asking for a helper. The fixer reads every
// findings file at once with no arbitration rule, so a lens that argues with
// itself is a lens the fixer has to guess about. Now the direction is split by
// lens instead: on the abstraction axis `reuse` may ask for MORE code, `leanness`
// only ever asks for less. That split is scoped to the abstraction axis and says
// nothing about `efficiency`, whose cheaper approach may well be a cache or a
// batch — stating it as a blanket "every other lens only cuts" would give the
// fixer a reason to reject a valid perf fix for adding lines.
// `leanness` also closes a real gap — `reuse` looks for reuse *inside the
// codebase*, so nothing used to catch hand-rolled stdlib or a dependency doing
// what the platform already ships.
const REVIEW_LENSES = [
  { key: reviewEngine.label, external: reviewEngine, choice: MODEL.reviewExternal, focus:
    'CROSS-VENDOR bug & correctness review — driven through the external CLI wrapper (see the external-engine prompt branch).' },
  { key: 'reuse', choice: MODEL.reviewLens, focus:
    'REUSE. Find duplicated logic and code that reinvents something the codebase already provides (existing helpers, utils, types, patterns). Also flag under-engineering: copy-paste that wants a helper. On the abstraction axis you are the only lens that may ask for MORE code — leanness only ever cuts, so a missing abstraction is yours to raise, not its. Each finding: file:line, what duplicates what, the reuse to apply.' },
  { key: 'leanness', choice: MODEL.reviewLens, focus:
    `LEANNESS — over-engineering only. Hunt what to DELETE. The diff's best outcome is getting shorter.
Correctness bugs, security holes, and performance are OUT of scope: another lens owns each. Do not report them.
Write ONE LINE per finding, in this exact shape:
  <file>:L<line>: <tag> <what>. <replacement>.
Tags — use exactly one per finding:
  delete:  dead code, unused flexibility, speculative feature. Replacement: nothing.
  stdlib:  hand-rolled thing the standard library ships. Name the function.
  native:  dependency or code doing what the platform/runtime already does. Name the feature.
  yagni:   abstraction with one implementation, config nobody sets, layer with one caller.
  shrink:  same logic, fewer lines. Show the shorter form.
Be blunt and concrete. No hedging, no "have you considered", no questions.
  BAD:  "This EmailValidator class might be more complex than necessary?"
  GOOD: \`src/mail.ts:L12-38: stdlib: 27-line validator class. "@" in email, 1 line, real validation is the confirmation mail.\`
  GOOD: \`src/fmt.ts:L4: native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.\`
  GOOD: \`repo.ts:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.\`
A single smoke test or assert-based self-check is the minimum, not bloat — never flag one for deletion.
End your file with exactly one summary line: \`net: -<N> lines possible.\` — omit it if you wrote "No findings.".` },
  { key: 'efficiency', choice: MODEL.reviewLens, focus:
    'EFFICIENCY. Find wasteful work — redundant passes, N+1 calls, recomputation, needless allocations/IO. Each finding: file:line, the cheaper approach.' },
]

// findings live under the flightlog dir (self-gitignored) → audit artifact
const reviewDir = (attempt) => `${CFG.logFile.replace(/\/[^/]+$/, '')}/review/attempt-${attempt}`

// The cross-vendor lens drives an external CLI (codex/opencode) through our
// wrapper; the three Claude lenses review the diff themselves. Branch on
// lens.external (the resolved ENGINES entry; undefined for a Claude lens).
const reviewPrompt = (ref, lens, attempt) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role review --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

${NO_RESTORE_RULE}

${lens.external ? `
You are the ${lens.external.label.toUpperCase()} (cross-vendor) reviewer in the FINAL REVIEW of flightplan ${CFG.slug} (task ${ref}). You do NOT review the code yourself — you have the ${lens.external.label} CLI review it and you record its findings.
1. Write a review instruction to a temp file: tell ${lens.external.label} to review THIS run's changes for BUGS & CORRECTNESS (logic errors, broken edge cases, regressions, security) — it should inspect both \`git diff ${CFG.baseRef}..HEAD\` (committed task changes) and \`git diff\` (uncommitted fixer edits) and report each issue with file:line and the concrete fix. Include the restore-family ban in that instruction, in your own words but with the same force.
2. Run this as ONE FOREGROUND Bash call with \`timeout: 600000\` (the Bash tool maximum): ${liveReview ? `bun ${CFG.relayPath} ${lens.external.label} review${lens.external.modelFlag} --git-scope none --dangerous --no-ask --wait-timeout 480000 --prompt-file <your-instruction-file>` : `bun ${S}/${lens.external.wrapper} review${lens.external.modelFlag} --prompt-file <your-instruction-file>`}
   ${liveReview ? `Relay runs ${lens.external.label} in a visible herdr live pane, prints its findings on stdout, then closes the pane. It is a REVIEW: relay's prompt contract tells ${lens.external.label} to analyze only, and you must not let it edit anything either. Read that stdout — don't look for any temp/transcript files.` : `It reads the repo + diffs and prints the CLI's findings, leaving no scratch. Read that stdout — don't look for any temp/transcript files.`}
   WAIT RULE — do NOT set \`run_in_background\`, and never write a shell poll loop (\`while\`, \`jobs\`, \`wait\`): a fresh shell per Bash call means \`jobs\` can never see an earlier call's command, so the loop spins to the 600s cap long after ${lens.external.label} finished. ${liveReview ? `The \`--wait-timeout 480000\` above is sized to expire inside that 600s cap with margin for relay's pane spawn and cleanup, so this one call normally returns on its own. ` : ''}If the harness moves the call to the background, wait for the completion notification and Read the output file it named, once.
${liveReview && COLLECT_ROUNDS > 0 ? `2b. PENDING — relay prints a report starting "Live ... still running after ...". ${lens.external.label} has NOT failed: it is still reviewing, and the pane is still open. Do NOT retry and do NOT write the findings file yet. Copy the \`relay ... collect --agent <name> --result <path>\` command the report prints and run it — again ONE foreground Bash call with \`timeout: 600000\`, and the same WAIT RULE. It reattaches to that same pane for another window. Run collect at most ${COLLECT_ROUNDS} times in total — the first collect is round 1, so after round ${COLLECT_ROUNDS} you stop. The moment any collect prints the findings, continue at step 3 as a normal success. Only when round ${COLLECT_ROUNDS} still reports pending is this an unreachable run.
` : ''}3. Write the printed findings to ${reviewDir(attempt)}/${lens.key}.md (run \`mkdir -p ${reviewDir(attempt)}\` first). If the ${liveReview ? 'command' : 'wrapper'} exits non-zero${liveReview ? ', returns an empty or absent result, or is still pending after the last allowed collect' : ''}, or its output begins with "${lens.external.token}", write exactly "${lens.external.token}" as the first line of that file — do NOT skip silently (a missing cross-vendor pass must fail this task, not pass it quietly).` : `
You are the ${lens.key.toUpperCase()} reviewer in the FINAL REVIEW of flightplan ${CFG.slug} (task ${ref}). Review the WHOLE autopilot diff — all changes committed during this run — through ONE lens only:
${lens.focus}
Get the full diff with BOTH commands:
  git diff ${CFG.baseRef}..HEAD   # committed task changes from this run
  git diff                         # uncommitted edits (a previous Final review fixer retry may have left changes in the working tree)
Combine both outputs — the working-tree diff covers any retry attempt's edits that are not yet committed.
Write your findings to ${reviewDir(attempt)}/${lens.key}.md (run \`mkdir -p ${reviewDir(attempt)}\` first), in the output format your lens specifies above — default to a short markdown bullet list when it names none. Every finding carries file:line and the concrete fix. If nothing is material, write exactly "No findings.".`}
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role review --attempt ${attempt} --agent "<your label>" --phase end --message "<findings count>"
You are a REVIEWER: do NOT edit any source file — only record. Return a one-line count of findings.`

const fixPrompt = (ref, path, attempt, feedback) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role fix --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

You are the FINAL REVIEW fixer for flightplan ${CFG.slug} (task ${ref}), on Opus. Independent reviewers have each written findings to ${reviewDir(attempt)}/ (one file per lens: ${reviewEngine.label}, reuse, leanness, efficiency).
1. Read EVERY file in ${reviewDir(attempt)}/. If ${reviewEngine.label}.md is MISSING, is empty, or begins with "${reviewEngine.token}", call that out prominently — the cross-vendor pass did not run.
2. Apply the real fixes (you have Edit/Write). Use judgement: fix correctness / integration / regression issues from the cross-vendor lens, and the safe quality cleanups from the three Claude lenses (behaviour-preserving). On the ABSTRACTION axis the two lenses point opposite ways on purpose: \`reuse\` may ask for more code, \`leanness\` only ever asks for less. Where they land on the same span, that is a genuine trade-off for you to settle — not a contradiction to route around. This split says nothing about \`efficiency\`: a cheaper approach that needs a cache, a batch, or an index is a normal fix, so never reject an efficiency finding merely because it adds code. For any finding you reject, say why.
3. VERIFY. Open the task file at ${path} and run its ## Verification commands yourself; confirm green and that the PLAN goal ("${CFG.planGoal}") is met.
${attempt > 1 ? 'This is re-loop attempt ' + attempt + ' (capped at ' + FINAL_MAX + '). The previous round was rejected:\n' + feedback + '\nEnsure the new findings + your fixes address that.' : ''}
${STATUS_RULE}
${NO_COMMIT_RULE}
Log a narrative note (which lenses fired, total findings, what you fixed, whether the cross-vendor lens ran):
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role fix --attempt ${attempt} --agent "<your label>" --phase end --message "<summary>"
Return a one-paragraph summary: lenses run, cross-vendor status, key fixes, verification result.`

// Run the Final review "dev" step: fan out the lenses in parallel, then one
// task-selected fixer applies every finding. Replaces the single dev agent for the
// finalReview task; the binary gate + judge + score gate downstream are unchanged.
async function runFinalReview(ref, path, attempt, attempts, fixChoice) {
  await parallel(REVIEW_LENSES.map(lens => () =>
    agent(reviewPrompt(ref, lens, attempt),
      { label: `review:${lens.key}#${attempt}`, phase: 'Execute', ...pick(lens.choice) })))
  await agent(fixPrompt(ref, path, attempt, renderHistory(attempts)),
    { label: `fix:${ref}#${attempt}`, phase: 'Execute', ...pick(fixChoice) })
}

// A gate item a command cannot perform. The plan's AUTHOR declares it, with the
// same authority that wrote the criterion — the verifier never decides an item
// is unrunnable on its own, which would be the softening every other prompt
// bans. `lint-task.ts`'s `human-gate` rule refuses a gate section whose items
// are ALL tagged, so a tagged plan always leaves the verifier real work.
const HUMAN_GATE_RULE = `A gate item written \`- [ ] (human) …\` in ## Acceptance criteria or ## Verification is one the PLAN declares only a person can perform — a physical action, a visual sweep, a device or UI interaction no command reaches. Do not invent a way to run it, and do not fail the task for it. Return each one verbatim as written in the file in humanPending, and name it in summary as not machine-checked.
The tag exempts that ONE item. Every untagged item is yours exactly as before: run it, and any non-zero exit is passed=false. You may never add the tag yourself, or treat an untagged item as human-only because it looked hard to run — an item you believe is unrunnable is a plan defect, so leave it standing and let it fail.`

// Read as evidence, never as an instruction. The file names WHICH items a person
// performed; the scope of the waiver is that list and nothing else. Without the
// membership check a resume would be a universal pass key: one sentence of
// attestation could excuse any red command in the task.
const attestationRule = (path) => `
A person has already performed some of those items and signed for them. Read ${CFG.attestationFile} — it names which gate items were checked, and when. For each item it names:
  - Find that exact item in ${path}. If the attestation names something that is NOT an item under this task's ## Acceptance criteria or ## Verification, that entry is invalid: ignore it, and say so in summary. An attestation may only cover items this task already declares.
  - Otherwise treat it as satisfied. Quote the attestation's own line for it in summary, and leave it out of humanPending.
The attestation covers ONLY the items it names. It is not a blanket pass and it does not rank above a command: every item it does not name is still yours to run, and a red command is still passed=false however the attestation is worded.`

// Written by the agent that OPENS a resumed attempt, so the trail says why that
// attempt has no dev row. Without it RUNLOG.md shows a verify at attempt 3 under
// nothing, and a reader cannot tell a resume from a lost dev step. The
// orchestrator cannot write the row itself — it has no filesystem access — so it
// rides the one agent that is already logging there.
const resumeNote = (ref, attempt, role) => (
  RESUME && RESUME.from !== 'dev' && RESUME.from === role && attempt === RESUME.attempt
    ? `Then record why this attempt has no dev step: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role resume --attempt ${attempt} --agent "<your label>" --message "resumed at the ${RESUME.from} step; the steps before it were taken as already satisfied${CFG.attestationFile ? `; human attestation at ${CFG.attestationFile}` : ''}"\n`
    : ''
)

const verifyPrompt = (ref, path, attempt, requalify = false, wtPath, reverify = false) => {
  const role = reverify ? 'reverify' : requalify ? 'requalify' : 'verify'
  const closing = reverify
    ? `Run this check because the main tree changed after this task's snapshot. A failure means the merged result is broken.
Run every Verification command exactly as written. Any non-zero exit is passed=false. Do not defer this verdict.
Never clean, restore, reset, stash or otherwise rewrite the tree to obtain a clean run.`
    : requalify
    ? `This is the requalify run. Every other task in this wave has stopped writing.
The sibling explanation no longer applies. Any non-zero exit is passed=false. deferred is ignored on this run.`
    : `Tasks in this wave run in PARALLEL${wtPath ? ", each in its own worktree" : " in the main tree"}.
Never clean, restore, reset, stash or otherwise rewrite the tree to obtain a clean run.
Run every Verification command exactly as written. Any non-zero exit is passed=false.
If — and only if — the evidence points at a sibling task's in-flight edits, also return deferred=true, prefix summary with the exact string SUSPECTED SIBLING INTERFERENCE, give the exact command and exit code, failing cases, and concrete evidence for attribution. The commands will then be run again once other tasks stop writing.
Deferring waives nothing and never changes a verdict on its own. An unsupported deferral is counted as a plain failure.`
  return `
${reverify ? `Work in the repo root: ${CFG.repoRoot}. Run every command from that directory.\n` : worktreeRules(wtPath)}First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role ${role} --attempt ${attempt} --agent "<your label>" --phase start
${resumeNote(ref, attempt, role)}Then proceed.
Use the identical label in both start and end calls.

You are an INDEPENDENT verifier for flightplan task ${ref} (tree: ${CFG.tasksDir}).
${NO_RESTORE_RULE}
Do NOT trust the dev's claims. Open the task file at ${path}, then:
  1. Run every concrete command in its ## Verification section yourself.
  2. Check every box in ## Acceptance criteria against the actual code/output.
Report passed=true ONLY if all verification commands succeed AND all acceptance criteria hold.
Put the raw evidence (commands, exit codes, failing output) in summary. Do not make subjective quality judgements — that is the rubric judge's job.
${HUMAN_GATE_RULE}${CFG.attestationFile ? attestationRule(path) : ''}
${closing}
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role ${role} --attempt ${attempt} --agent "<your label>" --phase end --message "<PASS or FAIL> — <one line: which command or criterion decided it>"
The message MUST start with the bare word PASS or FAIL. The dashboard colours the row from that word, and a message that starts with neither leaves the row uncoloured — it does not default to green.
When humanPending is not empty, end that same message with " — NEEDS HUMAN: <n> item(s)". The run's final report reads the structured list, but RUNLOG.md is what a person opens weeks later, and a pending check that appears in neither is a check nobody makes.
${RETURN_CONTRACT}
`
}

// Substituted for a verifier's evidence when `resumeFrom: 'judge'` skips the
// binary gate. It says plainly that no agent ran the commands, so the judge
// grounds correctness in the signed artifact and in what that artifact omits —
// rather than in a verdict nobody produced.
const humanGateSummary = () =>
  `HUMAN-SUPPLIED BINARY GATE — this run did NOT re-run the task's ## Verification commands. A person performed the binary gate by hand and signed it at ${CFG.attestationFile}. `
  + `Read that file: it names which gate items were checked, and when. Ground the correctness dimension in it exactly as you would in a verifier's raw output. `
  + `Treat every gate item the file does NOT name as unverified — say so in your rationale and score correctness accordingly. Do not assume an unnamed item passed.`

const judgePrompt = (ref, path, gateSummary, attempt, wtPath) => `
${worktreeRules(wtPath)}
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role judge --attempt ${attempt} --agent "<your label>" --phase start
${resumeNote(ref, attempt, 'judge')}Then proceed.
Use the identical label in both start and end calls.

You are the rubric judge for flightplan task ${ref} (tree: ${CFG.tasksDir}).
${NO_RESTORE_RULE}
The independent binary gate already PASSED with this evidence:
${gateSummary}
Open the task file at ${path} and its ## Eval rubric. Score EACH dimension 0–scaleMax based on the real code and the verification evidence above — ground the correctness dimension in that evidence, not opinion.
Write the scores JSON to a temp file, then run score-task.ts to compute and persist the verdict:
  echo '<scores-json>' > /tmp/scores-${ref.replace('/','-')}.json
Write your full rationale — the same prose you return — to /tmp/rationale-${ref.replace('/','-')}-a${attempt}.md using the Write tool, NOT a shell heredoc or echo: it is long markdown and shell quoting will mangle it. Then:
  bun ${S}/score-task.ts ${path} /tmp/scores-${ref.replace('/','-')}.json --json --log ${CFG.logFile} --attempt ${attempt} --agent "<your label>" --rationale-file /tmp/rationale-${ref.replace('/','-')}-a${attempt}.md
The rationale file is what puts your reasoning into the run's audit trail. Without it the trail keeps only a number, and a reader cannot tell why the task passed.
If the command exits 1, that is a valid rubric failure; still return the printed JSON verdict. Return the CLI's printed verdict object VERBATIM as "verdict", plus your scores and rationale.
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role judge --attempt ${attempt} --agent "<your label>" --phase end --message "<weighted score>"
${RETURN_CONTRACT}
`

const markDonePrompt = (ref, path) => `
Finalize flightplan task ${ref} at ${path}. Do this in three steps and report a verdict.
1. Run: bun ${S}/mark-done.ts ${path}
   It deterministically sets "> **Status**: done" AND ticks every checkbox in the task's ## Acceptance criteria and ## Verification sections in ONE transition (the task passed the gate, so all hold). It validates the header FIRST: on a malformed header it exits non-zero and writes nothing at all.
2. Re-read ${path} and find the "> **Status**:" line in the header blockquote.
3. Return ok=true ONLY if the command exited 0 AND that line reads exactly "> **Status**: done" with nothing after the value. Put the value you actually read into status.
   Otherwise return ok=false, the value you read into status, and the command's stderr into error.
Change nothing else by hand. NEVER edit the Status line or tick a checkbox yourself — if mark-done.ts failed, report the failure. A hand-written "done" would fake a gate result that the tree then trusts forever.
${RETURN_CONTRACT}`

const markBlockedPrompt = (ref, path, reason) => `
Park flightplan task ${ref} at ${path}. Do this in three steps and report a verdict.
1. Edit the "> **Status**:" line in the header blockquote to read exactly "> **Status**: blocked" — the value bare, with nothing after it. If that line is currently malformed (decorated, duplicated, or missing), REPAIR it to that exact bare form. Change nothing else in the file.
2. Re-read ${path} and find the "> **Status**:" line in the header blockquote.
3. Return ok=true ONLY if that line now reads exactly "> **Status**: blocked" with nothing after the value. Put the value you actually read into status.
   Otherwise return ok=false, the value you read into status, and what stopped you into error.
Do not tick or untick any checkbox. (Parked by autopilot: ${reason})
${RETURN_CONTRACT}`

// ── Structured-output resilience ────────────────────────────────────────────
// A schema'd `agent()` fails two ways. It resolves to `null` on a terminal API
// failure — that is what every `if (!gate)` guard below tests for. And it
// REJECTS when the subagent writes its payload as message text instead of
// calling the StructuredOutput tool. The harness nudges once and gives up, so
// the throw is what reaches us.
//
// Catching that throw is not the same as recovering from it. By the time it
// happens the agent has usually done all of the real work: live in run
// `wf_b03e0034-f95` the Final review verifier ran every check and wrote its
// `PASS` flightlog row, then emitted the verdict as text — and parking that as
// an infrastructure failure threw away a complete, green review round.
//
// So retry once, and only once. What makes a second run cost time and nothing
// else is that every call wrapped here is IDEMPOTENT: `verify` and `requalify`
// only read, `mark-done.ts` validates the header before it writes anything, the
// park is an idempotent edit, and the scout runs one read-only command. The
// retry replaces both model and effort so the failed call cannot leak its choice.
//
// Two callers are deliberately NOT wrapped, both for the same reason — they
// persist something before they return, so a second run is not free:
//   - the commit agents, where a retry after a partial commit writes a second,
//     incoherent commit. They keep `settled()`: report, never re-run.
//   - the rubric judge, which appends a verdict row via `score-task.ts --log`.
//     See the call site.
// A wrapped call may still duplicate its narrative flightlog rows. That is the
// accepted cost: the retry genuinely happened, so a trail showing both attempts
// is truthful. Duplicating a persisted VERDICT is not, which is where the line sits.
const resilient = async (make, retryModel) => {
  try {
    return await make(null)
  } catch (error) {
    log(`retrying a structured call on ${retryModel.model}${retryModel.effort ? `/${retryModel.effort}` : ''}: ${error?.message ?? String(error)}`)
    return await make(retryModel)
  }
}

// ── Failure shapes ──────────────────────────────────────────────────────────
// Two kinds of failure, handled differently:
//   QUALITY        — the work was judged and found wanting (gate failed, rubric
//                    below threshold). Retrying the dev loop is the right move.
//   INFRASTRUCTURE — nothing was judged at all: an agent returned no structured
//                    result, or the pipeline threw. Retrying dev would burn a
//                    second attempt on top of an unknown state, so the task is
//                    escalated immediately; only unlanded tasks are parked.
// The distinction has to survive to the wave loop, so it rides in the result.
const withKeptWorktree = (ref, reason) => reason
  + (live.has(ref) ? `\nWorktree kept at ${live.get(ref)}` : '')

const infrastructureFailure = (ref, attempt, cause, parked) => ({
  task: ref,
  passed: false,
  infrastructure: true,
  // The attempt that was actually running. Compute WAS consumed; reporting 0
  // here would misrepresent the run.
  attempt,
  parked,
  reason: withKeptWorktree(ref, cause),
})

// Best-effort park before land. Every pre-land catch path must record whether it
// worked — an unparked task stays `in-progress`, which next-ready never offers
// again, so it would vanish from the tree without a trace.
//
// "Worked" means the file was REREAD and shows a bare `Status: blocked`. An
// agent that returns a fluent summary having changed nothing is the failure mode
// this guards, so a non-null result is not evidence of anything.
async function parkBlocked(ref, path, reason, watch) {
  return withWriter(watch, async () => {
    try {
      const result = await resilient(retryModel => agent(markBlockedPrompt(ref, path, withKeptWorktree(ref, reason)),
        { label: `block:${ref}`, phase: 'Execute', ...pick(retryModel ?? MODEL.park), schema: PARK_SCHEMA }),
        MODEL.structuredRetry)
      return result?.ok === true
    } catch {
      return false
    }
  })
}

// Reproduces today's two feedback strings verbatim, so the prompt text a retry
// sees does not regress — only its scope widens.
const rejectionOf = (a) => a.weighted !== null
  ? `Rubric score ${a.weighted.toFixed(2)} did not pass`
    + (a.hardFailed ? ' (hard-fail veto)' : '')
    + (a.missing.length ? ` (missing dims: ${a.missing.join(', ')})` : '')
    + `:\n${a.rationale}`
  : `Binary gate failed (verification/acceptance):\n${a.gateSummary ?? 'no output'}`

const renderHistory = (attempts) => {
  if (attempts.length === 0) return ''
  const last = attempts[attempts.length - 1]
  const prior = attempts.slice(0, -1)
  return rejectionOf(last)
    + (prior.length
        ? `\n\nEARLIER ATTEMPTS on this task — already tried and rejected. Do not repeat them:\n`
          + prior.map(a => `- attempt ${a.n} (ran on ${a.model}): ${rejectionOf(a)}`).join('\n')
        : '')
}

// How many writers in this wave are mutating the tracked tree right now. A task
// that fails its gate retries dev and writes again, so "all first devs returned"
// is not a stable notion of quiet — this is a live count whose waiters resolve on
// the next zero-crossing, not a one-shot barrier.
const makeTreeWatch = (size) => {
  let writers = 0
  let waiters = []
  return {
    // `deferralAccepted` reads size to tell a solo wave from a parallel one.
    size,
    enter: () => { writers++ },
    leave: () => {
      if (--writers === 0) { const w = waiters; waiters = []; w.forEach(r => r()) }
    },
    // `deferralAccepted` reads this to refuse a deferral when no sibling is
    // actually writing at the moment the gate returns.
    active: () => writers,
    quiet: () => writers === 0 ? Promise.resolve() : new Promise(r => waiters.push(r)),
  }
}

const withWriter = async (watch, fn) => { watch.enter(); try { return await fn() } finally { watch.leave() } }

// Caps how many task pipelines run at once. A slot spans the WHOLE pipeline, not
// only the writer windows: a verifier's build or live check needs the shared
// resource too, and it is deliberately not a writer. Released in a finally, so a
// thrown or parked task still hands its slot on.
const makeSlots = (limit) => {
  let free = limit
  const queue = []
  return async (fn) => {
    if (free > 0) free--
    else await new Promise(r => queue.push(r))
    try { return await fn() } finally {
      const next = queue.shift()
      if (next) next()
      else free++
    }
  }
}

let mainTail = Promise.resolve()
const withMainLock = (fn) => {
  const run = mainTail.then(fn)
  mainTail = run.catch(() => {})
  return run
}
let mainFingerprint = ''
const live = new Map()
const cleanupFailures = []
const wtArgs = `--repo ${CFG.repoRoot} --slug ${CFG.slug}`
const wtCommand = (args) => `bun ${S}/worktree.ts ${args} ${wtArgs}`
const wtObject = (properties) => ({ type: 'object', properties, required: Object.keys(properties) })
const wtStrings = { type: 'array', items: { type: 'string' } }
const WT_SCHEMA = {
  create: wtObject({ path: { type: 'string' }, base: { type: 'string' } }),
  rebase: wtObject({ path: { type: 'string' }, base: { type: 'string' }, conflicted: wtStrings }),
  land: wtObject({
    status: { type: 'string', enum: ['clean', 'conflict', 'leak'] },
    drift: { type: 'boolean' }, files: wtStrings, paths: wtStrings,
    fingerprint: { type: 'string' }, previous: { type: 'string' },
  }),
  unland: wtObject({ restored: wtStrings }),
  remove: wtObject({ removed: { type: 'boolean' } }),
  show: wtObject({ path: { type: 'string' }, base: { type: ['string', 'null'] }, exists: { type: 'boolean' } }),
  sweep: wtObject({ removed: wtStrings, kept: { type: 'array', items: wtObject({ ref: { type: 'string' }, path: { type: 'string' } }) } }),
  fingerprint: wtObject({ fingerprint: { type: 'string' }, paths: wtStrings }),
}
// Call under withMainLock; keep the command identical through the structured retry.
const wtCall = (label, command, schema) => resilient(async (retryModel) => {
  const result = await agent(`Run exactly this one command: ${command}\nReturn its stdout JSON through StructuredOutput.\n${RETURN_CONTRACT}`,
    { label, phase: 'Execute', ...pick(retryModel ?? MODEL.park), schema })
  if (result === null) throw new Error(`${label}: no structured result`)
  return result
}, MODEL.structuredRetry)

const removeLanded = async (ref, path) => {
  try {
    await withMainLock(() => wtCall(`wt-remove:${ref}`, wtCommand(`remove ${ref}`), WT_SCHEMA.remove))
    live.delete(ref)
  } catch {
    let shown = null
    try {
      shown = await withMainLock(() => wtCall(`wt-show:${ref}`, wtCommand(`show ${ref}`), WT_SCHEMA.show))
    } catch {}
    live.delete(ref)
    if (shown?.exists !== false) cleanupFailures.push({ ref, path })
  }
}

const SIBLING_MARKER = 'SUSPECTED SIBLING INTERFERENCE'

// Every condition a deferral has to clear lives here. A predicate that left the
// "did this gate even ask to defer?" test outboard would return true for a gate
// that never requested one, which is a trap for the next caller.
const deferralAccepted = (gate, watch) =>
  gate.deferred === true
  && gate.passed === false
  && watch.size > 1
  && typeof gate.summary === 'string'
  && gate.summary.includes(SIBLING_MARKER)
  // Wave size is historical, not current state. Without a live-writer check, a
  // verifier whose siblings have all finished wins a free re-run of a red
  // command, which is weaker than simply failing.
  && watch.active() > 0

// ── Per-task retry pipeline ─────────────────────────────────────────────────
async function executeTask(item, watch) {
  const { ref, finalReview, path } = item
  const choices = { ...MODEL, ...parseModels(item.modelsRaw) }
  // The cross-vendor Final review round gets its own (smaller) cap; everything
  // else uses MAX. Past the cap the task is parked + escalated, never skipped.
  const cap = finalReview ? FINAL_MAX : MAX + (lastShotEngine ? 1 : 0)
  // A resume is a fresh flight for one task: it gets the WHOLE cap again, and
  // `first` only moves where the numbering starts so the flightlog and the score
  // rows keep rising instead of colliding with the parked run's attempt 1 and 2.
  // Every rung below is therefore keyed off `last`, never off `cap` — with
  // `first` at 1 the two are equal and the ladder is byte-identical to before,
  // but on a resume at attempt 3 a cap-keyed `attempt >= cap` is already true on
  // the first rung, which would raise effort immediately on every attempt.
  const first = RESUME && RESUME.ref === ref ? RESUME.attempt : 1
  const last = first + cap - 1
  const attempts = []
  // `(human)` items nobody has attested to. Carried out of the PASSING gate, so
  // the run can report them; a failed attempt's list is superseded by the retry.
  let humanPending = []
  let wt = null
  if (!finalReview) {
    try {
      wt = await withMainLock(async () => {
        const created = await wtCall(`wt-create:${ref}`, wtCommand(`create ${ref}`), WT_SCHEMA.create)
        live.set(ref, created.path)
        return created
      })
      // Keep initial dev dispatch concurrent for the legacy sibling writer watch.
      await mainTail
    } catch (error) {
      const cause = `worktree create failed: ${error?.message ?? String(error)}`
      return infrastructureFailure(ref, first, cause, await parkBlocked(ref, path, cause, watch))
    }
  }
  for (let attempt = first; attempt <= last; attempt++) {
    // Steps before the resume point are taken as already satisfied, and only on
    // the attempt the resume starts. If that attempt fails its gate, the retry
    // runs the whole pipeline — a red verify means the skipped work genuinely
    // does need redoing, including the expensive Final review round.
    const startAt = RESUME && attempt === first ? RESUME.from : 'dev'
    let attemptModel = 'final-review'
    // One counted window for the whole write step. Every branch below writes the
    // tree, exactly one of them runs, and none outlives this await — so four
    // wrappers opening and closing at the same two points would say nothing more.
    await withWriter(watch, async () => {
      if (startAt !== 'dev') {
        // Nothing to write: the resume takes this attempt's dev work as done.
      } else if (finalReview) {
        // multi-lens review fan-out + task-selected fixer (no escalation tier)
        await runFinalReview(ref, path, attempt, attempts, choices.fix)
      } else {
        // Dev step. An external devEngine falls back to the task's Claude choice at its cap.
        // `last > first` keeps a single-attempt external ladder on its configured engine.
        // An opted-in Claude ladder instead appends its external rung after Opus.
        const lastShot = attempt >= last && last > first
        // The appended rung is the final attempt, and only exists on a Claude ladder.
        const vendorRung = !!lastShotEngine && attempt === last
        // The last CLAUDE rung. With an appended rung the ladder is MAX + 1 long, so the
        // escalation tier must key off the Claude rung. Keying off `last` makes
        // `attempt >= claudeCap` false at the MAXth attempt, so the ladder would run
        // base effort, base effort, base effort, external — silently
        // turning this append into a replace.
        const claudeCap = last - (lastShotEngine ? 1 : 0)
        if (vendorRung) {
          attemptModel = lastShotEngine.label
          await agent(devExternalPrompt(lastShotEngine, ref, path, attempt, renderHistory(attempts), wt?.path),
            { label: `dev-${lastShotEngine.label}:${ref}#${attempt}`, phase: 'Execute', ...pick(MODEL.devExternal) })
        } else if (devEngine && !lastShot) {
          attemptModel = devEngine.label
          await agent(devExternalPrompt(devEngine, ref, path, attempt, renderHistory(attempts), wt?.path),
            { label: `dev-${devEngine.label}:${ref}#${attempt}`, phase: 'Execute', ...pick(MODEL.devExternal) })
        } else {
          const devChoice = attempt >= claudeCap ? raise(choices.dev) : choices.dev
          attemptModel = `${devChoice.model}${devChoice.effort ? `/${devChoice.effort}` : ''}`
          await agent(devPrompt(ref, path, attempt, renderHistory(attempts), wt?.path),
            { label: `dev:${ref}#${attempt}`, phase: 'Execute', ...pick(devChoice) })
        }
      }
    })

    // The verifier is deliberately not a writer: it must only inspect the tree.
    // Individual review lenses are also not wrapped; the one final-review window
    // encloses their fan-out because the fixer in that operation does write.
    // A verifier that returns NO structured result did not verify anything. That
    // is not the same as `passed: false`, which is a real verdict on real work.
    // Conflating them retries the dev loop against an unknown state.
    // `startAt: 'judge'` replaces the agent verdict with the human's signed one.
    // Synthesised rather than skipped, because everything downstream reads
    // `gate.summary` — the judge grounds correctness in it, and `rejectionOf`
    // quotes it into the next attempt's feedback.
    let gate = startAt === 'judge'
      ? { passed: true, summary: humanGateSummary(), humanPending: [] }
      : await resilient(retryModel => agent(verifyPrompt(ref, path, attempt, false, wt?.path),
      { label: `verify:${ref}#${attempt}`, phase: 'Execute', ...pick(retryModel ?? choices.verify), schema: GATE_SCHEMA }),
      MODEL.structuredRetry)
    if (!gate) {
      const cause = `verification did not run or did not return a verdict on attempt ${attempt}`
        + ` — the verify agent produced no structured result. The harness exposes no original cause for a null agent result, so none is reported here.`
      return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
    }
    if (deferralAccepted(gate, watch)) {
      await watch.quiet()
      const requalified = await resilient(retryModel => agent(verifyPrompt(ref, path, attempt, true, wt?.path),
        { label: `requalify:${ref}#${attempt}`, phase: 'Execute', ...pick(retryModel ?? choices.verify), schema: GATE_SCHEMA }),
        MODEL.structuredRetry)
      if (!requalified) {
        const cause = `requalification did not run or did not return a verdict on attempt ${attempt}`
          + ` — the requalify agent produced no structured result.`
        return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
      }
      // One defer per attempt: the requalify verdict is final. Nothing below reads
      // `deferred` again, and the next attempt reassigns `gate` from a fresh verify,
      // so the flag needs no clearing — only the verdict carries forward.
      gate = requalified
    }
    if (!gate.passed) {
      attempts.push({
        n: attempt,
        model: attemptModel,
        gateSummary: gate.summary ?? 'no output',
        rationale: null,
        weighted: null,
        hardFailed: false,
        missing: [],
      })
      continue
    }
    // Only a PASSING gate's list is meaningful: a failed attempt is retried, and
    // the retry's verifier re-derives the list from the same task file.
    humanPending = Array.isArray(gate.humanPending) ? gate.humanPending : []

    // The rubric judge reads the task file and appends only to the self-gitignored
    // flightlog directory, so it is not a tree writer. Counting it would make the
    // quiet signal fire later than it should for no gain. This is a deliberate
    // exclusion, and a later reader will otherwise "fix" it.
    // NOT wrapped in `resilient`, unlike every other schema'd call in this
    // pipeline. The judge runs `score-task.ts --log` BEFORE it returns, and that
    // appends a verdict row keyed by ref+attempt. A retry would score the same
    // attempt twice: `fleet.ts` keeps the FIRST row for a ref|attempt while the
    // orchestrator would act on the SECOND, so two honest-but-different Opus
    // scorings leave the trail contradicting the decision it records. Recovering
    // this one means reading the persisted verdict back, not re-judging — the
    // score row already holds the whole structured verdict. Until that exists,
    // a judge throw parks, which is the pre-existing behaviour and never worse.
    const judged = await agent(judgePrompt(ref, path, gate.summary, attempt, wt?.path),
      { label: `judge:${ref}#${attempt}`, phase: 'Execute', ...pick(choices.judge), schema: JUDGE_SCHEMA })
    if (!judged) {
      const cause = `the rubric judge returned no structured result on attempt ${attempt}`
        + ` — the task was never scored. The harness exposes no original cause for a null agent result, so none is reported here.`
      return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
    }

    const verdict = judged.verdict
    if (verdict.passed) {
      if (wt) {
        let landed
        let reverified = null
        try {
          landed = await withMainLock(async () => {
            const result = await wtCall(`wt-land:${ref}`,
              wtCommand(`land ${ref} --expect ${mainFingerprint} --op a${attempt}-land`), WT_SCHEMA.land)
            if (result.status === 'clean') {
              if (result.drift) {
                const prompt = verifyPrompt(ref, path, attempt, false, undefined, true)
                try {
                  reverified = await resilient(async (retryModel) => {
                    const checked = await agent(prompt,
                      { label: `reverify:${ref}#${attempt}`, phase: 'Execute', ...pick(retryModel ?? choices.verify), schema: GATE_SCHEMA })
                    if (checked === null) throw new Error('drift re-verify returned no structured result')
                    return checked
                  }, MODEL.structuredRetry)
                } catch {}
                if (!reverified?.passed) {
                  await wtCall(`wt-unland:${ref}`,
                    wtCommand(`unland ${ref} --op a${attempt}-unland`), WT_SCHEMA.unland)
                  if (reverified) {
                    const rebased = await wtCall(`wt-rebase:${ref}`,
                      wtCommand(`rebase ${ref} --op a${attempt}-rebase`), WT_SCHEMA.rebase)
                    wt.base = rebased.base
                  }
                  return result
                }
              }
              mainFingerprint = result.fingerprint
            }
            return result
          })
        } catch (error) {
          const cause = `worktree land failed: ${error?.message ?? String(error)}`
          return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
        }
        if (landed.status === 'clean' && landed.drift && !reverified?.passed) {
          if (!reverified) {
            const cause = `drift re-verify returned no structured result on attempt ${attempt}; the land was undone`
            return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
          }
          attempts.push({
            n: attempt,
            model: attemptModel,
            gateSummary: `REVERIFY FAIL:\n${reverified.summary}`,
            rationale: null,
            weighted: null,
            hardFailed: false,
            missing: [],
          })
          continue
        }
        if (landed.status === 'conflict') {
          try {
            const rebased = await withMainLock(() => wtCall(`wt-rebase:${ref}`,
              wtCommand(`rebase ${ref} --op a${attempt}-rebase`), WT_SCHEMA.rebase))
            wt.base = rebased.base
          } catch (error) {
            const cause = `worktree rebase failed: ${error?.message ?? String(error)}`
            return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
          }
          attempts.push({
            n: attempt,
            model: attemptModel,
            gateSummary: `LAND CONFLICT:\n${landed.files.join('\n')}`,
            rationale: null,
            weighted: null,
            hardFailed: false,
            missing: [],
          })
          continue
        }
        if (landed.status === 'leak') {
          // interim: a leak fails only this task; replaced by a run-wide abort later
          const cause = `MAIN TREE LEAK:\n${landed.paths.join('\n')}`
          return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
        }

        let finalized = null
        let doneError = ''
        try {
          finalized = await withWriter(watch, () => resilient(async (retryModel) => {
            const result = await agent(markDonePrompt(ref, path),
              { label: `done:${ref}`, phase: 'Execute', ...pick(retryModel ?? MODEL.markDone), schema: MARK_DONE_SCHEMA })
            if (result === null) throw new Error('mark-done returned no structured result')
            return result
          }, MODEL.structuredRetry))
        } catch (error) {
          doneError = error?.message ?? String(error)
        }
        await removeLanded(ref, wt.path)
        if (finalized?.ok) return { task: ref, passed: true, attempt, weighted: verdict.weighted, humanPending }
        const cause = 'landed, but Status was not marked done'
          + (finalized ? ` — the task passed its rubric but mark-done did not confirm a bare "Status: done" (read "${finalized.status}"): ${finalized.error ?? ''}` : `: ${doneError}`)
          + `. Run bun ${S}/mark-done.ts ${path} by hand. The next run avoids re-offering this task only after its Status is fixed to done.`
        return infrastructureFailure(ref, attempt, cause, false)
      }
      // The post-judge transition is its own infrastructure boundary — a task
      // that passed but never got written `done` would be re-offered forever, or
      // (worse) counted as complete by a run that never checked.
      const finalized = await withWriter(watch, () =>
        resilient(retryModel => agent(markDonePrompt(ref, path),
          { label: `done:${ref}`, phase: 'Execute', ...pick(retryModel ?? MODEL.markDone), schema: MARK_DONE_SCHEMA }),
          MODEL.structuredRetry))
      if (finalized && finalized.ok) {
        return { task: ref, passed: true, attempt, weighted: verdict.weighted, humanPending }
      }
      const cause = finalized
        ? `the task passed its rubric but mark-done did not confirm a bare "Status: done" (read "${finalized.status}")`
          + (finalized.error ? `: ${finalized.error}` : '')
        : `the task passed its rubric but the mark-done step returned no structured result`
          + ` — the harness exposes no original cause for a null agent result, so none is reported here.`
      // Park + escalate, never both complete and stalled for the same task.
      return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
    }
    attempts.push({
      n: attempt,
      model: attemptModel,
      gateSummary: gate.summary,
      rationale: judged.rationale,
      weighted: verdict.weighted,
      hardFailed: verdict.hardFailed,
      missing: verdict.missing,
    })
  }
  // Render once: the parked file and the returned reason must carry the same text.
  const history = renderHistory(attempts)
  const parkedOk = await parkBlocked(ref, path, history, watch)
  return { task: ref, passed: false, infrastructure: false, attempt: last, parked: parkedOk, reason: withKeptWorktree(ref, history) }
}

// Wrap every task before it reaches parallel(). Do NOT depend on parallel()
// surfacing an error object: a thrown pipeline resolves to null there, and a
// null carries neither the task ref nor the cause. Catching here keeps both.
async function runTaskGuarded(item, watch) {
  try {
    return await executeTask(item, watch)
  } catch (error) {
    const cause = `the task pipeline threw: ${error?.message ?? String(error)}`
    return infrastructureFailure(item.ref, 0, cause, await parkBlocked(item.ref, item.path, cause, watch))
  }
}

// ── Inline atomic-commit instructions ───────────────────────────────────────
// A Workflow agent has Bash + Read but NO Agent tool, so it CANNOT run the
// odin-git:atomic-commit skill — that skill spawns the vör + bragi sub-agents
// and would die mid-run. It also can't resolve that skill's scripts (they live
// in a *different* plugin's cache, and CLAUDE_PLUGIN_ROOT never reaches agent
// Bash). So we inline the skill's contract here — same atomic principles, same
// commit-message template — and let the agent commit over plain git itself.
// Self-contained on purpose: no Skill tool, no sub-agent, no cross-plugin path.
// `heldBack` is the task-file path of every task parked so far. Their source
// edits never passed a gate, so committing them would write failed work into
// the history the closing Final review reads as the deliverable. Excluding just
// those paths is what lets every OTHER task's work still land — the alternative,
// blocking the commit outright, leaves the whole tree dirty for every later
// wave, and every later gate then runs against a tree full of foreign changes.
const commitInstructions = (agentLabel, heldBack = []) =>
  'Commit the current working-tree changes as one or more ATOMIC commits using plain git over Bash. '
  + 'Do NOT use the Skill tool and do NOT spawn any sub-agent — do it yourself with git commands.\n'
  + NO_RESTORE_RULE + '\n'
  + (heldBack.length > 0
    ? `0. HELD BACK — these task(s) were PARKED and their work must NOT be committed:\n`
      + heldBack.map(p => `   - ${p}\n`).join('')
      + `   Read each of those task files and collect every path listed under its "## Files to create / modify" heading. Leave every one of those paths uncommitted, exactly as it is now. Commit the parked TASK FILES themselves (their Status is real state), but none of the source paths they declare.\n`
      + `   A path a parked task declares is held back even when another task also changed it — you cannot tell the two edits apart, so keep it.\n`
      + `   In step 7, list every path you held back.\n`
    : '')
  + `1. Record start: bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase start\n`
  + '2. Run `git status --porcelain`. If it prints nothing, the tree is clean — skip committing and continue.\n'
  + '3. Run `git diff` and `git diff --cached` to see every change. Group the files into atomic commits — each commit does ONE thing (single responsibility, independently revertable). Keep related code + its tests + its docs together; split unrelated changes apart.\n'
  + '4. For each group, in a sensible order, stage exactly that group by name (`git add <file>...`; never `git add -A`, never the interactive `git add -p`).\n'
  + '5. Commit each staged group with the template below.\n'
  + '6. After all commits, run `git log --oneline -n 5` to confirm.\n'
  + `7. Record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase end --message "committed shas: <shas, or none>${heldBack.length > 0 ? '; held back: <paths left uncommitted>' : ''}"\n`
  + `8. If any git command FAILS — a hook blocks the commit, a merge conflict, anything — stop committing, record the failure with bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase end --message "<git error message>", and return failed: true with that git error in reason. Never report a commit that did not happen.\n`
  + 'Return committed, the shas actually created, failed, and reason as the structured result.\n'
  + '\n'
  + 'Commit message template (MUST follow):\n'
  + '  Subject: `<emoji> <type>: <imperative summary>` — lowercase, no trailing period, <=50 chars.\n'
  + '  Then a blank line, an English markdown-bullet body (WHAT changed and WHY; omit for a trivial commit), then a line containing only `---`, then a one-line zh-TW summary (include only when there is a body).\n'
  + '  Emoji/type map: ✨ feat · 🐛 fix · 📦 refactor · ✅ test · 📖 docs · 🎨 style · 🔧 chore · 🔥 remove · ⚡️ perf · 🔒 security.\n'
  + '  Use a quoted heredoc so the body + summary survive newlines. The example below is INDENTED for readability; when you write the real command the closing EOF must start at column 0, or the heredoc never terminates:\n'
  + "    git commit -m \"$(cat <<'EOF'\n"
  + '    ✨ feat: add the thing\n'
  + '\n'
  + '    - what changed and why\n'
  + '\n'
  + '    ---\n'
  + '\n'
  + '    繁體中文一句摘要\n'
  + '    EOF\n'
  + '    )"\n'
  + RETURN_CONTRACT

// ── Wave loop ───────────────────────────────────────────────────────────────
return (async () => {
phase('Execute')
const completed = []
const escalations = []
// `(human)` gate items that passed WITHOUT a machine check and without an
// attestation. Not an escalation — the task legitimately passed — so it rides
// its own list, or the main agent would report a park that never happened.
const needsHuman = []
const parked = new Set()
// Task-file paths whose work must stay out of every commit. See commitInstructions.
const heldBack = new Set()

// Only an escalation that makes the TREE untrustworthy blocks a commit. A parked
// task does not: its paths are held back by pathspec instead, so the rest of the
// wave still lands. A `(commit)` failure does not either — blocking on it was
// collective punishment, disabling every later commit over one flaky agent.
const COMMIT_SAFE = new Set(['(commit)'])
const commitBlocked = () =>
  escalations.some(e => e.infrastructure && !parked.has(e.task) && !COMMIT_SAFE.has(e.task))
let wave = 0
let lastScout = null
let scoutFailed = false
let startKept = []
let worktreeFailed = false
const keptWorktrees = () => {
  const kept = new Map(startKept
    .filter(({ ref }) => scoutFailed || lastScout?.unfinished.some(item => item.ref === ref && item.state === 'blocked'))
    .map(({ ref, path }) => [ref, path]))
  for (const [ref, path] of live) kept.set(ref, path)
  return [...kept].map(([ref, path]) => ({ ref, path })).sort((a, b) => a.ref.localeCompare(b.ref))
}
const sweep = (stage, refs) => withMainLock(() => wtCall(`wt-sweep:${stage}`,
  wtCommand(`sweep${stage === 'list' ? ' --keep-all' : refs.length ? ` --keep ${refs.join(',')}` : ''}`), WT_SCHEMA.sweep))
const baseline = () => withMainLock(async () => {
  const result = await wtCall('wt-leak:baseline', wtCommand('fingerprint'), WT_SCHEMA.fingerprint)
  mainFingerprint = result.fingerprint
})
const worktreeFailure = (error) => {
  worktreeFailed = true
  const reason = `worktree infrastructure failed: ${error?.message ?? String(error)}`
  log(reason)
  escalations.push({ task: '(worktree)', attempt: 0, infrastructure: true, parked: false, reason })
}

// A schema'd agent has TWO failure modes, not one. A terminal API failure
// returns null — every guard below tests for that. But `agent({schema})`
// REJECTS when the subagent text-emits `<StructuredOutput>…</StructuredOutput>`
// instead of calling the tool, and a null-guard can never see a throw. Both
// calls in this loop sit OUTSIDE `runTaskGuarded`, so an unguarded throw here
// takes the whole run with it: `completed` and `escalations` for every wave
// already finished die with it, while the tree on disk still reads `done`. That
// is the worst possible shape — the work happened and the run reports nothing.
// Live: wf_993ede2c-a44, a Haiku scout, on the final wave of a 9/9 tree.
// Take a thunk, not a promise, so a synchronous throw is caught too.
const settled = async (call) => {
  try {
    return { value: await call(), threw: '' }
  } catch (error) {
    return { value: null, threw: error?.message ?? String(error) }
  }
}

// Both commit sites (inter-wave and post-loop) report a failure identically —
// only the label differs. One helper so the three wordings cannot drift apart.
// A null result is NOT a failure report: it means the agent returned no
// structured result at all, so whether anything was committed is unknowable. A
// throw is the same unknown, with a cause attached.
// Never terminal — the caller decides; `commitBlocked()` is what stops
// every later commit.
const escalateCommitFailure = (committed, what, threw) => {
  const reason = threw
    ? `the ${what} commit agent failed: ${threw}`
    : committed
      ? `the ${what} commit failed: ${committed.reason || 'no reason reported'}`
      : `the ${what} commit agent returned no structured result, so whether anything was committed is unknown`
  log(reason)
  escalations.push({ task: '(commit)', attempt: 0, infrastructure: true, parked: false, reason })
}

// Resume mode runs ONE task and no wave loop. Written as a loop condition rather
// than an if/else wrapper so the wave loop's 240-line body keeps its indentation:
// a whole-body re-indent would bury this change in a diff nobody can read.
while (!RESUME) {
  wave++
  scoutFailed = true
  // `settled` still wraps the retry: it converts a SECOND throw into the same
  // reportable shape, which is what keeps every finished wave's results alive.
  const { value: scout, threw: scoutThrew } = await settled(() => resilient(retryModel => agent(
    `First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task scout --role scout --agent "<your label>" --phase start\n`
    + `Then proceed.\n\n`
    + `Use the identical label in both start and end calls.\n`
    + `Run exactly this command: bun ${S}/next-ready.ts ${CFG.tasksDir} --summary\n`
    + `Return its stdout verbatim (unmodified), its exit code, and its stderr.\n`
    + `Also return maxParallel: the value of the "maxParallel" key in that JSON, the last key in it — an integer, or null when it prints null.\n`
    + `Also return readyModels: copy each ready item into { ref, modelsRaw }, preserving its modelsRaw string exactly or null when it prints null.\n`
    + `Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task scout --role scout --agent "<your label>" --phase end --message "command complete"\n`
    + RETURN_CONTRACT,
    { label: `scout-wave-${wave}`, phase: 'Execute', ...pick(retryModel ?? MODEL.scout), schema: SCOUT_SCHEMA }),
    MODEL.structuredRetry))

  // Pure in-memory work, so this needs no Workflow filesystem access.
  let snap = null
  let derailed = ''
  if (scoutThrew) {
    derailed = `the scout agent failed: ${scoutThrew}`
  } else if (!scout || typeof scout.stdout !== 'string' || scout.stdout.trim() === '') {
    derailed = `the scout returned no stdout${scout?.stderr ? `: ${scout.stderr}` : ''}`
  } else {
    try {
      snap = JSON.parse(scout.stdout)
    } catch (err) {
      derailed = `the scout's stdout was not JSON (${err?.message ?? String(err)}): ${scout.stdout.slice(0, 400)}`
    }
  }

  // Validate the parsed object explicitly because a silently-missing field is the
  // failure mode the old schema's `required` list existed to prevent. The shape
  // test comes first and is not a truthiness test: `JSON.parse("null")` (and any
  // other primitive) parses fine and is falsy, so a truthiness guard would skip
  // every check below and let `snap.ready` throw past the (scout) escalation.
  if (!derailed && (snap === null || typeof snap !== 'object' || Array.isArray(snap))) {
    const shape = snap === null ? 'null' : Array.isArray(snap) ? 'an array' : typeof snap
    derailed = `the scout's stdout parsed to ${shape}, not a JSON object: ${scout.stdout.slice(0, 400)}`
  }
  if (!derailed) {
    if (!Array.isArray(snap.ready)) derailed = `"ready" is not an array`
    else if (!Array.isArray(snap.unfinished)) derailed = `"unfinished" is not an array`
    else if (!Array.isArray(snap.invalid)) derailed = `"invalid" is not an array`
    else if (!Array.isArray(snap.errors)) derailed = `"errors" is not an array`
    else if (!snap.counts || typeof snap.counts !== 'object') derailed = `"counts" is not an object`
    else for (const k of ['total', 'todo', 'inProgress', 'done', 'blocked', 'invalid']) {
      if (typeof snap.counts[k] !== 'number') { derailed = `"counts.${k}" is not a number`; break }
    }
  }
  // Missing is not "no cap": a dropped field would silently run a serial plan in parallel.
  if (!derailed && scout.maxParallel !== null && !(Number.isInteger(scout.maxParallel) && scout.maxParallel > 0)) {
    derailed = `"maxParallel" is not null or a positive integer (got ${JSON.stringify(scout.maxParallel)})`
  }
  // The stdout copy may be dropped in transcription; when present, disagreeing means one copy is wrong.
  if (!derailed && 'maxParallel' in snap && snap.maxParallel !== scout.maxParallel) {
    derailed = `"maxParallel" is ${JSON.stringify(snap.maxParallel)} in stdout but ${JSON.stringify(scout.maxParallel)} in the scout's structured field`
  }
  if (!derailed) snap.maxParallel = scout.maxParallel

  if (!derailed) {
    for (const item of snap.ready) {
      const carried = Array.isArray(scout.readyModels) ? scout.readyModels.find(entry => entry.ref === item.ref) : null
      if (!carried || !Object.hasOwn(carried, 'modelsRaw')) {
        derailed = `${item.ref}: missing modelsRaw in the scout's readyModels`
        break
      }
      if ('modelsRaw' in item && item.modelsRaw !== carried.modelsRaw) {
        derailed = `${item.ref}: modelsRaw is ${JSON.stringify(item.modelsRaw)} in stdout but ${JSON.stringify(carried.modelsRaw)} in the scout's structured field`
        break
      }
      try {
        parseModels(carried.modelsRaw)
      } catch (error) {
        derailed = `${item.ref}: ${error?.message ?? String(error)}`
        break
      }
      item.modelsRaw = carried.modelsRaw
    }
  }

  if (derailed) {
    const reason = `next-ready scout failed in wave ${wave}: ${derailed}`
    log(reason)
    escalations.push({ task: '(scout)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  const ready       = snap.ready
  const c           = snap.counts
  const unfinished  = snap.unfinished
  const invalidRefs = snap.invalid.map(i => i.ref)
  const parseErrors = snap.errors

  // Unparseable files never reach `byRef`, so they never reach `counts` either.
  // `counts` therefore describes the tasks that PARSED, not the tree. Checking
  // this before the completion test is what stops `done === total` from holding
  // over a tree that still contains task files nobody could read.
  if (parseErrors.length > 0) {
    const reason = `${parseErrors.length} task file(s) did not parse in wave ${wave}, so the tree is incomplete and its counts describe only what parsed: `
      + parseErrors.map(e => `${e.file} (${e.reason})`).join('; ')
      + `. Fix those files — run lint-task.ts on the tree — then re-run autopilot.`
    log(reason)
    escalations.push({ task: '(tree)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  const bucketSum = c.todo + c.inProgress + c.done + c.blocked + c.invalid
  if (bucketSum !== c.total) {
    const reason = `scout counts do not add up in wave ${wave}: total ${c.total} vs buckets summing to ${bucketSum} (${JSON.stringify(c)})`
    log(reason)
    escalations.push({ task: '(scout)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  // A malformed tree is a scout failure, not a stall. Naming the refs is the
  // whole point — "invalid: 2" alone tells the user nothing they can act on.
  if (c.invalid > 0) {
    const reason = `${c.invalid} task(s) hold an invalid completion state and the tree cannot be trusted: `
      + `${invalidRefs.join(', ') || '(refs not reported)'}. `
      + `Reset each one's Status to in-progress or todo and rerun its gates — do NOT tick the boxes by hand.`
    log(reason)
    escalations.push({ task: '(tree)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  // A readable but EMPTY tasks dir yields all-zero counts, so `done === total`
  // would hold and the run would report clean success over no work at all —
  // after which the post-loop commit sweeps the working tree into a commit.
  if (c.total === 0) {
    const reason = `the tree at ${CFG.tasksDir} contains no parseable tasks (every count is zero), so there is nothing to execute. `
      + `Check the path, and run lint-task.ts on the tree.`
    log(reason)
    escalations.push({ task: '(tree)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  scoutFailed = false
  lastScout = snap
  if (wave === 1) {
    try {
      startKept = (await sweep('start', unfinished.filter(item => item.state === 'blocked').map(item => item.ref))).kept
      await baseline()
    } catch (error) {
      worktreeFailure(error)
      break
    }
  }

  // Whole-tree completion, resume-safe. `completed` only covers THIS run, so a
  // resumed run's `completed.length` is smaller than the tree and can never
  // prove completion. The on-disk count can.
  if (c.done === c.total) {
    log(`Tree complete: ${c.done}/${c.total} done.`)
    break
  }

  // Memory/disk divergence. `completed` is this run's memory; the scout reads
  // disk. A ref in BOTH means something rewrote a task file after it passed and
  // was confirmed done — a sibling task's `git checkout`, a hand edit, a revert.
  // The `fresh` filter below would bury it forever: the ref is dropped as
  // already-completed, so it is never re-dispatched, and the run eventually dies
  // as a generic stall that names the wrong cause. Test the INTERSECTION, not
  // `completed.length` vs `counts.done` — a resumed run inherits earlier `done`
  // tasks, so that comparison points the wrong way and stays silent on exactly
  // the runs where a rollback is hardest to spot.
  const diverged = completed.filter(ref => unfinished.some(u => u.ref === ref))
  if (diverged.length > 0) {
    const reason = `memory/disk divergence in wave ${wave}: ${diverged.join(', ')} passed and were confirmed done this run, but the tree on disk now reports them unfinished. `
      + `Something rewrote those task files after they were graded — look for a \`git checkout\`/\`git restore\` run by a parallel task, or a hand edit. `
      + `The code itself may already be committed, so check that FIRST: if the work stands, set each ref's Status back to done; if not, reset it to todo. Then re-run autopilot.`
    log(reason)
    escalations.push({ task: '(divergence)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  // Exclude both parked AND already-completed refs. next-ready won't re-offer a
  // done task, but this is defense-in-depth: even a misbehaving scout that
  // re-lists finished tasks can never trigger an infinite re-run of done work.
  const fresh = ready.filter(
    i => !parked.has(i.ref) && !completed.includes(i.ref))

  // Empty ready set + unfinished tasks = stalled. Report the counts AND the refs.
  // Tasks this run already parked are excluded: they carry their own escalation,
  // and re-reporting them as a fresh stall would double-count every parked run.
  if (fresh.length === 0) {
    const outstanding = unfinished.filter(u => !parked.has(u.ref))
    if (outstanding.length === 0) break   // nothing left but what we already escalated
    const remaining = outstanding.map(u => `${u.ref} (${u.state})`).join(', ')
    const reason = `stalled in wave ${wave}: no ready task, but ${c.total - c.done} of ${c.total} are unfinished. `
      + `Counts: ${JSON.stringify(c)}. Remaining: ${remaining}.`
    log(reason)
    escalations.push({ task: '(tree)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  if (wave > 1 && CFG.commitBetweenWaves && !commitBlocked()) {
    const { value: committed, threw } = await settled(() => agent(
      `Commit all changes from the previous wave.\n${commitInstructions(`commit-wave-${wave}`, [...heldBack])}`,
      { label: `commit-wave-${wave}`, phase: 'Execute', ...pick(MODEL.commit), schema: COMMIT_SCHEMA }))
    if (threw || !committed || committed.failed) {
      escalateCommitFailure(committed, `wave ${wave - 1}`, threw)
      // Continue this wave. A failed commit does NOT block the next one: the
      // work is still in the tree, so the next wave's commit sweeps it up.
    }
  }

  const left = budgetBelowFloor()
  if (left !== null) {
    const reason = `budget floor reached before wave ${wave} dispatch: ${left} of ${budget.total} output tokens remain, `
      + `below the configured floor of ${BUDGET_FLOOR}. Not dispatched: ${fresh.map(f => f.ref).join(', ')}. `
      + `${c.total - c.done} of ${c.total} task(s) remain unfinished. No task was parked and nothing is in flight — `
      + `raise or clear the budget floor, or grant more budget, then re-run autopilot to resume.`
    log(reason)
    escalations.push({ task: '(budget)', attempt: 0, infrastructure: true, parked: false, reason })
    break
  }

  // PLAN.md's `Max parallel`, carried by the scout; null means the whole wave at once.
  const slots = Math.min(fresh.length, snap.maxParallel ?? fresh.length)
  log(`Wave ${wave}: ${fresh.map(f => f.ref).join(', ')}${slots < fresh.length ? ` (at most ${slots} at a time)` : ''}`)
  // The watch is created per wave, not at module scope, because:
  // - size is a per-wave fact (how many tasks fresh contains this wave), so a
  //   surviving watch either reports a stale dispatch count or has to be mutated
  //   between waves — and the consumer that reads it uses size to decide whether
  //   a task had any sibling at all. A wrong answer there silently changes which
  //   deferrals are accepted.
  // - Per-wave scope also keeps the object's lifetime equal to the thing it
  //   describes: parallel() awaits every task thunk before the loop advances, so
  //   an instance created there is provably unobservable to any later wave, and no
  //   cross-wave state can accumulate.
  // Why this cannot deadlock:
  // - A task that awaits quiet() has already left the writer set — its own
  //   mutation window closed before its gate ran — so it never waits on itself.
  // - Every writer leaves through a finally, so a throwing writer still decrements.
  //   The count cannot strand.
  // - If every task in a wave awaits at once, no writer remains, writers is 0, and
  //   quiet() returns an already-resolved promise rather than registering a waiter.
  // Sized by slots, not by the wave: a serial task has no sibling beside it, so
  // `deferralAccepted` must refuse its sibling excuse.
  const watch = makeTreeWatch(slots)
  const inSlot = makeSlots(slots)
  // No `.filter(Boolean)` — reconciliation is by INDEX against `fresh`, so a
  // null result still lands on its own task instead of disappearing.
  const results = await parallel(fresh.map(item => () => inSlot(() => runTaskGuarded(item, watch))))

  // Reconcile every input task. A dropped task would land in NO list: its dev
  // step already set the task to in-progress, and next-ready only offers `todo`,
  // so it could never be re-offered — the run would end "clean" and the
  // post-loop commit would sweep its ungated edits into a commit. Escalating it
  // parks the task AND (via `heldBack`) keeps its paths out of those commits.
  let passedThisWave = false
  for (let i = 0; i < fresh.length; i++) {
    const item = fresh[i]
    const r = results[i]
    // Never read r.passed without this guard — r is null when even the guarded
    // wrapper could not return.
    if (r && r.passed) {
      completed.push(item.ref)
      if (r.humanPending?.length > 0) needsHuman.push({ task: item.ref, criteria: r.humanPending })
      passedThisWave = true
      continue
    }
    escalations.push({
      task: item.ref,
      attempt: r?.attempt ?? 0,
      infrastructure: r?.infrastructure ?? true,
      parked: r?.parked ?? false,
      reason: r?.reason
        ?? 'no result returned for this task and the harness exposed no cause — the pipeline was dropped, so the task state on disk is unknown',
    })
    parked.add(item.ref)
    // Held back for the rest of the run, never cleared: this task's edits never
    // passed a gate, and no later wave re-runs it to change that.
    heldBack.add(item.path)
  }
  // No task passed this wave → no new work will unblock; stop to avoid spinning.
  if (!passedThisWave) break
}

// ── Single-task resume ──────────────────────────────────────────────────────
// One pipeline, no scout, no waves. It then falls through to the post-loop
// commit, and that is load-bearing rather than incidental: the run that parked
// this task held its declared paths out of every commit, so the fixer's work is
// still sitting uncommitted. `heldBack` is empty here, so a passing resume is
// what finally lands it.
if (RESUME && !RESUME.finalReview) {
  try { await baseline() } catch (error) { worktreeFailure(error) }
}
if (RESUME && !worktreeFailed) {
  const item = { ref: RESUME.ref, finalReview: RESUME.finalReview, path: RESUME.path, modelsRaw: RESUME.modelsRaw }
  log(`Resuming ${item.ref} at the ${RESUME.from} step, from attempt ${RESUME.attempt}.`)
  // Sized 1: a resume has no sibling, so a SUSPECTED SIBLING INTERFERENCE
  // deferral must be refused exactly as it is for a serial wave.
  const r = await runTaskGuarded(item, makeTreeWatch(1))
  if (r && r.passed) {
    completed.push(item.ref)
    if (r.humanPending?.length > 0) needsHuman.push({ task: item.ref, criteria: r.humanPending })
  } else {
    escalations.push({
      task: item.ref,
      attempt: r?.attempt ?? 0,
      infrastructure: r?.infrastructure ?? true,
      parked: r?.parked ?? false,
      reason: r?.reason
        ?? 'no result returned for the resumed task and the harness exposed no cause — the pipeline was dropped, so the task state on disk is unknown',
    })
    parked.add(item.ref)
    heldBack.add(item.path)
  }
}

if (!RESUME && !worktreeFailed) {
  try {
    if (!lastScout) {
      startKept = (await sweep('list', [])).kept
    } else if (!scoutFailed) {
      await sweep('end', keptWorktrees().map(({ ref }) => ref))
    }
  } catch (error) {
    worktreeFailure(error)
  }
}

// ── Post-loop commit ────────────────────────────────────────────────────────
// The last wave (typically Final review) has no subsequent scout to trigger a
// commit. Run one final atomic-commit here to capture those remaining changes.
// Same guard as the inter-wave commits: a parked task holds back its own paths,
// but an untrustworthy tree — a divergence, a parse failure, a bad scout — blocks
// the commit entirely. Those escalations broke the loop, so the tree state that
// reached here is exactly the one nobody could vouch for.
if (CFG.commitBetweenWaves && !commitBlocked()) {
  const { value: committed, threw } = await settled(() => agent(
    `Commit any remaining uncommitted changes (from the last wave — typically Final review fixes).\n`
    + commitInstructions('commit-post-loop', [...heldBack]),
    { label: 'commit-post-loop', phase: 'Execute', ...pick(MODEL.commit), schema: COMMIT_SCHEMA }))
  if (threw || !committed || committed.failed) {
    escalateCommitFailure(committed, 'post-loop', threw)
  }
}

return { slug: CFG.slug, completed, escalations, needsHuman, worktrees: keptWorktrees(), cleanupFailures: cleanupFailures.sort((a, b) => a.ref.localeCompare(b.ref)) }
})()
```

## What the main agent does with the result

- `completed` — tasks that passed their rubric **and** whose `mark-done` transition was confirmed, this invocation only. It includes the Final review task, if the run finished cleanly. It is not a tree-completion count; see the note on `counts.done` below.
- `escalations` — `[{ task, attempt, infrastructure, parked, reason }]`. For each one, surface it to the user. In a cockpit session, use `needs_your_call` + `cockpit wait`. Otherwise, use `AskUserQuestion`. Include the last `reason` — the judge rationale, the gate output, or the infrastructure cause. `infrastructure: true` identifies a pipeline or mechanical failure; report the cause rather than claiming the work was rejected. When the cause says "landed, but Status was not marked done", tell the user to run `mark-done.ts` by hand before another run. `parked: false` means the task was NOT confirmed as `blocked`; report its Status as unknown and follow the escalation's recovery instruction.
- `needsHuman` — `[{ task, criteria }]`, the `(human)` gate items that passed with no machine check and no attestation. Report it **separately from `escalations`**: those tasks are genuinely `done`, nothing is parked, and nothing needs a Status reset. Print the criteria verbatim as the user's closing checklist, and say that `mark-done.ts` ticked their boxes like any other, so the task file no longer shows the check is outstanding.
- `worktrees` — report the sorted `{ ref, path }` union of live worktrees and blocked leftovers retained from the start sweep. If a scout failed, preserve the returned worktree list without filtering it further.
- `cleanupFailures` — report landed worktrees whose removal could not be confirmed, separately from kept worktrees. A removal failure alone leaves the task completed, with no escalation.
- A task ref appears in `completed` or in `escalations`, never in both. A ref in `needsHuman` is always also in `completed`.
- Then render the trail. Run `bun <scriptsDir>/flightlog.ts report <logFile>` → `RUNLOG.md`.
- **Resume**: after the user unblocks a parked task, reset its `Status` to `todo`. Then re-run autopilot. Completed tasks stay `done`, so the run re-offers only the unblocked work.

## Notes / gotchas

- **Wave re-scout is non-negotiable.** Statuses change only inside the run. The orchestrator must recompute the ready set each wave. A task unblocked by a wave-N completion is picked up in wave N+1.
- **The scout TRANSCRIBES.** It runs one command and hands back exactly what the command printed (`stdout`, `exitCode`, `stderr`). The script does every interpretation. Nothing the agent returns requires it to understand the tree. The script parses and validates the summary before deriving `{ready, counts, unfinished, invalidRefs, parseErrors}`. Note `--summary` prints its JSON **before** exiting non-zero on a malformed tree, so a non-zero exit alone is not a scout failure.
- **The scout copies `maxParallel` out of the blob as its own structured field, because a verbatim transcription drops it.** In `odin-dropper-cli` `docs/homebrew-backup` (run `wf_84deb543-ea1`), `next-ready.ts --summary` printed `…,"errors":[],"maxParallel":null}` and the Haiku scout returned stdout ending at `"errors":[]}`, so wave 1 died with `"maxParallel" is not null or a positive integer (got undefined)`. The trailing `null` key is the one a cheap model drops. The script now reads the cap from `SCOUT_SCHEMA.maxParallel` (`integer | null`, required). It checks the cap against stdout only when stdout still carries the key, and a disagreement between the two is a `(scout)` failure. A prompt line telling the scout to copy through the final `}` only made the drop less likely, so it was not kept. A checksum over a file written by `next-ready.ts` was rejected too: it only detects the drop, and the orchestrator cannot re-read the file to recover. **Residual:** a scout that drops the key from stdout *and* invents `null` for the structured field still runs a capped plan uncapped, because no check here can catch two coordinated errors.

- **`completed.length` is not a completion count. `counts.done` is.** The wave loop's `completed` array only holds tasks *this invocation* finished. A resumed run inherits `done` tasks from earlier runs, so comparing `completed.length` with the tree size reports a false stall on every resume. The scout's `counts.done === counts.total` counts the tree on disk, which is the only place completion actually lives. The loop also asserts `total === todo + inProgress + done + blocked + invalid` before trusting any bucket.

- **Nine terminal conditions, all explicit.** `done === total` is clean completion. A non-empty `errors` is a tree failure. `invalid > 0` is a tree failure naming the invalid refs. A counts mismatch is a scout failure. A readable but empty tasks directory, where every count is zero, escalates as `(tree)` before the `done === total` completion test. A ref that is in `completed` *and* still unfinished on disk is a **divergence**, escalated as `(divergence)` before the ready set is filtered. An empty ready set with unfinished tasks is a **stall**, escalated with the counts plus every remaining `ref (state)`. A configured budget floor stops the loop between the inter-wave commit and dispatch when the remaining output-token balance is below that floor. A wave where no task passed stops the loop, because nothing new can unblock. Only the first ends the run cleanly. A commit failure is not a terminal condition: it escalates as synthetic task `(commit)` and does **not** block later commits — the work stays in the tree, so the next wave's commit sweeps it up. Blocking on it was collective punishment: one flaky commit agent disabled every commit for the rest of the run.

- **Divergence is a set intersection, never a count comparison.** `completed` is memory, the scout's `unfinished` is disk, and a ref in both means a task file was rewritten after its `mark-done` was confirmed. The tempting check is `completed.length > counts.done`, and it is wrong: a resumed run inherits `done` tasks from earlier runs, so `counts.done` already exceeds `completed.length` and the inequality never fires — silent on precisely the runs where a rollback is hardest to see. The intersection holds on fresh and resumed runs alike, and it *is* the ref list the escalation has to print. It must run **before** the `fresh` filter, because that filter drops already-completed refs: after it, the diverged task is neither re-dispatched nor reported, and the run dies waves later as a generic `(tree)` stall blaming the wrong thing. Observed live in run `wf_5903a02b-b6e`: a parallel sibling ran `git checkout` over another task's file, reverting a confirmed `Status: done` to `todo`, and the run stalled at 7/11 with a message that never named the rolled-back task.

- **`counts` describes what parsed, not the tree.** A file that fails to parse — no H1, a duplicate `bucket/NN` — never enters `byRef`, so it never enters `counts`. Delete four broken files from a five-task tree and `counts` reads `{total: 1, done: 1}`: `done === total` holds, and the run reports clean completion over a tree it could not read. That is why the loop validates and checks the parsed `errors` array **before** the completion test instead of asking the scout to understand it.

- **The stall check excludes tasks this run already parked.** Every parked task carries its own escalation, and the very next wave necessarily sees it as unfinished-and-not-ready. Counting it again would append a phantom `(tree)` stall to every run that parked anything, so the run would report two problems where there is one. When the only unfinished tasks are ones already escalated, the loop just breaks.

- **The script has a deterministic fixture.** `scripts/orchestrator-script.test.ts` extracts this exact fenced block, runs it with stubbed `agent`/`parallel`, and asserts the termination rules, the quality-vs-infrastructure split, and the "every task lands in `completed` XOR `escalations`" invariant. No agent is spawned. **Edit the block and run `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts`** — a syntax error or a broken loop shows up there instead of mid-flight.

- **Quality failures retry; infrastructure failures escalate immediately.** A verifier returning `passed: false` judged real work and found it wanting — that feeds the dev loop another attempt. A verifier or judge returning *no structured result* judged nothing at all, so retrying dev would stack a second attempt on an unknown state. Apply the same rule to a thrown pipeline before land. Park unlanded tasks and report the specific failure. After a clean land, never park or unland: a failed `mark-done` escalates with "landed, but Status was not marked done", and removal still runs. If removal cannot be confirmed, probe with `wt-show` and report the path in `cleanupFailures` when it still exists or the probe fails. The attempt number is reported as it actually was — compute was consumed, and claiming otherwise would mislead the audit. **The harness exposes no original cause for a null agent result**; the escalation says so rather than inventing an error message.

- **Both status transitions are confirmed by a reread, not by the agent's word.** `markDonePrompt` and `markBlockedPrompt` each return `{ ok, status, error }` and each must reopen the file and read the Status line back. An agent can return a fluent summary having edited nothing, and for parking that is the *likely* case — the task is often being parked because its header was malformed to begin with. An unconfirmed park reported as success is worse than a failed one: the file still reads `in-progress`, `next-ready` never re-offers it, and the `parked: false` signal that tells the user to reset it by hand never fires.

- **A schema'd `agent()` throws as well as returning `null` — guard for both.** `agent(prompt, {schema})` resolves to `null` on a terminal API failure, and that is what every `if (!gate)` / `if (!judged)` / `if (!committed)` guard tests. But it **rejects** when the subagent never calls the StructuredOutput tool — typically because it text-emitted `<StructuredOutput>…</StructuredOutput>` as a message instead. A null-guard can never see a throw. Inside a task that is already handled: `runTaskGuarded` catches around the whole pipeline. The two calls that sit *outside* it — the wave-loop scout and both commit agents — are wrapped in `settled()`, which turns either failure into the same reportable shape. Do not remove those wrappers. An unguarded throw at the top of the wave loop discards `completed` and `escalations` for every wave that already finished, so the run returns nothing while the tree on disk reads `done` — the work happened and no one is told. Observed live in run `wf_993ede2c-a44`: a Haiku scout text-emitted its payload on the final wave of a 9/9 tree, argued with the harness's `[structured-output-enforce]` nudge, and killed the workflow after every task was complete and committed. Cheap models are likeliest to do this, and every one of these three calls runs on `MODEL.verify`/`MODEL.commit` (Haiku).

- **Catching that throw is not recovering from it — `resilient()` retries once.** The guards above keep the run *reportable*; they do not get the verdict back. By the time a schema'd call rejects, the agent has usually done all of the real work. Live in run `wf_b03e0034-f95`: the Final review verifier ran every check, wrote its `PASS` row to the flightlog, then emitted the verdict as message text — and `runTaskGuarded` correctly parked a complete, green review round as an infrastructure failure, discarding the most expensive round in the flight. So every schema'd call whose re-run is free of side effects is wrapped in `resilient()`, which retries exactly once on `MODEL.structuredRetry`. **Idempotence is the whole licence for the retry**: `verify` and `requalify` only read, `mark-done.ts` validates the header before it writes anything, the park is an idempotent edit, and the scout runs one read-only command. **Two callers are excluded, both because they persist something before they return.** The commit agents: a retry after a partial commit writes a second, incoherent commit. And the **rubric judge**, which is the subtle one — it runs `score-task.ts --log` *before* returning, appending a verdict row keyed by ref+attempt, and `fleet.ts` keeps the FIRST row for that key while the orchestrator would act on the SECOND. Two honest-but-different Opus scorings of one attempt would then leave the trail contradicting the decision it records, which is the same class of defect the deferral design exists to prevent. Recovering the judge means reading the persisted verdict back — the score row already holds the whole structured verdict — not re-judging; until that exists a judge throw parks, exactly as before. A wrapped call can still duplicate its *narrative* rows, and that is the accepted cost: the retry genuinely happened, so a trail showing both attempts is truthful. Duplicating a persisted verdict is not, and that is where the line sits. A retry is not a loop — the second throw propagates exactly as the first one used to, so a genuinely stuck agent still parks rather than burning the run. `RETURN_CONTRACT` is the cheap companion to all of this: the schema is invisible to the agent, so without one explicit sentence nothing in the prompt says *how* to return, and a model closing a long tool-heavy turn writes the payload as text believing it answered. Every schema'd prompt carries it, including the commit instructions the retry skips.
- **Wrap the task thunk; reconcile by index; never `.filter(Boolean)`.** `parallel()` resolves a thrown thunk to `null`, and a `null` carries neither the task ref nor the cause. `runTaskGuarded` catches around `executeTask` so both survive, and it still attempts `markBlockedPrompt` and records whether the park worked. The wave then reconciles `results[i]` against `fresh[i]`, so even a `null` lands on its own task instead of vanishing. Filtering first would drop the task from `completed` and `escalations` both, and an unparked task stays `in-progress` — which `next-ready` never offers again.
- **There is exactly one scoring implementation.** The judge agent runs `score-task.ts --json --log` with its scores. The orchestrator gates on that printed verdict object. If the formula changes, change `score-task.ts`. Do NOT duplicate the arithmetic in the orchestrator.
- **The judge's rationale reaches the trail through a file, or not at all.** The rationale ends up in three places when the attempt goes badly — `rejectionOf()` feeds it to the next dev attempt, and a capped task carries it into the park reason and the escalation. On a *passing* attempt it used to reach none of them: it lived only in the orchestrator's memory, so `RUNLOG.md` recorded a weighted number and no evidence for it, and the audit trail was thinnest exactly where an auditor looks first. So the judge writes it to `/tmp/rationale-<ref>-a<attempt>.md` and passes `--rationale-file`. **A file, not a `--rationale` argument**: a rationale runs to hundreds of words of markdown with quotes, backticks, and newlines, and the judge composes the command itself — shell quoting would mangle it. For the same reason the prompt names the **Write tool** rather than `echo` or a heredoc. `--rationale-file` never fails the run: the verdict is already computed when it is read, and the judge is one of the two calls `resilient()` deliberately does not retry, so an unreadable file warns on stderr and logs the verdict without it rather than parking a task that passed.
- **`CFG.budgetFloor` defaults to `0` (off).** `budget.total` is `null` unless the user declares a target, so enabling a floor by default would manufacture a surprise stall class for existing runs. When configured above zero, it stops dispatching a ready wave when the remaining output-token balance falls below the floor.
- **Final review needs no special phase.** Its transitive `Depends on` reaches every task. So `next-ready` offers it only once everything else is `done`. When the `finalReview` flag is set, the orchestrator runs `runFinalReview` instead of a single dev agent — the multi-lens fan-out described below. It also uses the smaller `FINAL_MAX` cap. The binary gate, the rubric judge, and the score gate stay unchanged. They evaluate the round's output against the Final review task's own `## Eval rubric`: integration, consistency, no regressions, and whether it meets the PLAN goal.
- **The *orchestrator* runs the review fan-out, not one agent.** A Workflow agent has `Skill` and `Bash`, so the external CLI is reachable. But it has **no `Agent` tool**. So it cannot spawn fan-out skills like `/simplify` or `/code-review` itself. The orchestrator sidesteps that. `runFinalReview` issues one `agent()` per lens via `parallel()`. One lens is the cross-vendor lens (`CFG.reviewEngine`: codex or opencode), driven through the `<engine>-run.ts review` wrapper over Bash. The other three are quality lenses — reuse, leanness, efficiency — and each runs on Claude. Every reviewer writes findings to `.flightlog/review/attempt-N/<lens>.md` and edits nothing. A single Opus **fixer** then reads all the files and applies the changes. The external engine gives the deliberate cross-*vendor* signal that an all-Claude dev+judge cannot produce. If it is unreachable, that reviewer writes its `<ENGINE> UNREACHABLE` token instead. The fixer then flags this, and the gate fails the task rather than pass an un-reviewed deliverable. Codex review is sandbox-enforced read-only. Opencode review is prompt-enforced read-only instead — its wrapper prepends a hard "analyze only" guard.
- **One lens per direction: `reuse` may add code, `leanness` may only cut.** The quality lenses used to be four — reuse, simplification, efficiency, altitude. `altitude` pointed both ways at once: its brief was "flag over-engineering **and** under-engineering", so on a single span it could ask the fixer to inline an abstraction while also asking for a helper, and `simplification` restated most of its over-engineering half besides. The fixer reads every findings file in one pass with no arbitration rule, so a lens that argues with itself is a lens the fixer has to guess about. Splitting the direction by lens fixes that: `reuse` absorbed the "copy-paste that wants a helper" half and is now the only lens permitted to ask for more code *on that axis*, and `leanness` replaced `simplification` plus `altitude`'s remaining half with a cut-only brief. Its output contract — the five tags and the closing net-lines line — is adapted from the [ponytail-review](https://github.com/DietrichGebert/ponytail) skill; the lens is named for the quality it judges, matching `reuse` and `efficiency`, rather than carrying that project's name. Where the two do land on the same span, the fixer prompt names it as a real trade-off to settle rather than a contradiction to route around. `leanness` also closes a coverage gap neither predecessor had: `reuse` looks for reuse *inside the codebase*, so nothing caught a hand-rolled `Intl.DateTimeFormat` or a dependency doing what the runtime already ships — that is what the `stdlib:` and `native:` tags are for. That borrowed output format is the point, not decoration: a tag plus a one-line replacement makes a lens that would otherwise hedge ("have you considered whether…") commit to a location, a cut, and a concrete substitute. The count drop 4→3 is a real saving — one fewer parallel Opus agent per Final review attempt. **Scope that "only reuse may add code" rule to the abstraction axis when you word it.** The first draft said "every other lens only cuts", and the fixer prompt repeated it; `efficiency` routinely proposes a cache, a batch, or an index, so the blanket phrasing handed the fixer a rule for rejecting a valid perf fix on the grounds that it added lines. The fixer prompt now names `efficiency` explicitly as exempt.
- **`CFG.liveReviewEngine` puts that cross-vendor lens in a visible herdr pane.** It is gated on `CFG.relayPath` alone, deliberately **not** on `liveDevEngine` or on `devEngine`: the review lens is external on every flight, including an all-Claude one, so tying it to the dev engine would make the most common flight the one that can never watch its own review. The lens agent then runs `relay <engine> review --git-scope none --wait-timeout 480000` instead of the `<engine>-run.ts review` wrapper, and the same 480s-inside-600s pairing and `relay collect` pending rounds apply for the same reasons they do on the dev path. It passes `--dangerous` like the dev delegate, and that is the deliberate call: a live pane has no sandbox flag of its own, so an approval prompt nobody is watching stalls the lens until the wait and every collect round expire — roughly half an hour, ending in a false `UNREACHABLE` on a review that was never actually blocked. Autopilot runs semi-unattended, so a stall costs more than the risk it buys back. Read-only stays prompt-enforced from two directions (relay's REVIEW_CONTRACT and the lens prompt's own "record, never edit"), and a reviewer that edits anyway surfaces downstream: the fixer re-runs the task's verification, and the binary gate grades the result. A pending review that never lands is written as the `<ENGINE> UNREACHABLE` token, exactly like a non-zero exit — the fixer must fail the task rather than pass an un-reviewed deliverable, so "still running" cannot quietly become "no findings". The three Claude quality lenses are unaffected; they are Claude agents with no CLI to place in a pane.
- **The fixer is not the judge.** The reviewers and the fixer form the "dev" side of the Final review. The binary gate and the rubric judge stay independent. So the dev≠judge anti-self-grading split still holds, even though this round is more elaborate.
- **`CFG.devEngine: 'codex'` (or `'opencode'`) hands the dev step to that CLI.** The default is `'claude'` (Sonnet→Opus). `CFG.lastShotEngine` defaults to `''` (off); on a Claude ladder, setting it to `'codex'` or `'opencode'` appends one external attempt after the Opus rung without replacing Opus. It is ignored when `devEngine` is already external, because that ladder already ends on Claude-Opus. When `devEngine` is set to an external engine, each non-finalReview task's dev step becomes a cheap Haiku *driver*. That driver runs the `<engine>-run.ts delegate` wrapper — the same wrapper the cross-vendor review lens uses, reachable from a Workflow agent's Bash. So the external CLI writes the implementation. If `CFG.liveDevEngine` is true and `CFG.relayPath` resolved under `HERDR_ENV=1`, the driver instead runs the same delegate through relay in a visible herdr live pane. Otherwise it uses the headless wrapper exactly as before. The verify → judge → score pipeline stays Claude. This *strengthens* the dev≠judge split into a cross-vendor one: the external CLI writes, and Claude-Opus judges. An external-engine ladder's last attempt before the cap still falls back to Claude-Opus, so a task the external engine cannot clear gets one strong Claude try before parking — **except at `maxAttempts: 1`**, where the `cap > 1` guard keeps that single attempt on the external engine rather than skipping it entirely, and there is no Claude fallback. A Claude ladder can instead end on the configured `lastShotEngine` after its Opus rung. If the CLI is unreachable, or relay returns no result, the driver never fabricates. The binary gate fails that attempt, and the loop reaches the next rung. The live path passes `--wait-timeout 480000` (8 min), and the driver is told to make ONE foreground Bash call with `timeout: 600000`. **That pairing is load-bearing: the wait must expire inside the Bash tool's 600s hard cap — with margin.** The margin is not optional: relay's poll clock starts *after* it spawns the pane and waits up to `SPAWN_IDLE_WAIT_MS` (20s) for the TUI to settle, so the Bash call's wall time is that setup plus the wait plus cleanup. 480s leaves roughly 90s of slack; 540s did not. A command that outruns the cap is moved to the background, and a cheap Haiku driver left to invent its own wait writes a `while sleep 5; do ... jobs %1 ...; done` poll loop — which can never work, because every Bash call gets a fresh shell where `jobs` sees nothing. Live transcript: the loop spun the full 600s and the driver read a *complete* result the instant it returned. Ten minutes burned after codex had already finished, plus an orphaned loop. So the driver prompt bans `run_in_background` and shell poll loops outright, and the wait is bounded below the cap so the one call returns on its own. Relay's poll loop returns the instant the result lands, so the budget costs nothing for normal-speed tasks. **A `pending` outcome is not a failure and must not be treated as one.** Relay checks the pane's status before reporting it: an agent that has settled without a verified result is reported as a real failure instead, so `pending` specifically means the delegate is *still working* — and still writing the working tree, with its pane still open. Failing the attempt there would start a second writer on the same files. So the driver keeps waiting instead: `CFG.liveCollectRounds` (default 3) more `relay collect` calls, each reattaching to that same pane for another 8-minute window. A task can therefore run ~32 min while every individual Bash call still returns inside the 600s cap. Only when the last allowed collect is still pending does the attempt fail. Do not wait indefinitely, and do not use `herd wait` for this — it blocks until `idle`, and codex parks at `done`, so it can miss a finished delegate entirely; `collect` reuses relay's own `idle`-or-`done`-plus-marker test. `devEngine` and `reviewEngine` are independent. You can have opencode write and codex review, or the reverse. Only the dev step changes. finalReview's multi-lens round, and everything else, stay untouched.

- **The external dev driver does not run the task's Verification commands; the Claude dev prompt still does.** That asymmetry is deliberate, not a missed edit. A Claude dev is the author: it holds Edit/Write, and a red result in its own turn is a self-correction that saves an attempt before the gate ever sees it. The driver holds no such lever — it may not hand-write the implementation (instruction shape (a)), and re-delegating is not a step it is given, so its verification could only ever be a report. And nothing reads that report: the dev step is `await agent(...)` with no assignment and no schema, and retry feedback is built by `renderHistory(attempts)` from the gate and judge verdicts, never from the dev's returned prose. So the driver's run duplicated the independent verifier's work — for the third time in a task, after the delegate's own run — while carrying two costs. It doubled a full verification pass (a suite, a typecheck) on wall clock. And it sat a cheap model in front of red output it had no sanctioned response to, which is exactly the pressure that produced both destructive-git incidents recorded below: the verifier that reached for `git reset --hard` in `tab-layout-selector`, and the Haiku driver that ran `git checkout` over a parallel task's file in `wf_5903a02b-b6e`. The driver also lacks the verifier's `SUSPECTED SIBLING INTERFERENCE` vocabulary, so in a parallel wave it could only misread a sibling's in-flight edits. **Two parts of the old step 6 stay, and neither is duplicated work.** `lint-task.ts` is the only structural check the task file gets — the external engine writes outside the harness, so the Edit/Write lint hook never saw it — and the verify agent does not lint. The changed-file list distinguishes "the engine produced nothing" from "the engine produced something wrong", which is what the failure path actually needs to log; the headless wrapper already prints a `git status --short`, so on that path it costs no command at all. The cost accepted is a thinner `dev` narrative row in the flightlog. It carries no verification result now, which is honest — the row never held a verdict anyone acted on.
- **The destructive-git ban belongs to every prompt that lets its agent choose what to run, not only to the prompts whose agents write source code.** The restore-family ban first reached only the dev prompt, the external dev driver prompt, and the fixer prompt because "writer" looked like the dangerous role. Universal Bash tool access made that boundary imaginary: every Workflow agent has Bash, including the verifier, rubric judge, review lenses, and commit agents, so role never bounded who *could* run a destructive command. Bash access is not the replacement boundary either. The two fixed task-status transitions (`mark-done` and `mark-blocked`) and the wave scout also have Bash, but each receives one scripted step rather than a decision: the transitions perform their single status edit and reread, and the scout runs exactly `bun .../next-ready.ts` with specified arguments. They are excluded on purpose because the real boundary is command discretion. The commit agents are included even though their job needs `git add`, `git commit`, `git status`, `git diff`, and `git log`, never the restore family: their instructions explicitly anticipate blocking hooks and merge conflicts, precisely the pressure under which an agent reaches for `reset` to tidy the tree before retrying. This is defense-in-depth, not enforcement. Workflow `agent()` accepts no tool allowlist, agent-frontmatter tool lists do not constrain Workflow subagents, an absolute path to `git` bypasses a PATH wrapper, and a before/after tree comparison detects damage only after `reset --hard` has made it unrecoverable. Keep dev, verify, and judge in the same task worktree so the verifier sees the uncommitted edits it must verify. The prompt is the only lever the script has. The failure was observed live in the `herdr-workbench` repository's `tab-layout-selector` flightplan on 2026-08-03 (`docs/tab-layout-selector/.flightlog/run.jsonl`): a module-extraction task and a config task were dispatched together at 06:17Z, then the extraction task's verifier attempted `git reset --hard` between 06:26Z and 06:33Z while the config task was still editing a shared source file. A human denied it. The verifier had seen test failures caused by its sibling's in-progress edits, had no sanctioned response to red output it did not create, and locally wiping the tree before another try was rational.

- **A verifier may delay a judgement; it may never avoid one.** A sibling-attribution waiver — "this failure is the sibling's, not mine, so I pass on my own criteria" — contradicts the gate's rule that every verification command must succeed. The files a task declares are not a causal boundary: a sibling can break this task's verification through a shared dependency, while this task's own regression can surface in a file it never declared. Yet unconditional strict fail is also wrong: failing as soon as red appears rejects green code whose shared dependencies are temporarily broken, wastes an attempt, and sends dev back to fruitlessly rewrite work that was already right. The gate therefore defers rather than waives to postpone the verdict: it waits for the tree to go quiet, reruns the verification commands exactly once, and treats that rerun's verdict as final. Quiet is a zero-crossing of the wave's live-writer count, not a one-shot "every first write finished" barrier, because a task that fails its gate retries dev and becomes a writer again. Waiting for siblings to reach terminal `blocked` or `done` state would deadlock two deferred tasks: each needs the other to terminate, and neither can terminate while waiting. The live-writer guard is load-bearing: deferral is refused unless another writer is active at that moment, or a verifier whose siblings already finished would gain a free second roll on a flaky failure or its own real regression, making the gate weaker than strict failure. A residual race remains: a sibling can begin a retry immediately after a zero-crossing releases the waiter, so the rerun can still meet a dirty tree. That outcome is a strict failure — never a better verdict or a different classification — which preserves the pre-existing behavior. A second residual has the same shape and the same outcome, and is worth naming because it looks like a hole: the external-engine dev driver can return while its live relay pane is still open and still writing — its own failure path says exactly that ("the pane was LEFT OPEN and is STILL WRITING") — so an abandoned delegate's writes fall outside the counted window and a sibling's `quiet()` can fire while that delegate works. Closing it means holding the lease until the pane terminates, which is the terminal-state wait rejected two sentences above, and it would deadlock on the same mutual-defer shape. It is left open deliberately, because the safety argument does not depend on the count being complete: the rerun is strict either way, so an uncounted writer can only cost a task an attempt, never buy one a pass. The count is an optimisation over strict failure, not the thing that makes the verdict sound. The same `herdr-workbench` `tab-layout-selector` run on 2026-08-03 (`docs/tab-layout-selector/.flightlog/run.jsonl`) proved why the verdict cannot be reclassified: after the denied reset, the verifier reported `PASS` over two tests that were still failing and attributed them to the sibling on its own initiative. That false positive is already in the wild, so "failed tests are the sibling's problem" is not a verdict type the script permits.

- **Only the commit agents commit — every other writer leaves its work unstaged.** `NO_COMMIT_RULE` goes into the Claude dev prompt, the external dev driver's prompt *and* the instruction that driver writes for its CLI, and the final-review fixer's prompt. It is one shared constant so the three writers cannot drift apart. Two things break when a task commits itself. The wave stops being one atomic commit — the inter-wave commit agent finds a partially committed tree and writes a second, incoherent commit for the remainder. And in a parallel wave, whatever the committing task stages sweeps up a sibling task's half-finished edits, so a commit message describes work its diff does not contain and a later revert takes an unrelated task with it. The external engines need the ban twice over: `codex` and `opencode` write the tree outside the harness, where no hook can stop them, and both are trained to finish a job by committing it.

- **The external driver's instruction file is shape-constrained, but it still restates the no-commit ban in its own words.** Step 3 forbids three things in the file it writes for the CLI: implementation code the driver authored, a softened gate, and a claim that existing work is already correct. Retry feedback is bounded the same way — it may add requirements, never subtract a verification command or excuse the rejected attempt. One live run produced all three at once. The driver wrote every migration, model, service, and spec as ready-to-paste Ruby, which reduces a cross-*vendor* dev step to transcription of a Claude solution and throws away the only reason to run an external engine. It then hit a `git status`-shaped acceptance gate that had failed the previous attempt, and instead of letting it fail it added staging steps to satisfy the gate and told the CLI to skip the checks that had errored. `lint-task.ts`'s `scope-git-status` rule already calls that gate a plan defect the driver must leave standing; the instruction file was simply a channel the rule did not cover.

- **The paraphrase of the ban is a known, accepted hole.** The same run restated `NO_COMMIT_RULE` as `Do NOT commit. Leave all changes staged but uncommitted.` plus a `### Step 9: Stage All Changes` — the inverse of a rule that bans `git add` outright. Ordering the block pasted verbatim closes it, and that was tried and deliberately reverted: some real verification commands (`git diff --exit-code <generated-file>`, or a `bin/ci` wrapper around one) only pass against a staged tree, and a hard verbatim ban parks those tasks with no escape. The cost of leaving it open is worse than the atomicity argument above suggests, so it is written down here rather than assumed benign. A task that pre-stages a path puts it in the index before the wave commit agent runs. That agent stages by name and never `git add -A`, but `git commit` takes the whole index regardless — and it is bound by `NO_RESTORE_RULE`, so it may not run `git restore --staged` to take a foreign path back out. If the pre-staged path belongs to a **parked** task, the held-back guarantee breaks with no recovery path available to any agent in the run. The three shapes differ: `git diff --exit-code` passes once staged (and staging defeats its intent, since it exists to prove the *committed* file matches the code), a `git status --porcelain` emptiness check does not pass, and a wrapper script is opaque to inspection. `scope-git-status` matches only `git status`, so the first and third shapes reach the driver unflagged.

  The rule bans the *restore* family — `git checkout`, `git restore`, `git reset`, `git clean` — in its own sentence, because the "any other command that changes git state" clause genuinely does not reach them: they rewrite the working tree and leave refs and the index alone, so a careful reader concludes they are permitted. A Haiku dev driver did exactly that in run `wf_5903a02b-b6e`, running `git checkout` over a *parallel* task's file to tidy its workspace and reverting a confirmed `Status: done` back to `todo`. The rule also separates the two prohibitions on purpose: editing a source file a sibling also edits is legitimate and common — that is what a parallel wave *is* — so the ban is narrowed to other tasks' files under `tasks/`. A blanket "don't touch files that aren't yours" would forbid the shared-file edits the plan itself schedules.
- **Commits use inline git, not the atomic-commit skill — the same `no Agent tool` constraint applies.** The inter-wave and post-loop commits must NOT invoke `odin-git:atomic-commit`. That skill spawns the vör + bragi sub-agents, and a Workflow agent cannot do that. Its analysis script also lives in a *different* plugin's cache, which the agent cannot resolve — there is no `CLAUDE_PLUGIN_ROOT` in agent Bash. The `commitInstructions` builder inlines the skill's whole contract instead: the matched flightlog lifecycle, the atomic grouping principles, plus the exact commit-message template (emoji/type subject, English body, `---`, zh-TW summary). So each labeled agent commits over plain git, self-contained. If the commit convention changes, edit the template in that one builder.
- **Concurrency** is capped by the Workflow runtime (`min(16, cores-2)`). Passing a wide wave is safe — excess tasks queue.
- **A plan caps its own concurrency with `> **Max parallel**: N` in PLAN.md, and the scout carries it.** `next-ready.ts --summary` parses the header into `maxParallel` (`null` when absent or `unlimited`), and the wave loop hands each task a slot from `makeSlots`. **The slot spans the whole pipeline — dev, verify, requalify, judge, mark-done, park — not only the writer windows.** The live failure was in `~/.config` `docs/sketchybar-swift-daemon`: seven tasks went out after `core/05`, and a Haiku verifier ran `swift build` and live checks while a sibling's codex delegate was mid-reinstall of the shared bar. The verifier is deliberately not a writer, so a cap on writers alone would have let exactly that through. That plan's workaround was a `mkdir /tmp/sketchybard-live.lock` rule pasted into four prompts; it reached an external delegate only when the Haiku driver copied it, and never reached the requalify agent or the fixer. A slot needs no prompt at all. **The cap is read off disk every wave, never baked into `CFG`**: a baked copy is one more value the main agent must remember to transcribe, and a missed transcription is the same silent parallel run. For the same reason a scout whose structured `maxParallel` is missing is a `(scout)` failure rather than "no cap", and a malformed header is a parse error in `errors`. The watch is sized by slots, so a serial task's `SUSPECTED SIBLING INTERFERENCE` deferral is refused — there is no sibling. **Residual:** a scout that drops `modelsRaw` from stdout and also invents `null` in `readyModels` silently selects defaults; these two coordinated errors can evade the same cross-check used for `maxParallel`. **Serial prose is only an advisory.** `lint-task.ts <tasks-dir>` prints `[serial-undeclared]` when PLAN.md or `_context/*.md` asks for serial execution or a lock without the header; it is not a violation because the matching wording in real plans (2 of ~20 on one machine, before the pattern was narrowed) was already enforced by `Depends on` edges. **Residual:** an external live delegate whose pane was left open and still writing after its driver returned holds no slot, so the next task can start beside it — the same uncounted writer the deferral note above accepts.
- **A single-task resume replaces the wave loop, and gets a whole fresh cap.** `CFG.resumeTask` runs one `executeTask` and no scout: there is no tree to read, and the ref, path and `finalReview` flag come from `CFG` because nothing downstream re-derives them. `CFG.resumeAttempt` only moves where the numbering *starts* — the task still gets `maxAttempts` (or `finalReviewMaxAttempts`) rungs, because a resume is a fresh flight for that task and the number exists so the flightlog and the `score-task.ts --log` verdict rows keep rising instead of colliding with the parked run's. **That is why every rung is keyed off `last` (`first + cap - 1`) and never off `cap`.** Two things break otherwise, both silently. `for (let attempt = 3; attempt <= FINAL_MAX; …)` is false on entry, so the loop body never runs and the task is re-parked having executed nothing — which reads exactly like "it tried again and still failed". And `attempt >= claudeCap` is already true on the first rung, so a resumed Claude ladder raises effort immediately instead of reserving the increase for its last Claude rung. With `first` at 1 the two are equal and every existing ladder is byte-identical. The loop is written `while (!RESUME)` rather than wrapped in an `if/else` on purpose: an else-wrapper re-indents 240 lines and buries the actual change in a diff nobody can read.

- **`CFG.resumeFrom` skips steps on the resumed attempt only.** `startAt` is `RESUME.from` when `attempt === first`, and `'dev'` on every later attempt. So a resumed attempt that fails its gate runs the *whole* pipeline next time, including the Final review's four-lens round. That is the right default and not a missed optimisation: a red verify says the work below it genuinely does need redoing, and the alternative — a task looping forever on a verifier re-reading the same unchanged tree — is worse than paying for the round. `'judge'` synthesises `gate` rather than skipping it, because `gate.summary` is read downstream by the judge prompt and by `rejectionOf`; a skipped gate would hand both of them `undefined`.

- **Skipping the binary gate requires a signed artifact, and the attestation is scoped to the items it names.** `resumeFrom: 'judge'` throws at script start without `CFG.attestationFile`. The alternative was a free-text `--evidence` string, and it was rejected: once *any* wording can stand in for the gate, every red task can be passed by asserting a person checked it, and no later reader can tell an honest attestation from a convenient one. So the file must name **which gate items** were performed, quoting each as the task file writes it; the verifier is told to reject an entry that is not an item of that task, and never to treat the attestation as ranking above a command. The residual is honest and unclosable from inside the script: a person who signs for a check they did not perform gets the pass, and all the design buys is that the claim is specific, on disk, and attributable. `resumeFrom: 'verify'` needs no attestation — it runs the real gate and only adds evidence.

- **A `(human)` gate item is declared by the plan, skipped by the verifier, and reported at the end of the run.** The tag sits at the head of a gate item (`- [ ] (human) …`) and means no command can perform it — a pointer sweep, a hardware toggle, a click on a menu-bar app. Before this, such an item guaranteed a park: the verifier could only fail it, so the task burned every attempt and stopped the tree on work that was correct. Now the verifier leaves it alone, returns it in `humanPending`, and the task passes on its machine-checkable half; the orchestrator collects those into `needsHuman` and the main agent prints them as a closing checklist. Three rules keep that from becoming a pass key. The **plan author** declares the tag, with the same authority that wrote the criterion — a verifier may never add one, and an item it merely finds hard to run must be left to fail, because an uncheckable item is a plan defect. **`lint-task.ts`'s `human-gate` rule refuses a gate section whose items are all tagged**, so a tagged plan always leaves the verifier real work; that rule is what stops the tag from hollowing out the binary gate one item at a time. And `humanPending` is taken from the **passing** gate only — a failed attempt is retried, and its verifier re-derives the same list, so carrying a rejected attempt's list forward would report every item twice. **Known residual:** `mark-done.ts` ticks a `(human)` box like any other, so the task file alone cannot tell you a person still owes a check. `RUNLOG.md` and the run result are where that lives, which is why the verifier's flightlog message ends with `NEEDS HUMAN: <n> item(s)`.

- **Do NOT give the dev agent `isolation: 'worktree'`.** Avoid `agent({isolation: 'worktree'})`: it isolates one agent call and never merges back. Let the orchestrator own one worktree per task across dev → verify → judge, with mechanical agents creating and landing it through `worktree.ts`. Admit a judged pass into the main tree only through a three-way land under the main-tree lock.

- **Rebase the task worktree onto the current main tree after a land conflict.** Charge one attempt because dev must resolve the conflict markers. Allow conflicting edits within a wave without a `Depends on` edge.

- **Use a land op id per attempt.** After a conflict fix, let the next attempt's land act instead of replaying the old conflict.

- **Hold the main-tree lock around every `worktree.ts` call.** Prevent an unlocked create from snapshotting half a land and two unlocked state rewrites from losing an entry. Stop the run with its cause if a sweep or baseline fails twice; no task owns that failure.

- **Throw on a null worktree result inside the `make` passed to `resilient`.** Trigger its single retry, which otherwise runs only on a throw. Repeat the identical command, including `--expect` and `--op`; replaying a recorded `--op` in `worktree.ts` makes a land retry safe.

- **Re-verify a clean land with drift before marking the task done.** Hold the main-tree lock and the task slot while `reverify` runs Verification in the repo root with the task's verify model and effort. Record the new fingerprint only after a pass. On failure, run `unland` and `rebase` under the same lock with attempt-specific op ids, then feed `REVERIFY FAIL` and the summary to the next dev attempt. Keep the worktree when the attempt cap parks the task.

- **Retry a null drift re-verify once by throwing inside `resilient`'s `make`.** Repeat the same prompt on the structured retry model. If neither call returns a structured result, unland under the lock, then park as an infrastructure failure without rebasing or starting another attempt. Keep the worktree and the previous main fingerprint.

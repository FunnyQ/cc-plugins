# Autopilot orchestrator — canonical Workflow script

This is the script the `autopilot` skill adapts and passes to the **Workflow** tool.
Read the three hard constraints in `SKILL.md` first. They explain every awkward-looking choice in this file.

The main agent scouts inline. It then calls `Workflow({ script: <this> })`. **Bake the
scouted values into the `CFG` block at the top of the script as literals.**

Wave loop: `scout → tree guards → derive fresh ready tasks → stall guard → inter-wave commit → budget-floor check → parallel task dispatch → reconciliation → no-progress stop`.

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
  opencodeDevModel:      '',        // optional opencode model for devEngine or lastShotEngine (empty → wrapper default opencode-go/kimi-k2.7-code); codex ignores -m
  opencodeReviewModel:   '',        // optional opencode model for the review lens (empty → wrapper default opencode-go/qwen3.7-max); only applies when reviewEngine is 'opencode'
  reviewLensModel:       'opus',    // 'opus' (default) or 'fable' — model for the 4 final-review /simplify lenses (reuse/simplification/efficiency/altitude) ONLY; the fixer + rubric judge stay Opus
}

// ── Model policy (tune here — one place) ───────────────────────────────────
// Final review reviewers split by what the lens actually needs:
//   reviewExternal (Haiku) — only DRIVES an external CLI (codex/opencode); the
//     review intelligence lives in that CLI, so the wrapping agent just invokes
//     + records.
//   reviewLens  (Opus default; CFG.reviewLensModel can set 'fable') — the four
//     /simplify lenses must truly *understand* the code to judge
//     reuse/complexity/efficiency/altitude, so they get a strong model. Tunable in
//     one place via CFG.reviewLensModel ('opus' | 'fable'); this affects ONLY the
//     four lenses — the fixer and rubric judge stay Opus regardless.
//   fix (Opus) — reads every finding and applies the changes.
//   devExternal (Haiku) — used when CFG.devEngine is external or a Claude ladder
//     reaches CFG.lastShotEngine: a cheap driver that has that CLI write the implementation
//     (via <engine>-run.ts delegate) and verifies. The coding intelligence lives
//     in the external CLI, so the driver just invokes + checks. An external-engine
//     ladder ends on Claude-Opus; an opted-in Claude ladder ends on the external rung.
const MODEL = { dev: 'sonnet', devEscalated: 'opus', devExternal: 'haiku', verify: 'haiku', judge: 'opus', reviewExternal: 'haiku', reviewLens: CFG.reviewLensModel ?? 'opus', fix: 'opus', commit: 'haiku' }
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
// Attach an optional `--model` flag for opencode (codex ignores -m). Spread into a
// fresh object so dev and review never share a mutated entry even when both are
// opencode. Empty modelFlag → the <engine>-run.ts per-mode default is used.
// Throws on an unknown key rather than spreading `undefined` — that would yield
// a truthy `{modelFlag}` object whose `label` is undefined, and the run would die
// far away, inside a Final review reviewer prompt.
const withModel = (key, override) => {
  if (!ENGINES[key]) throw new Error(`unknown engine "${key}" — CFG.devEngine/lastShotEngine/reviewEngine must be codex or opencode`)
  return { ...ENGINES[key], modelFlag: key === 'opencode' && override ? ` --model ${override}` : '' }
}
const devEngine    = CFG.devEngine && CFG.devEngine !== 'claude' ? withModel(CFG.devEngine, CFG.opencodeDevModel) : null
// Appended, never substituted: replacing the Opus rung would lose every task that
// only Opus clears. Null whenever devEngine is already external — that ladder
// already ends on Claude-Opus, so it is already a vendor switch.
const lastShotEngine = (!devEngine && CFG.lastShotEngine)
  ? withModel(CFG.lastShotEngine, CFG.opencodeDevModel)
  : null
const reviewEngine = withModel(CFG.reviewEngine ?? 'codex', CFG.opencodeReviewModel)
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
  },
  required: ['stdout', 'exitCode', 'stderr'],
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

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },     // every Verification command + Acceptance criterion passed
    summary: { type: 'string' },     // raw evidence: commands run, exit codes, failing output
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

const devPrompt = (ref, path, attempt, feedback) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

You are implementing flightplan task ${ref} in the tree at ${CFG.tasksDir}.
Read the task file at ${path} and every file in its "Required reading".
Implement the task fully: create/modify the listed files, follow Implementation notes.
${attempt > 1 ? 'This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nAddress that specifically.' : ''}
${STATUS_RULE} When done, run the task's ## Verification commands yourself.
Then log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "<your label>" --phase end --message "<what you changed>"
Return a one-paragraph summary of what you did.`

// External-engine dev driver — used when CFG.devEngine is 'codex' or 'opencode'.
// The agent does NOT hand-write the implementation; it has the external CLI write
// it via our thin `<engine>-run.ts delegate` wrapper, or optionally via relay in a
// visible herdr live pane, and then verifies. The driver reads the command stdout
// only — it never mines temp/transcript files. The driver feeds the CLI the full
// task context so it never needs to pause for clarification (it runs non-interactively).
// If the CLI is unreachable the driver must NOT fabricate code — it reports failure
// so the binary gate fails the attempt and the loop proceeds to the next rung when
// one remains, or parks after the cap.
const devExternalPrompt = (engine, ref, path, attempt, feedback) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "dev-${engine.label}:${ref}#${attempt}" --phase start
Then proceed.
Use the identical label expression "dev-${engine.label}:${ref}#${attempt}" in both start and end calls. It names this task and attempt, so parallel delegates never close each other's row.

You are the ${engine.label.toUpperCase()} DEV DRIVER for flightplan task ${ref} (tree: ${CFG.tasksDir}). You do NOT write the implementation yourself — you have the ${engine.label} CLI write it, then you verify.
1. Read the task file at ${path} and every file in its "Required reading". Note its "Files to create / modify" list and "Implementation notes".
2. ${STATUS_RULE} Tell the external engine to leave it in-progress too.
3. Build the ${engine.label} instruction from the task file — the exact files to create/modify plus the full Goal, Implementation notes, and Acceptance criteria, telling ${engine.label} to implement the task fully and stay strictly within the listed files. It runs non-interactively, so give it EVERYTHING up front; it can never ask you anything.${attempt > 1 ? ' This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nFold this feedback into the instruction so ' + engine.label + ' fixes exactly that.' : ''}
4. Write that instruction to a temp file, then run this as ONE FOREGROUND Bash call with \`timeout: 600000\` (the Bash tool maximum):
  ${liveDev ? `bun ${CFG.relayPath} ${engine.label} delegate --prompt-file <your-instruction-file> --git-scope none --dangerous --wait-timeout 480000` : `bun ${S}/${engine.wrapper} delegate${engine.modelFlag} --prompt-file <your-instruction-file>`}
   WAIT RULE — never improvise a wait. Do NOT set \`run_in_background\`. Do NOT write a shell poll loop (\`while\`, \`jobs\`, \`wait\`, repeated \`tail\`). Every Bash call gets a fresh shell, so \`jobs\` can never see a command an earlier call started: such a loop spins until the 600s cap and burns ten minutes AFTER ${engine.label} has already finished. ${liveDev ? `The \`--wait-timeout 480000\` above is sized to expire inside the 600s cap with margin for relay's pane spawn and cleanup, so this one call normally returns on its own. It can still outrun the cap: when relay cannot spawn a pane it falls back to headless inside the same invocation, and headless has no timeout at all.` : ''} If the harness reports that the call outran the cap and was moved to the background, do not poll: wait for the completion notification, then Read the output file it named, once.
   ${liveDev ? `Relay runs ${engine.label} in a visible herdr live pane, edits the working tree directly, prints the delegate result on stdout, then closes the pane on success. Read that stdout — do NOT go looking for any temp/transcript files.` : `The headless wrapper has ${engine.label} edit the working tree directly, then prints its summary plus a \`git status --short\` of what changed, and cleans up its own scratch. Read that stdout — do NOT go looking for any temp/transcript files.`}
${liveDev && COLLECT_ROUNDS > 0 ? `5. PENDING — relay prints a report starting "Live ... still running after ...". ${engine.label} is NOT finished and has NOT failed: it is still writing the working tree, and the pane is still open. Do NOT retry, do NOT hand-write anything, and do NOT go to step 6 yet. Keep waiting instead: copy the \`relay ... collect --agent <name> --result <path>\` command the report prints, and run it — again ONE foreground Bash call with \`timeout: 600000\`, and the same WAIT RULE. It reattaches to that same pane and watches for another window. Run collect **at most ${COLLECT_ROUNDS} times in total** — the first collect is round 1, so after round ${COLLECT_ROUNDS} you stop. The moment any collect prints the delegate's result, continue at step 6 as a normal success. Only when round ${COLLECT_ROUNDS} still reports pending, go to step 5b.
5b. FAILURE PATH` : `5. FAILURE PATH`} — the command exits non-zero${liveDev ? `, or relay returns an empty/absent result${COLLECT_ROUNDS > 0 ? ', or the last allowed collect is still pending' : ', or relay prints a PENDING report ("still running after ... this is NOT a failure" — relay exits 0, but autopilot counts that delegate as NOT finished)'}` : `, or its output begins with "${engine.token}"`}. Then: do NOT hand-write the implementation yourself, and do NOT return early. Run steps 6 and 7 as usual, then return a summary whose FIRST word is FAILED, stating ${engine.label} was unreachable, failed, or timed out.${liveDev ? ' For a still-pending delegate, name the Agent from relay stdout in the step-7 log and note the pane was LEFT OPEN and is STILL WRITING the working tree.' : ''} Step 6 is the real correctness gate: it decides whether anything usable actually landed, so never skip it. The binary gate then fails this attempt; the loop moves to the next rung when one remains, or parks after the cap.
6. Lint the task file, then verify. The lint runs FIRST, before any verification:
     bun ${S}/lint-task.ts ${path}
   The external engine edits files outside the harness, so the Edit/Write lint hook never saw its work — this call is the only structural check on the task file. A non-zero exit means the engine left the task file malformed (a decorated Status, a hand-ticked gate box, a sibling-task reference). Repair the header yourself until it lints clean: reset "> **Status**:" to a bare \`in-progress\`, and never hand-tick an Acceptance criteria or Verification box. Only then run the task's ## Verification commands YOURSELF to confirm the changes actually hold.
7. Log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "dev-${engine.label}:${ref}#${attempt}" --phase end --message "<what ${engine.label} changed, or '${engine.label} unreachable'>"
Return a one-paragraph summary: what ${engine.label} implemented and your verification result.`

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
//   - reuse         : duplicated logic, missed reuse of existing helpers   ┐
//   - simplification: dead code, needless complexity, clearer equivalents   │ the four
//   - efficiency    : wasteful work, N+1s, redundant passes/allocations     │ /simplify
//   - altitude      : right level of abstraction (over-/under-engineering)  ┘ lenses
// The external engine owns bugs (where cross-vendor diversity matters most); the
// four Claude lenses own quality cleanups. Reviewers only record findings to
// files; only the Opus fixer edits code. The fixer ≠ judge, so the dev≠judge
// anti-bias split holds.
const REVIEW_LENSES = [
  { key: reviewEngine.label, external: reviewEngine, model: MODEL.reviewExternal, focus:
    'CROSS-VENDOR bug & correctness review — driven through the external CLI wrapper (see the external-engine prompt branch).' },
  { key: 'reuse', model: MODEL.reviewLens, focus:
    'REUSE. Find duplicated logic and code that reinvents something the codebase already provides (existing helpers, utils, types, patterns). Each finding: file:line, what duplicates what, the reuse to apply.' },
  { key: 'simplification', model: MODEL.reviewLens, focus:
    'SIMPLIFICATION. Find dead code, needless complexity, and constructs with a clearer behaviour-preserving equivalent. Each finding: file:line, the simpler form.' },
  { key: 'efficiency', model: MODEL.reviewLens, focus:
    'EFFICIENCY. Find wasteful work — redundant passes, N+1 calls, recomputation, needless allocations/IO. Each finding: file:line, the cheaper approach.' },
  { key: 'altitude', model: MODEL.reviewLens, focus:
    'ALTITUDE. Judge whether code sits at the right level of abstraction: flag over-engineering (premature generality, speculative indirection) and under-engineering (copy-paste that wants a helper). Each finding: file:line, the right altitude.' },
]

// findings live under the flightlog dir (self-gitignored) → audit artifact
const reviewDir = (attempt) => `${CFG.logFile.replace(/\/[^/]+$/, '')}/review/attempt-${attempt}`

// The cross-vendor lens drives an external CLI (codex/opencode) through our
// wrapper; the four Claude lenses review the diff themselves. Branch on
// lens.external (the resolved ENGINES entry; undefined for a Claude lens).
const reviewPrompt = (ref, lens, attempt) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role review --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

${lens.external ? `
You are the ${lens.external.label.toUpperCase()} (cross-vendor) reviewer in the FINAL REVIEW of flightplan ${CFG.slug} (task ${ref}). You do NOT review the code yourself — you have the ${lens.external.label} CLI review it and you record its findings.
1. Write a review instruction to a temp file: tell ${lens.external.label} to review THIS run's changes for BUGS & CORRECTNESS (logic errors, broken edge cases, regressions, security) — it should inspect both \`git diff ${CFG.baseRef}..HEAD\` (committed task changes) and \`git diff\` (uncommitted fixer edits) and report each issue with file:line and the concrete fix.
2. Run this as ONE FOREGROUND Bash call with \`timeout: 600000\` (the Bash tool maximum): ${liveReview ? `bun ${CFG.relayPath} ${lens.external.label} review${lens.external.modelFlag} --git-scope none --dangerous --wait-timeout 480000 --prompt-file <your-instruction-file>` : `bun ${S}/${lens.external.wrapper} review${lens.external.modelFlag} --prompt-file <your-instruction-file>`}
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
Write your findings to ${reviewDir(attempt)}/${lens.key}.md (run \`mkdir -p ${reviewDir(attempt)}\` first) as a short markdown bullet list — each finding carries file:line and the concrete fix. If nothing is material, write exactly "No findings.".`}
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role review --attempt ${attempt} --agent "<your label>" --phase end --message "<findings count>"
You are a REVIEWER: do NOT edit any source file — only record. Return a one-line count of findings.`

const fixPrompt = (ref, path, attempt, feedback) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role fix --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

You are the FINAL REVIEW fixer for flightplan ${CFG.slug} (task ${ref}), on Opus. Independent reviewers have each written findings to ${reviewDir(attempt)}/ (one file per lens: ${reviewEngine.label}, reuse, simplification, efficiency, altitude).
1. Read EVERY file in ${reviewDir(attempt)}/. If ${reviewEngine.label}.md is MISSING, is empty, or begins with "${reviewEngine.token}", call that out prominently — the cross-vendor pass did not run.
2. Apply the real fixes (you have Edit/Write). Use judgement: fix correctness / integration / regression issues from the cross-vendor lens, and the safe quality cleanups from the four Claude lenses (behaviour-preserving). For any finding you reject, say why.
3. VERIFY. Open the task file at ${path} and run its ## Verification commands yourself; confirm green and that the PLAN goal ("${CFG.planGoal}") is met.
${attempt > 1 ? 'This is re-loop attempt ' + attempt + ' (capped at ' + FINAL_MAX + '). The previous round was rejected:\n' + feedback + '\nEnsure the new findings + your fixes address that.' : ''}
${STATUS_RULE}
Log a narrative note (which lenses fired, total findings, what you fixed, whether the cross-vendor lens ran):
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role fix --attempt ${attempt} --agent "<your label>" --phase end --message "<summary>"
Return a one-paragraph summary: lenses run, cross-vendor status, key fixes, verification result.`

// Run the Final review "dev" step: fan out the lenses in parallel, then one
// Opus fixer applies every finding. Replaces the single dev agent for the
// finalReview task; the binary gate + judge + score gate downstream are unchanged.
async function runFinalReview(ref, path, attempt, attempts) {
  await parallel(REVIEW_LENSES.map(lens => () =>
    agent(reviewPrompt(ref, lens, attempt),
      { label: `review:${lens.key}#${attempt}`, phase: 'Execute', model: lens.model })))
  await agent(fixPrompt(ref, path, attempt, renderHistory(attempts)),
    { label: `fix:${ref}#${attempt}`, phase: 'Execute', model: MODEL.fix })
}

const verifyPrompt = (ref, path, attempt) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role verify --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

You are an INDEPENDENT verifier for flightplan task ${ref} (tree: ${CFG.tasksDir}).
Do NOT trust the dev's claims. Open the task file at ${path}, then:
  1. Run every concrete command in its ## Verification section yourself.
  2. Check every box in ## Acceptance criteria against the actual code/output.
Report passed=true ONLY if all verification commands succeed AND all acceptance criteria hold.
Put the raw evidence (commands, exit codes, failing output) in summary. Do not make subjective quality judgements — that is the rubric judge's job.
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role verify --attempt ${attempt} --agent "<your label>" --phase end --message "<verification passed or failed>"
`

const judgePrompt = (ref, path, gateSummary, attempt) => `
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role judge --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
Use the identical label in both start and end calls.

You are the rubric judge for flightplan task ${ref} (tree: ${CFG.tasksDir}).
The independent binary gate already PASSED with this evidence:
${gateSummary}
Open the task file at ${path} and its ## Eval rubric. Score EACH dimension 0–scaleMax based on the real code and the verification evidence above — ground the correctness dimension in that evidence, not opinion.
Write the scores JSON to a temp file, then run score-task.ts to compute and persist the verdict:
  echo '<scores-json>' > /tmp/scores-${ref.replace('/','-')}.json
  bun ${S}/score-task.ts ${path} /tmp/scores-${ref.replace('/','-')}.json --json --log ${CFG.logFile} --attempt ${attempt} --agent "<your label>"
If the command exits 1, that is a valid rubric failure; still return the printed JSON verdict. Return the CLI's printed verdict object VERBATIM as "verdict", plus your scores and rationale.
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role judge --attempt ${attempt} --agent "<your label>" --phase end --message "<weighted score>"
`

const markDonePrompt = (ref, path) => `
Finalize flightplan task ${ref} at ${path}. Do this in three steps and report a verdict.
1. Run: bun ${S}/mark-done.ts ${path}
   It deterministically sets "> **Status**: done" AND ticks every checkbox in the task's ## Acceptance criteria and ## Verification sections in ONE transition (the task passed the gate, so all hold). It validates the header FIRST: on a malformed header it exits non-zero and writes nothing at all.
2. Re-read ${path} and find the "> **Status**:" line in the header blockquote.
3. Return ok=true ONLY if the command exited 0 AND that line reads exactly "> **Status**: done" with nothing after the value. Put the value you actually read into status.
   Otherwise return ok=false, the value you read into status, and the command's stderr into error.
Change nothing else by hand. NEVER edit the Status line or tick a checkbox yourself — if mark-done.ts failed, report the failure. A hand-written "done" would fake a gate result that the tree then trusts forever.`

const markBlockedPrompt = (ref, path, reason) => `
Park flightplan task ${ref} at ${path}. Do this in three steps and report a verdict.
1. Edit the "> **Status**:" line in the header blockquote to read exactly "> **Status**: blocked" — the value bare, with nothing after it. If that line is currently malformed (decorated, duplicated, or missing), REPAIR it to that exact bare form. Change nothing else in the file.
2. Re-read ${path} and find the "> **Status**:" line in the header blockquote.
3. Return ok=true ONLY if that line now reads exactly "> **Status**: blocked" with nothing after the value. Put the value you actually read into status.
   Otherwise return ok=false, the value you read into status, and what stopped you into error.
Do not tick or untick any checkbox. (Parked by autopilot: ${reason})`

// ── Failure shapes ──────────────────────────────────────────────────────────
// Two kinds of failure, handled differently:
//   QUALITY        — the work was judged and found wanting (gate failed, rubric
//                    below threshold). Retrying the dev loop is the right move.
//   INFRASTRUCTURE — nothing was judged at all: an agent returned no structured
//                    result, or the pipeline threw. Retrying dev would burn a
//                    second attempt on top of an unknown state, so the task is
//                    parked and escalated immediately.
// The distinction has to survive to the wave loop, so it rides in the result.
const infrastructureFailure = (ref, attempt, cause, parked) => ({
  task: ref,
  passed: false,
  infrastructure: true,
  // The attempt that was actually running. Compute WAS consumed; reporting 0
  // here would misrepresent the run.
  attempt,
  parked,
  reason: cause,
})

// Best-effort park. Every catch path must try this, and must record whether it
// worked — an unparked task stays `in-progress`, which next-ready never offers
// again, so it would vanish from the tree without a trace.
//
// "Worked" means the file was REREAD and shows a bare `Status: blocked`. An
// agent that returns a fluent summary having changed nothing is the failure mode
// this guards, so a non-null result is not evidence of anything.
async function parkBlocked(ref, path, reason) {
  try {
    const result = await agent(markBlockedPrompt(ref, path, reason),
      { label: `block:${ref}`, phase: 'Execute', model: MODEL.verify, schema: PARK_SCHEMA })
    return result?.ok === true
  } catch {
    return false
  }
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

// ── Per-task retry pipeline ─────────────────────────────────────────────────
async function executeTask(item) {
  const { ref, finalReview, path } = item
  // The cross-vendor Final review round gets its own (smaller) cap; everything
  // else uses MAX. Past the cap the task is parked + escalated, never skipped.
  const cap = finalReview ? FINAL_MAX : MAX + (lastShotEngine ? 1 : 0)
  const attempts = []
  for (let attempt = 1; attempt <= cap; attempt++) {
    let attemptModel = 'final-review'
    if (finalReview) {
      // multi-lens review fan-out + Opus fixer (always Opus, no escalation tier)
      await runFinalReview(ref, path, attempt, attempts)
    } else {
      // Dev step. An external devEngine falls back to Claude-Opus at its cap.
      // `cap > 1` keeps a single-attempt external ladder on its configured engine.
      // An opted-in Claude ladder instead appends its external rung after Opus.
      const lastShot = attempt >= cap && cap > 1
      // The appended rung is the final attempt, and only exists on a Claude ladder.
      const vendorRung = !!lastShotEngine && attempt === cap
      // The last CLAUDE rung. With an appended rung cap is MAX + 1, so the escalation
      // tier must key off the Claude cap. Keying off `cap` makes `attempt >= cap` false
      // at attempt MAX, so the ladder would run sonnet, sonnet, sonnet, external and
      // Opus would never execute — silently turning this append into a replace.
      const claudeCap = cap - (lastShotEngine ? 1 : 0)
      if (vendorRung) {
        attemptModel = lastShotEngine.label
        await agent(devExternalPrompt(lastShotEngine, ref, path, attempt, renderHistory(attempts)),
          { label: `dev-${lastShotEngine.label}:${ref}#${attempt}`, phase: 'Execute', model: MODEL.devExternal })
      } else if (devEngine && !lastShot) {
        attemptModel = devEngine.label
        await agent(devExternalPrompt(devEngine, ref, path, attempt, renderHistory(attempts)),
          { label: `dev-${devEngine.label}:${ref}#${attempt}`, phase: 'Execute', model: MODEL.devExternal })
      } else {
        const devModel = attempt >= claudeCap ? MODEL.devEscalated : MODEL.dev
        attemptModel = devModel
        await agent(devPrompt(ref, path, attempt, renderHistory(attempts)),
          { label: `dev:${ref}#${attempt}`, phase: 'Execute', model: devModel })
      }
    }

    // A verifier that returns NO structured result did not verify anything. That
    // is not the same as `passed: false`, which is a real verdict on real work.
    // Conflating them retries the dev loop against an unknown state.
    const gate = await agent(verifyPrompt(ref, path, attempt),
      { label: `verify:${ref}#${attempt}`, phase: 'Execute', model: MODEL.verify, schema: GATE_SCHEMA })
    if (!gate) {
      const cause = `verification did not run or did not return a verdict on attempt ${attempt}`
        + ` — the verify agent produced no structured result. The harness exposes no original cause for a null agent result, so none is reported here.`
      return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause))
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

    const judged = await agent(judgePrompt(ref, path, gate.summary, attempt),
      { label: `judge:${ref}#${attempt}`, phase: 'Execute', model: MODEL.judge, schema: JUDGE_SCHEMA })
    if (!judged) {
      const cause = `the rubric judge returned no structured result on attempt ${attempt}`
        + ` — the task was never scored. The harness exposes no original cause for a null agent result, so none is reported here.`
      return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause))
    }

    const verdict = judged.verdict
    if (verdict.passed) {
      // The post-judge transition is its own infrastructure boundary — a task
      // that passed but never got written `done` would be re-offered forever, or
      // (worse) counted as complete by a run that never checked.
      const finalized = await agent(markDonePrompt(ref, path),
        { label: `done:${ref}`, phase: 'Execute', model: MODEL.verify, schema: MARK_DONE_SCHEMA })
      if (finalized && finalized.ok) {
        return { task: ref, passed: true, attempt, weighted: verdict.weighted }
      }
      const cause = finalized
        ? `the task passed its rubric but mark-done did not confirm a bare "Status: done" (read "${finalized.status}")`
          + (finalized.error ? `: ${finalized.error}` : '')
        : `the task passed its rubric but the mark-done step returned no structured result`
          + ` — the harness exposes no original cause for a null agent result, so none is reported here.`
      // Park + escalate, never both complete and stalled for the same task.
      return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause))
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
  const parkedOk = await parkBlocked(ref, path, history)
  return { task: ref, passed: false, infrastructure: false, attempt: cap, parked: parkedOk, reason: history }
}

// Wrap every task before it reaches parallel(). Do NOT depend on parallel()
// surfacing an error object: a thrown pipeline resolves to null there, and a
// null carries neither the task ref nor the cause. Catching here keeps both.
async function runTaskGuarded(item) {
  try {
    return await executeTask(item)
  } catch (error) {
    const cause = `the task pipeline threw: ${error?.message ?? String(error)}`
    return infrastructureFailure(item.ref, 0, cause, await parkBlocked(item.ref, item.path, cause))
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
const commitInstructions = agentLabel =>
  'Commit the current working-tree changes as one or more ATOMIC commits using plain git over Bash. '
  + 'Do NOT use the Skill tool and do NOT spawn any sub-agent — do it yourself with git commands.\n'
  + `1. Record start: bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase start\n`
  + '2. Run `git status --porcelain`. If it prints nothing, the tree is clean — skip committing and continue.\n'
  + '3. Run `git diff` and `git diff --cached` to see every change. Group the files into atomic commits — each commit does ONE thing (single responsibility, independently revertable). Keep related code + its tests + its docs together; split unrelated changes apart.\n'
  + '4. For each group, in a sensible order, stage exactly that group by name (`git add <file>...`; never `git add -A`, never the interactive `git add -p`).\n'
  + '5. Commit each staged group with the template below.\n'
  + '6. After all commits, run `git log --oneline -n 5` to confirm.\n'
  + `7. Record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase end --message "committed shas: <shas, or none>"\n`
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
  + '    )"'

// ── Wave loop ───────────────────────────────────────────────────────────────
return (async () => {
phase('Execute')
const completed = []
const escalations = []
const parked = new Set()
let wave = 0

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
// Never terminal — the caller decides; the escalation-free guard is what stops
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

while (true) {
  wave++
  const { value: scout, threw: scoutThrew } = await settled(() => agent(
    `First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task scout --role scout --agent "<your label>" --phase start\n`
    + `Then proceed.\n\n`
    + `Use the identical label in both start and end calls.\n`
    + `Run exactly this command: bun ${S}/next-ready.ts ${CFG.tasksDir} --summary\n`
    + `Return its stdout verbatim (unmodified), its exit code, and its stderr.\n`
    + `Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task scout --role scout --agent "<your label>" --phase end --message "command complete"`,
    { label: `scout-wave-${wave}`, phase: 'Execute', model: MODEL.verify, schema: SCOUT_SCHEMA }))

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

  // Whole-tree completion, resume-safe. `completed` only covers THIS run, so a
  // resumed run's `completed.length` is smaller than the tree and can never
  // prove completion. The on-disk count can.
  if (c.done === c.total) {
    log(`Tree complete: ${c.done}/${c.total} done.`)
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

  if (wave > 1 && CFG.commitBetweenWaves && escalations.length === 0) {
    const { value: committed, threw } = await settled(() => agent(
      `Commit all changes from the previous wave.\n${commitInstructions(`commit-wave-${wave}`)}`,
      { label: `commit-wave-${wave}`, phase: 'Execute', model: MODEL.commit, schema: COMMIT_SCHEMA }))
    if (threw || !committed || committed.failed) {
      escalateCommitFailure(committed, `wave ${wave - 1}`, threw)
      // Continue this wave; the escalation-free guard prevents every later commit.
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

  log(`Wave ${wave}: ${fresh.map(f => f.ref).join(', ')}`)
  // No `.filter(Boolean)` — reconciliation is by INDEX against `fresh`, so a
  // null result still lands on its own task instead of disappearing.
  const results = await parallel(fresh.map(item => () => runTaskGuarded(item)))

  // Reconcile every input task. A dropped task would land in NO list: its dev
  // step already set the task to in-progress, and next-ready only offers `todo`,
  // so it could never be re-offered — the run would end "clean" and the
  // post-loop commit would sweep its ungated edits into a commit. Escalating it
  // parks the task AND (via the escalation-free guard) blocks those commits.
  let passedThisWave = false
  for (let i = 0; i < fresh.length; i++) {
    const item = fresh[i]
    const r = results[i]
    // Never read r.passed without this guard — r is null when even the guarded
    // wrapper could not return.
    if (r && r.passed) {
      completed.push(item.ref)
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
  }
  // No task passed this wave → no new work will unblock; stop to avoid spinning.
  if (!passedThisWave) break
}

// ── Post-loop commit ────────────────────────────────────────────────────────
// The last wave (typically Final review) has no subsequent scout to trigger a
// commit. Run one final atomic-commit here to capture those remaining changes.
// Only commit when the whole run finished cleanly (no escalations) — same guard
// as the inter-wave commits: don't commit a run that has blocked/dirty task edits.
if (CFG.commitBetweenWaves && escalations.length === 0) {
  const { value: committed, threw } = await settled(() => agent(
    `Commit any remaining uncommitted changes (from the last wave — typically Final review fixes).\n`
    + commitInstructions('commit-post-loop'),
    { label: 'commit-post-loop', phase: 'Execute', model: MODEL.commit, schema: COMMIT_SCHEMA }))
  if (threw || !committed || committed.failed) {
    escalateCommitFailure(committed, 'post-loop', threw)
  }
}

return { slug: CFG.slug, completed, escalations }
})()
```

## What the main agent does with the result

- `completed` — tasks that passed their rubric **and** whose `mark-done` transition was confirmed, this invocation only. It includes the Final review task, if the run finished cleanly. It is not a tree-completion count; see the note on `counts.done` below.
- `escalations` — `[{ task, attempt, infrastructure, parked, reason }]`. For each one, surface it to the user. In a cockpit session, use `needs_your_call` + `cockpit wait`. Otherwise, use `AskUserQuestion`. Include the last `reason` — the judge rationale, the gate output, or the infrastructure cause. `infrastructure: true` means nothing was judged, so tell the user that verification did not run rather than that the work was rejected. `parked: false` means the task was NOT written back as `blocked`, so its file still reads `in-progress` and `next-ready` will not re-offer it — say so, because the user has to reset that Status by hand before resuming.
- A task ref appears in `completed` or in `escalations`, never in both.
- Then render the trail. Run `bun <scriptsDir>/flightlog.ts report <logFile>` → `RUNLOG.md`.
- **Resume**: after the user unblocks a parked task, reset its `Status` to `todo`. Then re-run autopilot. Completed tasks stay `done`, so the run re-offers only the unblocked work.

## Notes / gotchas

- **Wave re-scout is non-negotiable.** Statuses change only inside the run. The orchestrator must recompute the ready set each wave. A task unblocked by a wave-N completion is picked up in wave N+1.
- **The scout TRANSCRIBES.** It runs one command and hands back exactly what the command printed (`stdout`, `exitCode`, `stderr`). The script does every interpretation. Nothing the agent returns requires it to understand the tree. The script parses and validates the summary before deriving `{ready, counts, unfinished, invalidRefs, parseErrors}`. Note `--summary` prints its JSON **before** exiting non-zero on a malformed tree, so a non-zero exit alone is not a scout failure.

- **`completed.length` is not a completion count. `counts.done` is.** The wave loop's `completed` array only holds tasks *this invocation* finished. A resumed run inherits `done` tasks from earlier runs, so comparing `completed.length` with the tree size reports a false stall on every resume. The scout's `counts.done === counts.total` counts the tree on disk, which is the only place completion actually lives. The loop also asserts `total === todo + inProgress + done + blocked + invalid` before trusting any bucket.

- **Eight terminal conditions, all explicit.** `done === total` is clean completion. A non-empty `errors` is a tree failure. `invalid > 0` is a tree failure naming the invalid refs. A counts mismatch is a scout failure. A readable but empty tasks directory, where every count is zero, escalates as `(tree)` before the `done === total` completion test. An empty ready set with unfinished tasks is a **stall**, escalated with the counts plus every remaining `ref (state)`. A configured budget floor stops the loop between the inter-wave commit and dispatch when the remaining output-token balance is below that floor. A wave where no task passed stops the loop, because nothing new can unblock. Only the first ends the run cleanly. A commit failure is not a terminal condition: it escalates as synthetic task `(commit)`, and the escalation-free guard blocks later commits without stopping task dispatch.

- **`counts` describes what parsed, not the tree.** A file that fails to parse — no H1, a duplicate `bucket/NN` — never enters `byRef`, so it never enters `counts`. Delete four broken files from a five-task tree and `counts` reads `{total: 1, done: 1}`: `done === total` holds, and the run reports clean completion over a tree it could not read. That is why the loop validates and checks the parsed `errors` array **before** the completion test instead of asking the scout to understand it.

- **The stall check excludes tasks this run already parked.** Every parked task carries its own escalation, and the very next wave necessarily sees it as unfinished-and-not-ready. Counting it again would append a phantom `(tree)` stall to every run that parked anything, so the run would report two problems where there is one. When the only unfinished tasks are ones already escalated, the loop just breaks.

- **The script has a deterministic fixture.** `scripts/orchestrator-script.test.ts` extracts this exact fenced block, runs it with stubbed `agent`/`parallel`, and asserts the termination rules, the quality-vs-infrastructure split, and the "every task lands in `completed` XOR `escalations`" invariant. No agent is spawned. **Edit the block and run `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts`** — a syntax error or a broken loop shows up there instead of mid-flight.

- **Quality failures retry; infrastructure failures park immediately.** A verifier returning `passed: false` judged real work and found it wanting — that feeds the dev loop another attempt. A verifier or judge returning *no structured result* judged nothing at all, so retrying dev would stack a second attempt on an unknown state. Same for a thrown pipeline and for a post-judge `mark-done` that does not confirm a bare `Status: done`. Each of those parks the task and escalates on the spot, and the escalation says plainly that verification did not run or did not return a verdict. The attempt number is reported as it actually was — compute was consumed, and claiming otherwise would mislead the audit. **The harness exposes no original cause for a null agent result**; the escalation says so rather than inventing an error message.

- **Both status transitions are confirmed by a reread, not by the agent's word.** `markDonePrompt` and `markBlockedPrompt` each return `{ ok, status, error }` and each must reopen the file and read the Status line back. An agent can return a fluent summary having edited nothing, and for parking that is the *likely* case — the task is often being parked because its header was malformed to begin with. An unconfirmed park reported as success is worse than a failed one: the file still reads `in-progress`, `next-ready` never re-offers it, and the `parked: false` signal that tells the user to reset it by hand never fires.

- **A schema'd `agent()` throws as well as returning `null` — guard for both.** `agent(prompt, {schema})` resolves to `null` on a terminal API failure, and that is what every `if (!gate)` / `if (!judged)` / `if (!committed)` guard tests. But it **rejects** when the subagent never calls the StructuredOutput tool — typically because it text-emitted `<StructuredOutput>…</StructuredOutput>` as a message instead. A null-guard can never see a throw. Inside a task that is already handled: `runTaskGuarded` catches around the whole pipeline. The two calls that sit *outside* it — the wave-loop scout and both commit agents — are wrapped in `settled()`, which turns either failure into the same reportable shape. Do not remove those wrappers. An unguarded throw at the top of the wave loop discards `completed` and `escalations` for every wave that already finished, so the run returns nothing while the tree on disk reads `done` — the work happened and no one is told. Observed live in run `wf_993ede2c-a44`: a Haiku scout text-emitted its payload on the final wave of a 9/9 tree, argued with the harness's `[structured-output-enforce]` nudge, and killed the workflow after every task was complete and committed. Cheap models are likeliest to do this, and every one of these three calls runs on `MODEL.verify`/`MODEL.commit` (Haiku).
- **Wrap the task thunk; reconcile by index; never `.filter(Boolean)`.** `parallel()` resolves a thrown thunk to `null`, and a `null` carries neither the task ref nor the cause. `runTaskGuarded` catches around `executeTask` so both survive, and it still attempts `markBlockedPrompt` and records whether the park worked. The wave then reconciles `results[i]` against `fresh[i]`, so even a `null` lands on its own task instead of vanishing. Filtering first would drop the task from `completed` and `escalations` both, and an unparked task stays `in-progress` — which `next-ready` never offers again.
- **There is exactly one scoring implementation.** The judge agent runs `score-task.ts --json --log` with its scores. The orchestrator gates on that printed verdict object. If the formula changes, change `score-task.ts`. Do NOT duplicate the arithmetic in the orchestrator.
- **`CFG.budgetFloor` defaults to `0` (off).** `budget.total` is `null` unless the user declares a target, so enabling a floor by default would manufacture a surprise stall class for existing runs. When configured above zero, it stops dispatching a ready wave when the remaining output-token balance falls below the floor.
- **Final review needs no special phase.** Its transitive `Depends on` reaches every task. So `next-ready` offers it only once everything else is `done`. When the `finalReview` flag is set, the orchestrator runs `runFinalReview` instead of a single dev agent — the multi-lens fan-out described below. It also uses the smaller `FINAL_MAX` cap. The binary gate, the rubric judge, and the score gate stay unchanged. They evaluate the round's output against the Final review task's own `## Eval rubric`: integration, consistency, no regressions, and whether it meets the PLAN goal.
- **The *orchestrator* runs the review fan-out, not one agent.** A Workflow agent has `Skill` and `Bash`, so the external CLI is reachable. But it has **no `Agent` tool**. So it cannot spawn fan-out skills like `/simplify` or `/code-review` itself. The orchestrator sidesteps that. `runFinalReview` issues one `agent()` per lens via `parallel()`. One lens is the cross-vendor lens (`CFG.reviewEngine`: codex or opencode), driven through the `<engine>-run.ts review` wrapper over Bash. The other four are the `/simplify` lenses — reuse, simplification, efficiency, altitude — and each runs on Claude. Every reviewer writes findings to `.flightlog/review/attempt-N/<lens>.md` and edits nothing. A single Opus **fixer** then reads all the files and applies the changes. The external engine gives the deliberate cross-*vendor* signal that an all-Claude dev+judge cannot produce. If it is unreachable, that reviewer writes its `<ENGINE> UNREACHABLE` token instead. The fixer then flags this, and the gate fails the task rather than pass an un-reviewed deliverable. Codex review is sandbox-enforced read-only. Opencode review is prompt-enforced read-only instead — its wrapper prepends a hard "analyze only" guard.
- **`CFG.liveReviewEngine` puts that cross-vendor lens in a visible herdr pane.** It is gated on `CFG.relayPath` alone, deliberately **not** on `liveDevEngine` or on `devEngine`: the review lens is external on every flight, including an all-Claude one, so tying it to the dev engine would make the most common flight the one that can never watch its own review. The lens agent then runs `relay <engine> review --git-scope none --wait-timeout 480000` instead of the `<engine>-run.ts review` wrapper, and the same 480s-inside-600s pairing and `relay collect` pending rounds apply for the same reasons they do on the dev path. It passes `--dangerous` like the dev delegate, and that is the deliberate call: a live pane has no sandbox flag of its own, so an approval prompt nobody is watching stalls the lens until the wait and every collect round expire — roughly half an hour, ending in a false `UNREACHABLE` on a review that was never actually blocked. Autopilot runs semi-unattended, so a stall costs more than the risk it buys back. Read-only stays prompt-enforced from two directions (relay's REVIEW_CONTRACT and the lens prompt's own "record, never edit"), and a reviewer that edits anyway surfaces downstream: the fixer re-runs the task's verification, and the binary gate grades the result. A pending review that never lands is written as the `<ENGINE> UNREACHABLE` token, exactly like a non-zero exit — the fixer must fail the task rather than pass an un-reviewed deliverable, so "still running" cannot quietly become "no findings". The four Claude `/simplify` lenses are unaffected; they are Claude agents with no CLI to place in a pane.
- **The fixer is not the judge.** The reviewers and the fixer form the "dev" side of the Final review. The binary gate and the rubric judge stay independent. So the dev≠judge anti-self-grading split still holds, even though this round is more elaborate.
- **`CFG.devEngine: 'codex'` (or `'opencode'`) hands the dev step to that CLI.** The default is `'claude'` (Sonnet→Opus). `CFG.lastShotEngine` defaults to `''` (off); on a Claude ladder, setting it to `'codex'` or `'opencode'` appends one external attempt after the Opus rung without replacing Opus. It is ignored when `devEngine` is already external, because that ladder already ends on Claude-Opus. When `devEngine` is set to an external engine, each non-finalReview task's dev step becomes a cheap Haiku *driver*. That driver runs the `<engine>-run.ts delegate` wrapper — the same wrapper the cross-vendor review lens uses, reachable from a Workflow agent's Bash. So the external CLI writes the implementation. If `CFG.liveDevEngine` is true and `CFG.relayPath` resolved under `HERDR_ENV=1`, the driver instead runs the same delegate through relay in a visible herdr live pane. Otherwise it uses the headless wrapper exactly as before. The verify → judge → score pipeline stays Claude. This *strengthens* the dev≠judge split into a cross-vendor one: the external CLI writes, and Claude-Opus judges. An external-engine ladder's last attempt before the cap still falls back to Claude-Opus, so a task the external engine cannot clear gets one strong Claude try before parking — **except at `maxAttempts: 1`**, where the `cap > 1` guard keeps that single attempt on the external engine rather than skipping it entirely, and there is no Claude fallback. A Claude ladder can instead end on the configured `lastShotEngine` after its Opus rung. If the CLI is unreachable, or relay returns no result, the driver never fabricates. The binary gate fails that attempt, and the loop reaches the next rung. The live path passes `--wait-timeout 480000` (8 min), and the driver is told to make ONE foreground Bash call with `timeout: 600000`. **That pairing is load-bearing: the wait must expire inside the Bash tool's 600s hard cap — with margin.** The margin is not optional: relay's poll clock starts *after* it spawns the pane and waits up to `SPAWN_IDLE_WAIT_MS` (20s) for the TUI to settle, so the Bash call's wall time is that setup plus the wait plus cleanup. 480s leaves roughly 90s of slack; 540s did not. A command that outruns the cap is moved to the background, and a cheap Haiku driver left to invent its own wait writes a `while sleep 5; do ... jobs %1 ...; done` poll loop — which can never work, because every Bash call gets a fresh shell where `jobs` sees nothing. Live transcript: the loop spun the full 600s and the driver read a *complete* result the instant it returned. Ten minutes burned after codex had already finished, plus an orphaned loop. So the driver prompt bans `run_in_background` and shell poll loops outright, and the wait is bounded below the cap so the one call returns on its own. Relay's poll loop returns the instant the result lands, so the budget costs nothing for normal-speed tasks. **A `pending` outcome is not a failure and must not be treated as one.** Relay checks the pane's status before reporting it: an agent that has settled without a verified result is reported as a real failure instead, so `pending` specifically means the delegate is *still working* — and still writing the working tree, with its pane still open. Failing the attempt there would start a second writer on the same files. So the driver keeps waiting instead: `CFG.liveCollectRounds` (default 3) more `relay collect` calls, each reattaching to that same pane for another 8-minute window. A task can therefore run ~32 min while every individual Bash call still returns inside the 600s cap. Only when the last allowed collect is still pending does the attempt fail. Do not wait indefinitely, and do not use `herd wait` for this — it blocks until `idle`, and codex parks at `done`, so it can miss a finished delegate entirely; `collect` reuses relay's own `idle`-or-`done`-plus-marker test. `devEngine` and `reviewEngine` are independent. You can have opencode write and codex review, or the reverse. Only the dev step changes. finalReview's multi-lens round, and everything else, stay untouched.
- **Commits use inline git, not the atomic-commit skill — the same `no Agent tool` constraint applies.** The inter-wave and post-loop commits must NOT invoke `odin-git:atomic-commit`. That skill spawns the vör + bragi sub-agents, and a Workflow agent cannot do that. Its analysis script also lives in a *different* plugin's cache, which the agent cannot resolve — there is no `CLAUDE_PLUGIN_ROOT` in agent Bash. The `commitInstructions` builder inlines the skill's whole contract instead: the matched flightlog lifecycle, the atomic grouping principles, plus the exact commit-message template (emoji/type subject, English body, `---`, zh-TW summary). So each labeled agent commits over plain git, self-contained. If the commit convention changes, edit the template in that one builder.
- **Concurrency** is capped by the Workflow runtime (`min(16, cores-2)`). Passing a wide wave is safe — excess tasks queue.
- **Do NOT give the dev agent `isolation: 'worktree'`.** It looks like the fix for tasks that mutate shared files in parallel, and it breaks every run: the dev's edits land in a private worktree that is never merged back, while `verify` and `judge` run in the main tree and see nothing. Every attempt then fails its binary gate and every task parks. Isolation would have to wrap a task's whole dev→verify→judge→score pipeline, which separate `agent()` calls cannot express. For real parallel conflicts, sequence the conflicting tasks instead — add a `Depends on` edge between them in the flightplan so `next-ready` never offers them in the same wave.

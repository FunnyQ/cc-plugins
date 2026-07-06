# Autopilot orchestrator — canonical Workflow script

This is the script the `autopilot` skill adapts and passes to the **Workflow** tool. Read the three hard constraints in `SKILL.md` first; they explain every awkward-looking choice here.

The main agent scouts inline, then calls `Workflow({ script: <this> })` — **with the scouted values baked into the `CFG` block at the top of the script as literals.** Do NOT rely on the Workflow `args` global: in practice it does not reliably reach the orchestrator (an unset `args` surfaces as `undefined`, e.g. `bun undefined/next-ready.ts`, which fails the scout and silently looks like "no work to do"). Since the main agent already knows every value from the inline scout, write them in directly.

> **Why every path is absolute (`tasksDir` / `planPath` / `logFile` / `scriptsDir`):** Workflow agents do not share a stable working directory — an agent that `cd`s into the tasks tree (e.g. to read task files) resolves a *relative* `logFile` against *its own* cwd, so a `bun .../flightlog.ts log docs/<slug>/.flightlog/run.jsonl` from inside `docs/<slug>/tasks/` lands in a nested `docs/<slug>/tasks/docs/<slug>/.flightlog/` — splitting the audit trail across two dirs. (`CLAUDE_PLUGIN_ROOT` likewise never reaches agent Bash, so the orchestrator can't resolve paths itself.) **Bake every path as an absolute literal** so it resolves identically no matter which agent writes it. Get the real repo root from `git rev-parse --show-toplevel` (it may be anywhere — `/Users/<name>/Projects/...`, `/opt/temp/project-repo`, `/workspace/...`); build `<root>/docs/<slug>/...` from it. Resolve `scriptsDir` from the skill's load-time "Base directory for this skill" banner. The values are unambiguous absolute paths that every agent's Bash and file tools (Read/Write/Glob) resolve identically. `~/...` is an *optional* shorthand **only when the repo genuinely lives under `$HOME`** (Bash + the file tools expand a leading `~`, and it avoids leaking the username) — never invent a `~` form for a repo outside `$HOME`. Baking these in (rather than passing via `args`) is what makes the run reliable.

## The script

When adapting this script for the Workflow call, strip the explanatory comments; they are for the adapter, not the runtime. Keep only the one-line CFG field comments.

```javascript
export const meta = {
  name: 'autopilot-run',
  description: 'Execute a flightplan task tree: per-task dev→verify→judge→score loop, then the final review gate',
  phases: [
    { title: 'Execute', detail: 'wave loop: scout ready tasks, run each through the retry pipeline' },
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
  devEngine:             'claude',  // 'claude' (default), 'codex', or 'opencode' — who writes code in the dev step; an external engine has each task written by that CLI via its <engine>-run.ts wrapper (last attempt before the cap still falls back to Claude-Opus)
  reviewEngine:          'codex',   // 'codex' (default) or 'opencode' — the cross-vendor reviewer in the closing Final review (driven via <engine>-run.ts review)
  opencodeDevModel:      '',        // optional opencode model for the dev engine (empty → wrapper default opencode-go/kimi-k2.7-code); only applies when devEngine is 'opencode' (codex ignores -m)
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
//   devExternal (Haiku) — only used when CFG.devEngine is an external engine
//     (codex/opencode): a cheap driver that has that CLI write the implementation
//     (via <engine>-run.ts delegate) and verifies. The coding intelligence lives
//     in the external CLI, so the driver just invokes + checks. The last attempt
//     before the cap still escalates to Claude-Opus (devEscalated) — a
//     cross-vendor last shot before parking.
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
const withModel = (key, override) => ({
  ...ENGINES[key],
  modelFlag: key === 'opencode' && override ? ` --model ${override}` : '',
})
const devEngine    = CFG.devEngine && CFG.devEngine !== 'claude' ? withModel(CFG.devEngine, CFG.opencodeDevModel) : null
const reviewEngine = withModel(CFG.reviewEngine ?? 'codex', CFG.opencodeReviewModel)

// ── Schemas ─────────────────────────────────────────────────────────────────
const READY_SCHEMA = {
  type: 'object',
  properties: {
    refs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },              // "ui/03"
          finalReview: { type: 'boolean' },      // header carries `> **Final review**: true`
          path: { type: 'string' },              // exact task file path from next-ready.ts
        },
        required: ['ref', 'finalReview', 'path'],
      },
    },
    error: { type: 'string' },
  },
  required: ['refs'],
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
const devPrompt = (ref, path, attempt, feedback) => `
You are implementing flightplan task ${ref} in the tree at ${CFG.tasksDir}.
Read the task file at ${path} and every file in its "Required reading".
Implement the task fully: create/modify the listed files, follow Implementation notes.
${attempt > 1 ? 'This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nAddress that specifically.' : ''}
When done: set the task header "> **Status**:" to in-progress while working. Run the task's ## Verification yourself first.
Then log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "<your label>" --message "<what you changed>"
Return a one-paragraph summary of what you did.`

// External-engine dev driver — used when CFG.devEngine is 'codex' or 'opencode'.
// The agent does NOT hand-write the implementation; it has the external CLI write
// it via our thin `<engine>-run.ts delegate` wrapper (reachable from a Workflow
// agent's Bash) and then verifies. The wrapper prints the CLI's summary + a
// `git status --short` and leaves NO scratch behind, so the driver reads one clean
// stdout — it never mines a transcript. The driver feeds the CLI the full task
// context so it never needs to pause for clarification (it runs non-interactively).
// If the CLI is unreachable the driver must NOT fabricate code — it reports failure
// so the binary gate fails the attempt and the loop proceeds (the last attempt
// falls back to Claude-Opus).
const devExternalPrompt = (engine, ref, path, attempt, feedback) => `
You are the ${engine.label.toUpperCase()} DEV DRIVER for flightplan task ${ref} (tree: ${CFG.tasksDir}). You do NOT write the implementation yourself — you have the ${engine.label} CLI write it, then you verify.
1. Read the task file at ${path} and every file in its "Required reading". Note its "Files to create / modify" list and "Implementation notes".
2. Set the task header "> **Status**:" to in-progress.
3. Build the ${engine.label} instruction from the task file — the exact files to create/modify plus the full Goal, Implementation notes, and Acceptance criteria, telling ${engine.label} to implement the task fully and stay strictly within the listed files. It runs non-interactively, so give it EVERYTHING up front; it can never ask you anything.${attempt > 1 ? ' This is retry attempt ' + attempt + '. The previous attempt was rejected:\\n' + feedback + '\\nFold this feedback into the instruction so ' + engine.label + ' fixes exactly that.' : ''}
4. Write that instruction to a temp file, then run:
  bun ${S}/${engine.wrapper} delegate${engine.modelFlag} --prompt-file <your-instruction-file>
   It has ${engine.label} edit the working tree directly, then prints its summary plus a \`git status --short\` of what changed, and cleans up its own scratch. Read that stdout — do NOT go looking for any temp/transcript files; the printed status list IS the record of what changed.
5. If the wrapper exits non-zero or its output begins with "${engine.token}", do NOT hand-write the implementation yourself. Log the failure (step 7) and return a summary stating ${engine.label} was unreachable — the binary gate will then fail this attempt and the loop moves on (the final attempt escalates to Claude-Opus automatically).
6. Run the task's ## Verification commands YOURSELF to confirm the changes actually hold.
7. Log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "${engine.label}-delegate" --message "<what ${engine.label} changed, or '${engine.label} unreachable'>"
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
const reviewPrompt = (ref, lens, attempt) => lens.external ? `
You are the ${lens.external.label.toUpperCase()} (cross-vendor) reviewer in the FINAL REVIEW of flightplan ${CFG.slug} (task ${ref}). You do NOT review the code yourself — you have the ${lens.external.label} CLI review it and you record its findings.
1. Write a review instruction to a temp file: tell ${lens.external.label} to review THIS run's changes for BUGS & CORRECTNESS (logic errors, broken edge cases, regressions, security) — it should inspect both \`git diff ${CFG.baseRef}..HEAD\` (committed task changes) and \`git diff\` (uncommitted fixer edits) and report each issue with file:line and the concrete fix.
2. Run: bun ${S}/${lens.external.wrapper} review${lens.external.modelFlag} --prompt-file <your-instruction-file>
   It reads the repo + diffs and prints the CLI's findings, leaving no scratch. Read that stdout — don't look for any temp/transcript files.
3. Write the printed findings to ${reviewDir(attempt)}/${lens.key}.md (run \`mkdir -p ${reviewDir(attempt)}\` first). If the wrapper exits non-zero or its output begins with "${lens.external.token}", write exactly "${lens.external.token}" as the first line of that file — do NOT skip silently (a missing cross-vendor pass must fail this task, not pass it quietly).
You are a REVIEWER: do NOT edit any source file — only record. Return a one-line count of findings.` : `
You are the ${lens.key.toUpperCase()} reviewer in the FINAL REVIEW of flightplan ${CFG.slug} (task ${ref}). Review the WHOLE autopilot diff — all changes committed during this run — through ONE lens only:
${lens.focus}
Get the full diff with BOTH commands:
  git diff ${CFG.baseRef}..HEAD   # committed task changes from this run
  git diff                         # uncommitted edits (a previous Final review fixer retry may have left changes in the working tree)
Combine both outputs — the working-tree diff covers any retry attempt's edits that are not yet committed.
Write your findings to ${reviewDir(attempt)}/${lens.key}.md (run \`mkdir -p ${reviewDir(attempt)}\` first) as a short markdown bullet list — each finding carries file:line and the concrete fix. If nothing is material, write exactly "No findings.". You are a REVIEWER: do NOT edit any source file — only record. Return a one-line count of your findings.`

const fixPrompt = (ref, path, attempt, feedback) => `
You are the FINAL REVIEW fixer for flightplan ${CFG.slug} (task ${ref}), on Opus. Independent reviewers have each written findings to ${reviewDir(attempt)}/ (one file per lens: ${reviewEngine.label}, reuse, simplification, efficiency, altitude).
1. Read EVERY file in ${reviewDir(attempt)}/. If ${reviewEngine.label}.md begins with "${reviewEngine.token}", call that out prominently — the cross-vendor pass did not run.
2. Apply the real fixes (you have Edit/Write). Use judgement: fix correctness / integration / regression issues from the cross-vendor lens, and the safe quality cleanups from the four Claude lenses (behaviour-preserving). For any finding you reject, say why.
3. VERIFY. Open the task file at ${path} and run its ## Verification commands yourself; confirm green and that the PLAN goal ("${CFG.planGoal}") is met.
${attempt > 1 ? 'This is re-loop attempt ' + attempt + ' (capped at ' + FINAL_MAX + '). The previous round was rejected:\n' + feedback + '\nEnsure the new findings + your fixes address that.' : ''}
Set the task header "> **Status**:" to in-progress while working.
Log a narrative note (which lenses fired, total findings, what you fixed, whether the cross-vendor lens ran):
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role final-review --attempt ${attempt} --agent "<your label>" --message "<summary>"
Return a one-paragraph summary: lenses run, cross-vendor status, key fixes, verification result.`

// Run the Final review "dev" step: fan out the lenses in parallel, then one
// Opus fixer applies every finding. Replaces the single dev agent for the
// finalReview task; the binary gate + judge + score gate downstream are unchanged.
async function runFinalReview(ref, path, attempt, feedback) {
  await parallel(REVIEW_LENSES.map(lens => () =>
    agent(reviewPrompt(ref, lens, attempt),
      { label: `review:${lens.key}#${attempt}`, phase: 'Execute', model: lens.model })))
  await agent(fixPrompt(ref, path, attempt, feedback),
    { label: `fix:${ref}#${attempt}`, phase: 'Execute', model: MODEL.fix })
}

const verifyPrompt = (ref, path) => `
You are an INDEPENDENT verifier for flightplan task ${ref} (tree: ${CFG.tasksDir}).
Do NOT trust the dev's claims. Open the task file at ${path}, then:
  1. Run every concrete command in its ## Verification section yourself.
  2. Check every box in ## Acceptance criteria against the actual code/output.
Report passed=true ONLY if all verification commands succeed AND all acceptance criteria hold.
Put the raw evidence (commands, exit codes, failing output) in summary. Do not make subjective quality judgements — that is the rubric judge's job.`

const judgePrompt = (ref, path, gateSummary, attempt) => `
You are the rubric judge for flightplan task ${ref} (tree: ${CFG.tasksDir}).
The independent binary gate already PASSED with this evidence:
${gateSummary}
Open the task file at ${path} and its ## Eval rubric. Score EACH dimension 0–scaleMax based on the real code and the verification evidence above — ground the correctness dimension in that evidence, not opinion.
Write the scores JSON to a temp file, then run score-task.ts to compute and persist the verdict:
  echo '<scores-json>' > /tmp/scores-${ref.replace('/','-')}.json
  bun ${S}/score-task.ts ${path} /tmp/scores-${ref.replace('/','-')}.json --json --log ${CFG.logFile} --attempt ${attempt} --agent "<your label>"
If the command exits 1, that is a valid rubric failure; still return the printed JSON verdict. Return the CLI's printed verdict object VERBATIM as "verdict", plus your scores and rationale.`

const markDonePrompt = (ref, path) => `
Finalize flightplan task ${ref} at ${path} by running:
  bun ${S}/mark-done.ts ${path}
That deterministically sets "> **Status**: done" AND ticks every checkbox in the task's ## Acceptance criteria and ## Verification sections (the task passed the gate, so all hold). Change nothing else by hand.`

const markBlockedPrompt = (ref, path, reason) => `
Set the "> **Status**:" line in flightplan task ${ref}'s file (${path}) to: blocked. Change nothing else. (Parked by autopilot: ${reason})`

// ── Per-task retry pipeline ─────────────────────────────────────────────────
async function executeTask(item) {
  const { ref, finalReview, path } = item
  // The cross-vendor Final review round gets its own (smaller) cap; everything
  // else uses MAX. Past the cap the task is parked + escalated, never skipped.
  const cap = finalReview ? FINAL_MAX : MAX
  let feedback = ''
  for (let attempt = 1; attempt <= cap; attempt++) {
    if (finalReview) {
      // multi-lens review fan-out + Opus fixer (always Opus, no escalation tier)
      await runFinalReview(ref, path, attempt, feedback)
    } else {
      // Dev step. The last attempt before the cap is the "last shot": Claude
      // escalates Sonnet → Opus, and an external engine ALSO falls back to
      // Claude-Opus there (a cross-vendor final try before parking). `cap > 1`
      // so a single-attempt task still runs the external engine rather than
      // skipping it.
      const lastShot = attempt >= cap && cap > 1
      if (devEngine && !lastShot) {
        await agent(devExternalPrompt(devEngine, ref, path, attempt, feedback),
          { label: `dev-${devEngine.label}:${ref}#${attempt}`, phase: 'Execute', model: MODEL.devExternal })
      } else {
        const devModel = attempt >= cap ? MODEL.devEscalated : MODEL.dev
        await agent(devPrompt(ref, path, attempt, feedback),
          { label: `dev:${ref}#${attempt}`, phase: 'Execute', model: devModel })
      }
    }

    const gate = await agent(verifyPrompt(ref, path),
      { label: `verify:${ref}#${attempt}`, phase: 'Execute', model: MODEL.verify, schema: GATE_SCHEMA })
    if (!gate || !gate.passed) {
      feedback = `Binary gate failed (verification/acceptance):\n${gate?.summary ?? 'no output'}`
      continue
    }

    const judged = await agent(judgePrompt(ref, path, gate.summary, attempt),
      { label: `judge:${ref}#${attempt}`, phase: 'Execute', model: MODEL.judge, schema: JUDGE_SCHEMA })
    if (!judged) { feedback = 'Judge produced no verdict.'; continue }

    const verdict = judged.verdict
    if (verdict.passed) {
      await agent(markDonePrompt(ref, path), { label: `done:${ref}`, phase: 'Execute', model: MODEL.verify })
      return { task: ref, passed: true, attempt, weighted: verdict.weighted }
    }
    feedback = `Rubric score ${verdict.weighted.toFixed(2)} did not pass`
      + (verdict.hardFailed ? ' (hard-fail veto)' : '')
      + (verdict.missing.length ? ` (missing dims: ${verdict.missing.join(', ')})` : '')
      + `:\n${judged.rationale}`
  }
  await agent(markBlockedPrompt(ref, path, feedback), { label: `block:${ref}`, phase: 'Execute', model: MODEL.verify })
  return { task: ref, passed: false, attempt: cap, reason: feedback }
}

// ── Inline atomic-commit instructions ───────────────────────────────────────
// A Workflow agent has Bash + Read but NO Agent tool, so it CANNOT run the
// odin-git:atomic-commit skill — that skill spawns the vör + bragi sub-agents
// and would die mid-run. It also can't resolve that skill's scripts (they live
// in a *different* plugin's cache, and CLAUDE_PLUGIN_ROOT never reaches agent
// Bash). So we inline the skill's contract here — same atomic principles, same
// commit-message template — and let the agent commit over plain git itself.
// Self-contained on purpose: no Skill tool, no sub-agent, no cross-plugin path.
const COMMIT_INSTRUCTIONS =
  'Commit the current working-tree changes as one or more ATOMIC commits using plain git over Bash. '
  + 'Do NOT use the Skill tool and do NOT spawn any sub-agent — do it yourself with git commands.\n'
  + '1. Run `git status --porcelain`. If it prints nothing, the tree is clean — skip committing and continue.\n'
  + '2. Run `git diff` and `git diff --cached` to see every change. Group the files into atomic commits — each commit does ONE thing (single responsibility, independently revertable). Keep related code + its tests + its docs together; split unrelated changes apart.\n'
  + '3. For each group, in a sensible order: stage exactly that group by name (`git add <file>...`; never `git add -A`, never the interactive `git add -p`), then commit with the template below.\n'
  + '4. After all commits, run `git log --oneline -n <count>` to confirm.\n'
  + '\n'
  + 'Commit message template (MUST follow):\n'
  + '  Subject: `<emoji> <type>: <imperative summary>` — lowercase, no trailing period, <=50 chars.\n'
  + '  Then a blank line, an English markdown-bullet body (WHAT changed and WHY; omit for a trivial commit), then a line containing only `---`, then a one-line zh-TW summary (include only when there is a body).\n'
  + '  Emoji/type map: ✨ feat · 🐛 fix · 📦 refactor · ✅ test · 📖 docs · 🎨 style · 🔧 chore · 🔥 remove · ⚡️ perf · 🔒 security.\n'
  + '  Use a quoted heredoc so the body + summary survive newlines:\n'
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
phase('Execute')
const completed = []
const escalations = []
const parked = new Set()
let wave = 0

while (true) {
  wave++
  // Commit previous wave's changes before scouting the next ready set, but only
  // while the entire run is escalation-free. A blocked task's dirty edits can
  // persist across later waves, so a per-wave guard would still risk committing
  // incomplete/rejected work after a later clean wave.
  const commitPreamble = (wave > 1 && CFG.commitBetweenWaves && escalations.length === 0)
    ? `First, commit all changes from the previous wave.\n${COMMIT_INSTRUCTIONS}\n\nThen: `
    : ``

  const scout = await agent(
    commitPreamble
    + `Run exactly this command: bun ${S}/next-ready.ts ${CFG.tasksDir} --json\n`
    + `It prints a JSON array of the ready tasks (each with its finalReview flag and exact file path), e.g.\n`
    + `  [{"ref":"ui/03","finalReview":false,"path":"${CFG.tasksDir}/ui/03-build.md"},{"ref":"api/02","finalReview":false,"path":"${CFG.tasksDir}/api/02-endpoint.md"}]\n`
    + `or exactly [] when NOTHING is ready (all tasks done/blocked). An empty array means there is no work — that is the normal end state.\n`
    + `Return { refs: <the printed array, VERBATIM> }. If it printed [], return refs: []. Do NOT open task files, infer, or enumerate any task the command did not print — echo only what it printed.\n`
    + `If the command exits non-zero, return refs: [] and put the stderr in error.`,
    { label: `scout-wave-${wave}`, phase: 'Execute', model: MODEL.verify, schema: READY_SCHEMA })

  // A scout failure is NOT "no work to do" — surface it as an escalation so the
  // run can't silently return empty (the classic `bun undefined/next-ready.ts`
  // trap). Only a clean scout with zero fresh refs means the tree is drained.
  if (!scout || scout.error) {
    const reason = `next-ready scout failed in wave ${wave}: ${scout?.error ?? 'no result'}`
    log(reason)
    escalations.push({ task: '(scout)', attempt: 0, reason })
    break
  }
  // Exclude both parked AND already-completed refs. next-ready won't re-offer a
  // done task, but this is defense-in-depth: even a misbehaving scout that
  // re-lists finished tasks can never trigger an infinite re-run of done work.
  const fresh = (scout.refs ?? []).filter(
    i => !parked.has(i.ref) && !completed.includes(i.ref))
  if (fresh.length === 0) break

  log(`Wave ${wave}: ${fresh.map(f => f.ref).join(', ')}`)
  const results = (await parallel(fresh.map(item => () => executeTask(item)))).filter(Boolean)

  for (const r of results) {
    if (r.passed) completed.push(r.task)
    else { escalations.push(r); parked.add(r.task) }
  }
  // No task passed this wave → no new work will unblock; stop to avoid spinning.
  if (!results.some(r => r.passed)) break
}

// ── Post-loop commit ────────────────────────────────────────────────────────
// The last wave (typically Final review) has no subsequent scout to trigger a
// commit. Run one final atomic-commit here to capture those remaining changes.
// Only commit when the whole run finished cleanly (no escalations) — same guard
// as the inter-wave commits: don't commit a run that has blocked/dirty task edits.
if (CFG.commitBetweenWaves && escalations.length === 0) {
  await agent(
    `Commit any remaining uncommitted changes (from the last wave — typically Final review fixes).\n`
    + COMMIT_INSTRUCTIONS,
    { label: 'commit-post-loop', phase: 'Execute', model: MODEL.commit })
}

return { slug: CFG.slug, completed, escalations }
```

## What the main agent does with the result

- `completed` — tasks that passed their rubric (the Final review task among them if the run finished cleanly).
- `escalations` — `[{ task, attempt, reason }]`. For each, surface to the user: in a cockpit session via `needs_your_call` + `cockpit wait`; otherwise `AskUserQuestion`. Include the last `reason` (judge rationale or gate output).
- Then render the trail: `bun <scriptsDir>/flightlog.ts report <logFile>` → `RUNLOG.md`.
- **Resume** after the user unblocks a parked task: reset its `Status` to `todo`, re-run autopilot. Completed tasks stay `done`, so only the unblocked work is re-offered.

## Notes / gotchas

- **Wave re-scout is non-negotiable.** Statuses change only inside the run, so the ready set must be recomputed each wave. A task unblocked by a wave-N completion is picked up in wave N+1.
- **The scout echoes `next-ready.ts --json` verbatim — it does not interpret.** Use the `--json` mode (emits `[{ref,finalReview,path}]`, or `[]` when none ready) and have the agent return that array as-is. An earlier line-oriented scout had a fatal blind spot: when `next-ready` printed nothing (all tasks done), the agent didn't map "empty" → `[]` and instead re-listed every task as ready, causing the whole tree to re-run. `[]` from `--json` is unambiguous; the `!completed.includes` filter is the backstop.
- **There is exactly one scoring implementation.** The judge agent runs `score-task.ts --json --log` with its scores, and the orchestrator gates on that printed verdict object. If the formula changes, change `score-task.ts`; the orchestrator must not duplicate the arithmetic.
- **Final review needs no special phase.** Its transitive `Depends on` reaches every task, so `next-ready` only offers it once all else is `done`. When the `finalReview` flag is set the orchestrator runs `runFinalReview` instead of a single dev agent (the multi-lens fan-out below) and uses the smaller `FINAL_MAX` cap; the binary gate + rubric judge + score gate are unchanged — they evaluate the round's output against the Final review task's own `## Eval rubric` (integration / consistency / no regressions / meets PLAN goal).
- **The review fan-out is done by the *orchestrator*, not by one agent.** A Workflow agent has `Skill` + `Bash` (the external CLI is reachable) but **no `Agent` tool**, so it cannot spawn fan-out skills like `/simplify` or `/code-review` itself. The orchestrator sidesteps that: `runFinalReview` issues one `agent()` per lens via `parallel()` — the cross-vendor lens (`CFG.reviewEngine`: codex or opencode, driven through the `<engine>-run.ts review` wrapper over Bash) plus the four `/simplify` lenses (reuse / simplification / efficiency / altitude), each Claude. Every reviewer writes findings to `.flightlog/review/attempt-N/<lens>.md` and edits nothing; a single Opus **fixer** then reads all the files and applies the changes. The external engine is the deliberate cross-*vendor* signal the all-Claude dev+judge can't produce; if it's unreachable that reviewer writes its `<ENGINE> UNREACHABLE` token so the fixer flags it and the gate fails the task rather than passing an un-reviewed deliverable. (codex review is sandbox-enforced read-only; opencode review is prompt-enforced read-only — its wrapper prepends a hard "analyze only" guard.)
- **The fixer is not the judge.** Reviewers + fixer are the "dev" side of the Final review; the binary gate + rubric judge stay independent, so the dev≠judge anti-self-grading split still holds even though the round is more elaborate.
- **`CFG.devEngine: 'codex'` (or `'opencode'`) hands the dev step to that CLI.** Default is `'claude'` (Sonnet→Opus). When set to an external engine, each non-finalReview task's dev step becomes a cheap Haiku *driver* that runs the `<engine>-run.ts delegate` wrapper (reachable from a Workflow agent's Bash — the same wrapper the cross-vendor review lens uses), so the external CLI writes the implementation. The wrapper prints the CLI's summary + a `git status --short` and cleans up its own scratch, so the driver reads one clean stdout instead of mining a transcript. The verify → judge → score pipeline stays Claude, which *strengthens* the dev≠judge split into a cross-vendor one (the external CLI writes, Claude-Opus judges). The last attempt before the cap still falls back to Claude-Opus, so a task the external engine can't clear gets one strong Claude try before parking; if the CLI is unreachable the wrapper exits non-zero (the driver never fabricates), the binary gate fails the attempt, and the loop reaches that Opus fallback. `devEngine` and `reviewEngine` are independent — you can have opencode write and codex review, or vice versa. Only the dev step changes — finalReview's multi-lens round and everything else are untouched.
- **Commits are inline git, not the atomic-commit skill — same `no Agent tool` constraint.** The inter-wave and post-loop commits must NOT invoke `odin-git:atomic-commit`: that skill spawns the vör + bragi sub-agents, which a Workflow agent can't do, and its analysis script lives in a *different* plugin's cache that the agent can't resolve (no `CLAUDE_PLUGIN_ROOT` in agent Bash). The `COMMIT_INSTRUCTIONS` constant inlines the skill's whole contract — atomic grouping principles + the exact commit-message template (emoji/type subject, English body, `---`, zh-TW summary) — so the agent commits over plain git, self-contained. Edit the template in that one constant if the commit convention changes.
- **Concurrency** is capped by the Workflow runtime (`min(16, cores-2)`); passing a wide wave is safe — excess tasks queue.
- If tasks mutate shared files and could conflict in parallel, give `executeTask`'s dev agent `isolation: 'worktree'` — only if real conflicts occur (it's expensive).

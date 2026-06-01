# Autopilot orchestrator — canonical Workflow script

This is the script the `autopilot` skill adapts and passes to the **Workflow** tool. Read the three hard constraints in `SKILL.md` first; they explain every awkward-looking choice here.

The main agent scouts inline, then calls `Workflow({ script: <this> })` — **with the scouted values baked into the `CFG` block at the top of the script as literals.** Do NOT rely on the Workflow `args` global: in practice it does not reliably reach the orchestrator (an unset `args` surfaces as `undefined`, e.g. `bun undefined/next-ready.ts`, which fails the scout and silently looks like "no work to do"). Since the main agent already knows every value from the inline scout, write them in directly:

```javascript
const CFG = {
  slug:                  'my-plan',
  tasksDir:              'docs/my-plan/tasks',
  planPath:              'docs/my-plan/PLAN.md',
  logFile:               'docs/my-plan/.flightlog/run.jsonl',
  planGoal:              '<one-line goal copied from PLAN.md>',
  maxAttempts:           3,
  finalReviewMaxAttempts: 2,                              // bounded re-loop for the cross-vendor review round
  scriptsDir:            '<abs path to skills/flightplan/scripts>',  // from the skill's load-time base dir
}
```

> **Why `scriptsDir` is a literal:** `CLAUDE_PLUGIN_ROOT` does not reach agent Bash, and the orchestrator can't resolve paths itself. The main agent knows the skill's base directory at load time — resolve `skills/flightplan/scripts` from it (the load-time "Base directory for this skill" banner) and write the absolute path into `CFG.scriptsDir` so the workflow's agents can call `next-ready.ts` / `score-task.ts` / `flightlog.ts`. Baking it in (rather than passing via `args`) is what makes the run reliable.

## The script

```javascript
export const meta = {
  name: 'autopilot-run',
  description: 'Execute a flightplan task tree: per-task dev→verify→judge→score loop, then the final review gate',
  phases: [
    { title: 'Execute', detail: 'wave loop: scout ready tasks, run each through the retry pipeline' },
  ],
}

// ── Config — BAKE THESE IN (do not rely on the Workflow `args` global) ──────
// The main agent fills these from its inline scout. `args` does not reliably
// reach the orchestrator; an unset value surfaces as `undefined` and silently
// fails the scout. Literals here = a reliable run.
const CFG = {
  slug:                  'my-plan',
  tasksDir:              'docs/my-plan/tasks',
  planPath:              'docs/my-plan/PLAN.md',
  logFile:               'docs/my-plan/.flightlog/run.jsonl',
  planGoal:              '<one-line goal copied from PLAN.md>',
  maxAttempts:           3,
  finalReviewMaxAttempts: 2,   // bounded re-loop for the closing cross-vendor review round
  scriptsDir:            '<abs path to skills/flightplan/scripts>',
}

// ── Model policy (tune here — one place) ───────────────────────────────────
// Final review reviewers split by what the lens actually needs:
//   reviewCodex (Haiku) — only drives the codex CLI; the review intelligence
//     lives in codex itself, so the wrapping agent just invokes + records.
//   reviewLens  (Opus)  — the four /simplify lenses must truly *understand* the
//     code to judge reuse/complexity/efficiency/altitude, so they get Opus.
//   fix (Opus) — reads every finding and applies the changes.
const MODEL = { dev: 'sonnet', devEscalated: 'opus', verify: 'haiku', judge: 'opus', reviewCodex: 'haiku', reviewLens: 'opus', fix: 'opus' }
const MAX = CFG.maxAttempts ?? 3
const FINAL_MAX = CFG.finalReviewMaxAttempts ?? 2   // the Final review round loops at most this many times before parking
const S = CFG.scriptsDir   // abs path to flightplan/scripts

// ── Inline score gate ───────────────────────────────────────────────────────
// MUST mirror scoreTask() in score-task.ts exactly. We can't import it (the
// orchestrator has no module access), so the arithmetic is duplicated here for
// the control-flow decision. The judge agent separately runs `score-task --log`
// for the persisted verdict, using the same formula — the two must agree.
function scoreInline(rubric, scores) {
  let weightSum = 0, acc = 0
  const missing = []
  for (const d of rubric.dimensions) {
    const has = Object.prototype.hasOwnProperty.call(scores, d.name)
    if (!has) missing.push(d.name)
    weightSum += d.weight
    acc += (has ? scores[d.name] : 0) * d.weight
  }
  const weighted = weightSum > 0 ? acc / weightSum : 0
  let hardFailed = false
  if (rubric.hardFail) {
    const hv = scores[rubric.hardFail.dimension]
    if (typeof hv === 'number') {
      hardFailed = rubric.hardFail.op === '<'
        ? hv < rubric.hardFail.value
        : hv <= rubric.hardFail.value
    }
  }
  const meets = rubric.passOp === '>'
    ? weighted > rubric.passThreshold
    : weighted >= rubric.passThreshold
  return { weighted, passed: meets && !hardFailed && missing.length === 0, hardFailed, missing }
}

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
        },
        required: ['ref', 'finalReview'],
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
    rubric: {
      type: 'object',
      properties: {
        passThreshold: { type: 'number' },
        passOp: { type: 'string', enum: ['>', '>='] },
        hardFail: {
          type: ['object', 'null'],
          properties: {
            dimension: { type: 'string' },
            op: { type: 'string', enum: ['<', '<='] },
            value: { type: 'number' },
          },
        },
        dimensions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, weight: { type: 'number' } },
            required: ['name', 'weight'],
          },
        },
      },
      required: ['passThreshold', 'passOp', 'dimensions'],
    },
    scores: { type: 'object', additionalProperties: { type: 'number' } },  // { Correctness: 5, ... }
    rationale: { type: 'string' },
  },
  required: ['rubric', 'scores', 'rationale'],
}

// ── Prompts ───────────────────────────────────────────────────────────────
const devPrompt = (ref, attempt, feedback) => `
You are implementing flightplan task ${ref} in the tree at ${CFG.tasksDir}.
Read the task file (find it under ${CFG.tasksDir}/<bucket>/NN-*.md matching ${ref}) and every file in its "Required reading".
Implement the task fully: create/modify the listed files, follow Implementation notes.
${attempt > 1 ? 'This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nAddress that specifically.' : ''}
When done: set the task header "> **Status**:" to in-progress while working. Run the task's ## Verification yourself first.
Then log a narrative note:
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role dev --attempt ${attempt} --agent "<your label>" --message "<what you changed>"
Return a one-paragraph summary of what you did.`

// ── Final review: orchestrator-level multi-lens review fan-out ──────────────
// The dev and the rubric judge are both Claude, so they share blind spots. The
// Final review task's "dev" step is therefore not a Claude self-review — it is a
// fan-out of independent review lenses, then a single Opus fixer that reads all
// their findings and applies them. The fan-out happens HERE in the orchestrator
// (parallel agent() calls), NOT inside one agent — a Workflow agent has no Agent
// tool, so it can't spawn reviewers itself, but the orchestrator can. This
// recovers the /codex review + /simplify multi-agent power we otherwise couldn't
// run from inside a single workflow agent. Lenses:
//   - codex         : cross-vendor (OpenAI) bug/correctness review via /codex review
//   - reuse         : duplicated logic, missed reuse of existing helpers   ┐
//   - simplification: dead code, needless complexity, clearer equivalents   │ the four
//   - efficiency    : wasteful work, N+1s, redundant passes/allocations     │ /simplify
//   - altitude      : right level of abstraction (over-/under-engineering)  ┘ lenses
// codex owns bugs (where cross-vendor diversity matters most); the four Claude
// lenses own quality cleanups. Reviewers only record findings to files; only the
// Opus fixer edits code. The fixer ≠ judge, so the dev≠judge anti-bias split holds.
const REVIEW_LENSES = [
  { key: 'codex', codex: true, model: MODEL.reviewCodex, focus:
    'CROSS-VENDOR bug & correctness review. Invoke the Skill tool with skill "codex" and the "review" subcommand so OpenAI codex reviews the whole working-tree diff. Follow the skill (it runs the codex CLI over Bash, verified reachable). Record codex\'s findings. If codex is UNREACHABLE or the review cannot run, write exactly "CODEX UNREACHABLE" as the first line of your findings file — do NOT skip silently (a missing cross-vendor pass must fail this task, not pass it quietly).' },
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

const reviewPrompt = (ref, lens, attempt) => `
You are the ${lens.key.toUpperCase()} reviewer in the FINAL REVIEW of flightplan ${CFG.slug} (task ${ref}). Review the WHOLE working-tree diff — the accumulated uncommitted changes from every task (use \`git status\` and \`git diff\` to see them) — through ONE lens only:
${lens.focus}
Write your findings to ${reviewDir(attempt)}/${lens.key}.md (run \`mkdir -p ${reviewDir(attempt)}\` first) as a short markdown bullet list — each finding carries file:line and the concrete fix. If nothing is material, write exactly "No findings.". You are a REVIEWER: do NOT edit any source file — only record. Return a one-line count of your findings.`

const fixPrompt = (ref, attempt, feedback) => `
You are the FINAL REVIEW fixer for flightplan ${CFG.slug} (task ${ref}), on Opus. Independent reviewers have each written findings to ${reviewDir(attempt)}/ (one file per lens: codex, reuse, simplification, efficiency, altitude).
1. Read EVERY file in ${reviewDir(attempt)}/. If codex.md begins with "CODEX UNREACHABLE", call that out prominently — the cross-vendor pass did not run.
2. Apply the real fixes (you have Edit/Write). Use judgement: fix correctness / integration / regression issues from codex, and the safe quality cleanups from the four Claude lenses (behaviour-preserving). For any finding you reject, say why.
3. VERIFY. Open the task file (under ${CFG.tasksDir}/<bucket>/NN-*.md matching ${ref}) and run its ## Verification commands yourself; confirm green and that the PLAN goal ("${CFG.planGoal}") is met.
${attempt > 1 ? 'This is re-loop attempt ' + attempt + ' (capped at ' + FINAL_MAX + '). The previous round was rejected:\n' + feedback + '\nEnsure the new findings + your fixes address that.' : ''}
Set the task header "> **Status**:" to in-progress while working.
Log a narrative note (which lenses fired, total findings, what you fixed, whether codex ran):
  bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role final-review --attempt ${attempt} --agent "<your label>" --message "<summary>"
Return a one-paragraph summary: lenses run, codex status, key fixes, verification result.`

// Run the Final review "dev" step: fan out the lenses in parallel, then one
// Opus fixer applies every finding. Replaces the single dev agent for the
// finalReview task; the binary gate + judge + score gate downstream are unchanged.
async function runFinalReview(ref, attempt, feedback) {
  await parallel(REVIEW_LENSES.map(lens => () =>
    agent(reviewPrompt(ref, lens, attempt),
      { label: `review:${lens.key}#${attempt}`, phase: 'Execute', model: lens.model })))
  await agent(fixPrompt(ref, attempt, feedback),
    { label: `fix:${ref}#${attempt}`, phase: 'Execute', model: MODEL.fix })
}

const verifyPrompt = (ref) => `
You are an INDEPENDENT verifier for flightplan task ${ref} (tree: ${CFG.tasksDir}).
Do NOT trust the dev's claims. Open the task file, then:
  1. Run every concrete command in its ## Verification section yourself.
  2. Check every box in ## Acceptance criteria against the actual code/output.
Report passed=true ONLY if all verification commands succeed AND all acceptance criteria hold.
Put the raw evidence (commands, exit codes, failing output) in summary. Do not make subjective quality judgements — that is the rubric judge's job.`

const judgePrompt = (ref, gateSummary) => `
You are the rubric judge for flightplan task ${ref} (tree: ${CFG.tasksDir}).
The independent binary gate already PASSED with this evidence:
${gateSummary}
Open the task file and its ## Eval rubric. Score EACH dimension 0–scaleMax based on the real code and the verification evidence above — ground the correctness dimension in that evidence, not opinion.
Return the parsed rubric (passThreshold, passOp, hardFail, dimensions[{name,weight}]), your per-dimension scores keyed by dimension name, and a rationale.
Then persist the verdict to the flightlog (use the SAME scores):
  echo '<scores-json>' > /tmp/scores-${ref.replace('/','-')}.json
  bun ${S}/score-task.ts <task-file> /tmp/scores-${ref.replace('/','-')}.json --log ${CFG.logFile} --attempt <attempt> --agent "<your label>"`

const markDonePrompt = (ref) => `
Finalize flightplan task ${ref} (under ${CFG.tasksDir}): locate its file (<bucket>/NN-*.md matching ${ref}) and run:
  bun ${S}/mark-done.ts <task-file>
That deterministically sets "> **Status**: done" AND ticks every checkbox in the task's ## Acceptance criteria and ## Verification sections (the task passed the gate, so all hold). Change nothing else by hand.`

const markBlockedPrompt = (ref, reason) => `
Set the "> **Status**:" line in flightplan task ${ref}'s file (under ${CFG.tasksDir}) to: blocked. Change nothing else. (Parked by autopilot: ${reason})`

// ── Per-task retry pipeline ─────────────────────────────────────────────────
async function executeTask(item, wave) {
  const { ref, finalReview } = item
  // The cross-vendor Final review round gets its own (smaller) cap; everything
  // else uses MAX. Past the cap the task is parked + escalated, never skipped.
  const cap = finalReview ? FINAL_MAX : MAX
  let feedback = ''
  for (let attempt = 1; attempt <= cap; attempt++) {
    if (finalReview) {
      // multi-lens review fan-out + Opus fixer (always Opus, no escalation tier)
      await runFinalReview(ref, attempt, feedback)
    } else {
      // last attempt before the cap escalates Sonnet → Opus
      const devModel = attempt >= cap ? MODEL.devEscalated : MODEL.dev
      await agent(devPrompt(ref, attempt, feedback),
        { label: `dev:${ref}#${attempt}`, phase: 'Execute', model: devModel })
    }

    const gate = await agent(verifyPrompt(ref),
      { label: `verify:${ref}#${attempt}`, phase: 'Execute', model: MODEL.verify, schema: GATE_SCHEMA })
    if (!gate || !gate.passed) {
      feedback = `Binary gate failed (verification/acceptance):\n${gate?.summary ?? 'no output'}`
      continue
    }

    const judged = await agent(judgePrompt(ref, gate.summary),
      { label: `judge:${ref}#${attempt}`, phase: 'Execute', model: MODEL.judge, schema: JUDGE_SCHEMA })
    if (!judged) { feedback = 'Judge produced no verdict.'; continue }

    const verdict = scoreInline(judged.rubric, judged.scores)
    if (verdict.passed) {
      await agent(markDonePrompt(ref), { label: `done:${ref}`, phase: 'Execute', model: MODEL.verify })
      return { task: ref, passed: true, attempt, weighted: verdict.weighted }
    }
    feedback = `Rubric score ${verdict.weighted.toFixed(2)} did not pass`
      + (verdict.hardFailed ? ' (hard-fail veto)' : '')
      + (verdict.missing.length ? ` (missing dims: ${verdict.missing.join(', ')})` : '')
      + `:\n${judged.rationale}`
  }
  await agent(markBlockedPrompt(ref, feedback), { label: `block:${ref}`, phase: 'Execute', model: MODEL.verify })
  return { task: ref, passed: false, attempt: cap, reason: feedback }
}

// ── Wave loop ───────────────────────────────────────────────────────────────
phase('Execute')
const completed = []
const escalations = []
const parked = new Set()
let wave = 0

while (true) {
  wave++
  const scout = await agent(
    `Run exactly this command: bun ${S}/next-ready.ts ${CFG.tasksDir} --json\n`
    + `It prints a JSON array of the ready tasks (each with its finalReview flag), e.g.\n`
    + `  [{"ref":"ui/03","finalReview":false},{"ref":"api/02","finalReview":false}]\n`
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
  const results = (await parallel(fresh.map(item => () => executeTask(item, wave)))).filter(Boolean)

  for (const r of results) {
    if (r.passed) completed.push(r.task)
    else { escalations.push(r); parked.add(r.task) }
  }
  // No task passed this wave → no new work will unblock; stop to avoid spinning.
  if (!results.some(r => r.passed)) break
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
- **The scout echoes `next-ready.ts --json` verbatim — it does not interpret.** Use the `--json` mode (emits `[{ref,finalReview}]`, or `[]` when none ready) and have the agent return that array as-is. An earlier line-oriented scout had a fatal blind spot: when `next-ready` printed nothing (all tasks done), the agent didn't map "empty" → `[]` and instead re-listed every task as ready, causing the whole tree to re-run. `[]` from `--json` is unambiguous; the `!completed.includes` filter is the backstop.
- **The inline gate and `score-task --log` must use the same scores.** The orchestrator decides loop/pass from `scoreInline`; the judge agent persists via the CLI. If you change the formula, change it in both `score-task.ts` and `scoreInline` here.
- **Final review needs no special phase.** Its transitive `Depends on` reaches every task, so `next-ready` only offers it once all else is `done`. When the `finalReview` flag is set the orchestrator runs `runFinalReview` instead of a single dev agent (the multi-lens fan-out below) and uses the smaller `FINAL_MAX` cap; the binary gate + rubric judge + score gate are unchanged — they evaluate the round's output against the Final review task's own `## Eval rubric` (integration / consistency / no regressions / meets PLAN goal).
- **The review fan-out is done by the *orchestrator*, not by one agent.** A Workflow agent has `Skill` + `Bash` (codex CLI reachable) but **no `Agent` tool**, so it cannot spawn fan-out skills like `/simplify` or `/code-review` itself. The orchestrator sidesteps that: `runFinalReview` issues one `agent()` per lens via `parallel()` — codex (cross-vendor bug review, run through `/codex review` over Bash) plus the four `/simplify` lenses (reuse / simplification / efficiency / altitude), each Claude. Every reviewer writes findings to `.flightlog/review/attempt-N/<lens>.md` and edits nothing; a single Opus **fixer** then reads all the files and applies the changes. codex is the deliberate cross-*vendor* signal the all-Claude dev+judge can't produce; if it's unreachable the codex reviewer writes `CODEX UNREACHABLE` so the fixer flags it and the gate fails the task rather than passing an un-reviewed deliverable.
- **The fixer is not the judge.** Reviewers + fixer are the "dev" side of the Final review; the binary gate + rubric judge stay independent, so the dev≠judge anti-self-grading split still holds even though the round is more elaborate.
- **Concurrency** is capped by the Workflow runtime (`min(16, cores-2)`); passing a wide wave is safe — excess tasks queue.
- If tasks mutate shared files and could conflict in parallel, give `executeTask`'s dev agent `isolation: 'worktree'` — only if real conflicts occur (it's expensive).

# Autopilot orchestrator — canonical Workflow script

This is the script the `autopilot` skill adapts and passes to the **Workflow** tool. Read the three hard constraints in `SKILL.md` first; they explain every awkward-looking choice here.

The main agent scouts inline, then calls `Workflow({ script: <this>, args: {...} })`. Pass the scouted values via `args`:

```
args = {
  slug:        "my-plan",
  tasksDir:    "docs/my-plan/tasks",
  planPath:    "docs/my-plan/PLAN.md",
  logFile:     "docs/my-plan/.flightlog/run.jsonl",
  planGoal:    "<one-line goal copied from PLAN.md>",
  maxAttempts: 3,
  scriptsDir:  "<abs path to skills/flightplan/scripts>"   // from the skill's load-time base dir
}
```

> **Why `scriptsDir` is passed in:** `CLAUDE_PLUGIN_ROOT` does not reach agent Bash, and the orchestrator can't resolve paths itself. The main agent knows the skill's base directory at load time — resolve `skills/flightplan/scripts` from it and pass the absolute path in `args` so the workflow's agents can call `next-ready.ts` / `score-task.ts` / `flightlog.ts`.

## The script

```javascript
export const meta = {
  name: 'autopilot-run',
  description: 'Execute a flightplan task tree: per-task dev→verify→judge→score loop, then the final review gate',
  phases: [
    { title: 'Execute', detail: 'wave loop: scout ready tasks, run each through the retry pipeline' },
  ],
}

// ── Model policy (tune here — one place) ───────────────────────────────────
const MODEL = { dev: 'sonnet', devEscalated: 'opus', verify: 'haiku', judge: 'opus' }
const MAX = args.maxAttempts ?? 3
const S = args.scriptsDir   // abs path to flightplan/scripts

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
const devPrompt = (ref, attempt, feedback, finalReview) => `
You are implementing flightplan task ${ref} in the tree at ${args.tasksDir}.
Read the task file (find it under ${args.tasksDir}/<bucket>/NN-*.md matching ${ref}) and every file in its "Required reading".
${finalReview ? 'This is the FINAL REVIEW task: review the whole deliverable for integration, consistency, regressions, and whether the PLAN goal was met ("' + args.planGoal + '"). Make fixes if needed.' : 'Implement the task fully: create/modify the listed files, follow Implementation notes.'}
${attempt > 1 ? 'This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nAddress that specifically.' : ''}
When done: set the task header "> **Status**:" to in-progress while working. Run the task's ## Verification yourself first.
Then log a narrative note:
  bun ${S}/flightlog.ts log ${args.logFile} --task ${ref} --role ${finalReview ? 'final-review' : 'dev'} --attempt ${attempt} --agent "<your label>" --message "<what you changed>"
Return a one-paragraph summary of what you did.`

const verifyPrompt = (ref) => `
You are an INDEPENDENT verifier for flightplan task ${ref} (tree: ${args.tasksDir}).
Do NOT trust the dev's claims. Open the task file, then:
  1. Run every concrete command in its ## Verification section yourself.
  2. Check every box in ## Acceptance criteria against the actual code/output.
Report passed=true ONLY if all verification commands succeed AND all acceptance criteria hold.
Put the raw evidence (commands, exit codes, failing output) in summary. Do not make subjective quality judgements — that is the rubric judge's job.`

const judgePrompt = (ref, gateSummary) => `
You are the rubric judge for flightplan task ${ref} (tree: ${args.tasksDir}).
The independent binary gate already PASSED with this evidence:
${gateSummary}
Open the task file and its ## Eval rubric. Score EACH dimension 0–scaleMax based on the real code and the verification evidence above — ground the correctness dimension in that evidence, not opinion.
Return the parsed rubric (passThreshold, passOp, hardFail, dimensions[{name,weight}]), your per-dimension scores keyed by dimension name, and a rationale.
Then persist the verdict to the flightlog (use the SAME scores):
  echo '<scores-json>' > /tmp/scores-${ref.replace('/','-')}.json
  bun ${S}/score-task.ts <task-file> /tmp/scores-${ref.replace('/','-')}.json --log ${args.logFile} --attempt <attempt> --agent "<your label>"`

const markDonePrompt = (ref) => `
Set the "> **Status**:" line in flightplan task ${ref}'s file (under ${args.tasksDir}) to: done. Change nothing else.`

const markBlockedPrompt = (ref, reason) => `
Set the "> **Status**:" line in flightplan task ${ref}'s file (under ${args.tasksDir}) to: blocked. Change nothing else. (Parked by autopilot: ${reason})`

// ── Per-task retry pipeline ─────────────────────────────────────────────────
async function executeTask(item, wave) {
  const { ref, finalReview } = item
  let feedback = ''
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const escalate = attempt >= MAX
    const devModel = (finalReview || escalate) ? MODEL.devEscalated : MODEL.dev

    await agent(devPrompt(ref, attempt, feedback, finalReview),
      { label: `dev:${ref}#${attempt}`, phase: 'Execute', model: devModel })

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
  return { task: ref, passed: false, attempt: MAX, reason: feedback }
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
    `Run: bun ${S}/next-ready.ts ${args.tasksDir}\n`
    + `For each ready ref it prints, open that task file and check whether its header carries "> **Final review**: true".\n`
    + `Return { refs: [{ref, finalReview}], error? }. If the command exits non-zero, return refs:[] and the stderr in error.`,
    { label: `scout-wave-${wave}`, phase: 'Execute', model: MODEL.verify, schema: READY_SCHEMA })

  if (scout?.error) { log(`Wave ${wave} scout failed: ${scout.error}`); break }
  const fresh = (scout?.refs ?? []).filter(i => !parked.has(i.ref))
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

return { slug: args.slug, completed, escalations }
```

## What the main agent does with the result

- `completed` — tasks that passed their rubric (the Final review task among them if the run finished cleanly).
- `escalations` — `[{ task, attempt, reason }]`. For each, surface to the user: in a cockpit session via `needs_your_call` + `cockpit wait`; otherwise `AskUserQuestion`. Include the last `reason` (judge rationale or gate output).
- Then render the trail: `bun <scriptsDir>/flightlog.ts report <logFile>` → `RUNLOG.md`.
- **Resume** after the user unblocks a parked task: reset its `Status` to `todo`, re-run autopilot. Completed tasks stay `done`, so only the unblocked work is re-offered.

## Notes / gotchas

- **Wave re-scout is non-negotiable.** Statuses change only inside the run, so the ready set must be recomputed each wave. A task unblocked by a wave-N completion is picked up in wave N+1.
- **The inline gate and `score-task --log` must use the same scores.** The orchestrator decides loop/pass from `scoreInline`; the judge agent persists via the CLI. If you change the formula, change it in both `score-task.ts` and `scoreInline` here.
- **Final review needs no special phase.** Its transitive `Depends on` reaches every task, so `next-ready` only offers it once all else is `done`. The orchestrator just bumps its dev+judge to Opus via the `finalReview` flag.
- **Concurrency** is capped by the Workflow runtime (`min(16, cores-2)`); passing a wide wave is safe — excess tasks queue.
- If tasks mutate shared files and could conflict in parallel, give `executeTask`'s dev agent `isolation: 'worktree'` — only if real conflicts occur (it's expensive).

# Orchestrator contract

Everything the `orchestrator/` tasks need about the canonical Workflow script and its fixture. Read with
`shared.md`.

Script: `packages/dispatch/skills/autopilot/references/orchestrator.md` — one fenced ```` ```javascript ````
block, ~700 lines of it.
Fixture: `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (~539 lines).
Dashboard consumer: `packages/dispatch/skills/autopilot/scripts/fleet.ts` + `fleet.test.ts`.

## Rule zero — the script lives in markdown, and the test extracts it verbatim

The Workflow runtime takes the script as **source text**; it cannot import a module. So the canonical
script is a fenced block inside a `.md` file, and the fixture pulls it out by string search:

```ts
const start = doc.indexOf("```javascript");
const bodyStart = doc.indexOf("\n", start) + 1;
const end = doc.indexOf("\n```", bodyStart);
return doc.slice(bodyStart, end).replace(/^export const meta/m, "const meta");
```

It then runs it through `new Function("agent", "parallel", "log", "phase", ...)`.

**Every change must land inside that fenced block, not in the prose around it.** A change written beside
the block is invisible to both the runtime and the test. After any edit, run:

```bash
bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts
```

A syntax error or a broken loop surfaces there instead of mid-flight.

## Workflow runtime constraints (these explain every awkward choice)

- **No filesystem access in the script.** Only agents can touch files. Pure in-memory JS is fine.
- **No shared cwd between agents.** Every path in `CFG` is an absolute literal for this reason.
- **No `Agent` tool inside an agent.** An agent has `Bash`, `Read`, `Edit`, `Write`, `Skill` — but it
  cannot spawn sub-agents. This is why the orchestrator itself fans out the review lenses, and why the
  commit step inlines git instead of calling a commit skill.
- **`args` is unreliable.** An unset `args` is `undefined`, and the resulting `bun undefined/next-ready.ts`
  failure reads as "no work to do". Config is baked in as literals in the `CFG` block.
- **`budget`** is a runtime global: `{ total: number|null, spent(): number, remaining(): number }`.
  `total` is `null` when the user declared no token target. It is **not** injected by the fixture, so any
  read of it must tolerate `typeof budget === 'undefined'`.
- **`Date.now()` / `Math.random()` / argless `new Date()` throw** inside a workflow script.
- Concurrency is capped at `min(16, cores - 2)`; a wide `parallel()` just queues.

## Current shape of the wave loop

```
while (true) {
  wave++
  commitPreamble = (wave > 1 && CFG.commitBetweenWaves && escalations.length === 0) ? <commit text> : ''
  scout = await agent(commitPreamble + <scout prompt>, { label: `scout-wave-${wave}`, model: MODEL.verify, schema: SCOUT_SCHEMA })

  ── guards, in this exact order ──
  1. !scout || scout.error                  → escalation '(scout)',  break
  2. scout.errors.length > 0                → escalation '(tree)',   break     // files that did not parse
  3. bucketSum !== counts.total             → escalation '(scout)',  break
  4. counts.invalid > 0                     → escalation '(tree)',   break     // names the refs
  5. counts.done === counts.total           → log, break                      // clean completion
  6. fresh = ready minus parked minus completed
  7. fresh.length === 0                     → stall escalation '(tree)' unless every
                                               outstanding ref is already parked, then break

  results = await parallel(fresh.map(item => () => runTaskGuarded(item)))
  reconcile results[i] against fresh[i] by INDEX          // never .filter(Boolean)
  if (!passedThisWave) break
}
post-loop commit, only when CFG.commitBetweenWaves && escalations.length === 0
return { slug, completed, escalations }
```

Three properties are non-negotiable and no task in this plan may weaken them:

1. **Completion lives on disk.** `counts.done === counts.total`, never `completed.length`. `completed`
   holds only *this invocation's* finishes, so a resumed run would false-stall.
2. **`counts` describes what parsed, not the tree.** That is why `scout.errors` is checked *before* the
   completion test.
3. **Reconciliation is by index, and every task lands in `completed` XOR `escalations`.** A dropped task
   would stay `in-progress` on disk, which `next-ready` never re-offers.

## Escalation shape

```js
escalations.push({ task, attempt, infrastructure, parked, reason })
```

- `task` — a task ref, or a synthetic `'(scout)'` / `'(tree)'`.
- `infrastructure: true` means nothing was judged. `false` means real work was judged and rejected.
- `parked: false` means the file still reads `in-progress` and the user must reset it by hand.
- Synthetic escalations use `attempt: 0`, `infrastructure: true`, `parked: false`.

## `MODEL` policy

```js
const MODEL = { dev: 'sonnet', devEscalated: 'opus', devExternal: 'haiku', verify: 'haiku',
                judge: 'opus', reviewExternal: 'haiku', reviewLens: ..., fix: 'opus', commit: 'haiku' }
```

`MODEL.commit` already exists and is already `'haiku'`. The **post-loop** commit already uses it
(`model: MODEL.commit` on the `commit-post-loop` agent). Only the **inter-wave** commit does not: it rides
the scout agent, which runs on `MODEL.verify`. So the model fix applies to the inter-wave commit only.

## `COMMIT_INSTRUCTIONS`

A single string constant assembled by `+` concatenation. It inlines the atomic-commit contract because a
Workflow agent cannot invoke a commit skill: `git status --porcelain` → group into atomic commits →
`git add <file>...` by name (never `-A`, never `-p`) → commit with the emoji/type template → confirm with
`git log --oneline -n 5` → **step 5 already says**: if any git command fails, stop committing and say so
explicitly, never report a commit that did not happen.

## The per-task pipeline (`executeTask`)

```js
const cap = finalReview ? FINAL_MAX : MAX
let feedback = ''
for (let attempt = 1; attempt <= cap; attempt++) {
  if (finalReview)          await runFinalReview(ref, path, attempt, feedback)
  else {
    const lastShot = attempt >= cap && cap > 1
    if (devEngine && !lastShot) <external driver on MODEL.devExternal>
    else                        <claude dev on (attempt >= cap ? MODEL.devEscalated : MODEL.dev)>
  }
  gate = await agent(verifyPrompt, { schema: GATE_SCHEMA })
  if (!gate)        → infrastructureFailure, park, return
  if (!gate.passed) { feedback = `Binary gate failed …`; continue }
  judged = await agent(judgePrompt, { schema: JUDGE_SCHEMA })
  if (!judged)      → infrastructureFailure, park, return
  if (judged.verdict.passed) { mark-done, confirmed by reread; return or park }
  feedback = `Rubric score … did not pass … ${judged.rationale}`
}
park + return a quality failure with attempt: cap
```

`feedback` is a **single string, overwritten every attempt** — that is D7. Note that `lastShot` guards on
`cap > 1` so a `maxAttempts: 1` task still runs its configured engine.

## Fixture stub contract

Keep the stubs faithful to the runtime:

- `agent()` returns `null` on a terminal failure. It does **not** throw.
- `parallel()` resolves a thrown thunk to `null`. The call itself never rejects.

The stub `agent` dispatches on `opts.label`:

| Label prefix | Returns |
|---|---|
| `scout-wave-` | the next entry of `scenario.scouts` (or `null` when the queue is empty) |
| `verify:` | `scenario.gate[ref]` queue, default `{ passed: true, summary: "green" }` |
| `judge:` | `scenario.judge[ref]` queue, default `{ verdict: pass, rationale: "solid" }` |
| `done:` | `scenario.markDone[ref]` queue, default `{ ok: true, status: "done" }` |
| `block:` | `scenario.park[ref]` queue, default `{ ok: true, status: "blocked" }` |
| `dev:` / `dev-` | throws when the ref is in `scenario.devThrows`, else `"implemented"` |
| anything else | the string `"ok"` |

`runOrchestrator(scenario)` returns `{ result, labels }` where `labels` is every `opts.label` in call
order. **Prompts are not captured** — only labels. `accountsForEveryTask(result, refs)` asserts the
`completed` XOR `escalations` invariant and is used by several tests.

`CFG` is baked into the block as literals, so no test can currently vary a `CFG` field. The only source
rewriting `loadScript()` does today is `export const meta` → `const meta`.

## `fleet.ts` and the `commit` role

`fleet.ts` already understands commits end to end and needs **no change**:

- its role union includes `'commit'`;
- it parses the `commit-post-loop` label;
- it falls back to an entry's own `role` field when the label carries no task ref.

Only **emission** is missing: no commit path calls `flightlog.ts`, so no `role: commit` entry ever exists.

## `flightlog.ts` CLI shape

```bash
bun <scriptsDir>/flightlog.ts log <logFile> --task <ref> --role <role> \
    --agent "<label>" --phase start|end [--attempt N] [--message "<text>"]
bun <scriptsDir>/flightlog.ts report <logFile>     # renders RUNLOG.md
```

Every worker prompt already opens with a `--phase start` call and closes with `--phase end`, using the
identical `--agent` label in both.

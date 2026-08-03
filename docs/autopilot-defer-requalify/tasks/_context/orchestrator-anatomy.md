# The orchestrator script: anatomy and runtime contract

> Read this before editing `packages/dispatch/skills/autopilot/references/orchestrator.md`.
> Line numbers are as of the start of this plan and drift as tasks land — use them to find a
> thing, never to assert one.

## The file is a program inside a document

`orchestrator.md` is prose wrapped around **one** ` ```javascript ` fence (opens ~line 36,
closes ~line 933). That fence is the entire program: the `autopilot` skill reads it, bakes its
own values into the `CFG` block at the top, and hands the result to the `Workflow` tool as
source. Everything outside the fence is guidance for the agent doing that adaptation.

Consequences that bite:

- **It is plain JavaScript.** No type annotations, no `interface`, no generics.
- **It is never imported.** There is no module to typecheck. Its gate is the test fixture below.
- **The body runs inside an async wrapper the runtime supplies.** The script uses a top-level
  `return (async () => { … })()` for the wave loop, which is legal only under that wrapper.
- **`Date.now()`, `new Date()` and `Math.random()` throw** in the Workflow runtime — they would
  break run resumption. Never reach for a clock or randomness.
- Prompts are template literals. Editing one changes what an agent is told, and nothing type
  checks that.

## The deterministic test fixture

`packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` reads the markdown,
extracts that exact fence, and executes it with stubbed `agent` / `parallel` / `log` / `phase`.
No agent is spawned and no file is touched. **This is the correctness gate for every change to
the script**, and it is where new coverage belongs.

Stub contract, which the fixture's own header insists on keeping faithful:

- `agent()` resolves to `null` on a terminal API failure.
- `agent({schema})` **throws** when the subagent never calls the structured-output tool — it
  does not return `null`, so a null-guard alone never sees that failure. The fixture models it
  with a `THROWS` sentinel.
- `parallel()` resolves a thrown thunk to `null`; the call itself never rejects.
- The stubbed `parallel` is real concurrency (`Promise.all` over thunks started immediately), so
  ordering between tasks in a wave is observable and testable.

The stub dispatches on the agent **label**: `scout-wave-*`, `commit-*`, `done:` / `block:`
prefixes, and a `role:ref#attempt` split for the rest. A per-scenario queue lets a test hand a
specific ref a specific gate/judge/park result. Scenarios are plain objects; existing knobs
include `devThrows` (a ref whose dev step throws) and a budget block.

## Prompt builders and where the two git rules go

`STATUS_RULE` (~:235) and `NO_COMMIT_RULE` (~:242) are the shared constants injected into
prompt builders.

`NO_COMMIT_RULE` is three paragraphs: a commit ban, then a **restore-family ban**
(`git checkout` / `git restore` / `git reset` / `git clean`), then a narrow rule about never
touching another task's file under `tasks/`. The second paragraph opens by saying the first
sentence "does not cover them — do not reason your way past this one", because those commands
rewrite the working tree while leaving refs and the index alone, so a careful reader concludes
they are permitted.

The builders, in file order:

| Builder | ~line | Agent holds Bash | Writes source | Gets `NO_COMMIT_RULE` today |
|---|---|---|---|---|
| `devPrompt` | 246 | yes | yes | yes |
| `devExternalPrompt` | 270 | yes | via the CLI it drives | yes, twice — its own prompt and the instruction it writes for the CLI |
| `reviewPrompt` | 330 | yes — runs two `git diff`s | no | no |
| `fixPrompt` | 353 | yes | yes | yes |
| `verifyPrompt` | 380 | yes — runs the task's own commands | no | no |
| `judgePrompt` | 395 | yes | no | no |
| `markDonePrompt` | 411 | runs one script | task file only | no |
| `markBlockedPrompt` | 420 | edits one line | task file only | no |
| `commitInstructions` | 616 | yes — plain git | stages and commits | no |

`commitInstructions` is a builder shared by **two** call sites — the inter-wave commit agent
(~:855) and the post-loop commit agent (~:922) — so one edit covers both.

The **wave scout** is an inline prompt string in the wave loop (~:707). It runs exactly one
command, `next-ready.ts --summary`, and returns stdout verbatim. It issues no git.

## The per-task pipeline

`executeTask(item)` (~:486) runs an attempt ladder, `cap` attempts (`MAX` is 3 by default; the
final-review task uses its own smaller cap):

1. **Dev step** — one of three branches (Claude dev, an external-engine driver, or an appended
   last-shot rung), or, for the final-review task, `runFinalReview()`, which fans out review
   lenses in parallel and then runs a single fixer.
2. **Binary gate** — `agent(verifyPrompt(...), { label: `verify:${ref}#${attempt}`, schema:
   GATE_SCHEMA })` (~:528). `GATE_SCHEMA` (~:203) is `{ passed: boolean, summary: string }`,
   both required. A `null` result is treated as *infrastructure failure*, which is deliberately
   not the same as `passed: false`: it parks the task instead of retrying against an unknown
   state. On `passed: false` the attempt is pushed onto `attempts[]` (~:536) and the loop
   `continue`s to the next dev attempt.
3. **Rubric judge** (~:548) — scores the task and persists a verdict through `score-task.ts`.
4. **Mark done** (~:561) — `agent(markDonePrompt(...), { label: `done:${ref}` })`, which runs
   `mark-done.ts` to set `Status: done` and tick every gate box.

`attempts[]` entries flow into `renderHistory()` → `rejectionOf()` (~:466–474), which builds the
feedback string the **next dev attempt** receives. A verifier's `summary` therefore reaches the
retrying dev verbatim.

`parkBlocked(ref, path, reason)` (~:455) is the best-effort park. It is called from **five**
places: three infrastructure-failure paths inside `executeTask` (~:533, ~:553, ~:572), the
cap-exhausted path (~:586), and `runTaskGuarded`'s catch (~:598).

`runTaskGuarded(item)` (~:593) is a thin wrapper: `try { return await executeTask(item) } catch
{ … parkBlocked … }`. **Its catch runs outside `executeTask` entirely** — anything scoped to
the inside of `executeTask` does not cover it.

## The wave loop

```
while (true) {
  wave++
  scout ────────────────── next-ready.ts --summary
  tree guards ──────────── divergence / parse failures
  fresh = ready - parked - completed
  stall guard
  inter-wave commit ────── commitInstructions(...)      [wave > 1]
  budget floor check
  results = await parallel(fresh.map(item => () => runTaskGuarded(item)))   (~:878)
  reconciliation ───────── by INDEX against `fresh`, never filtered         (~:886)
  if (!passedThisWave) break
}
post-loop commit                                                            (~:922)
```

`parallel()` awaits every task thunk before the loop advances, so anything created per wave
before that call cannot be observed by a later wave — and anything module-scoped survives every
wave, already in whatever state the last one left it.

Reconciliation is by index on purpose: a `null` result must land on its own task rather than
disappear. A task that neither passes nor is escalated would vanish — its dev step already set
`Status: in-progress`, and `next-ready` only offers `todo`, so nothing would ever re-offer it.

`settled(call)` (~:680) wraps the calls that sit *outside* `runTaskGuarded` — the scout and both
commit agents — turning either a `null` or a throw into one reportable shape.

## Rules the script already lives by

- **Only the labelled commit agents commit.** Every other writer leaves its work unstaged.
- **No `isolation: 'worktree'` on the dev agent.** Its edits would land in a private worktree
  the verifier never sees, so every gate would fail.
- **A schema'd `agent()` throws as well as returning `null`** — guard for both, or wrap in
  `settled()`.
- **Cheap models sit on the gate roles.** The verifier, the scout, the park/done agents and the
  commit agents all run on the cheapest tier, so any instruction they receive must be
  unambiguous and any invariant that matters must be enforced in code, not in prose.

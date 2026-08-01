# ORCHESTRATOR-02: the scout transcribes, the script interprets

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/orchestrator-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: orchestrator/01
> **Status**: todo

## Goal

The scout agent returns raw command output and nothing else, the orchestrator script derives every tree
field itself in plain JS, and an empty-but-readable tasks directory escalates instead of reporting a clean
finish.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — inside the fenced
  ```` ```javascript ```` block: replace `SCOUT_SCHEMA`, reduce the scout prompt to a transcription
  instruction, add the parse-and-derive step, and add the empty-tree guard.
- The same file, **outside** the fenced block (modify) — the prose this change makes stale. The gotcha
  asserting the scout "echoes `next-ready.ts --summary` verbatim" now has to describe a schema that carries
  raw stdout rather than tree fields, and the gotcha enumerating the terminal conditions gains the
  empty-tree case. Update both. Prose that contradicts the script is worse than no prose: the next author
  trusts it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — flip the scout stub
  contract from interpreted objects to raw stdout strings across every existing scenario, and add the
  parse-failure and empty-tree cases.

## Implementation notes

### The two defects this closes

**The scout still transforms.** Today `SCOUT_SCHEMA` asks the agent for five interpreted fields, and one
of them requires real work: `invalidRefs` is the agent mapping `invalid[].ref` out of the command's
`invalid` array. The schema also carries a defensive `required` list purely to stop the agent from
summarizing `errors` away, and the prompt spends five lines telling it not to recount, re-enumerate, or
open task files. That is trust surface on the control path for no gain — the transform is trivial and the
script can do it deterministically.

This is **residual trust surface, not a demonstrated bug**. The whole-tree re-listing incident that the
prompt's warnings guard against belongs to a retired line-oriented scout, not the current JSON one. Do not
write the change up as fixing a live failure.

**An empty tasks directory reads as complete.** `next-ready.ts` returns empty maps for a readable but empty
directory and leaves every count at zero, so the completion test `counts.done === counts.total` evaluates
`0 === 0` and the run reports clean success. The post-loop commit then sweeps whatever is in the working
tree into a commit. Reproduce it with `next-ready.ts <empty-dir> --summary` → exit 0, all counts zero.

### The new schema

```js
// The scout TRANSCRIBES. It runs one command and hands back exactly what the
// command printed; the script below does every interpretation. Nothing the agent
// returns requires it to understand the tree, so there is nothing for it to get
// creatively wrong.
const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    stdout:   { type: 'string' },   // verbatim stdout, uninterpreted
    exitCode: { type: 'number' },
    stderr:   { type: 'string' },
  },
  required: ['stdout', 'exitCode', 'stderr'],
}
```

### The new prompt

Reduce it to the flightlog announce/complete pair plus: run exactly this one command, return its stdout
**verbatim** with nothing added or removed, plus its exit code and its stderr. Delete every instruction
about `ready` being `[]`, about copying `errors` exactly, about not recounting, and about the crash
fallback — none of them describe the agent's job any more.

Keep the two `flightlog.ts` calls with the identical `--agent` label in both, matching every other worker
prompt.

### Parse and derive

Immediately after the agent call, before any guard that reads a tree field:

```js
// Pure in-memory work, so this needs no Workflow filesystem access.
let snap = null
let derailed = ''
if (!scout || typeof scout.stdout !== 'string' || scout.stdout.trim() === '') {
  derailed = `the scout returned no stdout${scout?.stderr ? `: ${scout.stderr}` : ''}`
} else {
  try {
    snap = JSON.parse(scout.stdout)
  } catch (err) {
    derailed = `the scout's stdout was not JSON (${err?.message ?? String(err)}): ${scout.stdout.slice(0, 400)}`
  }
}
```

Then validate the parsed object explicitly, because a silently-missing field is the failure mode the old
schema's `required` list existed to prevent, and that protection now has to live here:

- `snap.ready`, `snap.unfinished`, `snap.invalid`, and `snap.errors` must each be an array.
- `snap.counts` must be an object carrying all six of `total`, `todo`, `inProgress`, `done`, `blocked`,
  `invalid` as numbers.
- Any failure sets `derailed` to a message that **names the offending field**, not a generic "bad shape".

A non-empty `derailed` becomes an explicit escalation and breaks, exactly where the old null/`error` check
sat:

```js
if (derailed) {
  const reason = `next-ready scout failed in wave ${wave}: ${derailed}`
  log(reason)
  escalations.push({ task: '(scout)', attempt: 0, infrastructure: true, parked: false, reason })
  break
}
```

Then derive the five values the rest of the loop already consumes, and change nothing else:

```js
const ready       = snap.ready
const c           = snap.counts
const unfinished  = snap.unfinished
const invalidRefs = snap.invalid.map(i => i.ref)
const parseErrors = snap.errors
```

Every downstream guard keeps its exact order and semantics — the parse-errors check, the counts-sum
identity, the `invalid > 0` check that names the refs, the completion test, the `fresh` filter that
excludes parked and completed refs, and the empty-`fresh` stall. Only the *source* of the values changes,
from agent-interpreted fields to locally-derived ones.

### A non-zero exit code is not a failure

This is the trap in the new shape. `next-ready.ts --summary` prints its JSON **before** exiting non-zero
on a malformed or unparseable tree — that is deliberate, so the caller can name the invalid refs. So
`exitCode !== 0` must **not** be treated as a scout failure on its own. The only failure conditions are an
absent/empty stdout and stdout that will not parse. Capture `exitCode` because it is useful in an
escalation message, and do not branch on it.

### The empty-tree guard

Add it with the other counts guards and **before** the completion test:

```js
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
```

Placing it before the completion test is the whole point; after it, the `0 === 0` break wins first.

### Fixture work

The scout stub contract flips. It currently hands back already-interpreted objects and must now hand back
`{ stdout, exitCode, stderr }` with the tree snapshot JSON-stringified into `stdout`. Add a helper so the
scenarios stay readable rather than carrying hand-written JSON strings:

```js
const snapshot = (tree, exitCode = 0) => ({
  stdout: JSON.stringify({
    ready: [], unfinished: [], invalid: [], errors: [], ...tree,
  }),
  exitCode,
  stderr: "",
})
```

Note the field rename the fixture has to absorb: scenarios currently express invalid tasks as
`invalidRefs: ["<a ref>"]`, but the command actually prints an `invalid` array of objects. The snapshot
helper must emit `invalid: [{ ref, rule, reason }]`, since the script now does the mapping. Update the
`ScoutResult` type accordingly, and rewrite every existing scenario — all of them — through the helper.

Then add:

- A stub whose `stdout` is non-JSON prose escalates as `(scout)` with `infrastructure: true`, and the run
  ends with an empty `completed` rather than looking like a drained tree.
- A stub whose `stdout` is valid JSON but missing `counts` escalates as `(scout)` with a reason naming
  `counts`.
- A snapshot with `counts.total === 0` escalates as `(tree)` and does **not** report completion.
- A snapshot that exits 1 while printing a valid tree with `invalid` entries still reaches the existing
  `invalid > 0` guard and names the refs — proving `exitCode` is not treated as a failure.
- The existing scout-returns-null case still escalates as `(scout)`.
- `accountsForEveryTask` still holds everywhere it is asserted today.

### Out of scope for this task

- Any change to `next-ready.ts`. Its `--summary` output shape is the contract this task consumes, and it
  already prints everything needed.
- Any change to the commit step, its schema, or its placement.
- Adding retry or repair logic for a scout that fails. Escalating and stopping is the designed behaviour.
- Changing the `counts`-sum identity check, the completion test, the `fresh` filter, or the stall check.
- Making the script tolerate a partially-valid snapshot. A missing field is an escalation, never a
  defaulted empty array — defaulting is how a broken tree gets read as finished.

## Acceptance criteria

- [ ] `SCOUT_SCHEMA` is exactly `{ stdout: string, exitCode: number, stderr: string }` with all three in
      `required`.
- [ ] The scout prompt asks only for a verbatim stdout transcription plus exit code and stderr; it
      contains no instruction about interpreting, mapping, recounting, or defaulting any tree field.
- [ ] The script parses `scout.stdout` with `JSON.parse` inside a try/catch and derives `ready`, `counts`,
      `unfinished`, `invalidRefs` (mapped from the `invalid` array's `ref` values), and the parse-errors
      list in plain JS.
- [ ] Absent, empty, or non-JSON stdout produces a `(scout)` escalation with `infrastructure: true` and a
      reason that includes the underlying cause.
- [ ] A snapshot missing any of `ready`, `counts`, `unfinished`, `invalid`, `errors` — or a `counts` lacking
      any of its six numeric fields — produces a `(scout)` escalation whose reason names the offending
      field.
- [ ] `exitCode !== 0` alone never produces an escalation; a non-zero exit that still printed a valid tree
      flows into the normal guards.
- [ ] `counts.total === 0` produces a `(tree)` escalation, and it is evaluated before the
      `done === total` completion test.
- [ ] Every pre-existing guard keeps its order and its semantics; no guard is defaulted, softened, or
      reordered.
- [ ] No field is silently defaulted to an empty array when the snapshot omits it.
- [ ] `next-ready.ts` is unmodified.

- [ ] The scout gotcha and the terminal-conditions gotcha in `orchestrator.md` describe the transcription
      schema and the empty-tree condition — no stale claim about the scout survives outside the fenced
      block.

## Verification

- [ ] Every **executable-script** change lands inside the fenced ```` ```javascript ```` block of
      `orchestrator.md` — the fixture extracts that block verbatim by string search, so script logic
      written in the surrounding prose is invisible to both the runtime and the test.
- [ ] The prose corrections listed under "Files to create / modify" are made **outside** that block, and
      no longer contradict the shipped script. These two checks are complementary, not in tension: script
      logic goes inside the fence, descriptions of it go outside.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` green.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` green — no regression in the sibling suites.
- [ ] Every existing fixture scenario is expressed through the raw-stdout helper; `grep -c "invalidRefs:"`
      in the fixture returns 0 for scenario definitions, since scenarios now carry an `invalid` array.
- [ ] A fixture case with non-JSON stdout asserts `escalations[0].task === '(scout)'` and
      `completed` is empty.
- [ ] A fixture case with `counts.total === 0` asserts `escalations[0].task === '(tree)'`.
- [ ] `git diff --stat packages/dispatch/skills/flightplan/scripts/next-ready.ts` is empty.
- [ ] Create an empty directory, run
      `bun packages/dispatch/skills/flightplan/scripts/next-ready.ts <empty-dir> --summary`, and confirm it
      exits 0 with all counts zero — the input condition the new guard exists to catch.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | A missing field is defaulted rather than escalated, a guard changed order, or `exitCode !== 0` is treated as failure. | Parsing and derivation work but one validation or the empty-tree placement is wrong. | Derivation, per-field validation, the exit-code subtlety, and the pre-completion placement of the empty-tree guard all hold, with every other guard untouched. |
| Test coverage | ×2 | Scenarios not migrated, or the suite passes against the old schema. | Migrated, but the new failure cases are untested. | All scenarios migrated through the helper, plus parse-failure, missing-field, empty-tree, and non-zero-exit-with-valid-tree cases, and the accounting invariant re-asserted. |
| Interface & readability | ×1 | Hand-written JSON strings scattered through scenarios, or validation duplicated per field. | Works but the derivation block is hard to follow. | One snapshot helper carries every scenario, and the validation reads as a single legible block naming its fields. |
| Assumptions & docs | ×1 | The exit-code subtlety is left implicit. | Noted in one place. | The print-then-exit-non-zero behaviour and the never-default-a-missing-field rule are both *why* comments, and the notes/gotchas prose describing the old echoing scout is rewritten to match. |

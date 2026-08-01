# ORCHESTRATOR-03: cross-attempt retry history

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/orchestrator-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: orchestrator/02
> **Status**: todo

## Goal

A retry sees every previous attempt on its task and which model ran each one, instead of only the most
recent rejection.

This change is **unconditional** — every run gets it, with no config field and no opt-in.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — inside the fenced
  ```` ```javascript ```` block: replace the single overwritten feedback string with an ordered attempt
  record, and render the whole history into the retry prompts.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — capture each agent
  call's prompt, and cover the multi-attempt history.

No prose change is required outside the fenced block: no gotcha describes the retry-feedback mechanism, so
nothing outside the block goes stale. If you find prose that does describe it, update that too.

## Implementation notes

**Every edit to the executable script must land INSIDE the fenced ```` ```javascript ```` block.** The
fixture locates the script by string search — `doc.indexOf("```javascript")` to the next `"\n```"` — and
runs the slice through `new Function`. A change written in the prose around the block is invisible to both
the runtime and the test, and will look like it worked.

### The defect

The per-task retry loop currently carries one string:

```js
let feedback = ''
for (let attempt = 1; attempt <= cap; attempt++) {
  ...
  if (!gate.passed) {
    feedback = `Binary gate failed (verification/acceptance):\n${gate.summary ?? 'no output'}`
    continue
  }
  ...
  feedback = `Rubric score ${verdict.weighted.toFixed(2)} did not pass`
    + (verdict.hardFailed ? ' (hard-fail veto)' : '')
    + (verdict.missing.length ? ` (missing dims: ${verdict.missing.join(', ')})` : '')
    + `:\n${judged.rationale}`
}
```

Each assignment **overwrites** the last. So the third attempt is told only what the second did wrong. It
cannot know the first attempt already tried that same fix, which is how a task oscillates — fixing A while
re-breaking B — and burns its whole ladder.

### The record

```js
// Every attempt's outcome, in order. The retry prompt renders ALL of them, not
// just the last: with only the newest rejection visible, attempt 3 cannot know
// that attempt 1 already tried the same fix, so the ladder oscillates instead of
// converging.
const attempts = []   // [{ n, model, gateSummary, rationale, weighted, hardFailed, missing }]
```

Field contract — all seven fields on every record, because two different rejection shapes share it:

- `n` — the attempt number, as it actually ran.
- `model` — the model or engine label that ran the dev step for that attempt (`'sonnet'`, `'opus'`, or an
  engine label such as `'codex'`). This is the field that makes the history worth rendering: "attempt 2 on
  sonnet already tried X" is actionable in a way that a bare rejection string is not.
- `gateSummary` — the verifier's raw evidence for that attempt, whether it passed or failed.
- `rationale` and `weighted` — set **only** when the binary gate passed and the rubric judge then rejected.
  `null` for a binary-gate failure.
- `hardFailed` and `missing` — the rubric verdict's veto flag and its missing-dimension list, for that same
  rubric-rejection case; `false` and `[]` for a binary-gate failure.

`hardFailed` and `missing` are on the record because the current rubric feedback string annotates them
(`(hard-fail veto)`, `(missing dims: …)`) and the renderer must keep doing so. They live on
`judged.verdict`, not on `weighted` or `rationale`, so they cannot be reconstructed later. Omit them and
those annotations are silently lost — a feedback regression, not a cosmetic one.

### The renderer

```js
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
```

Thread `renderHistory(attempts)` into the **same argument slot** the prompts already use. The three prompt
builders keep their signatures unchanged — `devPrompt(ref, path, attempt, feedback)`,
`devExternalPrompt(engine, ref, path, attempt, feedback)`, and `fixPrompt(ref, path, attempt, feedback)`.
Each already wraps that argument in its own framing:

```js
${attempt > 1 ? 'This is retry attempt ' + attempt + '. The previous attempt was rejected:\n' + feedback + '\nAddress that specifically.' : ''}
```

So `renderHistory` must return only the **body** — newest rejection first, then the labelled earlier block.
Do not have it emit its own "the previous attempt was rejected" preamble, or the prompt says it twice.

Also replace the two trailing uses of the old string: the final `parkBlocked(ref, path, feedback)` call and
the `reason:` field of the returned quality failure both become `renderHistory(attempts)`. The escalation
surfaced to the user then carries the whole ladder instead of its last rung.

### The closing review round's `model` value

The history applies to the closing review round too — its fixer re-loop reads the same argument slot. But
that round has no single dev model: it fans out across several review lenses and then applies findings with
one Opus fixer, so "the model that ran the dev step" has no answer there.

Record the literal string `'final-review'` for those attempts. Not the fixer's model, and not a list:

- The fixer model names only the fixer, and would claim the round was one Opus attempt, hiding the fan-out.
- A list would make `model` a different type for one branch, and the field is rendered into a prompt
  sentence (`ran on ${a.model}`) where a list reads as noise.
- `'final-review'` is honest and stable: it says which *kind* of round produced the rejection, which is the
  only thing a retry can act on. The lens breakdown already lives in the flightlog, where audit detail
  belongs.

Do not leave this to judgement — it is the one field whose value is not obvious, and an invented one would
differ between runs.

### Fixture capability this task must add

**Prompt capture.** The stub `agent` records only `opts.label`, so no test can see what a retry was told.
Extend `runOrchestrator` to record `{ label, prompt }` per call and return that alongside the existing
`labels` array. Keep `labels` exactly as it is, so no existing test has to change.

### Out of scope for this task

- Any config field, and any change to which model runs which attempt. The ladder's dispatch and cap logic
  are handled by the next change in this bucket; this one only records and renders what already ran.
- Any change to the wave loop, the scout, the commit step, or the guard order.
- Any change to the schemas, to `score-task.ts`, or to the scoring arithmetic.
- Reading the Workflow `budget` global.
- A config field for how many history entries to render. Render all of them; a ladder is at most a handful
  of attempts.

## Acceptance criteria

- [ ] The per-task loop accumulates one record per rejected attempt, in order, and no longer overwrites a
      single feedback string.
- [ ] Every record carries all seven fields — `n`, `model`, `gateSummary`, `rationale`, `weighted`,
      `hardFailed`, `missing`. A five-field shape is not acceptable: it silently drops the hard-fail and
      missing-dimension annotations.
- [ ] `rationale` and `weighted` are `null` for a binary-gate failure and populated for a rubric rejection;
      the renderer emits the matching one of the two existing feedback strings, including the hard-fail and
      missing-dimension annotations.
- [ ] `model` records the model or engine label that actually ran each attempt's dev step.
- [ ] A closing-review-round attempt records `model` as the literal `'final-review'`, not a fixer model
      name and not a list of lens models.
- [ ] On the third attempt of a task, the dev prompt contains the first attempt's rejection text **and**
      the second's, newest first, with the earlier one under a labelled prior-attempts block.
- [ ] The renderer emits no "previous attempt was rejected" preamble of its own, so no prompt states it
      twice.
- [ ] The park reason and the returned quality-failure `reason` both carry the rendered history rather than
      only the last rejection.
- [ ] The three prompt-builder signatures are unchanged — the history rides the existing argument slot.
- [ ] The fixture records each agent call's prompt as well as its label, and the existing `labels` array is
      still returned unchanged.
- [ ] Every change to the executable script sits inside the fenced ```` ```javascript ```` block.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` green.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` green — no regression in the sibling
      dashboard suites.
- [ ] A fixture case where a task's gate fails three times asserts the **third** dev prompt contains the
      rejection text of attempts 1 **and** 2, with attempt 1 under the prior-attempts heading. It cannot
      contain attempt 3's own rejection — that prompt is built before attempt 3's gate runs — so do not
      assert it there.
- [ ] The same fixture case asserts the final parked escalation reason accounts for all three attempts,
      which is the only place the complete history is observable.
- [ ] A fixture case whose judge returns a hard-failed verdict with missing dimensions asserts the retry
      prompt contains both `(hard-fail veto)` and the `missing dims:` list.
- [ ] A fixture case where the closing-review task's first round is rejected asserts the second round's
      prompt records the prior attempt as having run on `final-review`.
- [ ] A fixture case asserts a first attempt's prompt contains no prior-attempts block at all.
- [ ] `bun -e "const d=await Bun.file('packages/dispatch/skills/autopilot/references/orchestrator.md').text(); const s=d.indexOf('\`\`\`javascript'); const b=d.indexOf('\n',s)+1; const e=d.indexOf('\n\`\`\`',b); new Function(d.slice(b,e).replace(/^export const meta/m,'const meta'))"`
      exits 0 — the block still parses as a function body.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The rendered prompt duplicates a preamble, drops an annotation, or a record is missing fields. | The history renders but a shape is wrong (a closing-review `model`, a first-attempt empty case, or a null-field case). | Both rejection shapes, all seven fields, the closing-review label, and the first-attempt empty case all behave exactly as specified. |
| Test coverage | ×2 | No test, or tests that would pass without the change. | Happy path only, or the history asserted without prompt capture. | Multi-attempt ordering, both rejection shapes, the veto annotations, the closing-review label, and the empty first attempt are all covered, and each test would fail without the change. |
| Interface & readability | ×1 | The history threaded through a new prompt parameter, or the renderer duplicating framing the prompts already own. | Works but the record's two shapes are hard to tell apart. | Prompt signatures unchanged, one small renderer, and the two rejection shapes obvious from the code. |
| Assumptions & docs | ×1 | The body-only rendering contract and the `'final-review'` choice are left silent. | Noted somewhere. | Both are *why* comments next to the code, and the record's null-vs-populated field contract is stated where the record is declared. |

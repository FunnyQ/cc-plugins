# REVIEW-01: Final Review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/types.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: work/04
> **Status**: done
> **Final review**: true

## Goal

Judge the finished token-usage feature as one whole: that the four layers compose, that
the numbers on screen are the numbers on disk, that nothing else in flightdeck
regressed, and that no layer was built that nobody asked for.

## Files to create / modify

This task reviews and repairs; it creates nothing new by default.

- `packages/dispatch/skills/autopilot/scripts/*.ts` (modify, only if a defect is found)
- `packages/dispatch/skills/autopilot/dashboard/dist/**` (modify, only if a defect is found)
- `packages/dispatch/skills/autopilot/dashboard/dist/modules/*.js` (modify, only if a defect is found)

Fix what you find. Do not refactor what already works.

## Implementation notes

### The end-to-end truth check

This is the one check no earlier gate can perform, because each of them only sees its
own layer. Every layer can pass its unit tests while the assembled number is wrong.

**Run it against generated data.** Do not open "a plan that has already run". The
transcripts are uncommitted, machine-local, and deleted by Claude Code on its own
retention schedule, so that form of the check reports a zero-versus-zero agreement once
the data ages out and cannot run on another machine at all. `../_context/shared.md`
carries the rule and the generator's contract.

1. Run the fixture generator. Capture the `planDir`, `projectsRoot`, and `expected` from
   the JSON it prints. `expected` is the ground truth: the generator declares the numbers
   it built, so nothing here needs a second summing script that could share a bug with
   the first.
2. Start the flightdeck server against that plan directory, passing `--projects-root`
   for that projects tree, and read one frame off the events endpoint with `curl -N`.
3. Compare the payload's exact plan-wide output total to `expected.totals.output`. They
   must agree **exactly**. Confirm `usage.agentCount` matches too — an `agentCount` of
   zero means the fixture was not found, and a zero total agreeing with nothing is the
   precise failure this whole arrangement exists to prevent.
4. Then, separately, confirm the header on screen shows the token formatter applied to
   that same payload value. This is a formatting check, not a truth check.
   **Never compare the header text to the ground truth directly** — the display rounds
   (`278146` renders `278.1K`), so that comparison fails against a perfectly correct
   implementation for every figure above 999.
5. If step 3 disagrees, the defect is real and this task fixes it. Do not adjust the
   fixture to match the dashboard.

**Then, if and only if real historical data happens to survive, repeat step 3 against
it.** This is a strictly stronger signal, because the fixture was written by the same
mind that wrote the reader and can share its blind spots. Find the surviving
transcripts the way the feature does, sum `message.usage.output_tokens` over every
`assistant` line of every matching file with a throwaway script, and compare. **Sum
across every matching workflow directory, not just one** — plan usage is cumulative
over every execution, so a plan that ran twice has two directories and both count; a
single-directory sum disagrees with a *correct* dashboard and reads as a feature bug
when the bug is in the check.

Say in your report whether this second comparison ran or was skipped for lack of data.
A reader is entitled to know which of the two signals backs the verdict.

### The distinctions that must survive assembly

- **Unavailable is not zero.** A fleet row with no matched transcript reads `N/A`.
  Confirm this end to end, not just in a unit test: find a row whose work was delegated
  to an external engine, or synthesize one, and confirm the rendered cell.
- **Conservation.** The per-task figures plus the unattributed figure equal the plan
  total. **Check this against the raw event payload, not against the screen.** Two
  things make the rendered values unusable for it: the unattributed figure is never
  displayed anywhere, and the token formatter abbreviates and rounds, so summing what
  the cards show cannot reproduce the header exactly even when the data is perfect.
  Read one frame off the events endpoint with `curl -N`, then assert the identity on
  the numbers inside it. Verifying the assembled payload rather than the unit under
  test is still an end-to-end check — the payload is what the browser receives.
- **Scope agreement.** The token figures and the fleet rows must describe the same set
  of runs. The decision on record is that both are cumulative across every execution of
  the plan. If a plan was run twice, both panels must reflect both runs.

### Consistency across the tree

Read the whole diff at once and check for the seams that per-layer review misses:

- One name per concept. The counter fields are `input` / `output` / `cacheRead` /
  `cacheWrite` everywhere inland; the raw wire names appear only at the parse boundary.
- One formatter. There must be exactly one function that turns a token count into
  display text, imported by every caller. Two formatters is a defect even if they agree
  today.
- One owner per file. No type is declared twice, no helper is copied rather than
  imported.
- The comments explain why, not what, and every dependence on Claude Code's
  undocumented on-disk layout is flagged as an observation a future reader must
  re-verify.

### Regressions

The fleet panel is the reason this dashboard exists. A token panel that breaks it is a
net loss. Confirm the panel still streams, still reaps abandoned rows, still renders
verdicts, and that the tree endpoint is untouched.

### Leanness

Score the judgement, not the line count. This feature's specific over-engineering risks,
in the order they are likely to have happened:

- A cache, a persisted cursor file, or a rebuild path. The decision on record is that
  cursor state lives in memory for the life of one stream and nothing is written to disk.
- A second poll loop, timer, or watcher alongside the one the event stream already runs.
- A new HTTP route. The decision on record is that usage rides the existing frame.
- An **indirection** with exactly one caller: a strategy interface, a pluggable-source
  registry, a factory type, a config object nobody sets, an options bag with one field.

  A plain local helper function with one caller is **not** what this means and is not a
  finding. Naming a `title` string or a cell's markup in its own small function is
  ordinary readable code, and two of the layers legitimately do it. Score the
  indirection, not the function count.

  The optional parameters that exist purely as test seams are also not findings. There
  are two of them by design, each defaulted to the real construction, each the reason a
  path is testable at all. Removing one would trade a working test for nothing.
- Hand-rolled versions of what already exists in this directory: the byte-cursor
  helpers, the identity key, the HTML escaper, the score formatter.

A plan that legitimately added a lot of code should still score well here. Delete only
what has no current requirement behind it.

## Acceptance criteria

- [x] Which end-to-end path was available — historical transcripts, or a built fixture —
      was established before the check was written, and is stated in the report.
- [x] The plan-wide output total **in the event payload** matches an independently
      computed ground truth exactly: summed across every workflow directory the plan
      produced when historical transcripts survive, or against hand-chosen fixture
      numbers when they do not. A zero-versus-zero agreement caused by a missing
      directory does not satisfy this criterion.
- [x] The header on screen shows the token formatter applied to that payload value.
- [x] A fleet row with no matched transcript renders as unavailable, and a row with a
      matched transcript renders its own figure.
- [x] The per-task figures plus the unattributed figure equal the plan total, asserted
      on the raw event-stream payload rather than on rendered text.
- [x] Exactly one token-formatting function exists in the codebase, and every display
      site imports it.
- [x] The counter field names are consistent inland, with the raw wire names confined
      to the parse boundary.
- [x] The fleet panel still streams, reaps, and renders verdicts; the tree endpoint's
      payload is unchanged.
- [x] No cache, persisted cursor, extra timer, extra HTTP route, or single-caller
      **indirection** was introduced. Any found is removed or justified in one line.
      Small local helpers and the two defaulted test-seam parameters are expected and
      do not count.
- [x] Every defect found in this review is fixed, or recorded with the reason it was
      left.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` — every test passes.
- [x] `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/` — every
      test passes.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch/skills/autopilot` — prints
      nothing. Run it against the root `tsconfig.json`; naming files on the command line
      drops the config and floods the output with errors that are not real. Do not chase
      a zero total, the repo-wide run is not green for unrelated reasons.
- [x] Start the flightdeck server against the generated fixture's plan directory, with
      `--projects-root` pointing at its projects tree, open it in a browser, and confirm
      the fleet column, a lanes card total, and the header total all render, plus the one
      row the fixture leaves without a transcript reading `N/A`. Read the port from the
      server's own startup output. This is the same fixture-backed procedure described
      above — do not substitute an already-executed plan directory, which is the gate
      wording the shared conventions forbid.
- [x] `git status --short -- packages/dispatch/skills/autopilot docs/flightdeck-tokens/tasks/review/01-final-review.md`
      — confirm the paths this review actually edited appear. This is a weak signal, not
      a scope gate; other paths in the tree belong to work running beside this one.

## Eval rubric

> Scale 0–5. Weighted average `> 4.0` to pass. `Meets the goal < 4` is an automatic veto.
> This task scores the assembled feature, not the individual layers — see `../_context/rubric.md` for the per-layer bar it does not repeat.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Meets the goal | ×3 | the displayed total does not match ground truth, or no end-to-end check was run | the total matches but a distinction was lost — unavailable renders as zero, or the two panels disagree about scope | the header, card, and column figures all trace to disk correctly, and unavailable stays distinct from zero |
| Integration | ×2 | a layer's output does not fit the next layer's input; the assembled path throws or silently drops data | the layers compose but a seam leaks — a raw wire name inland, a duplicated formatter, a type declared twice | reader, attribution, stream, and render compose cleanly with one owner per file and one name per concept |
| No regressions | ×2 | the fleet panel, the stream, or the tree endpoint broke | an existing test needed changing for a reason other than a deliberately changed signature | every pre-existing test passes, the fleet panel still streams and reaps, the tree payload is untouched |
| Consistency | ×1 | naming, error handling, and comment style differ layer to layer | mostly consistent with one or two unexplained deviations | reads as one author, and every dependence on the undocumented on-disk layout is flagged for re-verification |
| Leanness | ×1 | a cache, persistence layer, extra timer, or extra route was added that nothing required | one single-caller indirection or one hand-rolled copy of an existing helper survives | nothing was built that no stated requirement needed; existing helpers were reused rather than re-written; small local helpers and defaulted test seams left alone |

## Out of scope

- **Dollar cost.** Deferred. There is no pricing table this code may import, and
  duplicating one is a decision that has not been made.
- **Cache-read and cache-write display.** Deferred deliberately: cache-read runs roughly
  260 times output, so rendering it would flatten every other figure into noise. The
  data is collected and unused, which is the intended state.
- **Codex and OpenCode token capture.** Deferred. Those agents leave no Claude
  transcript; their usage lives in a different store entirely and needs its own reader.
- **Broadening the review to the rest of the dashboard.** Report anything you notice
  outside this feature's diff. Do not fix it.

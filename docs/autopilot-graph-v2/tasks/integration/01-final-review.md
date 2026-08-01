# INTEGRATION-01: final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/orchestrator-contract.md`
> - `../_context/lint-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: lint/03, orchestrator/05
> **Status**: done
> **Final review**: true

## Goal

The holistic closing gate: confirm the five shipped requirements compose into one coherent orchestrator
graph, that the linter and the orchestrator agree with the docs that describe them, that nothing
regressed, and that the plan's goal was actually met.

## Files to create / modify

- None expected. This task reviews the whole deliverable and edits files only to fix defects it finds.
  Any such fix must also keep the relevant task's own criteria satisfied.
- `docs/autopilot-graph-v2/tasks/README.md` (modify) — record the existing-tree sweep results and any
  remaining Known gaps in the human-authored section.

## Implementation notes

Five requirements landed across two independent branches. The linter branch added a tree-level
regression-net rule plus an exit-code-neutral informational report, and updated the templates that teach
planners to write a closing net. The orchestrator branch made five serial edits to the single fenced
`javascript` block in `packages/dispatch/skills/autopilot/references/orchestrator.md`: the commit step
became its own agent placed after the scout guards, the scout was reduced to raw transcription with an
empty-tree guard added, the retry loop gained cross-attempt history, the Claude dev ladder gained an
optional appended external rung, and the wave loop gained a budget floor.

Review the whole run diff, not just the last change. The base commit this plan was written against is
recorded in `../_context/shared.md` under "Run base reference", along with the fallback to use if it is
not an ancestor of `HEAD`. Get the diff with **both** commands — the last wave's edits may still be
uncommitted:

```bash
git diff <the recorded base SHA>..HEAD   # everything committed during the run
git diff                                  # plus anything still in the working tree
```

### Integration: do the five orchestrator edits actually compose

The five orchestrator changes all edit the same wave loop and the same `executeTask`. Each was verified
alone. What no single task verified is their interaction. Check these explicitly:

- **Guard order survived all four edits.** Walk the wave loop top to bottom and confirm the sequence is
  still: scout-null/error → parse `errors` → counts-sum → `invalid > 0` → empty-tree → `done === total` →
  compute `fresh` → empty-`fresh` stall → commit agent → budget floor → `parallel()` dispatch. Two of the
  five changes inserted a step into this sequence and one rewrote where every value comes from; a
  reordering here is the most likely silent defect in the whole plan.
- **The commit still runs before the budget break.** If the budget check preceded the commit, a
  budget-stopped run would leave the finished wave uncommitted. Confirm the commit call is above it.
- **`counts` still comes from a derived object, not from the agent.** Confirm no guard reads a field the
  scout agent produced directly — the agent returns only `stdout`, `exitCode`, and `stderr` now.
- **The commit escalation does not break the loop, but the budget escalation does.** Both push an
  escalation; only one is terminal. Confirm each behaves as designed and that both are visible in the
  returned `escalations`.
- **`escalations.length === 0` still gates every commit.** A commit failure, a budget stop, or any task
  escalation must all suppress the post-loop commit. This guard is the only thing keeping rejected edits
  out of git.
- **The three load-bearing properties are intact**: completion is tested with `counts.done ===
  counts.total` and never `completed.length`; the parse-errors list is checked before the completion
  test — read it from the locally derived snapshot, since the scout agent no longer returns tree
  fields at all;
  reconciliation is by index with no `.filter(Boolean)`, so every task lands in `completed` XOR
  `escalations`.

### Consistency: code, prose, and templates must agree

- The prose and the "Notes / gotchas" list in `orchestrator.md` still describe the script that is now in
  the fenced block. The five edits moved a commit, replaced a schema, extended a ladder twice, and added a
  terminal condition — the surrounding prose claims things about all four. In particular the note that
  enumerates the terminal conditions must now account for the empty-tree guard and the budget stop, and
  the note asserting the scout "echoes verbatim" must match the schema that actually ships.
- `CFG` gained fields. Every new field carries a one-line comment in the `CFG` block, and the defaults
  documented in prose match the literals in the block.
- The template guidance and the flightplan `SKILL.md` describe the regression-net rule the linter
  actually enforces — same trigger condition, same severity, no drift.
- `packages/dispatch/skills/autopilot/SKILL.md` does not contradict the new orchestrator behaviour.

### Regressions

- Every suite green, not just the ones a single task touched.
- Both dispatch manifests still read the version they had before this work started, and both marketplace
  registries are unmodified. This tree deliberately ships no release.
- The fenced block still parses. The fixture extracts it by string search
  (`indexOf("```javascript")` → `indexOf("\n```")`), so a stray fence or an edit made *beside* the block
  rather than inside it breaks extraction. A green fixture run proves extraction still works.
- The linter's existing rules still behave: self-containment, required-reading resolution, status
  validity, completion state, rubric parsing, and the final-review coverage check.
- Every existing plan tree under `docs/` was linted and each failure was recorded rather than silently
  accepted or retro-fitted.

### Meets the goal

A tree that owns a test suite can no longer ship a closing gate that runs no test at all — a presence
guarantee, not a coverage one. The control path contains no interpreting agent,
a blocked commit is reportable and appears in the audit trail, a retry can see every prior attempt and
*can* end on a different vendor once that rung is configured, and a run that declares a budget *and* sets
a non-zero floor gets a reported between-waves stop.

Two of the five are **opt-in and off by default** — the vendor rung and the budget floor. Judge them on
whether the capability works when switched on and is inert when not, never on whether it fires in a
default run. A criterion that demanded default-on behaviour would be unsatisfiable, and both defaults are
deliberate: the rung costs an extra attempt per failing task, and a floor that fires unasked would
manufacture a new stall class.

### Out of scope for this task

- Re-scoring individual tasks. Per-task rubrics already did that; this gate scores integration,
  consistency, regressions, and whether the goal was met.
- Bumping a version, writing a `CHANGELOG.md` entry, or touching a marketplace registry.
- A live execution run. Proving `role: commit` entries appear in a real flightlog and render in the
  dashboard needs a real run over a real tree, which a run cannot honestly perform on itself. That stays
  a manual step and is recorded as a Known gap.
- Building anything from the rejected or deferred sections: continuous scheduling, per-task commits,
  worktree isolation for dev agents, a multi-judge panel.

## Acceptance criteria

- [x] The wave loop's guard order is verified end to end and matches the sequence listed above, with the
      commit agent after every scout guard and the budget check between the commit and the dispatch.
- [x] No guard reads a tree field produced directly by the scout agent; every one reads a value derived
      in the script from the parsed command output.
- [x] A failing commit escalates without ending the run; a tripped budget floor escalates and ends it.
      Both escalations reach the returned `escalations` array.
- [x] Completion is still tested with `counts.done === counts.total`, the **derived** parse-errors list
      (not a field on the scout result — that shape no longer exists) is still checked
      before that test, and reconciliation is still by index with no `.filter(Boolean)`.
- [x] `orchestrator.md`'s prose and gotchas describe the script that now ships, including the full set of
      terminal conditions and the scout's actual schema.
- [x] Every new `CFG` field has a one-line comment, and the prose defaults match the literals.
- [x] The template guidance and the flightplan `SKILL.md` describe the same trigger and severity the
      linter enforces.
- [x] Both dispatch manifests read their pre-existing version and both marketplace registries are
      unmodified.
- [x] Every plan tree under `docs/` has been linted and each failure is recorded in this tree's
      `tasks/README.md`, with no `done` tree retro-fitted and no checkbox hand-ticked.
- [x] The goal is met: the closing gate runs a real suite, the control path has no interpreting agent,
      commits have a failure channel, and retries carry full history.
- [x] The commit audit trail is judged on **emission**, which is what this tree can prove: the built commit
      instructions carry matched `--phase start` / `--phase end` calls with `--role commit` and the
      interpolated agent label, and the renderer displays such an entry. That real commit workers then write
      those records in a live run is **explicitly outside this gate** — it needs an actual execution run and
      is recorded as a Known gap. Do not mark this criterion on the strength of a live run you did not do,
      and do not perform one to satisfy it.
- [x] The two opt-in capabilities are verified as capabilities: with its switch set, the ladder's final
      rung runs the configured external engine and a tripped floor stops dispatch with a `(budget)`
      escalation; with both switches at their defaults, neither changes any decision the run makes.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/ packages/dispatch/skills/flightplan/scripts/`
      green — the whole regression net for both branches, in one command.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` green on its own,
      which also proves the fenced block still extracts and parses.
- [x] `bun -e "const d=await Bun.file('packages/dispatch/skills/autopilot/references/orchestrator.md').text(); const s=d.indexOf('\`\`\`javascript'); const b=d.indexOf('\n',s)+1; const e=d.indexOf('\n\`\`\`',b); if(s<0||e<0) throw new Error('block missing'); new Function(d.slice(b,e).replace(/^export const meta/m,'const meta'))"`
      exits 0 — the block is syntactically valid JavaScript.
- [x] `for t in docs/*/tasks; do bun packages/dispatch/skills/flightplan/scripts/lint-task.ts "$t"; done`
      run and every reported failure transcribed into this tree's `tasks/README.md`.
- [x] `bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/autopilot-graph-v2/tasks`
      exits 0 — this tree lints clean under its own new rule.
- [x] `bun -e "JSON.parse(await Bun.file('packages/dispatch/.claude-plugin/plugin.json').text()); JSON.parse(await Bun.file('packages/dispatch/.codex-plugin/plugin.json').text())"`
      exits 0, and both `git diff --stat <base SHA>..HEAD -- packages/dispatch/.claude-plugin/plugin.json packages/dispatch/.codex-plugin/plugin.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json CHANGELOG.md`
      and the same command without a revision range (working tree) print nothing. Both halves are needed:
      the range misses an uncommitted bump and the working-tree form misses a committed one.
- [x] `git status --porcelain` reviewed: nothing unexpected left in the working tree.

## Eval rubric

This gate scores the holistic axes, not the per-task ones in `../_context/rubric.md`.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Regressions < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Integration | ×3 | Any of the five orchestrator edits conflict: a guard is out of order, a value is read from the wrong source, the Claude-cap arithmetic dropped the Opus rung, or the budget check sits on the wrong side of the commit. | They compose, but an interaction was asserted rather than walked and confirmed — or one of the five (commit extraction, scout transcription, retry history, vendor rung, budget floor) went unexamined. | The full guard sequence was walked end to end and every interaction listed above was confirmed against the shipped block, covering all five edits including history rendering and cap arithmetic. |
| Meets the PLAN goal | ×3 | One or more of the five requirements does not actually deliver its stated outcome. | All five are present; one delivers only partially. | Each of the five delivers the outcome it was scoped to, demonstrated against real output. |
| Regressions | ×3 | A suite is red, a version or registry moved, or the fenced block no longer extracts. | Everything green, but a check was skipped or taken on trust. | Every suite green, block extraction proven, versions and registries provably untouched, and every existing tree swept. |
| Consistency | ×2 | Prose, templates, or `CFG` comments contradict the shipped behaviour. | Mostly aligned; a stale claim survives somewhere. | Code, prose, gotchas, templates, and `CFG` comments all describe the same system. |

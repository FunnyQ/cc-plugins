# WIRING-01: orchestrator start events

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Blocks**: wiring/03
> **Status**: done

## Goal

Every autopilot agent that does real work brackets itself in the flightlog — a start marker before it
begins and a matching end marker when it finishes — so a live viewer can see the fleet in flight rather
than only what has already landed.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — add a start-log instruction
  to each working agent's prompt.

## Implementation notes

This is the highest-risk edit in the whole plan. This file is the 491-line script that drives every
autopilot run, and a mistake here breaks flights that have nothing to do with flightdeck. Change only
what this task specifies. Do not reformat, do not reorder, do not "improve" adjacent prompt text.

### Every start needs a matching end

A start with no end stays in flight forever — the fleet model has no staleness ceiling by design. So
each agent below must emit **both** markers, and the two must carry the identical `--agent` label,
`--role`, `--task`, and `--attempt`, because that is what the viewer pairs on.

Three of these agents already log a completion note today. For those, **add `--phase end` to the
existing line**; do not add a second log call. The other four have no completion note at all, so they
need one written.

| Agent | Role | Start line | End line |
|---|---|---|---|
| the Claude dev agent | `dev` | add | already exists — add the flag |
| the external dev driver | `dev` | add | already exists — add the flag |
| the final-review fixer | `fix` | add | already exists as a `final-review` note — change its role to `fix` and add the flag |
| the independent verifier | `verify` | add | add |
| the rubric judge | `judge` | add | add |
| each final-review lens, external and Claude alike | `review` | add | add |
| the per-wave scout | `scout` | add | add |

Do **not** touch the done-transition agent, the blocked-transition agent, or the post-loop commit agent.
They are single-command agents that finish in seconds, so a marker pair for them would be noise.

The scout has no task ref. Log it with the literal task value `scout` so the entry still parses and
groups; the flightlog's task field is a free string.

### The lines to insert

The start line is step 1 of each prompt, before any other work, so the marker lands even if the agent
later fails:

```
First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role <role> --attempt ${attempt} --agent "<your label>" --phase start
Then proceed.
```

The end line is the last step, after the work and before returning:

```
Finally, record completion: bun ${S}/flightlog.ts log ${CFG.logFile} --task ${ref} --role <role> --attempt ${attempt} --agent "<your label>" --phase end --message "<one-line outcome>"
```

Substitute the real role per the table, and use the **same** value in both lines of a pair. For the
scout, use the literal `scout` in place of `${ref}` and omit `--attempt` from both lines.

Tell each agent explicitly to reuse the identical label in both calls. An agent that invents a different
label on its second call produces an orphan start that renders as permanently in flight.

### The path trap — read this before editing

`${CFG.logFile}` and `${S}` are **absolute paths baked into the config block**, and every start line
must use them exactly as the existing end-of-task log lines do. This file already documents why: an
agent may change directory into the tasks tree, and a relative log path then resolves against that
agent's own working directory, writing the trail into a nested directory and splitting the audit trail
in two. The existing dev and final-review log lines are the correct pattern to copy verbatim.

Do not introduce a new variable, do not rebuild the path, and do not use a shorthand home path.

### Labels

The viewer pairs a start with its end on the `--agent` value, so **both lines of a pair must pass the
identical expression**. Two forms are in play, and mixing them breaks the pair:

- **The external dev driver** already logs its completion with the literal `${engine.label}-delegate`.
  Use that same expression in its start line. Do **not** convert either line to the placeholder form.
- **Every other instrumented agent** uses the `<your label>` placeholder the existing log lines use, so
  the agent reports the label the orchestrator assigned it.

Those labels follow the taxonomy in the data model context file listed in Required reading. An agent that
invents a different label still renders, as an unknown role, so a stray label degrades the view rather
than breaking it — but an unmatched pair leaves a row in flight forever, which is worse.

### Exactly which edits are permitted

Do not change the workflow script itself: no new agent, no changed label, no changed model, no changed
schema, no reordered stage. Every edit lands inside a prompt string, and only these three kinds:

1. **Added** start lines — one per working agent prompt.
2. **Added** end lines — for the four agents that had no completion note.
3. **Modified** existing completion lines — for the three that already had one: append `--phase end`,
   and on the fixer's line only, change its role value from `final-review` to `fix`. Leave every existing
   `--agent` expression exactly as it is, including the external driver's `${engine.label}-delegate`.

Nothing else in the file changes. "Additions only" would be wrong here — three lines are deliberately
modified — so review the diff against this list rather than against a blanket rule.

## Acceptance criteria

- [x] Each of the seven working agent prompts carries a start-log instruction as its first step.
- [x] Each of the same seven carries a matching end-log instruction as its last step.
- [x] The three agents that already logged a completion note gained `--phase end` on that existing line
      rather than a duplicate call.
- [x] Both lines of every pair pass the same role, task, attempt, and `--agent` expression — the
      placeholder for six agents, and the existing delegate expression for the external dev driver.
- [x] Each prompt tells the agent to reuse the identical label in both calls.
- [x] The done-transition, blocked-transition, and post-loop commit prompts are unchanged.
- [x] Every added line uses the baked absolute config values for the scripts directory and the log file,
      matching the existing log lines exactly.
- [x] The scout's line uses the literal task value `scout` and omits the attempt flag.
- [x] Each added line passes the role value from the table above.
- [x] No agent label, model, schema, phase, or stage ordering is changed.
- [x] Every hunk in the diff is one of the three permitted kinds: an added start line, an added end line,
      or an existing completion line gaining `--phase end` (plus the fixer's role change).
- [x] The workflow script's control flow is byte-identical: same agents, labels, models, schemas, and
      stage order.

## Verification

- [x] Confirm the count of each marker:
      `rg -c -- "--phase start" packages/dispatch/skills/autopilot/references/orchestrator.md` → `7`, and
      `rg -c -- "--phase end" packages/dispatch/skills/autopilot/references/orchestrator.md` → `7`.
      Unequal counts mean some agent will render as permanently in flight.
- [x] Confirm every added line uses the baked config values and none uses a relative or home-shorthand
      path: `rg -n -- "--phase start" packages/dispatch/skills/autopilot/references/orchestrator.md`
      — every hit contains both the scripts-dir variable and the log-file variable.
- [x] Confirm no relative log path was introduced anywhere. Ripgrep's default engine has no
      negative lookahead, so use two stages rather than one pattern: list every log invocation, then
      subtract the ones that correctly interpolate a variable.
      `rg -n "flightlog\.ts log" packages/dispatch/skills/autopilot/references/orchestrator.md | rg -v 'flightlog\.ts log \$\{'`
      returns nothing.
- [x] Review the diff and confirm every changed hunk matches one of the three permitted kinds:
      `git diff -- packages/dispatch/skills/autopilot/references/orchestrator.md`
      Three hunks modify an existing line; the rest are pure additions. Anything else is out of scope.
- [x] Confirm the excluded agents were not touched: the diff contains no change to the done-transition,
      blocked-transition, or commit prompts.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A relative log path is introduced, or control flow changed | Starts added without matching ends, or a pair's role and label disagree | Seven matched pairs, correct roles, existing completion lines extended not duplicated, baked absolute paths, excluded agents untouched |
| Test coverage | ×2 | No checks run | Counted the additions only | Every Verification command run, including the relative-path and diff-scope checks |
| Interface & readability | ×1 | Added lines break the surrounding prompt's voice or numbering | Consistent but placed mid-prompt | Uniform wording, start first and end last in every prompt, matching the file's existing instruction style |
| Assumptions & docs | ×1 | No note on why paths must stay baked | Mentions it without the reason | The reason is carried where an editor will see it: a relative path splits the trail across agent directories |

## Out of scope

- Launching flightdeck from the skill. Separate task in this bucket.
- Actually flying a plan to confirm the events land. That is the fixture-flight task in this bucket;
  this one is a text edit verified statically.
- Logging start events for the trivial transition agents. Excluded above with the reason.
- Any change to what agents return to the orchestrator. Their schemas and return contracts stay as they are.

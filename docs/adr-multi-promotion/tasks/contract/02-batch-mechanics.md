# CONTRACT-02: Batch mechanics and failed-batch recovery

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Status**: done

## Goal

`packages/chronicle/skills/adr/SKILL.md` tells the main agent how to run a batch: how it
pre-allocates record numbers, how many groups one run carries, what a deferred group does
to the archive plan, and how Q recovers a batch that failed validation.

## Files to create / modify

- `packages/chronicle/skills/adr/SKILL.md` (modify) — number pre-allocation, the 12-group
  cap, the verdicts-to-`newAdrs` mapping, the deferred-group re-plan, the Constraint 7
  rewrite, a new recovery section, and every remaining singular payload reference.

## Implementation notes

This task edits one file and no other. A sibling change already converted the two gate
response blocks in that same file: gate 1 gained the `group` field, and gate 2 gained the
`verdicts` array. Do not redo those blocks.

Write every acceptance criterion as an end state, not as a diff. If a sentence you were
going to fix already reads correctly, leave it and move on.

Follow the STE-lite writing rules in `../_context/shared.md`. Keep every backticked token
verbatim. Do not edit the YAML frontmatter.

### 1. Number pre-allocation, in the `triage` numbered steps

The `## `triage` — process the inbox` section is a numbered list. Step 4 already covers
the archive target and the gate-1 override re-plan. Add a new step after it that builds
the `draft` payload.

The main agent folds the confirmed `promote` rows into `groups`. Rows that share a `group`
value become one entry. A `promote` row with no `group` becomes its own single-member
entry. The order is the order the `promote` rows appear in Q's confirmed response.

The main agent then assigns each entry its `groupId` by position: `g1`, `g2`, `g3`, and so
on. Q's `group` value only clusters rows, and it is never carried through as the
`groupId`. State the failure this prevents: a Q-invented label would collide with a
single-member group that Q never labelled, and two entries would share one `groupId`.

The main agent assigns each entry a record number before it spawns `draft`. Group `i`
takes `adrIndex.nextNumber + i`, with `i` zero-based. State that the Codifier never counts
and never reads `adrIndex.nextNumber` for itself. Name the failure this prevents: two
groups drafted against one `nextNumber` collide on one path, and the Barrowkeeper refuses
the whole batch.

Inline this payload:

```json
{
  "groups": [
    { "groupId": "g1", "entryIds": ["id-1", "id-2"], "adrNumber": 27 },
    { "groupId": "g2", "entryIds": ["id-3"], "adrNumber": 28 }
  ]
}
```

### 2. The 12-group cap, enforced at gate 1

State the cap: at most 12 groups per run.

Enforcement belongs in `triage` step 3, where gate 1 is presented, not in the new step you
added for the `draft` payload. Warn before the step: once gate 1 is confirmed, the
disposition set is complete and the archive plan already covers every candidate, so
dropping groups after confirmation would archive an unrecorded decision to `done`.

Write the procedure. The group count is unknown until Q replies, because `group` is Q's
field. So the cap is checked on the reply, not on the ledger:

1. Present the gate-1 ledger. If the reckoner produced more than 12 `promote` candidates,
   say so, and say that grouping may still bring the run under the cap.
2. Fold Q's reply into groups.
3. If the folded count exceeds 12, re-surface before treating the reply as confirmed. Ask
   Q to group further, or to disposition the excess as `watch` in this run.

A `watch` candidate archives to the watched bucket and re-queues on the next `triage` run,
so nothing is lost.

State that the main agent never picks the excess itself. Which decisions wait is Q's call.
Add the cap check to the existing re-run rule, so it re-runs after any correction Q makes,
exactly as the consistency check does.

State the cap's origin honestly. 12 is a judgment call from one measured run of 26 groups,
not a measured ceiling. Q reports the limit on that run was review fatigue, not a failure.
Do not present 12 as a technical limit, and do not invent a symptom it prevents.

### 3. Build the `commit` payload from the verdicts

Add this step immediately after gate 2. Without it, nothing tells the main agent how to
turn `verdicts` into `newAdrs`, and the main `triage` path cannot reach `commit` at all.

The main agent keeps every `approve` verdict, in the order the drafts were proposed, and
drops every `drop` verdict. For each kept verdict it builds one `newAdrs` entry:

- `path` is the verdict's `proposedPath`.
- `content` is the verdict's own `draftText` when it carries one, otherwise the Codifier's
  `draftText` for that draft.

State that a verdict's `draftText` is Q's edit and always wins over the Codifier's text.

If every verdict was `drop`, the run promoted nothing. Omit `newAdrs` entirely, and never
send `[]`.

### 4. Deferred-group re-plan, before `commit`

A gate-2 `drop` defers a group. Its candidates were `promote` at gate 1, so the Reckoner
already assigned their source sessions `target: "done"`. Warn before the step: if nothing
corrects that, the dropped decision archives to `done` unrecorded and leaves triage
forever.

Add the correction as its own step after gate 2 and before `commit`. The main agent:

1. treats every dropped group's candidates as `watch`,
2. re-folds the `watch`-wins rule across every session those candidates touch,
3. keeps each row's original `from` untouched,
4. serializes the corrected `assignments`,
5. re-runs `bun <plannerPath> --assignments <corrected assignments JSON>`,
6. passes the fresh `planPath` into `commit`.

Two details carry a reason, so state both. Re-fold across every session those candidates
touch, not only the dropped ones, because another candidate from the same session may
already be `watch`. Never hand-edit `moves[]` or any other field of the serialized plan,
because a plan's `target`, `to`, and `from` fields are derived together and patching one
desyncs the rest.

This is the same recipe the gate-1 override already uses. Present gate 2 as a second
trigger for it rather than as a second recipe. The existing gate-1 prose says
`plannerPath` is retained from the collect-phase inputs. Extend that sentence so
`plannerPath` is retained through gate 2 as well.

### 5. Constraint 7 rewrite

The `## Constraints` list currently carries this item 7:

> 7. **`draft` and `commit` write exactly one ADR per invocation.** The codifier
>    returns one `draftText`/`proposedPath` pair, and the barrowkeeper writes one
>    `newAdr`. A triage with several `promote` candidates currently needs one
>    `draft`/gate-2/`commit` cycle per candidate — there is no batched or merged
>    multi-ADR path yet. Do not invent one inline; this is tracked as follow-up
>    work, not a gap to paper over with an ad hoc multi-record payload.

Replace the whole item. The replacement states the batch rule:

- One `draft`, gate-2, and `commit` cycle promotes up to 12 records.
- The Codifier returns `drafts`, one entry per input group.
- The Barrowkeeper takes `newAdrs`, and writes every entry in one batch.
- `supersede <adr-id>` still replaces one record per run.
- `metadataUpdate` stays a single object and is never batched.

Keep it as item 7 in the same list. Do not renumber the other constraints.

### 6. New recovery section

Add one new top-level section titled `## Recovering a failed batch`. Put it immediately
after the `## Constraints` section and immediately before `## Edge Cases`.

The section describes the state after the Barrowkeeper reports `validation-error`:

- The written records are on disk, uncommitted.
- The session logs are untouched in `.cockpit/`.
- The plan file survives at `/tmp/chronicle/adr/`.

The recovery is: Q fixes the offending record by hand, then re-runs `triage`. State that
there is no archive-only entry point, and that this change adds none.

State the three reasons the re-run self-heals, because a reader who cannot see them will
reach for a rollback that does not exist:

1. `adrIndex.nextNumber` has advanced past the written records, so no path collides.
2. The Reckoner skips clusters that match an existing ADR, so the same decisions
   disposition to `skip`.
3. The run then takes the no-promotion branch, and the archive plan finally applies.

### 7. The no-promotion branch

The `### No-promotion branch` subsection currently ends with `pass no `newAdr` and no
`metadataUpdate`.` Change the field name to `newAdrs`. Change nothing else about the
branch. It still skips `draft` and gate 2, and it still invokes `commit` with only the
approved plan.

### 8. Every remaining singular payload reference

`newAdr` and `newAdrs` are distinct field names, and the Lorekeeper refuses `newAdr` as an
unknown field. So a stale mention in this file is a live instruction to send a payload the
Lorekeeper rejects. Convert the rest of the file:

- The `## Topology` intro paragraph says the main agent passes "the confirmed draft, target
  path, metadata update, and archive plan" into `commit`. Restate it in terms of the
  confirmed drafts, `newAdrs`, the optional `metadataUpdate`, and the archive plan.
- The `## `promote <candidate-or-topic>` — direct promotion` section describes one draft
  and one path. It is a single-record escape hatch and stays one record. State that it
  sends a one-entry `groups` payload into `draft`, and a one-entry `newAdrs` into `commit`,
  so it rides the same contract as `triage`.
- The `## `supersede <adr-id>` — replace an accepted record` section stays one record per
  run. Add that the replacement travels as a one-entry `newAdrs` beside the single
  `metadataUpdate`.

Do not batch `promote` or `supersede`. Both keep exactly one record per run. Only the
field names change.

## Acceptance criteria

- [x] `SKILL.md` documents that the main agent folds confirmed `promote` rows into
      `groups`, and assigns each group `adrIndex.nextNumber + i` with `i` zero-based.
- [x] `SKILL.md` inlines the `groups` payload with `groupId`, `entryIds`, and `adrNumber`.
- [x] `SKILL.md` states the 12-group cap, checks it on Q's folded reply before gate-1
      confirmation, tells the main agent to re-surface an over-cap reply rather than pick
      the excess itself, and states that 12 is a judgment call from one 26-group run.
- [x] `SKILL.md` states that the main agent assigns each group a positional `groupId`
      (`g1`, `g2`, `g3`), and that Q never supplies one.
- [x] `SKILL.md` states that the Codifier never counts and never reads
      `adrIndex.nextNumber` for itself.
- [x] `SKILL.md` tells the main agent to build `newAdrs` from the `approve` verdicts, to map
      `proposedPath` to `path` and `draftText` to `content`, to prefer a verdict's own
      `draftText`, and to omit `newAdrs` when every verdict was `drop`.
- [x] `SKILL.md` documents the gate-2 `drop` re-plan, including the re-fold across every
      session those candidates touch, the untouched `from`, the
      `bun <plannerPath> --assignments` re-run, and the fresh `planPath` into `commit`.
- [x] `SKILL.md` states that `plannerPath` is retained through gate 2.
- [x] `SKILL.md` still forbids hand-editing `moves[]`.
- [x] Constraint 7 no longer says that `draft` and `commit` write exactly one ADR per
      invocation, and now states the up-to-12 batch rule, `drafts`, and `newAdrs`.
- [x] Constraint 7 states that `supersede <adr-id>` and `metadataUpdate` stay singular.
- [x] A section titled `Recovering a failed batch` exists between `## Constraints` and
      `## Edge Cases`, and it names `/tmp/chronicle/adr/`, `.cockpit/`, and the three
      self-heal reasons.
- [x] The recovery section states that there is no archive-only entry point.
- [x] The no-promotion branch says `newAdrs`, and its behavior is otherwise unchanged.
- [x] No occurrence of the bare field name `newAdr` remains anywhere in `SKILL.md`.
- [x] The `promote` and `supersede` sections each name a one-entry `newAdrs`, and neither
      is batched.

## Verification

- [x] Run `grep -n "adrNumber" packages/chronicle/skills/adr/SKILL.md` and confirm the
      `groups` payload and the pre-allocation rule appear.
- [x] Run `grep -n "nextNumber" packages/chronicle/skills/adr/SKILL.md` and confirm both
      the `+ i` allocation rule and the self-heal reason appear.
- [x] Run `grep -n "12 groups" packages/chronicle/skills/adr/SKILL.md` and confirm the cap
      appears with its rationale nearby, inside the gate-1 step rather than the `draft`
      payload step.
- [x] Run `grep -n "groupId" packages/chronicle/skills/adr/SKILL.md` and confirm the
      positional assignment rule appears.
- [x] Run `grep -n "newAdr\b" packages/chronicle/skills/adr/SKILL.md` and confirm it
      returns nothing.
- [x] Run `grep -n "newAdrs" packages/chronicle/skills/adr/SKILL.md` and confirm the
      no-promotion branch, Constraint 7, and both single-record modes appear.
- [x] Run `grep -n "exactly one ADR per invocation" packages/chronicle/skills/adr/SKILL.md`
      and confirm it returns nothing.
- [x] Run `grep -n "Recovering a failed batch" packages/chronicle/skills/adr/SKILL.md` and
      confirm exactly one heading matches.
- [x] Run `grep -n "tmp/chronicle/adr" packages/chronicle/skills/adr/SKILL.md` and confirm
      the recovery section names the surviving plan file.
- [x] Run `grep -n "plannerPath" packages/chronicle/skills/adr/SKILL.md` and confirm the
      gate-2 re-plan and the retention rule appear.
- [x] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it passes. No
      script changes here, so a failure means an edit landed outside this file.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name drifts from the frozen contract, or `newAdr` survives anywhere in the file | The `groups` and `newAdrs` shapes are right, but the `+ i` rule, the 12-group cap, or the gate-2 re-plan is missing or softened | Every shape and rule matches the frozen contract, and each rule names the failure it prevents |
| Completeness | ×2 | Constraint 7 or the recovery section is absent | The new content landed, but a stale singular payload reference still sits in the Topology intro or in a single-record mode | All eight items landed, and no singular payload reference remains |
| Readability | ×1 | The new prose breaks the file's numbered-step structure, or renumbers the constraints | Correct content, but sentences run past 25 words, em dashes stack, or a new term appears for `group` or `batch` | The new steps read as one voice with the file, warnings sit before their step, and every term matches the frozen contract |
| Assumptions and docs | ×1 | The 12-group cap is presented as a measured technical limit | The cap, the re-fold scope, or the `moves[]` prohibition is stated with no reason | Each non-obvious rule carries its reason, and the cap is stated as a judgment call from one 26-group run |

## Out of scope

- The gate-1 `group` field, the gate-1 fallback JSON schema, the consistency check, and the
  gate-2 `verdicts` presentation — Deferred. A sibling change owns those two response
  blocks in this same file, and it lands first.
- `packages/chronicle/agents/lorekeeper.md`, `packages/chronicle/agents/codifier.md`, and
  `packages/chronicle/agents/barrowkeeper.md` — Deferred. Each agent file has its own
  owner. This task changes what the skill file tells the main agent, nothing else.
- Any file under `packages/chronicle/skills/adr/scripts/` — Deferred. Reason: this change
  is instruction text only, and the scripts already support every rule stated here.
- Renumbering after a dropped draft — Deferred. Reason: `adr-index.ts` never reuses a
  number gap, because reusing a number would make an id ambiguous across git history.

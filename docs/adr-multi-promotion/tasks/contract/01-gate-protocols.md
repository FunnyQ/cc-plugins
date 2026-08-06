# CONTRACT-01: Gate protocols for a batch of drafts

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: contract/02
> **Status**: todo

## Goal

`packages/chronicle/skills/adr/SKILL.md` describes both human gates in terms of a batch:
gate 1 groups candidates into records, and gate 2 returns one verdict per proposed draft.

## Files to create / modify

- `packages/chronicle/skills/adr/SKILL.md` (modify) — the gate-1 response schema and its
  prose, the gate-1 consistency check, the gate-2 presentation and its response schema,
  and both gate fallback branches.

## Implementation notes

This task owns the **gate protocol** half of `SKILL.md`. Five edits, listed below with the
exact current wording to find. Every JSON shape you need is inlined here. Do not invent a
field, and do not soften a rule.

Follow the STE-lite writing rules from `../_context/shared.md`. Keep every fenced block's
formatting style. Do not add, remove, or re-level a heading in `SKILL.md`.

### Edit 1 — the gate-1 response schema

Find this block (near the top of the file, inside the `## Topology` section, just after
the sentence "Require the complete set, not only the changed rows"):

```json
{
  "dispositions": [
    { "entryIds": ["id-1", "id-2"], "decision": "promote" },
    { "entryIds": ["id-3"], "decision": "skip" }
  ],
  "conflictResolutions": [
    { "entryIds": ["id-4", "id-5"], "resolution": "skip" }
  ],
  "notes": ""
}
```

Replace it with this block, verbatim:

```json
{
  "dispositions": [
    { "entryIds": ["id-1"], "decision": "promote", "group": "g1" },
    { "entryIds": ["id-2"], "decision": "promote", "group": "g1" },
    { "entryIds": ["id-3"], "decision": "promote" },
    { "entryIds": ["id-4"], "decision": "skip" }
  ],
  "conflictResolutions": [
    { "entryIds": ["id-5", "id-6"], "resolution": "skip" }
  ]
}
```

Two changes: disposition rows gain an optional `group`, and `notes` is gone.

### Edit 2 — the prose under the gate-1 schema

Find this paragraph, which follows that schema:

> `entryIds` must match a candidate's `entryIds` from the reckoner output
> exactly — it is the candidate's identity, since candidates carry no separate
> id field. `conflictResolutions` covers every entry in the reckoner's
> `conflicts`. This schema has no field for merging two candidates into one ADR;
> multi-candidate promotion is not yet wired through `draft` and `commit` (see
> the codifier/barrowkeeper single-record limit below). Until that lands, note a
> requested merge in free text under `notes` and apply it by hand — do not
> invent a `mergeGroup` field the rest of the pipeline cannot consume.

Keep the first two sentences, about `entryIds` and `conflictResolutions`. Delete every
sentence from "This schema has no field" onward. Replace them with the group rule:

- `group` is optional.
- Rows that share a `group` value become one ADR.
- A `promote` row with no `group` is its own single-member group.
- A `group` value is an opaque clustering label. Q chooses it. The main agent uses it only
  to decide which rows share a record, and then assigns each group its own positional
  `groupId` (`g1`, `g2`, `g3`). Say that Q never supplies a `groupId`. A carried-through
  label would collide with a single-member group that Q never labelled.

Do not reintroduce `notes`, and do not name a `mergeGroup` field. `group` is the only
spelling.

### Edit 3 — the gate-1 consistency check

Find this bullet under `## `triage` — process the inbox`, step 3:

> - **A merge with a declined half.** If Q's response folds two candidates
>   into one ADR, both must still be `promote`. If Q declined one, do not
>   silently merge the declined content in and do not silently drop the
>   merge — re-surface it: ask whether the surviving candidate stands alone
>   or the merge itself is off.

Replace it with the mechanical form. The check no longer reads free text, so it no longer
guesses:

- **A group with a non-`promote` row.** A `group` that holds any non-`promote` row is a
  contradiction. Re-surface it to Q. Ask whether the remaining rows still form one record,
  or whether the group itself is off. Never guess which half wins.

Keep both of these unchanged:

- The **A watch item that contradicts its own conflict** bullet, in full.
- The closing rule: "Re-run this check after any correction Q makes in response to a
  flagged contradiction — a fix to one contradiction can introduce another."

Also update the sentence that introduces the bullets. It currently reads "since a merge or
a conflict resolution is a gate-1-only decision the reckoner never produces or validates".
Replace "a merge" with "a group", because `merge` is no longer a term this file uses.

### Edit 4 — gate-2 presentation and the verdicts schema

Three places state gate 2 in the singular. Convert each.

**4a.** In `## Topology`, find:

> At gate 2, present the
> complete draft and target path, log `needs_your_call`, then use `cockpit wait`
> again.

Present every draft and its target path, not one draft.

**4b.** At the end of the same section, find:

> Gate 2's response follows
> the same shape: Q's reply is either an unqualified approval, or an edited
> `draftText`/`proposedPath` pair Q pastes back for the one proposed ADR.

Replace that sentence with the gate-2 response schema, inlined as a fenced JSON block in
the same style as the gate-1 schema:

```json
{
  "verdicts": [
    { "proposedPath": "docs/adr/0027-....md", "verdict": "approve" },
    { "proposedPath": "docs/adr/0028-....md", "verdict": "drop" },
    { "proposedPath": "docs/adr/0029-....md", "verdict": "approve", "draftText": "..." }
  ]
}
```

State these rules with it:

- One entry per proposed draft. `verdict` is `approve` or `drop`.
- An optional `draftText` on an `approve` replaces the codifier's text for that record.
- Require the complete set. A partial reply is ambiguous, so re-surface it to Q.
- A `drop` leaves a number gap. Nothing is renumbered. `adr-index.ts` never reuses a gap,
  because reusing a number would make an id ambiguous across git history.

**4c.** In `## `promote <candidate-or-topic>` — direct promotion`, find:

> Present the complete draft and proposed path at gate 2
> before writing.

That mode still produces one record. Keep it single-record. Add one sentence only: its
gate-2 reply uses the same `verdicts` shape, with one entry. Two gate-2 protocols in one
file would contradict each other.

### Edit 5 — both fallback branches render the batch

Keep both branches. Neither is removed, and neither becomes the other's fallback.

**5a. The Claude Code branch.** Find:

> - **On Claude Code**, build a custom interactive HTML review page with the
>   `Artifact` tool: gate 1 is a disposition ledger (one row per candidate, its
>   disposition and reason, and controls to confirm or override it) with a
>   live-updating decision summary and a "copy for chat" button; gate 2 is the
>   full draft text per proposed ADR, collapsible per record, for a verbatim
>   read-through.

The gate-1 ledger gains a `group` column, so Q can label rows into one record from the
page. The gate-2 page shows every proposed draft, collapsible per record, with an
approve-or-drop control per record.

**5b. The Codex branch.** Find:

> - **On Codex**, which has no `Artifact` tool, print the same content as
>   structured markdown directly in the transcript — the candidate ledger for
>   gate 1, the full draft text for gate 2 — and ask Q to reply in the same
>   terminal with the response block below.

The printed gate-1 ledger carries the same `group` column. The printed gate-2 content
carries every draft, not one. Keep the sentence that says this is not `AskUserQuestion`,
and keep the plaintext round-trip wording.

Both branches produce the same two plaintext response shapes: the gate-1 shape from Edit 1
and the gate-2 shape from Edit 4b.

### One accuracy note

The sentence "Treat the parsed response as the gate response exactly as `cockpit wait`
would return it, including the consistency check above" points at a check that lives
*below* it, under `triage` step 3. Fix the direction word while you are in that paragraph.
Do not move either block.

## Acceptance criteria

- [ ] `grep -n '"group"' packages/chronicle/skills/adr/SKILL.md` prints the gate-1 schema
      line carrying `"group": "g1"`.
- [ ] `grep -n '"notes"' packages/chronicle/skills/adr/SKILL.md` prints nothing.
- [ ] `grep -n 'mergeGroup' packages/chronicle/skills/adr/SKILL.md` prints nothing.
- [ ] `grep -n 'verdicts' packages/chronicle/skills/adr/SKILL.md` prints the gate-2 schema.
- [ ] `grep -n 'one proposed ADR' packages/chronicle/skills/adr/SKILL.md` prints nothing.
- [ ] `grep -n 'multi-candidate promotion is not yet wired' packages/chronicle/skills/adr/SKILL.md`
      prints nothing.
- [ ] `grep -n 'On Claude Code\|On Codex' packages/chronicle/skills/adr/SKILL.md` prints
      both fallback branches.
- [ ] The gate-1 consistency check names a `group` holding a non-`promote` row, and the
      **A watch item that contradicts its own conflict** bullet is still present in full.
- [ ] The `promote <candidate-or-topic>` section still describes one record, and names the
      `verdicts` shape with one entry.

## Verification

- [ ] Run `grep -c 'group' packages/chronicle/skills/adr/SKILL.md` and confirm the count is
      at least 4: the schema field, the group rule, the consistency-check bullet, and the
      ledger column.
- [ ] Run `grep -n 'draftText\|proposedPath' packages/chronicle/skills/adr/SKILL.md` and
      confirm every hit sits inside the `verdicts` schema or the `promote` mode sentence.
      No hit describes a bare top-level `draftText`/`proposedPath` pair.
- [ ] Read the `## Topology` section end to end. Confirm gate 1 and gate 2 both read as a
      batch, and that no sentence still says one draft.
- [ ] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it passes. This
      task changes no script, so a failure means an edit landed outside
      `packages/chronicle/skills/adr/SKILL.md`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted
> average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A schema field is spelled differently from the frozen contract, for example `mergeGroup` or `notes`, or the `verdicts` block is absent. | Both schemas match, but a rule is missing: the complete-set requirement, the drop-leaves-a-gap rule, or the single-member-group rule. | Both schemas match character for character, and every listed rule is stated with the failure it prevents. |
| Completeness | ×2 | One of the five edits is untouched. | Gate 1 converted while gate 2 still reads singular, or one fallback branch converted and the other left behind. | All five edits landed, and both fallback branches render the batch at gate 2 and the `group` column at gate 1. |
| Readability | ×1 | Instructions run past 25 words with stacked em dashes, or a heading was added. | Correct content, but the new prose uses a second term for a group, or breaks a backticked span across a line wrap. | New prose matches the file's voice, one term per thing, every instruction under 20 words. |
| Assumptions and docs | ×1 | A new gate behavior appears that the frozen contract does not define. | Rules stated with no reason, so a later editor cannot tell which are load-bearing. | Each rule names its failure mode, for example why a partial gate-2 reply is re-surfaced. |

## Out of scope

- ADR number pre-allocation, the 12-group cap, the deferred-group archive re-plan,
  Constraint 7's rewrite, and the batch recovery section — Deferred. Another task in this
  bucket owns the batch-mechanics half of the same file, and it runs after this one.
- Renaming the `newAdr` commit payload to `newAdrs`, in the no-promotion branch or anywhere
  else in this file — Deferred. Reason: the batch-mechanics task sweeps that one rename
  across every remaining mention in one pass, so splitting it would leave half the file
  stale between the two runs.
- `packages/chronicle/agents/codifier.md`, `packages/chronicle/agents/lorekeeper.md`, and
  `packages/chronicle/agents/barrowkeeper.md` — Deferred. Each has its own task. This task
  edits one file only.
- Any Codex TOML mirror under `packages/chronicle/agents-codex/` — Deferred. The mirrors
  compress their Markdown source, so they land after it.
- Batching `supersede <adr-id>` or `metadataUpdate` — Deferred. Both stay single-record,
  by decision.

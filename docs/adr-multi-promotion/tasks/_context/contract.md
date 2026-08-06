# The frozen batch contract

> This is the single source of truth for every payload shape in the ADR multi-promotion
> change. Every task file agrees to it. If a task file and this file disagree, this file
> wins, and the disagreement is a defect in the task file.

## Vocabulary

Use these terms, and only these terms, in every edited file.

- **group** — one or more gate-1 `promote` rows that become one ADR. A `promote` row with
  no `group` field is its own single-member group.
- **groupId** — the group's identifier. The main agent assigns it by position, as `g1`,
  `g2`, `g3`, and so on, in group order. Q's gate-1 `group` value only clusters rows; it is
  never carried through as the `groupId`. Positional assignment is what keeps a
  Q-invented label from colliding with a single-member group that had no label at all.
- **adrNumber** — the record number the main agent pre-allocated for a group.
- **draft** — one `{ groupId, draftText, proposedPath }` object.
- **batch** — every draft of one `triage` run, moving through gate 2 and `commit` together.

## Gate-1 response

Q returns this shape at gate 1, from the `cockpit wait` bridge or from either fallback
surface.

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

Rules:

- `entryIds` must match a candidate's `entryIds` from the reckoner output exactly. It is
  the candidate's identity, because candidates carry no separate id field.
- `group` is optional. Rows that share a `group` value become one ADR.
- A `promote` row with no `group` is its own single-member group.
- `notes` is removed. Do not reintroduce a free-text merge field.
- `conflictResolutions` covers every entry in the reckoner's `conflicts`.
- Require the complete set of dispositions, not only the changed rows. A partial reply is
  ambiguous about which candidates it leaves untouched.

### Consistency check

The check is mechanical. A `group` that holds any non-`promote` row is a contradiction.
The main agent re-surfaces the contradiction to Q instead of guessing which half wins.
The watch-versus-conflict check is unchanged: if a candidate is `watch` because of an
entry in `conflicts`, and Q also resolves that same conflict, the disposition and the
resolution must agree.

Re-run the whole check after any correction Q makes. A fix to one contradiction can
introduce another.

## Main agent to `draft`

```json
{
  "groups": [
    { "groupId": "g1", "entryIds": ["id-1", "id-2"], "adrNumber": 27 },
    { "groupId": "g2", "entryIds": ["id-3"], "adrNumber": 28 }
  ]
}
```

Rules:

- The main agent builds `groups` from the confirmed gate-1 dispositions, in the order the
  `promote` rows appear.
- `groupId` is `g1` for the first group, `g2` for the second, and so on. The main agent
  assigns it. Q never supplies a `groupId`.
- `adrNumber` is `adrIndex.nextNumber + i`, where `i` is the zero-based index of the group
  in `groups`.
- The codifier never counts and never reads `adrIndex.nextNumber` for itself.
- At most 12 groups per run.

### Enforcing the cap at gate 1

Enforce the cap **before** Q confirms, never after. Once gate 1 is confirmed, the
disposition set is complete and the archive plan already covers every candidate, so
dropping groups afterwards would archive an unrecorded decision to `done`.

The group count is unknown until Q replies, because `group` is Q's field. So the cap is
checked on the reply, not on the ledger:

1. Present the gate-1 ledger. If the reckoner produced more than 12 `promote` candidates,
   say so, and say that grouping may still bring the run under the cap.
2. Fold Q's reply into groups.
3. If the folded count exceeds 12, re-surface before treating the reply as confirmed. Ask
   Q to group further, or to disposition the excess as `watch` in this run.

A `watch` candidate archives to the watched bucket and re-queues on the next `triage` run,
so nothing is lost.

The main agent never picks the excess itself. Which decisions wait is Q's call. Re-run the
cap check after any correction, the same way the consistency check re-runs.

## Codifier output

```json
{
  "drafts": [
    { "groupId": "g1", "draftText": "...", "proposedPath": "docs/adr/0027-....md" }
  ]
}
```

Rules:

- One entry per input group, in the same order, with the same `groupId`.
- `draftText` is the complete record body, never a description of it.
- `draftText`'s H1 must read `# ADR-0027:` and match the group's `adrNumber`.
  `proposedPath` must carry the same zero-padded number. The `adr-validate.ts` rule
  `id-mismatch` compares the filename number to the H1 number, so a drift fails
  validation after the write.
- `proposedPath` is `docs/adr/<NNNN>-<kebab-title>.md`, with `<NNNN>` the four-digit
  zero-padded `adrNumber`.

## Gate-2 response

```json
{
  "verdicts": [
    { "proposedPath": "docs/adr/0027-....md", "verdict": "approve" },
    { "proposedPath": "docs/adr/0028-....md", "verdict": "drop" },
    { "proposedPath": "docs/adr/0029-....md", "verdict": "approve", "draftText": "..." }
  ]
}
```

Rules:

- One entry per proposed draft. `verdict` is `approve` or `drop`.
- An optional `draftText` on an `approve` replaces the codifier's text for that record.
- Require the complete set. A partial reply is ambiguous, so the main agent re-surfaces it.
- A `drop` leaves a number gap. Nothing is renumbered. `adr-index.ts` never reuses a gap,
  because reusing a number would make an id ambiguous across git history.

## Lorekeeper commit input

```json
{
  "newAdrs": [{ "path": "docs/adr/0027-....md", "content": "..." }],
  "metadataUpdate": { "path": "...", "set": {} }
}
```

Rules:

- The main agent builds `newAdrs` from the gate-2 verdicts. Keep every `approve` verdict, in
  the order the drafts were proposed. Drop every `drop` verdict. For each kept verdict, set
  `path` to its `proposedPath`, and set `content` to the verdict's own `draftText` when it
  carries one, otherwise to the codifier's `draftText` for that draft.
- `newAdrs` is optional. Omit it entirely when the run promoted nothing, which includes a
  run where every verdict was `drop`. Never send `[]`.
- `metadataUpdate` stays a single object. It is not batched.
- `newAdr` is an unknown field. Refuse a caller that sends it, and name it in the refusal.
  A silent fallback would write one record out of five.
- `planPath`, `validatorPath`, and `archiverPath` are still all required.

## Barrowkeeper output

Success:

```json
{ "success": true, "newAdrPaths": [], "validated": true, "archived": true }
```

Path collision, before any write:

```json
{ "success": false, "reason": "path-collision", "collisions": [] }
```

Validation error, after the writes landed:

```json
{ "success": false, "reason": "validation-error", "newAdrPaths": [], "violations": [], "archived": false }
```

`newAdrPaths` is always present on every shape that carries it, and it is always an array.
A run that wrote no record reports `[]`. Never omit the field, because an absent field and
an empty batch would look identical to a caller.

`newAdrPaths` on the validation-error shape is new. The recovery procedure needs to know
what landed. The metadata-update-failure shape is unchanged except that `newAdrPath`
becomes `newAdrPaths`.

## Barrowkeeper write order

Follow this order exactly.

1. Check every `newAdrs[].path` for an existing file. If any path exists, refuse the whole
   batch and write nothing. Return the `path-collision` shape with every colliding path.
2. Write all records.
3. Apply `metadataUpdate` if present.
4. Run the validator as `bun <validatorPath> <docs/adr directory>`.
5. If validation reports errors, return the `validation-error` shape with the violations
   and `newAdrPaths`. Skip archive. Delete nothing and repair nothing.
6. If validation passes, run `bun <archiverPath> --plan <planPath> --apply`.

`validateDir` already names the offending path in each violation, so no extra attribution
step is needed.

## Deferred groups and the archive plan

A gate-2 `drop` defers a group. Its candidates were `promote` at gate 1, so the reckoner
already assigned their source sessions to `target: "done"`. If nothing corrects that, the
dropped decision archives to `done` unrecorded and leaves triage forever.

Before `commit`, the main agent treats every dropped group's candidates as `watch`. It
re-folds the `watch`-wins rule across every session those candidates touch, not only the
dropped ones, because another candidate from the same session may already be `watch`. It
keeps each row's original `from` untouched, serializes the corrected `assignments`, and
re-runs `bun <plannerPath> --assignments <corrected assignments JSON>`. It passes the
fresh `planPath` into `commit`.

This reuses the gate-1 override recipe already in `SKILL.md`, with gate 2 as a second
trigger. Never hand-edit `moves[]` or any other field of the serialized plan. A plan's
`target`, `to`, and `from` fields are derived together, so patching one desyncs the rest.

`plannerPath` comes from the collect-phase inputs the main agent retained. Retain it
through gate 2 as well.

## Recovering a failed batch

After a validation failure:

- The written records are on disk, uncommitted.
- The session logs are untouched in `.cockpit/`.
- The plan file survives at `/tmp/chronicle/adr/`.

Q fixes the offending record by hand, then re-runs `triage`. There is no archive-only
entry point, and this plan adds none.

The re-run self-heals for three reasons. `adrIndex.nextNumber` has advanced past the
written records, so no path collides. The reckoner skips clusters that match an existing
ADR, so the same decisions disposition to `skip`. The run then takes the no-promotion
branch and the archive plan finally applies.

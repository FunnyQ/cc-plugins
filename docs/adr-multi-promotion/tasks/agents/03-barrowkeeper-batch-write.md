# AGENTS-03: Barrowkeeper batch write

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: codex/03
> **Status**: done

## Goal

The Barrowkeeper writes every approved record of one triage run in a single commit phase, refuses the whole batch on a path collision, and reports what landed when validation fails.

## Files to create / modify

- `packages/chronicle/agents/barrowkeeper.md` (modify) — rename `newAdr` to `newAdrs`, rewrite the Process section to the batch write order, and replace the output shapes.

Edit no other file. The Codex TOML mirror at `packages/chronicle/agents-codex/barrowkeeper.toml` is owned by a different task in this tree.

## Implementation notes

The current file is written entirely in the singular. It writes one record, validates, and archives. Every change below turns that into a batch while keeping the refusals identical in meaning.

Do not edit the YAML frontmatter. The `name`, `description`, `model`, `effort`, and `tools` lines stay byte-identical.

Keep `metadataUpdate` a single object everywhere. It is not batched.

### Input block

Rename `newAdr` to `newAdrs` and make it an array of `{ path, content }` objects. Keep `planPath`, `validatorPath`, and `archiverPath` always present. Write the input block as this shape:

```json
{
  "newAdrs": [{ "path": "docs/adr/0027-....md", "content": "..." }],
  "metadataUpdate": {
    "path": "docs/adr/0003-....md",
    "set": { "Status": "Superseded", "Superseded by": "ADR-0027" }
  },
  "planPath": "/tmp/chronicle/adr/archive-plan-1754438400000-51234.json",
  "validatorPath": ".../skills/adr/scripts/adr-validate.ts",
  "archiverPath": ".../skills/adr/scripts/archive-logs.ts"
}
```

Keep the existing rule that the two write kinds stay distinct, and that either may be absent. Restate it against the array field name:

- A plain promotion sends only `newAdrs`.
- A lifecycle correction sends only `metadataUpdate`.
- A triage run that promoted nothing commonly sends neither, and only a plan.
- An absent `newAdrs` is normal. An empty array is not sent.

### Process — the batch write order

Rewrite the Process section to this order. State the order at the head of the section, then number the steps.

1. Check every `newAdrs[].path` for an existing file. If any path exists, refuse the whole batch and write nothing. Return the `path-collision` shape with every colliding path.
2. Write all records.
3. Apply `metadataUpdate` if present.
4. Run the validator as `bun <validatorPath> <docs/adr directory>`.
5. If validation reports errors, return the `validation-error` shape with the violations and `newAdrPaths`. Skip archive. Delete nothing and repair nothing.
6. If validation passes, run `bun <archiverPath> --plan <planPath> --apply`.

Give the collision pre-check its reason, and put that reason before the step, per the warning-first writing rule. Two facts justify the position:

- A partially written batch that then refuses is worse than one that never started. The caller has to work out which records landed before it can retry.
- A collision is a numbering race, not a repairable condition. Overwriting would destroy a record.

Keep these rules from the current file, reworded for the batch:

- Never delete a log file. Archive is the operation, not removal.
- If the metadata update fails after the records land, do not roll back. The records are valid on their own, and the missing back-link is repairable by hand. Report the written paths and the exact failed step. Skip archiving.
- Rewrite only the lifecycle fields named in `set`: `Status`, `Supersedes`, `Superseded by`, and `Deprecated`. Refuse every other field. Never touch the `## Context`, `## Considered alternatives`, `## Decision`, `## Consequences`, or `## Evidence` bodies.
- Require an existing target path for a metadata update.
- The validator runs before archiving because archiving is irreversible.
- The validator exits `0` when only warnings fired. Treat warnings as non-blocking, because an empty evidence section is legal.
- Pass `planPath` straight through to the archiver. Never pass raw assignments, because the archiver cannot build a plan from assignments.

Add the attribution note to the validation-error step: `validateDir` already names the offending path in each violation, so the Barrowkeeper adds no attribution step of its own.

### Output shapes

Replace the singular success shape with these three. Copy the field names exactly.

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

`newAdrPaths` is an array on every shape that carries it. It appears on the validation-error shape because the recovery procedure needs to know what landed on disk.

Update the fourth shape, the metadata-update failure, so its `newAdrPath` field becomes `newAdrPaths` and carries an array. Keep the rest of that shape as it is:

```json
{
  "success": true,
  "newAdrPaths": ["docs/adr/0027-....md"],
  "metadataUpdateFailed": true,
  "error": "metadata update failed for docs/adr/0003-....md: <details>",
  "archived": false
}
```

Drop the existing instruction to omit the record-path field when no record was written. On the success, validation-error, and metadata-update-failure shapes, `newAdrPaths` is always present and always an array. A run that wrote no record reports `[]`. State the reason: an absent field and an empty batch would look identical to a caller.

The path-collision shape is the exception, and it carries no `newAdrPaths` at all. That refusal happens before any write, so there is no path list to report. It carries `collisions` instead.

## Acceptance criteria

- [x] `packages/chronicle/agents/barrowkeeper.md` names `newAdrs` as an array of `{ path, content }` in its input block.
- [x] No bare `newAdr` field name survives in the file. Every occurrence is either `newAdrs` or `newAdrPaths`.
- [x] The Process section documents the collision pre-check as step 1, ahead of every write, and states why the check moves first.
- [x] The Process section documents all six steps in the frozen order, ending with `bun <archiverPath> --plan <planPath> --apply`.
- [x] All three output shapes are present, with the literal reason strings `path-collision` and `validation-error`.
- [x] `newAdrPaths` is an array on the success shape, the validation-error shape, and the metadata-update-failure shape, and the file states that those three never omit it.
- [x] The path-collision shape carries `collisions` and no `newAdrPaths`, and the file says why.
- [x] No sentence tells the Barrowkeeper to omit a record-path field when nothing was written.
- [x] `metadataUpdate` is still a single object with a `path` and a `set` map.
- [x] The rules on deletion, rollback, lifecycle-only fields, warning tolerance, and `planPath` pass-through all survive in the rewritten text.
- [x] The YAML frontmatter is byte-identical to the version before this task.

## Verification

- [x] Run `grep -n "newAdrs" packages/chronicle/agents/barrowkeeper.md` and confirm it appears in the input block and in the Process section.
- [x] Run `grep -n "newAdrPaths" packages/chronicle/agents/barrowkeeper.md` and confirm three or more output shapes carry it.
- [x] Run `grep -nE "newAdr[^sP]|newAdr$" packages/chronicle/agents/barrowkeeper.md` and confirm it prints nothing.
- [x] Run `grep -n "path-collision" packages/chronicle/agents/barrowkeeper.md` and confirm the reason string is present.
- [x] Run `grep -n "validation-error" packages/chronicle/agents/barrowkeeper.md` and confirm the reason string is present.
- [x] Run `grep -n "newAdrPath\"" packages/chronicle/agents/barrowkeeper.md` and confirm it prints nothing, so no singular path field survives in a JSON shape.
- [x] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm every test passes. This task changes no script, so a failure means an edit went out of scope.
- [x] Read the frontmatter block and confirm the `name`, `description`, `model`, `effort`, and `tools` lines are unchanged.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name differs from the frozen contract, or a required output shape is missing | Shapes match but the collision check sits after a write, or a refusal rule is softened | Input block, write order, and all four output shapes match the frozen contract exactly |
| Completeness | ×2 | The Process section still reads in the singular | Input block converted while an output shape or a Process step still writes one record | Input, Process, and every output shape carry the batch contract, with no singular remnant |
| Readability | ×1 | Instructions run past 25 words, or stack em dashes | Correct content, but the collision reason lands after the step it justifies | Warning before step, one instruction per sentence, and one voice with the rest of the file |
| Assumptions and docs | ×1 | Invents a rollback, a repair, or a renumbering the contract forbids | The collision pre-check or the `newAdrPaths` addition is stated with no reason | Every non-obvious rule names the failure it prevents, including the attribution note |

## Out of scope

- `packages/chronicle/agents-codex/barrowkeeper.toml` — Deferred. A separate task compresses the landed Markdown into the Codex mirror, and both files changing at once hides which one drifted.
- Batching `metadataUpdate` — Deferred. Supersession is one replacement per run, and it carries a two-write partial-failure mode that a batch would multiply.
- Rollback or delete semantics on a failed batch — Deferred permanently. The skill constraint `Archive, never delete` holds, and a failed batch is recovered by hand.
- Renumbering after a dropped draft — Deferred permanently. `adr-index.ts` never reuses a number gap, because reusing a number would make a record id ambiguous across git history.

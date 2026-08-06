# AGENTS-02: Lorekeeper batch phase contracts

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: codex/02
> **Status**: todo

## Goal

The Lorekeeper's `draft` phase carries a `groups` array in and a `drafts` array out, and
its `commit` phase accepts an optional `newAdrs` array, so one triage run promotes many
records instead of exactly one.

## Files to create / modify

- `packages/chronicle/agents/lorekeeper.md` (modify) — `draft` phase Require list, steps,
  and output block; `commit` phase optional inputs and spawn step; one Output rule.

## Implementation notes

Edit one file: `packages/chronicle/agents/lorekeeper.md`. Its Codex TOML mirror at
`packages/chronicle/agents-codex/lorekeeper.toml` is another executor's file. Do not open
it and do not edit it.

Follow the STE-lite writing rules in `../_context/shared.md`. Do not edit the YAML
frontmatter. Do not add, remove, or re-level a heading. The file carries two headings
named `Child protocol`, one near the top and one at the end. That duplication is
pre-existing. Keep both.

### What does not change

Restate these, do not weaken them:

- The Lorekeeper holds no gate and asks the user nothing.
- The main agent spawns the Lorekeeper once per phase.
- The `collect` phase is untouched.
- The `draft` phase spawns exactly one `chronicle:codifier`, spawned once. One Codifier
  drafts every group. Never spawn one Codifier per group.
- `planPath`, `validatorPath`, and `archiverPath` stay required on `commit`. The
  `PHASE MISSING INPUT` refusal for them stays as written.
- `metadataUpdate` stays a single object. It is never batched.
- The launch-receipt rules stay as written.

### `draft` phase — Require list

The current list requires `candidateIds`, `bodyFetchPath`, `templatePath`, and `adrIndex`.

Replace `candidateIds` with `groups`. Keep `bodyFetchPath` and `templatePath` unchanged.
Remove the `adrIndex` bullet and its reason, "so the draft can propose the next number".
The main agent now pre-allocates every record number, so the phase never needs the index.

Write the `groups` bullet so the shape is readable without another file. `groups` is the
approved group list from the gate-1 confirmation. Each entry is
`{ "groupId": ..., "entryIds": [...], "adrNumber": ... }`:

```json
{
  "groups": [
    { "groupId": "g1", "entryIds": ["id-1", "id-2"], "adrNumber": 27 },
    { "groupId": "g2", "entryIds": ["id-3"], "adrNumber": 28 }
  ]
}
```

State that the caller allocated each `adrNumber`. Pass `groups` through unchanged.

### `draft` phase — steps

The three numbered steps become:

1. Spawn `chronicle:codifier` with `groups`, `bodyFetchPath`, and `templatePath`.
2. Receive `drafts`.
3. Return `drafts` to the main agent.

### `draft` phase — output block

Replace the singular draft-phase output block with the array form:

```json
{
  "phase": "draft",
  "drafts": [
    { "groupId": "g1", "draftText": "...", "proposedPath": "docs/adr/0027-....md" }
  ]
}
```

`drafts` holds one entry per input group, in the same order, with the same `groupId`.

### `commit` phase — optional inputs

Rename the optional `newAdr` object to a `newAdrs` array:

```json
{
  "newAdrs": [{ "path": "docs/adr/0027-....md", "content": "..." }],
  "metadataUpdate": { "path": "...", "set": {} }
}
```

Keep the existing rule that each optional input is independently optional. Keep the
instruction to assemble the value from what the gate-2 confirmation returned.

Add two rules to the `newAdrs` bullet:

- Omit `newAdrs` entirely when the run promoted nothing. Never send `[]`.
- `newAdr` is an unknown field. Refuse a caller that sends `newAdr`, and name the field in
  the refusal. Without the refusal a stale caller writes one record out of five, silently.

Update the `commit` phase spawn step so it names `newAdrs` in place of `newAdr`.

### The no-promotion exception

The paragraph that starts "A commit with neither" keeps its meaning exactly. Change the
field name only. It must still say that a run where every candidate was `watch` or `skip`
has an approved archive plan to apply, that refusing it there would strand the plan, and
that the exception never softens the three required paths.

### Output section prose

One rule in the Output section reads: "`draftText` must be the complete ADR body, not a
description of what the draft contains." Rewrite it so it binds every entry in `drafts`,
not one draft. The `candidates` field list in that same paragraph is unrelated. Leave it
alone.

## Acceptance criteria

- [ ] `grep -n "candidateIds" packages/chronicle/agents/lorekeeper.md` returns nothing.
- [ ] The `draft` phase Require list names `groups`, `bodyFetchPath`, and `templatePath`,
      and no longer requires `adrIndex`.
- [ ] The `draft` phase steps spawn one Codifier with `groups` and return `drafts`.
- [ ] The `draft` phase output block is the `drafts` array form, with `groupId`,
      `draftText`, and `proposedPath` per entry.
- [ ] The `commit` phase optional input is `newAdrs`, an array of `{ path, content }`,
      omitted entirely when nothing promoted and never sent as `[]`.
- [ ] The only surviving `newAdr` mention is the unknown-field refusal, and that refusal
      states the failure it prevents.
- [ ] `planPath`, `validatorPath`, and `archiverPath` are still all required, and the
      `PHASE MISSING INPUT` refusal text is unchanged.
- [ ] `metadataUpdate` is still described as a single object.
- [ ] The no-promotion exception paragraph survives with its meaning intact.
- [ ] The YAML frontmatter is byte-identical to the version before this task.

## Verification

- [ ] Run `grep -n "candidateIds\|adrIndex" packages/chronicle/agents/lorekeeper.md` and
      confirm it prints nothing.
- [ ] Run `grep -n "groups\|drafts\|newAdrs" packages/chronicle/agents/lorekeeper.md` and
      confirm hits in the `draft` Require list, the `draft` steps, the `draft` output
      block, and the `commit` optional inputs.
- [ ] Run `grep -n "newAdr\b" packages/chronicle/agents/lorekeeper.md` and confirm the
      only hit is the unknown-field refusal sentence.
- [ ] Run `grep -n "PHASE MISSING INPUT\|no-promotion path\|metadataUpdate" packages/chronicle/agents/lorekeeper.md`
      and confirm all three survive.
- [ ] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it passes. No
      script changed, so a failure means an edit landed outside the declared file.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted
> average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name differs from the frozen contract, or `candidateIds` survives | Shapes match but the `newAdr` refusal, the never-send-`[]` rule, or the same-order rule is missing | `groups`, `drafts`, and `newAdrs` match the contract exactly, and each rule names the failure it prevents |
| Completeness | ×2 | The Require list or the output block is untouched | The `draft` phase is converted while the `commit` phase still reads `newAdr`, or the Output prose still binds one draft | Require list, steps, output block, commit inputs, spawn step, and Output prose are all converted |
| Readability | ×1 | A heading was added or re-leveled, or the frontmatter changed | Correct content with sentences over 25 words, stacked em dashes, or a new term for `group` | Reads as one voice with the rest of the file and obeys the STE-lite rules |
| Assumptions and docs | ×1 | Invents a behavior the frozen contract does not define, such as one Codifier per group | A rule lands with no reason, so a later editor cannot tell it is load-bearing | Every new rule carries its reason, and the preserved rules stay verbatim in meaning |

## Out of scope

- `packages/chronicle/agents-codex/lorekeeper.toml` — Deferred. Another executor mirrors
  this file into Codex TOML after this change lands.
- The `collect` phase — Deferred. Nothing about collection changes in this plan.
- Batching `metadataUpdate` — Deferred. Supersession stays one record per run, because a
  two-write partial failure would multiply across a batch.
- Any file under `packages/chronicle/skills/adr/scripts/` — Deferred. This plan changes no
  code.

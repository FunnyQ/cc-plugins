# ADR multi-promotion

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-08-06

## Overview

`chronicle:adr` can promote exactly one ADR per triage run. This plan replaces that limit
with a batch contract, so one `triage` run drafts, gates, and writes up to 12 records in
one pass. The change is documentation and prompt text only, across four Markdown agent or
skill files and three Codex TOML mirrors.

## Goals

- Let one `triage` run promote N ADRs through one `draft` phase, one gate 2, and one
  `commit` phase.
- Make the documented protocol match the protocol a live run actually uses.
- Keep the Claude Markdown agents and the Codex TOML mirrors on one identical contract.
- Give a failed batch a written recovery procedure instead of an undefined state.

## Non-goals

- `supersede <adr-id>` still replaces one record per run. `metadataUpdate` stays a single
  object.
- No changes to `gleaner.md`, `reckoner.md`, or any script under
  `packages/chronicle/skills/adr/scripts/`.
- No rollback and no delete semantics. Constraint 3, `Archive, never delete`, still holds.
- No renumbering. `adr-index.ts` never reuses a number gap, so a dropped draft leaves a
  permanent gap by design.
- No new script, no new flag, and no new entry point. There is no archive-only re-entry.

## Context

The `chronicle:adr` pipeline is a main agent holding two human gates around three
`chronicle:lorekeeper` phases: `collect`, `draft`, and `commit`. The draft phase spawns
`chronicle:codifier`. The commit phase spawns `chronicle:barrowkeeper`.

Every promotion contract in that chain is singular today:

- `codifier.md` returns one `{ draftText, proposedPath }` object.
- `lorekeeper.md` draft phase requires `candidateIds` and returns that one pair.
- `lorekeeper.md` commit phase takes one optional `newAdr` object.
- `barrowkeeper.md` writes one record, in prose written entirely in the singular.
- `packages/chronicle/skills/adr/SKILL.md` Constraint 7 documents the limit and defers
  the fix.

A prior live run produced the 26 records now in `docs/adr/`. The documented protocol
cannot do that. That run deviated silently and left no record of how. This plan closes
the gap between the documented path and the used path.

The three Codex TOML mirrors carry the same contract, compressed. `codifier.toml` line 8
hardcodes the singular output schema as a literal JSON shape. A contract change that
skips the mirrors breaks Codex silently, because nothing cross-validates the two copies.

## Requirements

### MVP

1. **Gate 1 carries a `group` field** — a disposition row may name a group, and rows
   sharing a group become one ADR.
   - Acceptance: `SKILL.md`'s fallback JSON schema shows `group`, drops `notes`, and the
     consistency check reads groups mechanically instead of parsing free text.
2. **The main agent owns group identity and numbering** — the codifier never counts.
   - Acceptance: `SKILL.md` states that the main agent assigns each group a positional
     `groupId` (`g1`, `g2`, …) and that group `i` takes `adrIndex.nextNumber + i`;
     `codifier.md` bakes the given number into both the H1 and the proposed path.
3. **The 12-group cap is checked on Q's reply, before gate-1 confirmation** — never after.
   - Acceptance: `SKILL.md` tells the main agent to fold Q's reply into groups and, above
     12, to re-surface rather than confirm — because `group` is Q's field, so the group
     count does not exist until the reply does.
4. **Gate 2 takes a per-draft verdict** — one verdict per proposed draft, complete set
   required.
   - Acceptance: `SKILL.md` shows the `verdicts` array and states that a partial reply is
     re-surfaced.
5. **The draft phase drafts N records** — one codifier drafts every group.
   - Acceptance: `codifier.md` takes `groups`, makes one `--bodies` call over the union of
     entry ids, and returns `drafts[]` in input order.
6. **The commit phase writes N records** — `newAdrs` replaces `newAdr`.
   - Acceptance: `lorekeeper.md` and `barrowkeeper.md` name `newAdrs`, and a caller
     passing `newAdr` is refused as an unknown field.
7. **A batch fails whole or lands whole per step** — collision refuses the batch before
   any write; validation failure keeps every written record and skips archive.
   - Acceptance: `barrowkeeper.md` documents the write order and three output shapes,
     including `newAdrPaths` on the validation-error shape.
8. **A failed batch has a recovery procedure** — written in `SKILL.md`.
   - Acceptance: a new `SKILL.md` section states what is on disk, what Q fixes by hand,
     and why re-running `triage` self-heals.
9. **The Codex mirrors carry the same contract** — three TOML files updated.
   - Acceptance: each `developer_instructions` string names `groups`, `drafts`,
     `newAdrs`, or the batch write order, matching its Markdown source.

### Later

- **Grouping affordances beyond a text field** — the gate-1 ledger gains a `group` column in
  MVP, and the copied JSON carries whatever Q types into it. Drag-to-group, group colouring,
  and client-side validation of the consistency check are deferred. Reason: the plaintext
  round-trip is the contract, and richer controls only change how Q fills one column.
- **Batch `supersede`** — deferred. One replacement per run is the current need, and
  supersession carries a two-write partial-failure mode that a batch would multiply.

## Tech decisions

- **Stack**: Markdown instruction files and TOML agent definitions. No TypeScript changes.
- **Storage**: none. The contract is prompt text.
- **Conventions**: STE-lite writing rules, frozen in `tasks/_context/shared.md`.
- **Contract**: frozen verbatim in `tasks/_context/contract.md`. Every task agrees to it.

## Architecture

The phase boundaries do not move. Only the payload crossing each boundary becomes an
array.

```
main agent (owns both gates, pre-allocates ADR numbers)
  ├─ lorekeeper(collect) → gleaner, reckoner
  ├─ [GATE 1]  dispositions[] now carry an optional `group`
  │            main agent folds groups → groups[] with adrNumber
  ├─ lorekeeper(draft)   → codifier          groups[] in  →  drafts[] out
  ├─ [GATE 2]  verdicts[] — one per proposed draft
  └─ lorekeeper(commit)  → barrowkeeper      newAdrs[] in →  batch write, validate, archive
```

Four contract edges change shape:

| Edge | Before | After |
| --- | --- | --- |
| Gate-1 response | `dispositions[]`, free-text `notes` | `dispositions[]` with optional `group` |
| Main agent → `draft` | `candidateIds` | `groups[]` with `groupId`, `entryIds`, `adrNumber` |
| Codifier → gate 2 | `{ draftText, proposedPath }` | `drafts[]` |
| Gate 2 → `commit` | `newAdr` | `newAdrs[]` |

## Bucketing

- **Strategy**: by file family. The skill file, the Claude agents, and the Codex mirrors
  each form a family with its own failure mode.
- **Why**: the Codex mirrors compress a landed Markdown file, so each mirror task must
  run after its source. The two `SKILL.md` tasks must serialize on one file. Everything
  else runs in parallel.

### Buckets

- **`contract/`** — `packages/chronicle/skills/adr/SKILL.md`. Two tasks, serialized,
  because both edit one file.
- **`agents/`** — the three Claude agent Markdown files. Three tasks, one file each,
  fully parallel.
- **`codex/`** — the three Codex TOML mirrors. Each depends on its Markdown source.
- **`review/`** — the closing whole-tree review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| contract | 01 | gate-protocols | todo | > 4.0 | — |
| contract | 02 | batch-mechanics | todo | > 4.0 | contract/01 |
| agents | 01 | codifier-drafts-n-records | todo | > 4.0 | — |
| agents | 02 | lorekeeper-batch-phases | todo | > 4.0 | — |
| agents | 03 | barrowkeeper-batch-write | todo | > 4.0 | — |
| codex | 01 | codifier-toml-mirror | todo | > 4.0 | agents/01 |
| codex | 02 | lorekeeper-toml-mirror | todo | > 4.0 | agents/02 |
| codex | 03 | barrowkeeper-toml-mirror | todo | > 4.0 | agents/03 |
| review | 01 | final review 🏁 | todo | > 4.0 | contract/02, codex/01, codex/02, codex/03 |

(Mirrors the table in `tasks/README.md` — keep them in sync. The last row is the **final
review** task, marked `> **Final review**: true` in its file; its `Depends on` reaches
every other task transitively.)

## Cross-bucket dependencies

```
contract/01 → contract/02 ──────────────┐
                                        │
agents/01 → codex/01 ───────────────────┤
agents/02 → codex/02 ───────────────────┼── review/01
agents/03 → codex/03 ───────────────────┘
```

Three waves:

1. `contract/01`, `agents/01`, `agents/02`, `agents/03`
2. `contract/02`, `codex/01`, `codex/02`, `codex/03`
3. `review/01`

## Open questions

1. **Is 12 the right batch cap?** — Q ran 26 groups in one sitting and reports the limit
   was fatigue, not failure. 12 is a judgment call from one measured run, not a measured
   limit. The closing review flags it if the codifier task reads as fragile at that size.

## Known gaps

Tracked in `tasks/README.md`, which is the file an executor opens.

## References

- `packages/chronicle/skills/adr/SKILL.md` — Constraint 7 states the limit this plan
  removes.
- `docs/ste-rewrite/STE-RULES.md` — the writing standard every edited file follows.
- `docs/adr/0008-ste-lite-writing-rules-without-approved-word-dictionary.md` — why the
  standard drops the approved-word dictionary.

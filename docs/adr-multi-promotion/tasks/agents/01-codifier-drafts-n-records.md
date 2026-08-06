# AGENTS-01: Codifier drafts N records

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: codex/01
> **Status**: todo

## Goal

The Codifier takes a `groups` array and returns one draft per group, so a single `draft`
phase can produce every record of a `triage` run.

## Files to create / modify

- `packages/chronicle/agents/codifier.md` (modify) — the Input section, the Process steps,
  and the Output shape move from one record to N records.

## Implementation notes

Edit this one file. A separate task owns the Codex TOML mirror of this agent. Do not open
it and do not edit it.

Follow the STE-lite writing rules and the hard constraints in `../_context/shared.md`. Two
of those constraints bite here. Do not edit the YAML frontmatter. Copy every backticked
token verbatim, and never break a backticked span across a line wrap.

### The file's current shape

The file opens with a one-paragraph brief, then carries three headed sections:
`## Input (from the prompt)`, `## Process` (a seven-step numbered list), and `## Output`.
Keep all three headings and keep the numbered-list shape. The step count may change.

The frontmatter is these seven lines. They must be byte-identical after the edit:

```
---
name: codifier
description: "Chronicle's ADR codifier. Fetches full bodies for confirmed candidates and drafts the record text from the adr-template. Spawned by the ADR skill main agent after the first confirmation gate. Returns the draft; does not save it. Does not hold Write permission — the barrowkeeper alone writes records. Refuses to run mutating commands or invoke the archiver."
model: sonnet
effort: high
tools: ["Bash", "Read"]
---
```

### Opening brief

The brief now reads "Draft the ADR from confirmed candidates and return it." Make it
plural. The Codifier drafts every group of the batch in one run and returns all of them.
Keep the three refusals unchanged: do not save, do not run a mutating command, do not
invoke the archiver. Keep the sentence that the Barrowkeeper alone writes records after
the second confirmation gate.

### Input section

Replace `candidateIds` with `groups`. Drop the `adrIndex` line entirely, because `groups`
carries every number the Codifier needs. Keep `templatePath` and `bodyFetchPath` exactly
as they read now.

The new `groups` input has this shape:

```json
{
  "groups": [
    { "groupId": "g1", "entryIds": ["id-1", "id-2"], "adrNumber": 27 },
    { "groupId": "g2", "entryIds": ["id-3"], "adrNumber": 28 }
  ]
}
```

State these rules in the Input section:

- One group becomes one ADR. A group with several `entryIds` is a merge the human
  approved at the first gate.
- The caller pre-allocated every `adrNumber`. The Codifier never counts, and it never
  reads `adrIndex.nextNumber` for itself.
- Keep the existing sentence that tells the Codifier to use the supplied absolute script
  paths and never to guess a repo-relative path.

### One `--bodies` call for the whole batch

Process step 1 fetches bodies. It must now fetch the union of every `entryIds` across
every group, in one call:

```bash
bun <bodyFetchPath> --bodies <id1,id2,id3>
```

State why one call, because a later editor will otherwise loop it per group: the flag
takes one comma-joined list, so N calls multiply latency and gain nothing.

After the call, partition the returned records back to their groups by entry id. A record
belongs to the group whose `entryIds` holds its id.

Keep these existing warnings verbatim. `--bodies` is the flag's only spelling, and the
script exits `1` on anything else. The command prints one JSON line, not the records: read
`outputPath` from that line, then parse the JSON array of full records it names. Do not
fetch or include an entry id that no group carries.

### Draft one record per group

Current steps 2 to 6 stay, and each now applies per group:

- Read the supplied template at `templatePath` once. The template does not change between
  groups.
- Draft the complete record against that template.
- Set status from implementation state, never from draft quality.
- Embed a stable evidence summary plus the session ID, entry ID, and date. Never cite a
  `.cockpit` path.
- Exclude secrets, credentials, personal data, and raw transcript text.

Add one rule for a multi-member group. The group draws its evidence from every member's
entries, and it becomes one record, not one record per member.

### Bake the given `adrNumber`

Replace step 7. The Codifier no longer derives a number from an index.

- Bake the group's `adrNumber` into the H1, as `# ADR-0027:` for `adrNumber` 27.
- Bake the same number into `proposedPath`, as `docs/adr/<NNNN>-<kebab-title>.md`, with
  `<NNNN>` zero-padded to four digits.
- Propose the path without creating it. Return the drafts only.

State the failure this prevents. The `adr-validate.ts` rule `id-mismatch` compares the
filename number to the H1 number. A drift between the two fails validation after the
Barrowkeeper already wrote the record.

### Output section

Replace the singular `{ draftText, proposedPath }` block with this array:

```json
{
  "drafts": [
    { "groupId": "g1", "draftText": "...", "proposedPath": "docs/adr/0027-....md" }
  ]
}
```

State these rules:

- Return one entry per input group, in the same order, carrying the same `groupId`.
- `draftText` is the complete record body, never a description of it.

### Batch cap

The caller sends at most 12 groups. If more than 12 arrive, refuse the whole input and
report the count received. Never truncate the list silently, because a silent truncation
loses a decision the human already approved at the first gate.

## Acceptance criteria

- [ ] `packages/chronicle/agents/codifier.md` contains no occurrence of `candidateIds`.
- [ ] `adrIndex` survives in exactly one place: the sentence stating that the Codifier never
      reads `adrIndex.nextNumber` for itself. It is gone from the Input list and from the
      numbering step.
- [ ] The Input section documents `groups` with the `{ groupId, entryIds, adrNumber }`
      shape, and states that the Codifier never counts.
- [ ] Exactly one `bun <bodyFetchPath> --bodies` command appears in the file, described as
      one call over the union of every group's `entryIds`.
- [ ] The file states that the group's given `adrNumber` is baked into both the H1 and
      `proposedPath`, and names the `adr-validate.ts` rule `id-mismatch` as the failure it
      prevents.
- [ ] The Output section shows the `drafts` array. Neither `draftText` nor `proposedPath`
      is a top-level field of the returned JSON: inside the output shape, every occurrence
      of both sits under a `drafts[]` entry. Prose elsewhere in the file may name either
      token freely.
- [ ] The file states the 12-group cap and tells the Codifier to refuse a larger input
      rather than truncate it.
- [ ] The seven frontmatter lines are byte-identical to the block quoted in Implementation
      notes.

## Verification

- [ ] Run `grep -n "candidateIds" packages/chronicle/agents/codifier.md` and confirm it
      prints nothing.
- [ ] Run `grep -o "adrIndex" packages/chronicle/agents/codifier.md | wc -l` and confirm the
      count is `1`. Use `grep -o … | wc -l`, not `grep -c`: `grep -c` counts matching lines,
      so two mentions on one line would read as one.
- [ ] Run `grep -n "groups\|groupId\|adrNumber\|drafts" packages/chronicle/agents/codifier.md`
      and confirm every one of the four tokens is present.
- [ ] Run `grep -c -- "--bodies" packages/chronicle/agents/codifier.md` and confirm the
      count matches the mentions this file describes, with exactly one of them a runnable
      command line.
- [ ] Run `grep -n "id-mismatch" packages/chronicle/agents/codifier.md` and confirm the
      rule is named.
- [ ] Run `head -7 packages/chronicle/agents/codifier.md` and confirm the seven lines match
      the frontmatter block quoted in Implementation notes.
- [ ] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it passes. This
      task changes no script, so a failure means an edit landed out of scope.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name differs from the frozen contract, or the Output still returns one `draftText` | `groups` and `drafts` are present, but `groupId` order is unstated, or the Codifier still reads `adrIndex.nextNumber` | Input, Output, and numbering match the frozen contract, and the `id-mismatch` failure is named |
| Completeness | ×2 | The Output array landed and the Input still names `candidateIds` | Input and Output converted, but the Process steps still read in the singular | Brief, Input, all Process steps, Output, and the 12-group cap all read as a batch |
| Readability | ×1 | Backticked spans broken across line wraps, or frontmatter edited | Correct content, but sentences over 25 words or stacked em dashes | STE-lite throughout, one voice with the rest of the file, headings and list shape preserved |
| Assumptions and docs | ×1 | Invents a behavior the frozen contract does not define, such as a retry or a partial return | The one-call rule and the cap are stated with no reason given | Every non-obvious rule names the failure it prevents |

## Out of scope

- `packages/chronicle/agents-codex/codifier.toml` — Deferred. A separate task compresses
  this landed file into its Codex mirror, and doing both here would let the two drift.
- Any change to `packages/chronicle/skills/adr/scripts/` — Deferred. This change is
  instruction text only, and `adr-validate.ts` already enforces the H1 rule.
- The lorekeeper's `draft` phase Require list — Deferred. A separate task moves that phase
  from `candidateIds` to `groups`.

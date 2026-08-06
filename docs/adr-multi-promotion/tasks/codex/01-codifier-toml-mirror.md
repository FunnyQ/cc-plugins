# CODEX-01: Codifier TOML mirror

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: agents/01
> **Status**: done

## Goal

`packages/chronicle/agents-codex/codifier.toml` states the same batch contract as its
Markdown source, so a Codex Codifier drafts N records instead of one.

## Files to create / modify

- `packages/chronicle/agents-codex/codifier.toml` (modify) — compress the landed batch
  contract into the Codex mirror.

## Implementation notes

### Read the landed Markdown source first

`packages/chronicle/agents/codifier.md` has already been converted to the batch contract.
Read that file before you edit the mirror. Mirror what it actually says, not what you
expect it to say.

If `packages/chronicle/agents/codifier.md` and `../_context/contract.md` disagree, treat
`../_context/contract.md` as the authority. Report the disagreement in your result.

### Why this file needs its own task

The singular output schema is hardcoded in this TOML as a literal JSON string. No test and
no script cross-validates the TOML against its Markdown source. A contract change that
skips the mirror breaks Codex silently, because the Codex Codifier keeps returning one
record while the caller waits for N.

### Keep the file shape

Keep `model = "gpt-5.6-terra"` unchanged. Keep `model_reasoning_effort = "high"` unchanged.
This change retunes no agent.

Keep `developer_instructions` as one triple-quoted string:

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
developer_instructions = """
<compressed prose brief>
"""
```

The mirror is dense prose, not headed sections. Keep the existing three-paragraph shape and
topic order: role and inputs and fetch first, then status and evidence rules, then the
return shape. A reader who diffs the two files must see the contract change, never a
reorganization.

### Replace the input list

The current brief receives `candidateIds` and `adrIndex`. Drop both from the input list.

The mirror now receives `groups`, `bodyFetchPath`, and `templatePath`. `adrIndex` is no
longer an input, because the caller pre-allocates every record number.

Keep the token in exactly one negative clause: state that the Codifier never counts and
never reads `adrIndex.nextNumber` for itself. That clause is the whole point of dropping
the input, so name the field it must not reach for.

Inline this input literal:

```json
{"groups":[{"groupId":"g1","entryIds":["id-1","id-2"],"adrNumber":27},{"groupId":"g2","entryIds":["id-3"],"adrNumber":28}]}
```

### Keep the body-fetch warnings verbatim

State one `--bodies` call over the union of every group's `entryIds`, not one call per
group. Keep every existing flag warning, because each one names a real script failure:

- Join the IDs with commas, not JSON, and use no spaces.
- `--bodies` is the flag's only spelling, and the script exits `1` on anything else.
- The script prints one JSON line, not the records. Read `outputPath` from that line and
  parse the JSON array it names.

Keep the command spelling `bun <bodyFetchPath> --bodies <id1,id2,id3>` exactly.

### Bake the given number into both places

State that each draft takes its group's `adrNumber`. The number goes into the record H1 as
`# ADR-0027:` and into the proposed path as `docs/adr/<NNNN>-<kebab-title>.md`, where
`<NNNN>` is the four-digit zero-padded `adrNumber`.

Name the failure this prevents. The `adr-validate.ts` rule `id-mismatch` compares the
filename number to the H1 number. A drift between the two fails validation after the
record is already written.

### Replace the return shape

The last line currently pins a singular literal:

```json
{"draftText":"<complete record text ready to be written>","proposedPath":"docs/adr/0001-....md"}
```

Replace it with the batch literal:

```json
{"drafts":[{"groupId":"g1","draftText":"<complete record text ready to be written>","proposedPath":"docs/adr/0027-....md"}]}
```

State three rules with it. Return one entry per input group. Keep the input order. Carry
the same `groupId` through.

### Keep every preserved rule

Do not drop any of these while you rewrite:

- Run no mutating command at all.
- Return the draft text, and never save it.
- Never invoke the archiver.
- Set status from implementation state, not from your own confidence or draft quality.
- Include a durable evidence summary with session ID, entry ID, and date.
- Never cite a `.cockpit` path in evidence.
- Exclude secrets, credentials, personal data, and raw transcript text.

### State the cap

Accept at most 12 groups in one call. Above 12, refuse and report the count. Never truncate
the list, because a silent truncation drops records the human already approved.

### Word budget

Keep the mirror dense. STE-lite rule R13 caps a rewrite at 15% growth over the original,
but that budget governs a style rewrite. This change adds contract rules the file never
carried, so some growth is the honest cost. Add no sentence that carries no rule.

## Acceptance criteria

- [x] `packages/chronicle/agents-codex/codifier.toml` contains `groups`, `groupId`, and
      `adrNumber`.
- [x] The file contains the `drafts` array literal, with `groupId`, `draftText`, and
      `proposedPath` inside one array entry.
- [x] The file contains no `candidateIds`.
- [x] `adrIndex` survives in exactly one place: the clause stating that the Codifier never
      reads `adrIndex.nextNumber` for itself. It is gone from the received-input list.
- [x] The file contains no top-level singular return literal starting with
      `{"draftText":`.
- [x] `model = "gpt-5.6-terra"` and `model_reasoning_effort = "high"` are byte-identical to
      their current values.
- [x] The file parses as TOML and holds exactly one `developer_instructions` string key.
- [x] The brief states the one-call body fetch over the union of every group's `entryIds`,
      and keeps the comma-joined, no-spaces, `--bodies`-only, exit-`1`, and `outputPath`
      warnings.
- [x] The brief states that `adrNumber` sets both the H1 and the proposed path, and names
      the `adr-validate.ts` rule `id-mismatch` as the reason.
- [x] The brief states the 12-group cap and refuses above it.
- [x] The brief still carries every preserved rule: no mutating command, never save, never
      invoke the archiver, status from implementation state, evidence with session ID and
      entry ID and date, no `.cockpit` path, no secrets or raw transcript text.
- [x] No file outside `packages/chronicle/agents-codex/codifier.toml` is modified.

## Verification

- [x] Run `grep -n "groups\|groupId\|adrNumber\|drafts" packages/chronicle/agents-codex/codifier.toml`
      and confirm every one of the four strings appears.
- [x] Run `grep -n "candidateIds" packages/chronicle/agents-codex/codifier.toml`
      and confirm it exits `1` with no output.
- [x] Run `grep -o "adrIndex" packages/chronicle/agents-codex/codifier.toml | wc -l` and
      confirm the count is `1`. Use `grep -o … | wc -l`, not `grep -c`: this file packs a
      paragraph onto one line, so `grep -c` would report `1` for any number of mentions.
- [x] Run `grep -n '{"draftText"' packages/chronicle/agents-codex/codifier.toml` and
      confirm it exits `1` with no output.
- [x] Run `grep -n '^model = "gpt-5.6-terra"$' packages/chronicle/agents-codex/codifier.toml`
      and `grep -n '^model_reasoning_effort = "high"$' packages/chronicle/agents-codex/codifier.toml`,
      and confirm each returns exactly one line.
- [x] Run `bun -e 'const t = Bun.TOML.parse(await Bun.file("packages/chronicle/agents-codex/codifier.toml").text()); console.log(Object.keys(t).join(","), typeof t.developer_instructions)'`
      and confirm it prints `model,model_reasoning_effort,developer_instructions string`.
      `Bun.TOML.parse` exists in Bun 1.3.13. If your runtime lacks it, read the file
      instead and confirm one opening `"""` and one closing `"""`.
- [x] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it passes. This task
      changes no script, so a failure means an edit landed out of scope.
- [x] Read `packages/chronicle/agents-codex/codifier.toml` end to end beside
      `packages/chronicle/agents/codifier.md`, and confirm every rule in the Markdown source
      survives in the mirror.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name differs from the frozen contract, or the singular `draftText`/`proposedPath` return literal survives. | The `groups` and `drafts` literals are right, but a rule is softened — the fetch is per group, `adrIndex` still names an input, or the cap is missing. | Both literals match the frozen contract character for character, the union fetch is explicit, `adrIndex` appears only in the never-counts clause, and the cap refuses above 12. |
| Completeness | ×2 | A preserved rule is dropped, or `model` and `model_reasoning_effort` changed. | The contract landed but a preserved rule thinned out, for example the evidence rule lost session ID or date. | Every preserved rule survives, both tuning keys are byte-identical, and the file parses as TOML with one `developer_instructions` string. |
| Readability | ×1 | The mirror grew headed sections, bullet lists, or a second string key. | Dense prose, but the paragraph order was reshuffled, so the diff hides the contract change. | Dense prose in the existing three-paragraph order, so the diff shows only the contract change. |
| Assumptions and docs | ×1 | The brief invents a behavior the frozen contract does not define, such as renumbering or truncation. | The `adrNumber` rule is stated with no reason, so a later editor cannot tell it is load-bearing. | Each non-obvious rule names its failure, including `id-mismatch` for the H1-versus-path match. |

## Out of scope

- `packages/chronicle/agents-codex/lorekeeper.toml` and
  `packages/chronicle/agents-codex/barrowkeeper.toml` — Deferred. Each mirror compresses its
  own Markdown source and carries its own contract edge.
- `packages/chronicle/agents/codifier.md` — Deferred. It is already converted; this task
  only compresses it.
- `packages/chronicle/agents-codex/gleaner.toml` and
  `packages/chronicle/agents-codex/reckoner.toml` — Deferred. Neither agent sees the batch
  contract.
- Retuning `model` or `model_reasoning_effort` — Deferred. Reason: the tiered reasoning
  effort per role is a separate recorded decision.

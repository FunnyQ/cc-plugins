# REVIEW-01: Final review 🏁

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/02, codex/01, codex/02, codex/03
> **Status**: todo
> **Final review**: true

## Goal

The seven edited instruction files describe one batch contract, with no stale singular
field left anywhere, and `chronicle:adr` can promote N records in one triage run.

## Files to create / modify

Read all seven. Fix any file that fails a check below. Change nothing else.

- `packages/chronicle/skills/adr/SKILL.md` (review, fix if needed) — gate protocols, batch
  mechanics, recovery section
- `packages/chronicle/agents/codifier.md` (review, fix if needed) — drafts N records
- `packages/chronicle/agents/lorekeeper.md` (review, fix if needed) — draft and commit
  phase contracts
- `packages/chronicle/agents/barrowkeeper.md` (review, fix if needed) — batch write,
  validate, archive
- `packages/chronicle/agents-codex/codifier.toml` (review, fix if needed) — Codex mirror
- `packages/chronicle/agents-codex/lorekeeper.toml` (review, fix if needed) — Codex mirror
- `packages/chronicle/agents-codex/barrowkeeper.toml` (review, fix if needed) — Codex
  mirror

## Implementation notes

This is the holistic gate. It scores integration, cross-file agreement, regressions, and
whether the goal was met. It does not re-score the individual pieces of work that landed
before it.

You are the last writer in this tree. Every edit you apply is gated only by your own
`## Verification`. Run that section again after any fix.

### The file list

Every command below reuses one list. Set it once per shell:

```bash
FILES="packages/chronicle/skills/adr/SKILL.md \
packages/chronicle/agents/codifier.md \
packages/chronicle/agents/lorekeeper.md \
packages/chronicle/agents/barrowkeeper.md \
packages/chronicle/agents-codex/codifier.toml \
packages/chronicle/agents-codex/lorekeeper.toml \
packages/chronicle/agents-codex/barrowkeeper.toml"
```

### Check 1 — cross-file contract agreement

Read every payload shape in all seven files against `../_context/contract.md`. Every field
name must match that file exactly.

Then pair each Markdown agent with its Codex mirror and diff the contract by eye:

| Markdown agent | Codex mirror |
| --- | --- |
| `packages/chronicle/agents/codifier.md` | `packages/chronicle/agents-codex/codifier.toml` |
| `packages/chronicle/agents/lorekeeper.md` | `packages/chronicle/agents-codex/lorekeeper.toml` |
| `packages/chronicle/agents/barrowkeeper.md` | `packages/chronicle/agents-codex/barrowkeeper.toml` |

Each pair must agree on every literal JSON shape, character for character in the field
names. The mirror compresses prose. It never compresses a field name, a refusal, or a
rule. Nothing cross-validates these two copies at runtime, so a drift here breaks Codex
silently. That is the failure this check exists to prevent.

### Check 2 — stale strings gone

```bash
grep -n 'newAdr"\|newAdr\b' $FILES
grep -n 'candidateIds' $FILES
grep -n '"notes"\|`notes`' $FILES
grep -n 'draftText\|proposedPath' $FILES
```

Expected results:

- `newAdr` as a singular field name: zero hits. Only `newAdrs` survives. A hit inside a
  refusal sentence is legal, and only there — the files must tell a stale caller that
  `newAdr` is an unknown field.
- `candidateIds`: zero hits. `groups` replaced it.
- The gate-1 `notes` field: zero hits. The `group` field replaced the free-text workaround.
- `draftText` and `proposedPath`: hits are expected in prose, and prose hits are legal
  anywhere. Judge only the JSON return shapes. Read every fenced JSON block that defines a
  phase return or an agent output, and confirm neither token is a top-level field in any of
  them. Both belong inside a `drafts[]` entry or a gate-2 verdict entry. The lorekeeper's
  draft-phase return carries `drafts`, never a top-level `draftText` and `proposedPath`
  pair.

### Check 3 — new strings present

```bash
grep -c 'newAdrs' $FILES
grep -c 'drafts' $FILES
grep -c 'groups' $FILES
grep -c 'adrNumber' $FILES
grep -c 'verdicts' $FILES
grep -c 'group' $FILES
```

Confirm each string appears in the files that should carry it:

| String | Must appear in |
| --- | --- |
| `newAdrs` | `SKILL.md`, `lorekeeper.md`, `barrowkeeper.md`, and both of their mirrors |
| `drafts` | `SKILL.md`, `codifier.md`, `lorekeeper.md`, and both of their mirrors |
| `groups` | `SKILL.md`, `codifier.md`, `lorekeeper.md`, and both of their mirrors |
| `adrNumber` | `SKILL.md`, `codifier.md`, `lorekeeper.md`, and both of their mirrors |
| `verdicts` | `SKILL.md` |
| `group` (gate-1 field) | `SKILL.md` |

A zero count in a file that needs the string is a defect. Report it and fix it.

### Check 4 — non-goals held

```bash
git diff --stat -- packages/chronicle/skills/adr/scripts/
git diff --stat -- packages/chronicle/agents/gleaner.md packages/chronicle/agents/reckoner.md
git diff --stat -- packages/chronicle/agents-codex/gleaner.toml packages/chronicle/agents-codex/reckoner.toml
```

All three must print nothing. Read the seven files and confirm:

- `supersede <adr-id>` still replaces one record per run.
- `metadataUpdate` is still a single object, never an array.
- No rollback semantics appeared anywhere. `Archive, never delete` still holds.
- No delete semantics appeared anywhere.
- No renumbering appeared anywhere. A dropped draft leaves a permanent number gap,
  because reusing a number would make an id ambiguous across git history.

### Check 5 — preserved rules survived the rewrites

These rules predate this change. A rewrite that drops one is a regression, not a
simplification. Confirm each is still present and still says what it said:

- **The three always-required commit paths.** `planPath`, `validatorPath`, and
  `archiverPath` are all required. Missing any one is a `PHASE MISSING INPUT` refusal, and
  the barrowkeeper is not spawned.
- **The no-promotion branch.** A commit with neither `newAdrs` nor `metadataUpdate` is the
  normal no-promotion path, not a missing input. The exception covers the two optional
  inputs only. It never softens the three required paths.
- **`Archive, never delete`.** Reconstruction reaches into the archive, and a wrong record
  must stay correctable.
- **Never cite a `.cockpit` path in evidence.** Those logs can be deleted by hand, and
  `.cockpit/` never enters git, so a path reference is guaranteed to rot.
- **The lorekeeper child protocol.** One child per phase, spawned once, never two together
  and never in parallel. One codifier drafts all N groups. This change does not add a
  second child or a parallel spawn.

### Check 6 — leanness

Score the judgement, not the line count. Ask one question of every addition: does
`../_context/contract.md` require it?

Name any rule, field, branch, or refusal that appeared in these seven files and that the
frozen contract does not define. Common shapes to look for:

- A field invented to carry state the contract already carries.
- A partial-batch or per-record retry branch the contract does not define.
- A second spelling for a thing the contract already named.
- A configuration knob nobody sets.

Report each one with the file and the line. Delete it, unless it prevents a failure you can
name in one sentence.

### Check 7 — batch cap sanity

The cap is 12 groups per run. It is a judgment call from one measured 26-group run, not a
measured limit. Q reported that the limit in that run was fatigue, not failure.

Read the codifier's converted instructions and judge whether they read as fragile at 12:

- One `--bodies` call over the union of 12 groups' entry ids.
- 12 complete records drafted in one agent turn, each with its own pre-allocated
  `adrNumber` baked into both the H1 and the proposed path.
- One returned `drafts` array holding 12 complete record bodies.

State the verdict plainly in the report. Say that the cap is a judgment call, whether or
not you recommend changing it. Silence here reads as measured confidence the tree does not
have.

## Acceptance criteria

- [ ] Every payload shape in all seven files matches `../_context/contract.md` field for
      field.
- [ ] Each Markdown agent and its Codex mirror agree on every literal JSON shape.
- [ ] `newAdr` as a field name, `candidateIds`, and the gate-1 `notes` field return zero
      hits across the seven files, except inside an unknown-field refusal.
- [ ] In every fenced JSON block that defines a phase return or an agent output, neither
      `draftText` nor `proposedPath` is a top-level field. Both sit inside a `drafts[]`
      entry or a gate-2 verdict entry. Prose mentions of either token are legal anywhere and
      are not checked.
- [ ] `newAdrs`, `drafts`, `groups`, `adrNumber`, `verdicts`, and the gate-1 `group` field
      each appear in the files that should carry them.
- [ ] `supersede` still replaces one record per run, `metadataUpdate` is still a single
      object, and no rollback, delete, or renumbering semantics appeared anywhere.
- [ ] The five preserved rules of check 5 are present and unchanged in meaning.
- [ ] Every addition the frozen contract does not require is either removed or justified in
      the report by the failure it prevents.
- [ ] The report states a plain verdict on the 12-group cap, and says the cap is a judgment
      call rather than a measured limit.

## Verification

- [ ] Run `bun test packages/chronicle/` and confirm it passes. No task in this tree
      changes a script, so a failure means an edit landed out of scope.
- [ ] Set `FILES` to the seven paths, then run `grep -n 'newAdr\b' $FILES` and confirm
      every hit is an unknown-field refusal.
- [ ] Run `grep -n 'candidateIds' $FILES` and confirm zero hits.
- [ ] Run `grep -n 'notes' $FILES` and confirm no hit is the gate-1 response field.
- [ ] Run `grep -n 'draftText\|proposedPath' $FILES` and confirm no hit is a top-level
      phase-return field.
- [ ] Run `grep -c 'newAdrs' $FILES`, `grep -c 'drafts' $FILES`, `grep -c 'groups' $FILES`,
      `grep -c 'adrNumber' $FILES`, and `grep -c 'verdicts' $FILES`, then confirm each
      count against the table in the notes above.
- [ ] Run `git diff --stat -- packages/chronicle/skills/adr/scripts/` and confirm it prints
      nothing.
- [ ] Read all seven files end to end once, after every fix, and confirm each reads as one
      voice with no half-converted section.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted
> average > 4.0 to pass; Contract fidelity < 4 is an automatic veto. This table scores the
> whole deliverable, never one file.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A stale singular field still drives a live path, or a shape the contract defines is absent from the file that must carry it | A Markdown agent and its Codex mirror disagree on one field name, or one rule is stated in one copy and dropped from the other | Every field name and rule matches the frozen contract, and each mirror pair agrees character for character |
| Completeness | ×2 | A file in the seven was never converted | One file holds a converted section beside a sibling section still written in the singular | All seven read as one batch contract, with no half-converted section anywhere |
| Readability | ×1 | A reader cannot tell which shape a phase returns | Correct content, but stacked em dashes, sentences over 25 words, or a second term for a thing already named | One voice across all seven, STE-lite rules held, one term per thing |
| Assumptions and docs | ×1 | A behavior appears that the contract never defined, with no reason given | A load-bearing rule is stated with no reason, so a later editor cannot tell whether it can go | Every non-obvious rule names the failure it prevents, and the 12-group cap is flagged as a judgment call |
| Leanness | ×1 | The change added a field, a branch, or a knob the contract does not require, and it is now load-bearing | One unrequired addition survives, unjustified but harmless | Nothing survives that the frozen contract does not require, and every kept addition names the failure it prevents |

## Out of scope

- Re-scoring the individual file conversions. Each was gated by its own rubric. This gate
  scores integration, consistency, regressions, and whether the goal was met.
- Any change to `packages/chronicle/skills/adr/scripts/`. No script changes in this tree,
  and a script edit here would mean the review itself broke the non-goal it checks.
- Any change to the gleaner or the reckoner, in Markdown or in TOML. Both are explicitly
  out of scope for the whole change.
- Committing, tagging, or pushing. Q commits after the tree lands.
- Raising or lowering the 12-group cap without Q's word. Report the verdict, and let Q
  decide.

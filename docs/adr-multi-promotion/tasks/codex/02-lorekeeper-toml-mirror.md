# CODEX-02: Lorekeeper TOML mirror

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: agents/02
> **Status**: todo

## Goal

`packages/chronicle/agents-codex/lorekeeper.toml` carries the same batch contract as its
Markdown source, so a Codex run of the ADR skill drafts and commits N records instead of
one.

## Files to create / modify

- `packages/chronicle/agents-codex/lorekeeper.toml` (modify) — compress the landed batch
  contract into the Codex mirror's `developer_instructions` brief.

## Implementation notes

### Read the Markdown source first

`packages/chronicle/agents/lorekeeper.md` has already been converted to the batch
contract. Read that file before you touch the mirror, and mirror what it actually says.
Do not reconstruct the contract from memory.

If the Markdown source and `../_context/contract.md` ever disagree, `../_context/contract.md`
wins. Report the disagreement in your result. Do not encode a contradiction into the
mirror.

### Why this task exists at all

Nothing cross-validates the TOML mirror against its Markdown source. There is no test, no
linter, and no build step that compares the two files. A contract change that lands in the
Markdown agent and skips the mirror breaks Codex silently: the Claude path promotes N
records while the Codex path still asks for a single `newAdr` that no caller sends any
more.

### The file you are editing

The mirror has three top-level keys. `developer_instructions` is one triple-quoted string
holding 6 paragraphs and roughly 332 words. Keep all three keys, keep the triple-quoted
shape, and keep the 6-paragraph order.

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
developer_instructions = """
<paragraph 1 — role, no gate, one phase per invocation, never re-run a previous phase>

<paragraph 2 — per-phase requirements and which child each phase spawns>

<paragraph 3 — every path arrives absolute, never search for a script>

<paragraph 4 — the no-promotion exception>

<paragraph 5 — registered sibling selectors and the generic-runtime fallback>

<paragraph 6 — the return literals>
"""
```

Keep `model = "gpt-5.6-terra"` and `model_reasoning_effort = "medium"` byte-identical.
This change does not retune any agent.

### Edit 1 — the draft phase takes `groups`

Paragraph 2 currently requires `candidateIds`, `bodyFetchPath`, `templatePath`, and
`adrIndex` for the draft phase. Replace `candidateIds` with `groups`, and drop `adrIndex`
from that phase's requirements. The draft phase now requires `groups`, `bodyFetchPath`,
and `templatePath`.

`adrIndex` is dropped because the main agent pre-allocates every record number before the
draft phase starts. The Codifier never counts.

**A trap: `adrIndex` appears twice in that same paragraph.** The collect-phase sentence
spawns `chronicle_reckoner` with the Gleaner result's `outputPath` and `adrIndex`. That
occurrence stays. Only the draft-phase occurrence goes. A blind search-and-replace breaks
the collect phase.

The shape the draft phase now receives:

```json
{
  "groups": [
    { "groupId": "g1", "entryIds": ["id-1", "id-2"], "adrNumber": 27 },
    { "groupId": "g2", "entryIds": ["id-3"], "adrNumber": 28 }
  ]
}
```

At most 12 groups arrive per run.

### Edit 2 — the commit phase takes `newAdrs`

Paragraph 2 currently names the optional commit input `newAdr`, with the inline shape
`{"path":...,"content":...}`. Rename it to `newAdrs`, an array of `{path, content}`
objects:

```json
{
  "newAdrs": [{ "path": "docs/adr/0027-....md", "content": "..." }]
}
```

Add the refusal in the same paragraph: `newAdr` is an unknown field, and a caller that
sends it is refused by name. State the reason. A silent fallback would write one record
out of five.

Keep `metadataUpdate` a single object. It is not batched. Keep `newAdrs` and
`metadataUpdate` independently optional, and keep the instruction to omit `newAdrs`
entirely rather than send an empty array.

### Edit 3 — the no-promotion exception names `newAdrs`

Paragraph 4 states that a commit with neither `newAdr` nor `metadataUpdate` is the normal
no-promotion path. Rename that occurrence to `newAdrs`.

Keep the whole exception and its reason: a triage run where every candidate was `watch` or
`skip` still has an approved archive plan to apply, and a refusal there would strand the
plan and leave the inbox untriageable. Keep the closing clause that the exception covers
the two optional inputs only, and never softens the three required paths.

After this edit and Edit 2, the bare token `newAdr` survives in exactly one place: the
refusal clause.

### Edit 4 — the draft return literal becomes `drafts`

Paragraph 6 holds three return literals. Replace the draft one only:

- Before: `{"phase":"draft","draftText":"...","proposedPath":"docs/adr/...md"}`
- After: `{"phase":"draft","drafts":[{"groupId":"g1","draftText":"...","proposedPath":"docs/adr/0027-....md"}]}`

Leave the collect literal and the commit literal exactly as they are. Leave the
`PHASE MISSING INPUT` refusal line exactly as it is.

One draft entry comes back per input group, in the same order, with the same `groupId`.

### Preserve every existing rule

Carry all of these through unchanged in meaning:

- `planPath`, `validatorPath`, and `archiverPath` are all required for the commit phase.
  Missing any one is a `PHASE MISSING INPUT` refusal, and the Lorekeeper does not spawn the
  Barrowkeeper, which has no fallback for an absent path.
- A phase that arrives without its carry-over stops and reports the missing input. It never
  re-runs the previous phase.
- Every path arrives absolute from the caller. A path you were not given is a missing
  input, never a reason to search. Do not read the skill directory, do not glob the plugin
  cache, and never spawn a search agent.
- Spawn children sequentially. Never spawn helpers.
- A launch receipt is never a result.
- The registered-sibling selector names stay `chronicle_gleaner`, `chronicle_reckoner`,
  `chronicle_codifier`, and `chronicle_barrowkeeper`.
- The generic-runtime fallback stays: use the same task name, and tell the child to read
  `$CODEX_HOME/agents/chronicle/<role>.toml`, resolving `CODEX_HOME` from the environment
  and defaulting to `~/.codex`.

### Voice

The mirror is a compression, never a copy. Write dense prose paragraphs, not headed
sections and not bullet lists. Match the voice already in the file.

Keep the word budget: the rewritten `developer_instructions` may not exceed the original
332 words by more than 15%, so 382 words is the ceiling. The edits add a refusal clause and
one longer JSON literal. That is roughly 25 words. A mirror that grows past the ceiling has
been rewritten instead of compressed.

## Acceptance criteria

- [ ] `model = "gpt-5.6-terra"` and `model_reasoning_effort = "medium"` are byte-identical
      to their current values.
- [ ] `developer_instructions` is still one triple-quoted string holding 6 paragraphs, in
      the same topic order, at 382 words or fewer.
- [ ] The draft-phase requirements name `groups`, `bodyFetchPath`, and `templatePath`.
      `candidateIds` appears nowhere in the file.
- [ ] `adrIndex` still appears exactly once, in the collect-phase sentence.
- [ ] The commit-phase optional input is `newAdrs`, an array of `{path, content}`, and the
      no-promotion exception names `newAdrs` too.
- [ ] The bare token `newAdr` appears exactly once, inside the refusal clause that names it
      an unknown field and gives the reason.
- [ ] The draft return literal shows `drafts`; the collect literal and the commit literal
      are unchanged.
- [ ] The three required commit paths, the `PHASE MISSING INPUT` refusal, the no-promotion
      exception, and all four `chronicle_*` selector names are still present.

## Verification

- [ ] Run `grep -nE 'groups|newAdrs|drafts' packages/chronicle/agents-codex/lorekeeper.toml`
      and confirm all three new field names are present.
- [ ] Run `grep -c 'candidateIds' packages/chronicle/agents-codex/lorekeeper.toml` and
      confirm it prints `0`.
- [ ] Run `grep -nE 'newAdr([^s]|$)' packages/chronicle/agents-codex/lorekeeper.toml` and
      confirm exactly one hit, inside the refusal clause.
- [ ] Run `grep -o 'adrIndex' packages/chronicle/agents-codex/lorekeeper.toml | wc -l` and
      confirm it prints `1`, then read that line to confirm it is the collect-phase
      sentence. Count occurrences this way, never with `grep -c`, which counts matching
      lines and would report `1` while both occurrences sit on one line.
- [ ] Run `grep -nE 'chronicle_gleaner|chronicle_reckoner|chronicle_codifier|chronicle_barrowkeeper|PHASE MISSING INPUT|CODEX_HOME' packages/chronicle/agents-codex/lorekeeper.toml`
      and confirm every preserved rule is still there.
- [ ] Run `bun -e 'const t = Bun.TOML.parse(await Bun.file("packages/chronicle/agents-codex/lorekeeper.toml").text()); console.log(Object.keys(t), t.model, t.model_reasoning_effort, t.developer_instructions.trim().split(/\s+/).length)'`
      and confirm it parses, prints the three keys, the two unchanged values, and a word
      count at 382 or below. If `Bun.TOML.parse` is unavailable in the installed Bun, read
      the file top to bottom instead and confirm the triple quotes still close.
- [ ] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it still passes. No
      script changed, so a failure means something out of scope was edited.
- [ ] Read `packages/chronicle/agents/lorekeeper.md` and the finished mirror side by side.
      Confirm every field name matches character for character.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted
> average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name differs from the Markdown source, or the draft return literal still shows the singular `draftText`/`proposedPath` pair | Field names match but the `newAdr` refusal is missing, or the collect-phase `adrIndex` was deleted along with the draft-phase one | `groups`, `newAdrs`, and `drafts` match the source character for character, the refusal names `newAdr` and its reason, and the collect-phase `adrIndex` survives |
| Completeness | ×2 | An edit was skipped, so one paragraph still describes a single-record commit | All four edits landed but a preserved rule was dropped, for example a selector name or the no-promotion reason | All four edits landed and every preserved rule, refusal, and selector name is still present |
| Readability | ×1 | The brief was reorganized into headed sections or bullet lists, so a reader diffing the two files sees a rewrite | Dense prose kept, but the paragraph order shifted or the word budget was exceeded | Dense prose in the original voice, 6 paragraphs in the original order, inside the 382-word ceiling |
| Assumptions and docs | ×1 | The mirror states a rule the contract does not define, for example a rollback or a renumbering step | The refusal or the batch cap is stated with no reason, so a later editor cannot tell it is load-bearing | Every new rule carries the failure it prevents, and nothing beyond the frozen contract was invented |

## Out of scope

- Editing `packages/chronicle/agents/lorekeeper.md` — Deferred. That conversion lands
  before this task starts. Mirror it; do not re-edit it.
- Editing `codifier.toml` or `barrowkeeper.toml` — Deferred. Each mirror is converted
  beside its own Markdown source, so two tasks never contend for one file.
- Batching `metadataUpdate` — Deferred. Supersession stays one record per run, because a
  two-write partial-failure mode multiplies badly across a batch.
- Retuning `model` or `model_reasoning_effort` — Deferred. This change alters the contract,
  never the agent's cost profile.

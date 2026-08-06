# CODEX-03: Barrowkeeper TOML mirror

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: agents/03
> **Status**: todo

## Goal

The Codex Barrowkeeper writes a batch of ADR records, because its TOML mirror now carries
the same batch contract as its Markdown source.

## Files to create / modify

- `packages/chronicle/agents-codex/barrowkeeper.toml` (modify) — compress the landed batch
  contract into the Codex mirror.

## Implementation notes

### Why this mirror is in scope

Nothing cross-validates the TOML mirror against its Markdown source. No test reads either
file. No linter compares them. A contract change that skips the mirror breaks Codex
silently, and the break appears only when a Codex-side run writes one record out of five.

The output literals in this file are what a Codex-side caller parses. Treat them as the
load-bearing part of the change.

### Read the Markdown source first

`packages/chronicle/agents/barrowkeeper.md` has already been converted to the batch
contract. Read all of it before you edit the mirror. Mirror what that file actually says,
not what you expect it to say.

If the Markdown source and `../_context/contract.md` ever disagree, the frozen contract
wins. Report the disagreement in your result line.

### Shape to preserve

The file has exactly three keys and three prose paragraphs. Keep both counts.

```toml
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
developer_instructions = """
<paragraph 1 — inputs and the write order>

<paragraph 2 — refusals and failure handling>

<paragraph 3 — the return literals>
"""
```

Keep `model = "gpt-5.6-luna"` and `model_reasoning_effort = "low"` byte-identical. This
change does not retune the agent. Keep `developer_instructions` as one triple-quoted
string.

The mirror is a compression, never a copy. Write dense prose paragraphs, not headed
sections and not bullet lists.

### Paragraph 1 — inputs and the write order

Rename the single `newAdr` input to `newAdrs`, an array of `{path, content}` objects. The
caller sends this shape:

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

Keep `metadataUpdate` a single object. It is not batched.

Keep these input rules from the current paragraph, unchanged in meaning:

- `planPath`, `validatorPath`, and `archiverPath` are always present.
- Both write kinds may be absent. A triage run that promoted nothing commonly sends
  neither.
- Take an approved plan path, never raw assignments.

Rewrite the order sentence to this batch order:

1. Check every `newAdrs[].path` for an existing file. If any path exists, refuse the whole
   batch and write nothing.
2. Write all records.
3. Apply `metadataUpdate`.
4. Validate as `bun <validatorPath> <docs/adr directory>`.
5. Archive as `bun <archiverPath> --plan <planPath> --apply`.

State why the collision check moves ahead of every write. A per-record check would let
record 1 land and record 3 collide, which leaves a half-written batch with no rollback.
Checking every path first makes the refusal total.

### Paragraph 2 — refusals to preserve

Carry every current rule through, unchanged in meaning:

- Never delete.
- Refuse a new-record target path that already exists rather than overwriting it.
- Require an existing target for a lifecycle-metadata update.
- Touch only `Status`, `Supersedes`, `Superseded by`, and `Deprecated` on that update.
- Never change a record body.
- On partial failure, do not roll back, and skip archiving.
- Skip archiving on validation errors, leave successful writes intact, and report exact
  failures.
- The validator exits `0` when only warnings fired. Treat warnings as non-blocking,
  because an empty evidence section is legal.

### Paragraph 3 — the return literals

Replace all four literals. Keep the mirror's compact single-line JSON style.

Copy the first three from the frozen contract with their arrays empty, exactly as written
there. An empty array is the placeholder, not a claim that the run wrote nothing. Writing a
populated example here would make the mirror and its Markdown source differ on a literal
the closing review compares.

Success:

```json
{"success":true,"newAdrPaths":[],"validated":true,"archived":true}
```

Path collision, returned before any write:

```json
{"success":false,"reason":"path-collision","collisions":[]}
```

Validation error, returned after the writes landed:

```json
{"success":false,"reason":"validation-error","newAdrPaths":[],"violations":[],"archived":false}
```

Metadata-update failure after the records landed:

```json
{"success":true,"newAdrPaths":["docs/adr/...md"],"metadataUpdateFailed":true,"error":"metadata update failed for <path>: <details>","archived":false}
```

Two notes on the rename:

- `newAdrPaths` is always present on the success shape. Send `[]` when the run promoted
  nothing. The old rule omitted the field instead. An always-present array lets a caller
  tell "wrote nothing" apart from "field missing", and the frozen contract's success
  literal shows `[]`.
- `newAdrPaths` on the validation-error shape is new. The recovery procedure needs to know
  which records landed before validation failed.

`collisions` carries every colliding path, not the first one. A caller that renumbers by
hand needs the full list.

## Acceptance criteria

- [ ] `packages/chronicle/agents-codex/barrowkeeper.toml` names `newAdrs` as an array of
      `{path, content}`.
- [ ] No bare `newAdr` field name survives in the file.
- [ ] No bare `newAdrPath` field name survives in the file.
- [ ] All four return literals carry `newAdrPaths`, or `collisions` for the collision
      shape.
- [ ] The `path-collision` reason string is present.
- [ ] The documented order puts the collision pre-check ahead of every write, and states
      why.
- [ ] `metadataUpdate` is still described as a single object.
- [ ] `model = "gpt-5.6-luna"` and `model_reasoning_effort = "low"` are unchanged.
- [ ] `developer_instructions` is still one triple-quoted string with three paragraphs.

## Verification

- [ ] Run `grep -c 'newAdrs' packages/chronicle/agents-codex/barrowkeeper.toml` and
      confirm the count is at least 1.
- [ ] Run `grep -nE 'newAdr[^sP]|newAdrPath[^s]' packages/chronicle/agents-codex/barrowkeeper.toml`
      and confirm it prints nothing.
- [ ] Run `grep -n 'path-collision\|newAdrPaths\|collisions' packages/chronicle/agents-codex/barrowkeeper.toml`
      and confirm all three strings appear.
- [ ] Run `grep -n 'gpt-5.6-luna\|model_reasoning_effort = "low"' packages/chronicle/agents-codex/barrowkeeper.toml`
      and confirm both lines are intact.
- [ ] Run `bun -e 'const t = Bun.TOML.parse(await Bun.file("packages/chronicle/agents-codex/barrowkeeper.toml").text()); console.log(Object.keys(t).join(","), t.model, t.model_reasoning_effort)'`
      and confirm it prints `model,model_reasoning_effort,developer_instructions gpt-5.6-luna low`.
      `Bun.TOML.parse` exists in Bun 1.3.13. If your runtime lacks it, read the file
      instead and confirm the three keys and the closing `"""` by eye.
- [ ] Run `bun test packages/chronicle/skills/adr/scripts/` and confirm it still passes.
      This task changes no script, so a failure means an edit landed out of scope.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted
> average > 4.0 to pass; Contract fidelity < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Contract fidelity | ×3 | A field name differs from the frozen contract, or a literal still reads `newAdr` / `newAdrPath`. | The four literals match but a rule is softened, or the collision check is not stated as total. | All four literals match the frozen contract, and the write order refuses the whole batch before any write. |
| Completeness | ×2 | A return literal or the input rename is missing. | The literals landed but a preserved refusal was dropped, or `metadataUpdate` drifted to an array. | Every input rule, every refusal, and all four literals are present. |
| Readability | ×1 | The mirror was rewritten as headed sections or bullet lists. | Dense prose, but a sentence runs past 25 words or stacks em dashes. | Three dense prose paragraphs in the mirror's existing voice, each sentence under the STE-lite limit. |
| Assumptions and docs | ×1 | A rule appears that the frozen contract does not define. | The collision pre-check is stated with no reason, so a later editor cannot tell it is load-bearing. | Every non-obvious rule names the failure it prevents, and nothing is invented. |

## Out of scope

- `packages/chronicle/agents-codex/codifier.toml` and
  `packages/chronicle/agents-codex/lorekeeper.toml` — Deferred. Each mirror has its own
  task, and each compresses a different Markdown source.
- `packages/chronicle/agents/barrowkeeper.md` — Deferred. That file is already converted
  when this task starts. Read it, never edit it.
- Batching `metadataUpdate` — Deferred. Supersession is one record per run, and its
  two-write partial-failure mode would multiply under a batch.
- Rollback of a partly written batch — Deferred. `Archive, never delete` holds, and the
  recovery path is a hand fix plus a re-run.

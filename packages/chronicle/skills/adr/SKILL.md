---
name: adr
description: >-
  Triage the cockpit decision trail as an inbox and promote the decisions that
  mattered into Architecture Decision Records under docs/adr/.
when_to_use: >-
  When the user wants to review the decision trail, record an architecture
  decision, or replace one. Human-invoked only — do NOT auto-fire from a Stop
  hook, a scribe run, or an incidental mention of a decision.
argument-hint: "triage | promote <candidate-or-topic> | supersede <adr-id>"
---

# Chronicle ADR

The **main agent** owns both confirmation gates and holds state between exactly
three Lorekeeper invocations: collect, draft, and commit. The nested
**Lorekeeper** orchestrator owns each phase and delegates its mechanics. It cannot
run the whole flow and return control at both gates because its first return ends
that orchestrator run. Pass the collected plan into draft, then pass the confirmed
draft, target path, metadata update, and archive plan into commit.

## Topology

```
chronicle:adr  (this skill — the main agent; owns both gates)
  ├─ lorekeeper(collect) → gleaner, reckoner   skeletons → clusters → dispositions + assignments
  ├─ [GATE 1]  Q confirms the dispositions
  ├─ lorekeeper(draft)   → codifier            draft the ADR from the confirmed candidates
  ├─ [GATE 2]  Q confirms the draft and its target path
  └─ lorekeeper(commit)  → barrowkeeper        write, apply any link update, validate, archive
```

Spawn each Lorekeeper as a nested custom agent, never a fork. Spawn one Lorekeeper
per phase, in one `Agent` call, with no `name`. This chain is nested and
sequential, not a team: never spawn the gleaner, the reckoner, the codifier, or
the barrowkeeper yourself, never run two phases at once, and never put two agents
in one message. It does not inherit
the main conversation. At gate 1, log `needs_your_call`, then use `cockpit wait`
in the main agent to receive Q's confirmed dispositions. At gate 2, present the
complete draft and target path, log `needs_your_call`, then use `cockpit wait`
again. Do not put either gate inside Lorekeeper. Do not use `AskUserQuestion` for
these gates because the cockpit wait/send bridge must hand control back to Q.

**If `cockpit wait --require-watcher` exits `4`** (`nobody is watching` — Q's
`answer-here` switch is off), fall back instead of retrying the wait or
silently switching to `AskUserQuestion`:

- **On Claude Code**, build a custom interactive HTML review page with the
  `Artifact` tool: gate 1 is a disposition ledger (one row per candidate, its
  disposition and reason, and controls to confirm or override it) with a
  live-updating decision summary and a "copy for chat" button; gate 2 is the
  full draft text per proposed ADR, collapsible per record, for a verbatim
  read-through.
- **On Codex**, which has no `Artifact` tool, print the same content as
  structured markdown directly in the transcript — the candidate ledger for
  gate 1, the full draft text for gate 2 — and ask Q to reply in the same
  terminal with the response block below. This is not `AskUserQuestion`: it is
  the same plaintext round-trip the Artifact path uses, over the terminal
  instead of a copy button.

Either path produces the same plaintext gate-1 response, which Q pastes or
types back. Require the complete set, not only the changed rows — a partial
reply is ambiguous about which candidates it leaves untouched:

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

`entryIds` must match a candidate's `entryIds` from the reckoner output
exactly — it is the candidate's identity, since candidates carry no separate
id field. `conflictResolutions` covers every entry in the reckoner's
`conflicts`. This schema has no field for merging two candidates into one ADR;
multi-candidate promotion is not yet wired through `draft` and `commit` (see
the codifier/barrowkeeper single-record limit below). Until that lands, note a
requested merge in free text under `notes` and apply it by hand — do not
invent a `mergeGroup` field the rest of the pipeline cannot consume.

Treat the parsed response as the gate response exactly as `cockpit wait` would
return it, including the consistency check above. Gate 2's response follows
the same shape: Q's reply is either an unqualified approval, or an edited
`draftText`/`proposedPath` pair Q pastes back for the one proposed ADR.

## Script paths

Only the main agent sees the skill's load-time "Base directory for this skill"
banner. A subagent does not. Resolve `$SKILL_DIR` from that banner and pass every
path each phase needs as an absolute path, in the spawn prompt. A child that has to
find a script starts searching the plugin cache — that is the caller's bug.

| Input | Path |
| --- | --- |
| `collectorPath`, `bodyFetchPath` | `$SKILL_DIR/scripts/collect-adr-context.ts` |
| `indexReaderPath` | `$SKILL_DIR/scripts/adr-index.ts` |
| `plannerPath` | `$SKILL_DIR/scripts/archive-plan.ts` |
| `templatePath` | `$SKILL_DIR/references/adr-template.md` |
| `validatorPath` | `$SKILL_DIR/scripts/adr-validate.ts` |
| `archiverPath` | `$SKILL_DIR/scripts/archive-logs.ts` |

`collect` takes `collectorPath`, `indexReaderPath`, `bodyFetchPath`, and
`plannerPath`. `draft` takes `bodyFetchPath` and `templatePath`. `commit` takes
`validatorPath` and `archiverPath`.

## `triage` — process the inbox

This is the primary entry point.

1. Spawn Lorekeeper in `collect` phase with the four collect paths above,
   `contextBrief`, the requested mode, and any explicit scope. It scans unarchived
   logs and the watched bucket. Scanning and judging are read-only.
2. Cluster by **decision**, not by session. Assign every candidate `promote`,
   `watch`, or `skip`, and give a reason. Surface assignments from candidates to
   their source sessions.
3. Present every disposition at gate 1. A triage is done when every stale session
   was dispositioned and every retained candidate is named, not when the inbox is
   empty. Deliberately leave sessions written in the last ten minutes behind.

   Before treating Q's gate-1 response as final, check it for internal
   contradictions the reckoner cannot see, since a merge or a conflict
   resolution is a gate-1-only decision the reckoner never produces or
   validates:

   - **A merge with a declined half.** If Q's response folds two candidates
     into one ADR, both must still be `promote`. If Q declined one, do not
     silently merge the declined content in and do not silently drop the
     merge — re-surface it: ask whether the surviving candidate stands alone
     or the merge itself is off.
   - **A watch item that contradicts its own conflict.** If a candidate is
     `watch` because of an entry in `conflicts`, and Q's response also
     resolves that same conflict, the disposition and the resolution must
     agree. If they don't, re-surface both choices for Q rather than guessing
     which one wins.

   Re-run this check after any correction Q makes in response to a flagged
   contradiction — a fix to one contradiction can introduce another.
4. After Q confirms, derive the archive target per session. **`watch` wins**: if
   any candidate drawn from a session is `watch`, archive that session to the
   watched bucket. Otherwise archive it to `done`.

   If gate 1 changed any disposition the reckoner assumed — overriding a
   candidate, or declining one half of a proposed `merge` — the reckoner's
   `assignments` and its `planPath` no longer match Q's decision. Never edit
   `moves[]` or any other field of the serialized plan by hand: a plan's
   `target`, `to`, and `from`/`fromBucket` are derived together, and hand
   patching one desyncs the rest. Instead: apply the confirmed overrides to
   the candidate dispositions, re-fold the `watch`-wins rule across every
   session those candidates touch (not just the overridden session — another
   candidate from the same session may still be `watch`), keep each row's
   original `from` untouched, serialize the corrected `assignments`, and
   re-run `bun <plannerPath> --assignments <corrected assignments JSON>`
   using the `plannerPath` retained from the collect-phase inputs. Pass the
   fresh `planPath` this produces — never a prose description of the
   overrides — into `commit`.

During collection, when a fresh candidate cluster matches an entry in the watched
bucket, pull the watched entry back in and re-judge the combined evidence. Watched
items never re-queue on their own.

### Promotion threshold

Require **at least one** of these durability signals:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the code alone.

Also require **at least one** of these longevity signals:

- The decision remains relevant across sessions or releases.
- The decision affects multiple modules, plugins, or future contributors.
- A reasonable maintainer may challenge or accidentally undo it later.

Reject a flat "any two of five" threshold. Almost every non-trivial decision
affects multiple modules and may be undone, so that form would promote nearly
everything. It would contradict the skill's non-goal of treating every
implementation choice as architecture.

Reject promotion when the material is a local implementation detail, temporary
workaround, mechanical convention, or caveat that belongs in code or operational
documentation.

### No-promotion branch

At gate 1, if no candidate is `promote`, say that approving the dispositions is
the last decision in this run. Skip draft and gate 2. Invoke commit with only the
approved plan; pass no `newAdr` and no `metadataUpdate`.

A promotion whose source sessions all proved live can produce a draft with an
empty archive plan. Writing and archiving are independently optional. If the run
produces neither, report a no-op instead of spawning commit with nothing to do.

## `promote <candidate-or-topic>` — direct promotion

Use this escape hatch when Q already knows what should become a record. Collect
the decision across all relevant sessions, including archived sessions. Ask only
for material information the logs cannot establish. Apply the same promotion
threshold and identify any existing ADR before drafting.

Pass the reconstructed candidate, confirmed facts, source assignments, and
archive plan into `draft`. Present the complete draft and proposed path at gate 2
before writing. Pass only the confirmed draft, path, and archive plan into
`commit`.

## `supersede <adr-id>` — replace an accepted record

Collect the existing ADR and the evidence for its replacement. Draft the
replacement first. After gate 2, write the replacement, then update only the old
record's successor lifecycle metadata. Never rewrite the old decision's context
or consequences.

This is two writes with no transaction. If the successor-link update fails after
the replacement lands, do not roll anything back. The new record is valid alone,
and its missing back-link is repairable by hand. Skip archiving in this mode:
archiving a session while its record is half-written removes the evidence needed
to finish the repair.

## Codex

Codex loads the same three-phase Lorekeeper boundary through one of two paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_lorekeeper` per phase. Pass the resolved absolute paths from
   **Script paths**, `contextBrief`, and the phase-specific carry-over state.
2. **Generic sub-agent API only**: verify stable role files exist under
   `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`). Spawn
   exactly one non-fork generic agent per phase with task name
   `chronicle_lorekeeper` and no inherited turns. Tell it to read and obey
   `developer_instructions` in `lorekeeper.toml` before handling the same inputs.

If neither path is available, tell Q to run `chronicle:install` and start a new
Codex thread. Do not replace the role boundary with an inline flow.

## Constraints

1. **Read the log directory, never the registry.** Measurement found 63 log files
   but only 27 registry entries. The registry reaps entries after 14 days, while
   the lost tail shows whether a decision held up.
2. **Never archive a live session.** Cockpit resolves the log path on every write.
   Moving an active log makes the next write recreate the original path, silently
   splitting one session across two files. The archiver enforces a 10-minute mtime
   guard. Do not work around it.
3. **Archive, never delete.** Reconstruction reaches into the archive, and a wrong
   record must remain correctable.
4. **Derive status from the decision's implementation state, never from the
   skill's confidence.** A promoted record is `Accepted` because the code already
   works that way.
5. **Embed a stable evidence summary plus session id, entry id, and date.** Never
   cite a `.cockpit` path. Logs can be deleted manually, and `.cockpit/` never
   enters git, so path references are guaranteed to rot.
6. **Exclude secrets, credentials, personal data, and raw transcript text from
   evidence.** Preserve the decision without leaking its surrounding conversation.
7. **`draft` and `commit` write exactly one ADR per invocation.** The codifier
   returns one `draftText`/`proposedPath` pair, and the barrowkeeper writes one
   `newAdr`. A triage with several `promote` candidates currently needs one
   `draft`/gate-2/`commit` cycle per candidate — there is no batched or merged
   multi-ADR path yet. Do not invent one inline; this is tracked as follow-up
   work, not a gap to paper over with an ad hoc multi-record payload.

## Edge Cases

- **No trail at all**: the collector reports it. Say plainly that there is nothing
  to triage and stop. Do not create `docs/adr/`.
- **A candidate matches an existing record**: disposition it `skip` and name the
  matching record instead of drafting a near-duplicate.
- **Conflicting evidence**: surface the conflict for Q's judgment at gate 1. Never
  silently treat the newest entry as the winner.

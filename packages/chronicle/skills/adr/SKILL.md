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

Spawn each Lorekeeper as a nested custom agent, never a fork. It does not inherit
the main conversation. At gate 1, log `needs_your_call`, then use `cockpit wait`
in the main agent to receive Q's confirmed dispositions. At gate 2, present the
complete draft and target path, log `needs_your_call`, then use `cockpit wait`
again. Do not put either gate inside Lorekeeper. Do not use `AskUserQuestion` for
these gates because the cockpit wait/send bridge must hand control back to Q.

## `triage` — process the inbox

This is the primary entry point.

1. Spawn Lorekeeper in `collect` phase with `$SKILL_DIR`, `contextBrief`, the
   requested mode, and any explicit scope. It scans unarchived logs and the
   watched bucket. Scanning and judging are read-only.
2. Cluster by **decision**, not by session. Assign every candidate `promote`,
   `watch`, or `skip`, and give a reason. Surface assignments from candidates to
   their source sessions.
3. Present every disposition at gate 1. A triage is done when every stale session
   was dispositioned and every retained candidate is named, not when the inbox is
   empty. Deliberately leave sessions written in the last ten minutes behind.
4. After Q confirms, derive the archive target per session. **`watch` wins**: if
   any candidate drawn from a session is `watch`, archive that session to the
   watched bucket. Otherwise archive it to `done`.

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
   `chronicle_lorekeeper` per phase. Pass `$SKILL_DIR` from the skill's load-time
   "Base directory" banner, `contextBrief`, and the phase-specific carry-over
   state.
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

## Edge Cases

- **No trail at all**: the collector reports it. Say plainly that there is nothing
  to triage and stop. Do not create `docs/adr/`.
- **A candidate matches an existing record**: disposition it `skip` and name the
  matching record instead of drafting a near-duplicate.
- **Conflicting evidence**: surface the conflict for Q's judgment at gate 1. Never
  silently treat the newest entry as the winner.

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
drafts, `newAdrs`, the optional `metadataUpdate`, and the archive plan into commit.

## Topology

```
chronicle:adr  (this skill — the main agent; owns both gates)
  ├─ lorekeeper(collect) → gleaner, reckoner   skeletons → clusters → dispositions + assignments
  ├─ [GATE 1]  the user confirms the dispositions
  ├─ lorekeeper(draft)   → codifier            draft the ADR from the confirmed candidates
  ├─ [GATE 2]  the user confirms the draft and its target path
  └─ lorekeeper(commit)  → barrowkeeper        write, apply any link update, validate, archive
```

Spawn each Lorekeeper as a nested custom agent, never a fork. Spawn one Lorekeeper
per phase, in one `Agent` call, with no `name`. This chain is nested and
sequential, not a team: never spawn the gleaner, the reckoner, the codifier, or
the barrowkeeper yourself, never run two phases at once, and never put two agents
in one message. It does not inherit
the main conversation. Do not put either gate inside Lorekeeper.

**Both gates are one local HTML page.** Never hand-write that page and never
hand-design it — `gatePagePath` renders it. Build the payload, serve it, and end
the turn:

1. Write a payload JSON to the scratchpad. Gate 1 takes `gate: 1`, `nextAdr`,
   `candidates` (each with `entryIds`, `title`, `reason`, `disposition`, and an
   optional `matchesAdr` and `hint`), an optional `conflicts`, and an optional
   `scan` for the header facts. Gate 2 takes `gate: 2` and `drafts`, each with
   `groupId`, `adrNumber`, `proposedPath`, and the codifier's `draftText` verbatim.
2. Run `bun "{gatePagePath}" --data "{payload.json}" --serve --open` **as a background
   command**. Pass `--lang zh-TW` when the cockpit decision-log language is zh-TW.
3. Report the served URL to the user and end the turn. Do not poll the command and
   do not re-run it.

The command holds a one-shot loopback server open until the user presses the page's
send button, then prints the response JSON and exits. Ending the command is what
returns control: the harness wakes this session on that exit, and the response is
the command's output. Read it from there. Nothing is copied by hand on this path.

Run it in the background. A foreground call would be killed at the shell timeout
long before a user finishes reading twelve records, and the server would die with it.

The server binds `127.0.0.1` on a random port under a random path. Nothing about a
local repo's decision trail or its draft text leaves the machine.

The page carries its own consistency checks, so a submitted reply is already
internally consistent. Still run the checks below — a reply may also arrive typed
by hand over a fallback surface.

Read the command's exit code:

| Exit | Meaning | What to do |
| --- | --- | --- |
| `0` | The user submitted. | Parse the response JSON from stdout after the first line, which is the written HTML path. |
| `2` | Bad arguments. | Fix the call. Never report a usage error as a user decision. |
| `3` | No browser. | Take the fallback cascade below. |
| `4` | Timed out after 30 minutes. | Tell the user the gate expired and re-run the same command. The payload file is unchanged. |

**Do not call `cockpit wait` for either gate, and do not log `needs_your_call`.**
The wait only succeeds while the user's `answer-here` switch is on and a tab is
subscribed, and a gate carrying twelve full records reads badly in a cockpit card
either way. Parking on a call nobody will answer strands the run. Log a plain
decision entry recording that the gate was reached, then end the turn. Do not use
`AskUserQuestion` either — it would skip the decision trail entirely.

**When the command exits `3`**, the platform opener failed and there is no local
browser: a headless run, a remote environment, or Claude Code on the web. The
server is already stopped, so every fallback below is the plaintext round-trip the
send button replaced — the user copies or types the response back. Fall back in
this order:

- **`Artifact`**, when the tool is available. Publish the file `gate-page.ts`
  already rendered. Do not rebuild its markup. Its send button is dead on this
  path; the copy button beside it is the one that works.
- **Structured markdown in the transcript**, when it is not — the candidate
  ledger with its `group` column at gate 1, the full draft text for every
  proposed record at gate 2. This is not `AskUserQuestion`: it is the same
  plaintext round-trip, over the transcript instead of a copy button.

This cascade is about the browser, not about the harness. Codex writes files and
spawns processes like Claude Code does, so it renders and opens the same page
through the same script.

Every path produces the same gate-1 response, whether it was submitted, pasted, or
typed. Require the complete set, not only the changed rows — a partial reply is
ambiguous about which candidates it leaves untouched:

```json
{
  "dispositions": [
    { "entryIds": ["id-1"], "decision": "promote", "group": "g1" },
    { "entryIds": ["id-2"], "decision": "promote", "group": "g1" },
    { "entryIds": ["id-3"], "decision": "promote" },
    { "entryIds": ["id-4"], "decision": "skip" }
  ],
  "conflictResolutions": [
    { "entryIds": ["id-5", "id-6"], "resolution": "skip" }
  ]
}
```

`entryIds` must match a candidate's `entryIds` from the reckoner output
exactly — it is the candidate's identity, since candidates carry no separate
id field. `conflictResolutions` covers every entry in the reckoner's
`conflicts`.

- `group` is optional.
- Rows that share a `group` value become one ADR.
- A `promote` row with no `group` is its own single-member group.
- A `group` value is an opaque clustering label. The user chooses it, and the user never supplies a
  `groupId`. The main agent uses `group` only to decide which rows share a record, then
  assigns positional `groupId`s when it builds the `draft` payload (step 5).

Run the consistency check below on the parsed response, whichever surface it came
back over. Gate 2's response follows this schema:

```json
{
  "verdicts": [
    { "proposedPath": "docs/adr/0027-....md", "verdict": "approve" },
    { "proposedPath": "docs/adr/0028-....md", "verdict": "drop" },
    { "proposedPath": "docs/adr/0029-....md", "verdict": "approve", "draftText": "..." }
  ]
}
```

- One entry per proposed draft. `verdict` is `approve` or `drop`.
- An optional `draftText` on an `approve` replaces the codifier's text for that record.
- Require the complete set. A partial reply is ambiguous, so re-surface it to the user.
- A `drop` leaves a number gap. Nothing is renumbered. `adr-index.ts` never reuses a gap,
  because reusing a number would make an id ambiguous across git history.

## Script paths

Only the main agent sees the skill's load-time "Base directory for this skill"
banner. A subagent does not. Resolve the skill directory from that banner and pass
every path each phase needs as a **literal absolute path**, in the spawn prompt. A
child that has to find a script starts searching the plugin cache — that is the
caller's bug. Never pass a `$`-prefixed token: nothing sets that variable in the
child's shell, so its command silently runs against `/`.

| Input | Path |
| --- | --- |
| `collectorPath`, `bodyFetchPath` | `<skill dir>/scripts/collect-adr-context.ts` |
| `indexReaderPath` | `<skill dir>/scripts/adr-index.ts` |
| `plannerPath` | `<skill dir>/scripts/archive-plan.ts` |
| `templatePath` | `<skill dir>/references/adr-template.md` |
| `validatorPath` | `<skill dir>/scripts/adr-validate.ts` |
| `archiverPath` | `<skill dir>/scripts/archive-logs.ts` |
| `gatePagePath` | `<skill dir>/scripts/gate-page.ts` |

`collect` takes `collectorPath`, `indexReaderPath`, `bodyFetchPath`, and
`plannerPath`. `draft` takes `bodyFetchPath` and `templatePath`. `commit` takes
`validatorPath` and `archiverPath`. `gatePagePath` belongs to no phase — the main
agent runs it at both gates and never passes it to a Lorekeeper.

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
   empty. Deliberately leave sessions written in the last ten minutes behind. If
   the reckoner produced more than 12 `promote` candidates, say so, and say that
   grouping may still bring the run under the cap.

   At most 12 groups may reach `draft` in one run. Enforce the cap before the user
   confirms, never after: once gate 1 is confirmed, the disposition set is
   complete and the archive plan already covers every candidate, so dropping
   groups after confirmation would archive an unrecorded decision to `done`.
   Fold the user's reply into groups. If the folded count exceeds 12, re-surface it
   before treating the reply as confirmed. Ask the user to group further, or to
   disposition the excess as `watch` in this run — a `watch` candidate archives
   to the watched bucket and re-queues on the next `triage` run, so nothing is
   lost. The main agent never picks the excess itself; which decisions wait is
   the user's call. 12 is a judgment call, not a measured ceiling: in one 26-group run
   the limit was review fatigue, not failure.

   Before treating the user's gate-1 response as final, check it for internal
   contradictions the reckoner cannot see, since a group or a conflict
   resolution is a gate-1-only decision the reckoner never produces or
   validates:

   - **A group with a non-`promote` row.** A `group` that holds any non-`promote` row is a
     contradiction. Re-surface it to the user. Ask whether the remaining rows still form one record,
     or whether the group itself is off. Never guess which half wins.
   - **A watch item that contradicts its own conflict.** If a candidate is
     `watch` because of an entry in `conflicts`, and the user's response also
     resolves that same conflict, the disposition and the resolution must
     agree. If they don't, re-surface both choices for the user rather than guessing
     which one wins.

   Re-run the contradiction check and the group-count check after any correction
   the user makes — a fix to one contradiction can introduce another.
4. After the user confirms, derive the archive target per session. **`watch` wins**: if
   any candidate drawn from a session is `watch`, archive that session to the
   watched bucket. Otherwise archive it to `done`.

   Gate 1 is the first re-plan trigger. If it changed any disposition the
   reckoner assumed — overriding a candidate, or declining one half of a
   proposed `merge` — the reckoner's `assignments` and its `planPath` no longer
   match the user's decision. Apply the confirmed overrides to the candidate
   dispositions now, and re-plan by **Re-planning the archive** below.
5. Build the `draft` payload from the confirmed `promote` rows. Fold rows that
   share a `group` value into one entry, in the order the `promote` rows appear
   in the user's confirmed response. A `promote` row with no `group` becomes its own
   single-member entry.

   Assign each entry a `groupId` by position: `g1`, `g2`, `g3`, and so on. Never
   carry the user's `group` value through as the `groupId` — a user-invented label would
   collide with a single-member group the user never labelled, and two entries would
   share one `groupId`.

   Assign each entry a record number before spawning `draft`. Group `i` takes
   `adrIndex.nextNumber + i`, with `i` zero-based. `adrIndex` arrives in the
   collect return; retain it through gate 1, the same way `plannerPath` is
   retained. The codifier never counts and never reads `adrIndex.nextNumber` for
   itself — two groups drafted against one `nextNumber` would collide on one
   path, and the barrowkeeper would refuse the whole batch.

   ```json
   {
     "groups": [
       { "groupId": "g1", "entryIds": ["id-1", "id-2"], "adrNumber": 27 },
       { "groupId": "g2", "entryIds": ["id-3"], "adrNumber": 28 }
     ]
   }
   ```
6. After gate 2, build `newAdrs` from the verdicts. Keep every `approve`
   verdict, in the order the drafts were proposed. Drop every `drop` verdict.
   For each kept verdict, set `path` to its `proposedPath`, and set `content`
   to the verdict's own `draftText` when it carries one, otherwise to the
   codifier's `draftText` for that draft. A verdict's `draftText` is the user's edit,
   and it always wins over the codifier's text.

   If every verdict was `drop`, the run promoted nothing. Omit `newAdrs`
   entirely. Never send `[]`.
7. A gate-2 `drop` defers a group. Its candidates were `promote` at gate 1, so
   the reckoner already assigned their source sessions `target: "done"`. If
   nothing corrects that, the dropped decision archives to `done` unrecorded
   and leaves triage forever.

   Gate 2 is the second re-plan trigger. Treat every dropped group's candidates
   as `watch`, and re-plan by **Re-planning the archive** below.

During collection, when a fresh candidate cluster matches an entry in the watched
bucket, pull the watched entry back in and re-judge the combined evidence. Watched
items never re-queue on their own.

### Re-planning the archive

Two triggers, one recipe, one planner run. Run it once, immediately before
`commit`, folding every correction both gates made. A run whose gates corrected
nothing keeps the reckoner's original `planPath` and never runs the planner.

- Re-fold the `watch`-wins rule across every session the corrected candidates
  touch, not only the corrected ones — another candidate from the same session
  may already be `watch`.
- Keep each row's original `from` untouched.
- Serialize the corrected `assignments`.
- Re-run `bun "{plannerPath}" --assignments "{corrected assignments JSON}"`, using
  the `plannerPath` retained from the collect-phase inputs through both gates.
- Pass the fresh `planPath` into `commit` — never a prose description of the
  corrections.

Re-planning after gate 1 and again after gate 2 would start the second run from
the same corrected `assignments` and orphan the first plan file, so fold both
into the one run.

Never hand-edit `moves[]` or any other field of the serialized plan. A plan's
`target`, `to`, and `from`/`fromBucket` fields are derived together, so patching
one desyncs the rest.

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
approved plan; pass no `newAdrs` and no `metadataUpdate`. This branch's "before
`commit`" is right after gate 1, so re-plan there if gate 1 corrected anything.

A promotion whose source sessions all proved live can produce a draft with an
empty archive plan. Writing and archiving are independently optional. If the run
produces neither, report a no-op instead of spawning commit with nothing to do.

## `promote <candidate-or-topic>` — direct promotion

Use this escape hatch when the user already knows what should become a record. Collect
the decision across all relevant sessions, including archived sessions. Ask only
for material information the logs cannot establish. Apply the same promotion
threshold and identify any existing ADR before drafting.

Pass the reconstructed candidate, confirmed facts, source assignments, and
archive plan into `draft`, as a one-entry `groups` payload. Build that entry the
same way step 5 does: `groupId` is `g1`, `entryIds` is the reconstructed
candidate's own `entryIds`, and `adrNumber` is `adrIndex.nextNumber`. `adrIndex`
comes from the collect return, as in `triage`; retain it until `draft` is
spawned. The codifier refuses to derive a number for itself, so a payload
without `adrNumber` cannot draft.

```json
{ "groups": [{ "groupId": "g1", "entryIds": ["id-1"], "adrNumber": 27 }] }
```

Present the complete draft and proposed path at gate 2 before writing. Its
gate-2 reply uses the same `verdicts` shape, with one entry. Pass a one-entry
`newAdrs`, the path, and the archive plan into `commit` — the same contract
`triage` uses.

## `supersede <adr-id>` — replace an accepted record

Collect the existing ADR and the evidence for its replacement. Draft the
replacement first, through the same one-entry `groups` payload `promote` uses:
`groupId` `g1`, the replacement's `entryIds`, and `adrNumber`
`adrIndex.nextNumber` retained from the collect return. The replacement takes a
fresh number; the superseded record keeps its own. After gate 2, write the
replacement, then update only the old record's successor lifecycle metadata.
Never rewrite the old decision's context or consequences.

This is two writes with no transaction. If the successor-link update fails after
the replacement lands, do not roll anything back. The new record is valid alone,
and its missing back-link is repairable by hand. Skip archiving in this mode:
archiving a session while its record is half-written removes the evidence needed
to finish the repair.

The replacement travels into `commit` as a one-entry `newAdrs`, beside the single
`metadataUpdate`.

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

If neither path is available, tell the user to run `chronicle:install` and start a new
Codex thread. Do not replace the role boundary with an inline flow.

## OpenCode only — skip on Claude Code and Codex

Follow `~/.config/opencode/skills/adr/references/opencode.md` instead of the
spawn instructions above — bare agent names, no context inheritance, a literal
skill directory. The path is absolute because OpenCode prints no skill
base-directory banner.

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
7. **One `draft`, gate-2, and `commit` cycle promotes up to 12 records.** The
   codifier returns `drafts`, one entry per input group. The barrowkeeper takes
   `newAdrs`, and writes every entry in one batch. `supersede <adr-id>` still
   replaces one record per run. `metadataUpdate` stays a single object and is
   never batched.

## Recovering a failed batch

After the barrowkeeper reports `validation-error`:

- The written records are on disk, uncommitted.
- The session logs are untouched in `.cockpit/`.
- The plan file survives at `/tmp/chronicle/adr/`.

The user fixes the offending record by hand, then re-runs `triage`. There is no
archive-only entry point, and this change adds none.

The re-run self-heals: `adrIndex.nextNumber` has advanced past the written
records, so no path collides; the reckoner skips clusters that match an existing
ADR, so the same decisions disposition to `skip`; and the run then takes the
no-promotion branch, where the archive plan finally applies.

## Edge Cases

- **No trail at all**: the collector reports it. Say plainly that there is nothing
  to triage and stop. Do not create `docs/adr/`.
- **A candidate matches an existing record**: disposition it `skip` and name the
  matching record instead of drafting a near-duplicate.
- **Conflicting evidence**: surface the conflict for the user's judgment at gate 1. Never
  silently treat the newest entry as the winner.

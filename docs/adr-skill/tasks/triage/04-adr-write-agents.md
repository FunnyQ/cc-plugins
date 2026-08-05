# TRIAGE-04: Write the drafting and writing agents

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: triage/02, triage/03
> **Blocks**: triage/05
> **Status**: done

## Goal

The two agents that run after a human has approved something — one that drafts a record, and the one agent in the whole skill permitted to write.

## Files to create / modify

- `packages/chronicle/agents/codifier.md` (new) — drafts the record; saves nothing
- `packages/chronicle/agents/barrowkeeper.md` (new) — the only agent with `Write`

## Implementation notes

Match the frontmatter shape the existing chronicle agents use — `name`, `description`, `model`, `effort`, `tools` — and the prose voice in `packages/chronicle/agents/runesmith.md` and `messenger.md`: terse, imperative, second person, refusals stated up front.

### Frontmatter values

| Agent | model | effort | tools | Role |
|---|---|---|---|---|
| `codifier` | sonnet | high | `["Bash", "Read"]` | Fetches full bodies for confirmed candidates, drafts the record text. Returns the draft; does not save it. |
| `barrowkeeper` | haiku | low | `["Bash", "Read", "Write"]` | Writes the confirmed record, applies any lifecycle link update, validates, then archives with the approved plan. |

The `description` field follows the house pattern: what the agent does, then who spawns it, then what it refuses.

### One agent carries `Write`, and it is a contract rather than a sandbox

`codifier` holds `Bash`, which creates and moves files whether or not `Write` is listed. So do not claim it *cannot* mutate anything. What is true, and what belongs in its file: it runs no mutating command at all — it returns draft text, it does not save it, and it never invokes the archiver.

The enforceable half lives elsewhere: the trail collector has no write path, and the archiver refuses to move a byte without `--apply` and an approved plan. `Write` on exactly one agent is what makes "who is supposed to mutate" answerable from the topology alone — the same split the commit flow already draws between its changeset analyzer and its committer.

Write `tools: ["Bash", "Read"]`, never the scoped form `tools: ["Bash(bun:*)"]`-style variants. Scoped tool entries are only recognized when an agent runs as the main thread; inside a subagent definition they silently grant nothing, and the failure looks like an unresponsive agent rather than a permissions problem.

### Neither agent holds a confirmation gate

Both gates — confirming the dispositions, confirming the draft — sit in the skill's own instructions, in the main agent, using `cockpit wait`. These two agents are spawned *after* a gate has already passed. Say so in both files: they never ask the user anything, and an agent that tries to prompt from inside a subagent is unverified behaviour.

### Section shape both files follow

After the frontmatter:

1. A one-line statement of what it does, followed immediately by what it does **not** do.
2. `## Input (from the prompt)` — what the caller supplies. The caller passes **absolute script paths**; the agent never guesses a repo-relative path. Existing chronicle agents resolve these from the skill's load-time "Base directory for this skill" banner, and these must say the same.
3. `## Process` — numbered steps.
4. `## Output` — the exact shape returned, as a JSON block.

### codifier

Receives the confirmed candidates and fetches only those bodies, by id. Drafts against the record template in `packages/chronicle/skills/adr/references/adr-template.md`.

Three rules that are easy to get subtly wrong, so state each with its reason:

- **Status comes from the decision's implementation state, never from the agent's own confidence.** A promoted record is `Accepted` because the code already works that way — not because the draft reads well.
- **Evidence entries embed a stable summary plus session id, entry id, and date, and never cite a `.cockpit` path.** Those logs can be deleted by hand and `.cockpit/` never enters git, so a path reference is guaranteed to rot. The summary in the record *is* the durable evidence.
- **Excludes secrets, credentials, personal data, and raw transcript text.** Records are permanent and shared; the trail they came from was neither.

It returns the draft text and the proposed target path. It saves nothing — the human has not seen the draft yet, and the second gate is what stands between this output and a file on disk.

### barrowkeeper

Receives the approved record content, its target path, the path to the approved archive plan, the absolute path to the record validator, and — on a supersession — a lifecycle-metadata update for a record that already exists. Writes the new file, applies the metadata update, validates, then runs the archiver with `--apply`. It never deletes a log file.

Its input carries two distinct write kinds, and conflating them is what breaks supersession:

```json
{
  "newAdr": { "path": "docs/adr/0007-....md", "content": "..." },
  "metadataUpdate": {
    "path": "docs/adr/0003-....md",
    "set": { "Status": "Superseded", "Superseded by": "ADR-0007" }
  },
  "planPath": "/tmp/chronicle/adr/plan-1754438400000-51234.json"
}
```

`planPath` is the serialized archive plan produced before the first gate and carried through both of them unchanged — **not** a list of assignments. The applier takes `--plan` and `--apply` and nothing else — it cannot build a plan from assignments, because that is a different script it does not call. Handing this agent raw assignments would simply leave it unable to archive. It passes the path straight through: `archive-logs.ts --plan <planPath> --apply`.

`newAdr` refuses an existing target path — a collision means a numbering race, and overwriting would destroy a record. `metadataUpdate` **requires** the target to exist, and may only rewrite the lifecycle fields named in `set`. It must not touch the `## Context`, `## Considered alternatives`, `## Decision`, `## Consequences`, or `## Evidence` bodies: a superseded decision's original reasoning is the historical record, and rewriting it to look cleaner is a stated non-goal.

**Either field may be absent, and both absences are normal.** A plain promotion sends only `newAdr`. A lifecycle correction sends only `metadataUpdate`. A triage run that promoted nothing sends neither and only a plan — that is the common case when the whole backlog turns out to be local detail, not an error to guard against.

#### Validate before archiving, never after

Between the writes and the archive, `barrowkeeper` runs the record validator over the target directory. It is the only place validation can do anything: archiving is the irreversible step, and once the source sessions move, a malformed record can no longer be regenerated from the evidence that produced it.

So the sequence is **write → validate → archive**, and a validation *error* stops it dead:

- Report the violations, leave both records exactly as written, and **skip archiving entirely**. The record is fixable by hand precisely because its sources are still in the inbox.
- Warnings do not block. A record with an empty evidence section is legal — a hand-written one legitimately has nothing to cite — so only errors gate.
- Do not attempt a repair. This agent writes what it was handed; deciding what a malformed record should say is the drafting agent's job and the human's, not a cheap writer's.

Validating first and writing second would not work: the rules cover filenames, id-to-filename agreement, and cross-record links, none of which can be checked before the file exists at its path.

Ordering and partial failure both need stating, because there is no transaction here. Write `newAdr` first, then `metadataUpdate`, then validate, then archive. If the metadata update fails after the new record landed, **do not roll back**: the new record is valid on its own, and the missing back-link is repairable by hand. Report both paths and exactly which step failed, and skip archiving entirely — archiving a session whose record is only half-written would remove the evidence needed to finish it.

## Acceptance criteria

- [x] Both files exist at the paths listed above.
- [x] Each carries `name` / `description` / `model` / `effort` / `tools` frontmatter matching the table, and `barrowkeeper` is the one holding `Write`.
- [x] Neither file uses a scoped tools entry.
- [x] `codifier.md` states that it runs no mutating command, returns the draft without saving it, and never invokes the archiver.
- [x] `codifier.md` states that status comes from implementation state, that evidence never cites a filesystem path, and what is excluded from evidence.
- [x] `barrowkeeper.md` accepts `newAdr` and `metadataUpdate` as separate write kinds, refuses an existing target for the first, requires an existing target for the second, restricts the second to lifecycle fields, and states that either or both may be absent.
- [x] `barrowkeeper.md` takes `planPath` and never raw assignments, invoking the archiver as `--plan <planPath> --apply`, and never deletes a log file.
- [x] `barrowkeeper.md` runs the record validator after the writes and before archiving, skips archiving and reports on any validation error, does not block on warnings, and never attempts a repair.
- [x] `barrowkeeper.md` states the write order — write, then lifecycle update, then validate, then archive — and the do-not-roll-back-and-skip-archiving behaviour on partial failure.

## Verification

- [x] `grep -L 'model:' packages/chronicle/agents/{codifier,barrowkeeper}.md` prints nothing — both files have frontmatter.
- [x] `grep -l '"Write"' packages/chronicle/agents/codifier.md` prints nothing, and `grep -c '"Write"' packages/chronicle/agents/barrowkeeper.md` is 1.
- [x] `grep -n 'assignments' packages/chronicle/agents/barrowkeeper.md` returns nothing, or only prose stating that raw assignments are refused.
- [x] `git status --short -- packages/chronicle/agents/codifier.md packages/chronicle/agents/barrowkeeper.md` shows both paths dirty.

**Do not verify these roles by starting a session and looking for them in the agent list.** A session loads chronicle's agents from the version-pinned plugin cache, populated from a git clone tracking `main` — so an uncommitted file in this working tree is invisible to every session, fresh or not. Committing is the runner's job and releasing is out of scope for this tree, so that check cannot pass here regardless of correctness. The greps above are the real gate; live resolution is confirmed once, after release.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

This task ships no unit tests, so read "Test coverage" as **instruction coverage**: does each file state its failure and refusal behaviour, not just its happy path?

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4 (pass) | 5 |
|---|---|---|---|---|---|
| Correctness | ×3 | `codifier` holds `Write`, or the writing agent takes raw assignments, or a rollback is specified on partial failure. | The two write kinds are present but their preconditions are stated loosely, or the absent-field cases are not covered. | Both write kinds carry their precondition; either may be absent; the write order and the no-rollback rule are explicit; the plan path passes through untouched. | Also names what to report when the record write itself fails before anything else has happened. |
| Test coverage | ×2 | No refusals stated. | The happy path is detailed; the refusal list is thin on one agent. | Every refusal from the notes above appears in the file it belongs to, including the exclusion list on evidence. | Refusals read as decidable checks rather than as advice. |
| Interface & readability | ×1 | Input shape absent or contradicting the emitter's output. | Shape present but a field name drifts from what the previous phase returns. | Both files carry an `## Input` and an `## Output` block whose fields match the chain exactly. | A reader can trace `planPath` from its producer to `--apply` without opening a script. |
| Assumptions & docs | ×1 | The never-delete and never-overwrite rules appear without their reasons, so a later editor relaxes them. | Reasons present but generic. | Each carries the concrete consequence it prevents — a destroyed record, an unrecoverable half-write. | The reasoning would survive a reviewer who wanted the rules loosened. |

## Out of scope

- The orchestrator and the read-only agents — Deferred. They run before the first gate and are written by a sibling task in this bucket.
- The Codex `.toml` equivalents and their role registration — Deferred. Harness parity is its own task and depends on every agent file existing first.
- The skill's routing instructions and the two confirmation gates — Deferred. Those live in the skill file, written in the promote bucket.
- Implementing the archiver or the record validator — Deferred. Both script contracts already exist by the time this task runs.

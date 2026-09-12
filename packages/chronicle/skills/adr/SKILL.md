---
name: adr
description: >-
  Triage the cockpit decision trail as an inbox and promote the decisions that
  mattered into Architecture Decision Records under docs/adr/.
when_to_use: >-
  When the user wants to review the decision trail, record an architecture
  decision, or replace one. Human-invoked only — do NOT auto-fire from a Stop
  hook, a scribe run, or an incidental mention of a decision.
argument-hint: "triage | archive [--all] | promote <candidate-or-topic> | supersede <adr-id>"
---

# Chronicle ADR

The **main agent** owns both confirmation gates and runs triage itself: it runs
`triage.ts`, fans the batch files out to parallel `judge` agents, and merges
their results into the gate-1 payload and the archive plan. It hands the nested
**Lorekeeper** exactly two phases, draft and commit. The Lorekeeper owns each
phase and delegates its mechanics. It cannot run the whole flow and return
control at both gates because its first return ends that orchestrator run. Pass
the confirmed groups into draft, then pass the confirmed drafts, `newAdrs`, the
optional `metadataUpdate`, and the archive plan into commit.

Triage spawns no Lorekeeper. Clustering by identical decision text, base
session assignments, batching, result validation, merging, and archive planning
are deterministic, so `triage.ts` does them in seconds. Before it, one
101-entry run reached gate 1 after about 1,500s: a reckoner agent spent 558s
emitting 49k tokens of clusters, the Lorekeeper spent about 180s re-emitting that
JSON verbatim, and the main agent spent about 460s typing a 33KB gate payload by
hand, twice. Models now only screen and judge.

## Topology

```
chronicle:adr  (this skill — the main agent; owns both gates)
  ├─ triage.ts prep       skeletons → exact-text clusters → ≤10 batch files + base assignments
  ├─ judge × ≤10          parallel, sonnet: screen, fetch plausible bodies, disposition → triage.ts record
  ├─ triage.ts merge      results → ledger + gate-1 payload + assignments + archive plan
  ├─ main agent cross-checks the ledger → overrides → triage.ts merge again
  ├─ [GATE 1]  the user confirms the dispositions
  ├─ lorekeeper(draft)   → codifier            draft the ADR from the confirmed candidates
  ├─ [GATE 2]  the user confirms the draft and its target path
  └─ lorekeeper(commit)  → barrowkeeper        write, apply any link update, validate, archive
```

Spawn each Lorekeeper as a nested custom agent, never a fork. Spawn one Lorekeeper
per phase, in one `Agent` call, with no `name`. This chain is nested and
sequential, not a team: never spawn the codifier or the barrowkeeper yourself,
never run two Lorekeeper phases at once, and never put two Lorekeeper spawns in
one message. It does not inherit the main conversation. Do not put either gate
inside Lorekeeper.

The `judge` fan-out is the one deliberate exception to "never spawn a skill child
yourself": `judge` is not a Lorekeeper child, has no Lorekeeper spec, and is
spawned directly by the main agent — see **Judging the batches**.

**Both gates are one local HTML page.** Never hand-write that page and never
hand-design it — `gatePagePath` renders it. Build the payload, serve it, and end
the turn:

1. Use a payload in the run directory — see **Run files**. `triage.ts merge`
   writes gate 1's payload to `<runDir>/gate1.json`; never write or edit it by
   hand. Write gate 2's payload to `<runDir>/gate2.json`. Gate 1 takes `gate: 1`,
   `nextAdr`, `candidates` (each with `entryIds`, `title`, `reason`,
   `disposition`, and an optional `matchesAdr` and `hint`), an optional
   `conflicts`, and an optional `scan` for the header facts. Gate 2 takes
   `gate: 2` and `drafts`, each with `groupId`, `adrNumber`, `proposedPath`, and
   the codifier's `draftText` verbatim.
2. Run `bun "{gatePagePath}" --data "{payload.json}" --out "{runDir}/gate<N>.html" --serve --open`
   **as a background command**. Pass `--lang zh-TW` when the cockpit decision-log
   language is zh-TW. A submitted response also lands beside the page, at
   `<runDir>/gate<N>.html.response.json`.
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

When a gate-1 reply comes back over a fallback surface, write it to
`<runDir>/gate1-response.json` so `merge` can read it.

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

`entryIds` must match a candidate's `entryIds` from `gate1.json` exactly — it is
the candidate's identity, since candidates carry no separate id field.
`conflictResolutions` covers every entry in the merged `conflicts`; every
conflict comes from a judge.

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
| `triagePath` | `<skill dir>/scripts/triage.ts` |
| `bodyFetchPath` | `<skill dir>/scripts/collect-adr-context.ts` |
| `plannerPath` | `<skill dir>/scripts/archive-plan.ts` |
| `templatePath` | `<skill dir>/references/adr-template.md` |
| `validatorPath` | `<skill dir>/scripts/adr-validate.ts` |
| `archiverPath` | `<skill dir>/scripts/archive-logs.ts` |
| `gatePagePath` | `<skill dir>/scripts/gate-page.ts` |
| `archiveStalePath` | `<skill dir>/scripts/archive-stale.ts` |

`draft` takes `bodyFetchPath` and `templatePath`. `commit` takes `validatorPath`
and `archiverPath`. Every `judge` takes `bodyFetchPath`, `triagePath`, and its own
batch path. The main agent keeps `triagePath`, `plannerPath`, and `gatePagePath`
for itself and never passes them to a Lorekeeper; `plannerPath` only builds the
empty plan `promote` and `supersede` pass to `commit`. `archiveStalePath` belongs to no phase — only `archive` runs it.

## Run files

`/tmp/chronicle/adr/` is shared by every repo's runs, so each run gets its own
directory. `triage.ts prep` creates it as `<trail directory name>-<ms>-<pid>` and
prints it as `runDir`. Write every file the run needs inside `runDir`: the gate-2
payload, the cross-check overrides, and the gate-2 drop overrides. Never write a
fixed name such as `/tmp/chronicle/adr/gate1-payload.json`: a run in another repo
overwrites it, and a gate then renders that repo's records.

## `triage` — process the inbox

This is the primary entry point.

1. Run `bun "{triagePath}" prep` from the session's cwd. It prints one JSON line:
   `hasTrail`, `runDir`, `nextAdr`, `sessions`, `entries`, `clusters`,
   `tooFresh`, and `batches`, the batch file paths. When `hasTrail` is false,
   take the **No trail at all** edge case. When `clusters` is 0, say that the
   inbox holds nothing stale and stop.

   `prep` reads the inbox and the watched bucket, never the registry. It clusters
   entries whose `decision` text is identical, across sessions, and gives every
   stale inbox session one base assignment targeting `done`. It deliberately
   leaves a session written in the last ten minutes behind and counts it in
   `tooFresh`. It pulls a watched session back only when one of its entries
   shares its `decision` text with an inbox entry; watched items never re-queue
   on their own. It sizes the batches so that at most 10 judges run.
2. Judge the batches per **Judging the batches** below.
3. Merge and cross-check per **Merging and the archive plan** below, then present
   every disposition at gate 1 from `<runDir>/gate1.json`. A triage is done when
   every stale session was dispositioned and every retained candidate is named,
   not when the inbox is empty. If the merge counts more than 12 `promote`
   candidates, say so, and say that grouping may still bring the run under the
   cap.

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
   contradictions no judge can see, since a group or a conflict resolution is a
   gate-1-only decision produced and validated by nobody upstream:

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
4. After the user confirms, archive each session by **`watch` wins**: a session
   behind any `watch` candidate archives to the watched bucket, and every other
   session archives to `done`. Gate 1 is the first re-merge trigger. If it
   changed any disposition, re-merge with the gate-1 response per **Merging and
   the archive plan**; `merge` re-folds `watch` wins and rewrites the plan.
5. Build the `draft` payload from the confirmed `promote` rows. Fold rows that
   share a `group` value into one entry, in the order the `promote` rows appear
   in the user's confirmed response. A `promote` row with no `group` becomes its own
   single-member entry.

   Assign each entry a `groupId` by position: `g1`, `g2`, `g3`, and so on. Never
   carry the user's `group` value through as the `groupId` — a user-invented label would
   collide with a single-member group the user never labelled, and two entries would
   share one `groupId`.

   Assign each entry a record number before spawning `draft`. Group `i` takes
   `nextAdr + i`, with `i` zero-based. `nextAdr` arrives in the `prep` line;
   retain it through gate 1. The codifier never counts and never reads the record
   index for itself — two groups drafted against one number would collide on one
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
   the plan already assigned their source sessions `target: "done"`. If nothing
   corrects that, the dropped decision archives to `done` unrecorded and leaves
   triage forever.

   Gate 2 is the second re-merge trigger. Write `<runDir>/gate2-drops.json` in
   the override shape, with every dropped group's candidates at `decision:
   "watch"`, and re-merge per **Merging and the archive plan**.

### Judging the batches

Spawn one `judge` per batch file, every one in a **single `Agent` message** — that
is what makes them run in parallel. Keep each prompt to three literal paths:
`batchPath`, `bodyFetchPath`, and `triagePath`. Never paste clusters, candidates,
or the record index into a prompt. The model writes each prompt out before its
call starts, so in one run five judges with 4,000-character prompts started
23–26s apart despite sharing one message.

Each judge screens its clusters from their skeletons, fetches bodies for the
plausible ones, and records one candidate per cluster with `triage.ts record`,
which validates the result and writes `batch-NN.result.json` beside the batch. A
judge's reply is the recorder's one summary line. Never read candidates from a
reply.

1. **Wait for every judge.** Each spawn returns a launch receipt, not a result,
   and a judge that hangs sends no completion notice at all. Before ending a turn
   to wait, name every batch still outstanding in the reply, so a hung judge
   shows up as a named batch instead of a silent stall.
2. **Retry a failed batch once.** A batch has failed when its judge finished, or
   the run resumed, without `batch-NN.result.json` on disk. Spawn one fresh judge
   for that batch alone. The recorder keeps the first result written for a batch
   and refuses every later one, so a slow original landing after its retry cannot
   duplicate a candidate's `entryIds`, which is its identity at gate 1.
3. **Surface a second failure.** When the retry also leaves no result, merge with
   `--missing-as-watch`. That batch's clusters reach gate 1 as `watch`, with a
   reason naming the judge failure, never as a silent `skip`. `merge` writes that
   fallback as the batch's result file, so pass the flag once: every later merge
   reads the fallback, and a judge landing late is refused like any second result.

### Merging and the archive plan

Run `bun "{triagePath}" merge --run "{runDir}"` from the same cwd `prep` ran in. It
prints one JSON line: `gate1Path`, `planPath`, `ledgerPath`, the `promote`,
`watch`, and `skip` counts, `conflicts`, `moves`, and `refused`. It writes
`gate1.json`, `assignments.json`, `archive-plan.json`, and `ledger.md` into
`runDir`, replacing the previous merge's files, so a re-merge never orphans a
plan. Count dispositions from that line, never from a judge's reply.

`merge` exits `1` and writes nothing in three cases:

- A batch has no result. Take the retry path in **Judging the batches**.
- An override names no candidate or carries a decision other than `promote`,
  `watch`, or `skip`.
- The cwd resolves to a different trail than `prep` recorded, or every session is
  missing from it. Both mean the wrong cwd, never an empty inbox.

**Cross-check the batches before gate 1.** Parallel judges drift apart on the
same kind of material: in one run, one batch skipped two external-API facts as
reference material while another promoted a third. Read `ledger.md`, which lists
every candidate by disposition, promotes first. Check every `promote` against the
**hard skip rules** in **Promotion threshold** and against every `skip` from
another batch.

- When a `promote`'s own reason says the decision is already documented, or
  describes a fact about an external system, override it to `skip` and name the
  rule in `reason`.
- When a `promote` rests on the same ground another batch skipped, override it to
  `watch` and name that `skip` candidate's title in `reason`.
- Never raise a disposition here. Only the user raises one, at gate 1.

Write the overrides to `<runDir>/crosscheck.json` and re-merge with
`--overrides "{runDir}/crosscheck.json"`. Write no file and skip the re-merge
when nothing changed.

Every override file takes the gate-1 response shape. `merge` matches each row to a
candidate by its exact `entryIds` set, sets `decision`, replaces `reason` when the
row carries one, and ignores `group` and `conflictResolutions`:

```json
{
  "dispositions": [
    { "entryIds": ["id-1"], "decision": "watch", "reason": "Same ground as the skipped 'X' in batch 3." }
  ]
}
```

Re-merge whenever a gate changes a disposition. Pass every override file written
so far, each with its own `--overrides`, in this order; a later file wins:

1. `<runDir>/crosscheck.json`, when the cross-check wrote one.
2. `<runDir>/gate1.html.response.json`, or `<runDir>/gate1-response.json` for a
   reply that came back over a fallback surface.
3. `<runDir>/gate2-drops.json`, after a gate-2 `drop`.

`merge` re-folds `watch` wins across every session, so a correction to one
candidate also re-targets the other sessions it shares. Pass the final
`planPath` into `commit` — never a prose description of the assignments.

Never hand-edit `gate1.json`, `assignments.json`, or any field of
`archive-plan.json`. A plan's `target`, `to`, and `from`/`fromBucket` fields are
derived together, so patching one desyncs the rest. Change a disposition through
an override file and re-merge instead.

### Promotion threshold

Require **at least one** of these durability signals:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the repo — its
  code, code comments, and docs.

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
documentation. Also reject it when the decision is a default choice a competent
engineer would reach without debate — an ordinary feature or implementation
call, not an architectural one, even when it happens to touch multiple modules.

Two **hard skip rules** settle a candidate as `skip` before the threshold is
read, unless its records conflict. A conflict comes first and still makes the
candidate `watch`, so a disputed decision is not archived to `done`:

- **Already written down.** The decision and its reason already sit in a code
  comment at the site, a reference doc, a README, `CLAUDE.md`, or `AGENTS.md`.
  A record there is a second copy that drifts.
- **Not the project's decision.** A fact about an external system — an API's
  shape, a vendor's limit, an OS or library behaviour — is reference material,
  whatever the entry's `kind`.

When the evidence is thin or the read is close, disposition `watch`, not
`promote`. `watch` costs one more review next triage; a wrongly `promote`d
candidate becomes a permanent ADR. This bias is deliberate and applies hardest
to `judge`, whose batches run in parallel: every lenient call is also a
disagreement between batches the user meets at gate 1.

`judge` runs on sonnet, not haiku. On haiku, one 101-entry run promoted 20
candidates and watched 3 despite this bias, with batches splitting on the same
kind of material. The user rejected all 20, and 8 of them named the existing doc
or comment in their own reason.

### No-promotion branch

At gate 1, if no candidate is `promote`, say that approving the dispositions is
the last decision in this run. Skip draft and gate 2. Invoke commit with only the
approved plan; pass no `newAdrs` and no `metadataUpdate`. This branch's "before
`commit`" is right after gate 1, so re-merge there if gate 1 corrected anything.

A promotion whose source sessions all proved live can produce a draft with an
empty archive plan. Writing and archiving are independently optional. If the run
produces neither, report a no-op instead of spawning commit with nothing to do.

## `archive [--all]` — archive stale sessions without triage

Use this when the user wants the inbox cleared and no records written. It spawns
no Lorekeeper and no judge, and it has no gate. It moves every stale session in
`.cockpit/logs/` to `done`. It never touches the watched bucket: a `watch`
disposition is a decision an earlier triage made, and moving it to `done` would
drop it from every later run.

1. Without `--all`, run `bun "{archiveStalePath}" --apply` from the repo. The
   script resolves the trail from its cwd, the same way cockpit does.
2. With `--all`, run `bun "{archiveStalePath}" --all --apply` instead. It walks
   `~/Projects`, `~/.claude`, and `~/.config` for every `.cockpit/logs/`, and
   checks `~` itself without descending. It skips `node_modules`, `.git`,
   Syncthing's `.stversions`, `.Trash`, and every `references/fixtures`
   directory — chronicle's forward-test trails, which each plugin cache copy
   also carries.
3. Report each trail line and the summary. Relay every `warning:` line whole.

When the user asks what `archive` would move, run the same command without
`--apply`. The output keeps its shape and says `would move`.

| Exit | Meaning |
| --- | --- |
| `0` | Every trail was processed. A trail with nothing to move or skip prints no line. |
| `1` | Bad arguments, no trail at the cwd, or a trail whose plan the archiver refused. Each failing trail's error is on stderr, and the other trails were still processed. |

A `live` skip is not a failure. The planner and the archiver both refuse a log
written in the last ten minutes, and the next `archive` run moves it.

**The ignore warning.** A repo that ignores `.cockpit/logs/` but not
`.cockpit/archive/` commits every archived log on its next `git add -A`: 26 in
one repo and 8 in another before this check existed. The script runs `git check-ignore`
on every destination under `.cockpit/archive/done/` before moving, warns when
any one of them is not ignored, and moves the files anyway.
Tell the user to add `.cockpit/archive/` to that repo's `.gitignore`. Never
suggest ignoring `.cockpit/` whole, since some repos track other files there,
such as a build script. Do not edit any `.gitignore` yourself. Archived logs that
were already committed stay tracked after the rule lands; say so, and leave
untracking them to the user.

## `promote <candidate-or-topic>` — direct promotion

Use this escape hatch when the user already knows what should become a record. Run
`bun "{triagePath}" prep --evidence` to collect the decision across every session
in every bucket — inbox, watched, and done, fresh sessions included — and retain
its `runDir` and `nextAdr`. Evidence mode clusters every entry and assigns no
session. Find the candidate's clusters by searching the `decision` text in
`<runDir>/batch-*.json` with `rg` or `jq`; never read every batch into the
conversation. Fetch bodies with `bun "{bodyFetchPath}" --bodies` when a skeleton is
not enough. Spawn no judge in this mode. Ask only for material information the
logs cannot establish. Apply the same promotion threshold and identify any
existing ADR before drafting.

Archive nothing in this mode. A source session can hold other decisions nobody
has dispositioned, and a watched one holds decisions an earlier triage kept on
purpose; moving either to `done` would drop them from every later run. The next
`triage` retires the promoted entries instead, because the judge matches them to
the new record and skips them. `commit` still requires a `planPath`, so write `[]`
to `<runDir>/assignments.json` and run
`bun "{plannerPath}" --assignments "{runDir}/assignments.json"` from the same cwd.
Its stdout is the path of an empty plan that moves nothing.

Pass the reconstructed candidate and the confirmed facts into `draft`, as a
one-entry `groups` payload. Build that entry the
same way step 5 does: `groupId` is `g1`, `entryIds` is the reconstructed
candidate's own `entryIds`, and `adrNumber` is `nextAdr`. Retain `nextAdr` from the
`prep` line until `draft` is spawned. The codifier refuses to derive a number for
itself, so a payload without `adrNumber` cannot draft.

```json
{ "groups": [{ "groupId": "g1", "entryIds": ["id-1"], "adrNumber": 27 }] }
```

Present the complete draft and proposed path at gate 2 before writing. Its
gate-2 reply uses the same `verdicts` shape, with one entry. Pass a one-entry
`newAdrs`, the path, and the empty archive plan into `commit` — the same contract
`triage` uses.

## `supersede <adr-id>` — replace an accepted record

Collect the existing ADR and the evidence for its replacement, through the same
`prep --evidence` search `promote` uses. Draft the replacement first, through
the same one-entry `groups` payload `promote` uses: `groupId` `g1`, the
replacement's `entryIds`, and `adrNumber` `nextAdr` retained from the `prep` line.
The replacement takes a fresh number; the superseded record keeps its own. After
gate 2, write the replacement, then update only the old record's successor
lifecycle metadata. Never rewrite the old decision's context or consequences.

This is two writes with no transaction. If the successor-link update fails after
the replacement lands, do not roll anything back. The new record is valid alone,
and its missing back-link is repairable by hand. Skip archiving in this mode:
archiving a session while its record is half-written removes the evidence needed
to finish the repair. Pass `commit` the same empty plan `promote` builds.

The replacement travels into `commit` as a one-entry `newAdrs`, beside the single
`metadataUpdate`.

## Codex

Codex loads the same two-phase Lorekeeper boundary through one of two paths:

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

`chronicle_judge` is not a Lorekeeper phase and follows neither path above the
same way: the main agent spawns it directly, in parallel batches, exactly as
under Claude Code (see **Judging the batches**) — select the registered
`chronicle_judge` role, or the generic-agent fallback reading `judge.toml`.

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
- The plan file survives in the run directory under `/tmp/chronicle/adr/`.

The user fixes the offending record by hand, then re-runs `triage`. Do not use
`archive` to finish the batch: it sends every stale session to `done`, including
the sessions this batch assigned to `watch`.

The re-run self-heals: `nextAdr` has advanced past the written records, so no
path collides; the judge skips clusters that match an existing ADR, so the same
decisions disposition to `skip`; and the run then takes the no-promotion branch,
where the archive plan finally applies.

## Edge Cases

- **No trail at all**: `triage.ts prep` prints `hasTrail: false`. Say plainly that
  there is nothing to triage and stop. Do not create `docs/adr/`.
- **A candidate matches an existing record**: disposition it `skip` and name the
  matching record instead of drafting a near-duplicate.
- **Conflicting evidence**: surface the conflict for the user's judgment at gate 1. Never
  silently treat the newest entry as the winner.

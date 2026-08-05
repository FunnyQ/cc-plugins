# adr-skill — Task System

## Purpose

Each task file is a **self-contained, independently pickable unit**. An executor needs only:

1. The `_context/` files listed in the task's `Required reading` header
2. The task file itself

They should not need to open `PLAN.md` or any other task file. `PLAN.md` is the master spec; `_context/` is its surgical extract; task files describe **what to do** without re-explaining **why**.

## Directory layout

```
tasks/
├── README.md                  ← this file
├── _context/                  ← shared context (every task references these)
│   ├── shared.md              ← decisions, conventions, commit style
│   └── <other>.md             ← topic-specific shared context
└── <bucket>/                  ← bucket description
    └── NN-<slug>.md
```

## Reading order for executors

1. `_context/shared.md` — required for every task.
2. Topic-specific `_context/*.md` per the task's `Required reading` header.
3. The task file itself.

## Naming convention

`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded.

## Where to start

Start with **`foundation/01-extract-cockpit-trail.md`**. It is the hard prerequisite: every task
that reads the decision trail imports the module it creates, and it is the only task that touches
already-shipped code. Getting it wrong regresses `/chronicle:pr`.

`foundation/02-adr-conventions.md` is ready at the same time and shares no files with it, so the
two can run side by side. Everything else waits on one of them.

**Running this with autopilot:** the two highest-risk tasks are `foundation/01` (it edits
already-shipped code — its gate is that `analyze-branch.test.ts` passes with *zero* edits) and
`triage/02` (the only component that writes under `.cockpit/`, executing an untrusted plan). Read
those two results yourself rather than trusting the score. Everything else is new files with
self-contained tests.

<!-- flightplan:generated:start -->
## Status conventions

Each task header has a `> **Status**: <status>` line. Executors update it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| foundation | 01 | Extract the shared cockpit trail reader | todo | >= 4 | — |
| foundation | 02 | Freeze the ADR template and conventions | todo | >= 4 | — |
| foundation | 03 | Collect the trail context, read-only | todo | >= 4 | foundation/01, foundation/02 |
| foundation | 04 | Read the ADR directory into an index | todo | >= 4 | foundation/02 |
| promote | 01 | Validate a written ADR | todo | >= 4 | foundation/02, foundation/04 |
| promote | 02 | Write the skill and wire it into the repo docs | todo | >= 4 | triage/03, triage/04, triage/05, promote/01 |
| promote | 03 | Build the hand-judged forward-test fixtures | todo | >= 4 | promote/02 |
| promote | 04 | Final review | todo | >= 4 | promote/03 |
| triage | 01 | Plan an archive move set | todo | >= 4 | foundation/01 |
| triage | 02 | Execute an approved archive plan, safely | todo | >= 4 | triage/01 |
| triage | 03 | Write the orchestrator and the two read-only agents | todo | >= 4 | foundation/03, foundation/04, triage/01 |
| triage | 04 | Write the drafting and writing agents | todo | >= 4 | triage/02, triage/03 |
| triage | 05 | Ship the Codex half of the ADR roles | todo | >= 4 | triage/03, triage/04 |

## Dependency graph

```
foundation/01
├─→ foundation/03 *
│   └─→ triage/03 *
│       ├─→ promote/02 *
│       │   └─→ promote/03
│       │       └─→ promote/04
│       └─→ triage/05 *
└─→ triage/01
    └─→ triage/02
        └─→ triage/04 *
foundation/02
├─→ foundation/04
└─→ promote/01 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| promote/01 | foundation/02, foundation/04 |
| promote/02 | triage/03, triage/04, triage/05 |
| triage/01 | foundation/01 |
| triage/03 | foundation/03, foundation/04 |
<!-- flightplan:generated:end -->

## Known gaps

- **The archiver is deliberately two scripts, and a reviewer may read that as duplication.**
  `archive-plan.ts` decides and serializes; `archive-logs.ts` executes an approved plan and treats it
  as hostile input. One script would be shorter. The split buys a property a single file cannot: the
  planner has **no execution path in it at all**, so handing it to a read-only agent is a structural
  guarantee rather than an instruction the agent might ignore. It also isolates the untrusted-input
  hardening in the one task where it applies. Do not merge them back.
- **The plan converged on structure but not on detail.** Nineteen independent review passes ran;
  the first five found structural defects worth the whole exercise (the cross-plugin import that
  cannot work, gates placed in a layer that cannot ask, the orphaned validator). Passes ten onward
  returned a steady two-to-four spec-detail findings each, with no downward trend — each fix added
  specification surface for the next pass to find interactions in. Treat the remaining class of
  finding as what it is: things an executor resolves in seconds while writing the code. Do not run
  more review passes on this tree; run the code.
- **`.cockpit/` is a bare directory rule in `.gitignore`.** Git cannot re-include files under an
  excluded directory, so the fixture task's committed trail needs a differently-named source
  directory copied into place at run time, not a negation pattern. The fixture task carries a
  `git check-ignore` gate rather than treating this as a formality — but if it turns out uglier
  than expected, keeping the fixtures uncommitted and generating them from a script is the escape
  hatch.
- **Two copies of the trail walk-up will exist.** Chronicle ports cockpit's `logRoot` rather than
  importing it, because plugins install independently and monitor may not be present at all. The
  ported copy names its source in a comment, but nothing enforces that they stay in sync. If
  cockpit's anchoring rule ever changes, this is the thing that silently rots.
- **The archive is local-only.** `.cockpit/` never enters git, so a fresh machine re-triages old
  logs. Accepted for the first version.
- **Nothing reclaims cockpit logs anywhere.** `cockpit prune` was removed from monitor because it
  trashed the inbox rather than the archive. No task here replaces it; the trail is 636K and
  nothing fails without pruning.
- **Stage 4 of the original design is not in this tree.** Making `/chronicle:pr` cite accepted ADRs,
  and writing the marketplace documentation, both need a real ADR to exist first.
- **Outside this tree, still pending:** monitor needs a version bump plus a CHANGELOG entry.
  Removing a released CLI subcommand is a breaking change, and the removal itself landed on `main`
  as `0a3638a` without one. That bump ships **alongside this feature's release**, not as a separate
  cut — so the monitor `### Removed` entry for `cockpit prune` has to be in that CHANGELOG, at a
  breaking-level version step rather than a patch.
- **Nothing in this tree can be verified against a live session.** Agents and skills resolve from the
  version-pinned plugin cache, which is populated from a git clone tracking `main`. Every file this
  tree writes stays uncommitted in the working tree while it runs, so no `subagent_type` reaches it
  and no slash command resolves to it. Verification is therefore static — files exist, frontmatter
  parses, scripts run — and the flow is enacted by driving the scripts and reading the agent files by
  hand. Confirm live resolution once, after release, outside this tree.

### Filed notes — do not act on these during execution

Findings from the final review that are real but not structural. Recorded so an executor recognizes
them rather than re-deriving them; each is resolved in seconds while writing the code.

- **`Blocks:` headers disagree with the downstream `Depends on:`.** `foundation/03` and
  `foundation/04` both claim to block `triage/02` (and PLAN.md's diagram draws the
  `foundation/04 → triage/02` edge), but `triage/02` depends on `triage/01` alone. Harmless:
  `next-ready.ts` schedules from `Depends on` and never reads `Blocks`.
- **The `empty-repo/` fixture holds no files, and git cannot commit an empty directory.** A fresh
  clone loses the case silently. A `.gitkeep` or a README inside it is permitted and sufficient.
- **`triage/04`'s "Out of scope" claims every script contract already exists when it runs.** False
  for the validator — `promote/01` is not an ancestor of `triage/04`. Harmless: the task inlines
  enough of the contract to be written without it.
- **`promote/03`'s backdating check can pass while verifying nothing.** Where `find` resolves to
  `bfs`, `-newermt '-10 minutes'` is rejected — yet the pipeline still prints the expected `0`.
  Use `/usr/bin/find` explicitly, or an ISO timestamp.
- **`entryCount` versus `skeletonCount`.** The collector's stdout says `entryCount`; gleaner's return
  shape says `skeletonCount`. Same number, drifted name.

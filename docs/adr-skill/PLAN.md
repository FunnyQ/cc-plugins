# chronicle:adr — ADR curator skill

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-08-06

## Overview

Build `chronicle:adr`, a skill that triages the cockpit decision trail as an inbox and promotes the
decisions that turned out to matter into Architecture Decision Records under `docs/adr/`.

## Goals

- Triage a repository's cockpit trail as an inbox, and empty it of everything eligible — reporting
  what stayed behind and why. Sessions written within the last ten minutes are deliberately left in
  place, and the archiver re-checks that at apply time, so "the inbox is empty" is never the success
  condition. "Every stale session was dispositioned, and every retained one is named" is.
- Group related entries across sessions into reviewer-legible ADR candidates.
- Explain why each candidate does or does not meet the promotion threshold.
- Draft a new ADR, or propose an update to an existing one.
- Require Q's confirmation before writing an ADR or archiving anything.
- Preserve traceability from the ADR back to its source evidence.
- Detect likely conflicts, duplicates, and superseding decisions.

## Non-goals

- Do not publish ADRs automatically from a Stop hook or a scribe run.
- Do not treat every implementation choice, learning, or caveat as architecture.
- Do not replace the cockpit decision trail.
- Do not rewrite historical ADRs to make the decision process look cleaner than it was.
- Do not make ADR approval part of ordinary commit or PR creation.
- Do not add a database or external dependency for ADR indexing.
- Do not delete evidence. Archiving moves files; it never removes them.
- Do not build a log-deletion mechanic. The whole trail is 636K across 63 files (measured 2026-08-06); at roughly 10K per
  session a heavy year costs about 12MB. No current requirement fails without pruning.

## Context

Cockpit's decision trail is write-only. Nothing durable is ever produced from it. `/chronicle:pr`
reads a branch-sized window and discards it; the dashboard renders a live view. Both are ephemeral.
The 63 log files in this repo's `.cockpit/logs/` have never produced an artifact that outlives the
session that wrote them.

This skill is cockpit's first durable read path. That framing settles the boundary question: ADRs
do not compete with the trail — they consume it.

### Boundary with the other "why" stores

| Store | Owns | Lifetime |
| --- | --- | --- |
| Cockpit trail | Raw in-flight decisions | Expires — it is the raw material |
| **ADR** | Cross-release architecture commitments | Permanent, with a lifecycle |
| `CLAUDE.md` | How the repo works right now | Always describes the present |
| `memory/` | Harness behaviour and traps | Follows the harness, not the code |

Do not migrate `memory/` into ADRs. It mixes genuine harness facts, which belong there, with project
decisions that landed there only because nothing else existed. Move the second kind later,
deliberately, one at a time.

### The stakes

Once triage archives logs, ADR quality becomes the only thing standing between the trail and
permanent irrelevance. A careless run that skips everything means those sessions were recorded for
nothing. This is the cost of the inbox model. It is acceptable, but it argues for a conservative
threshold and for archiving rather than removing.

## Requirements

### MVP

1. **Shared cockpit trail reader** — one implementation of the decision-log reader, used by both the
   PR analyzer and the ADR collector.
   - Acceptance: `packages/chronicle/shared/scripts/cockpit-trail.ts` exists; `analyze-branch.ts`
     imports from it; `analyze-branch.test.ts` passes with zero edits.
2. **ADR conventions** — template, numbering, evidence format, status vocabulary, frozen on disk.
   - Acceptance: `packages/chronicle/skills/adr/references/adr-template.md` exists and every field
     an ADR carries is specified there.
3. **Read-only context collection** — trail skeletons and on-demand bodies, plus an ADR index.
   - Acceptance: `collect-adr-context.ts` and `adr-index.ts` exist with tests; neither writes.
4. **Archiving with a live-session guard** — split across a planner and an applier, gated on confirmation.
   - Acceptance: `archive-plan.ts` refuses any file whose mtime is within `STALE_MS` and contains no
     execution path; `archive-logs.ts` executes only an approved plan, re-validates it as untrusted
     input, re-checks the guard immediately before each move, and never deletes.
5. **Agent topology** — five agents on Claude, five on Codex, registered in both harnesses.
   - Acceptance: `packages/chronicle/agents/{lorekeeper,gleaner,reckoner,codifier,barrowkeeper}.md`
     and the matching `agents-codex/*.toml` exist; `setup-codex-agents.ts` installs all sixteen roles.
6. **The skill itself** — `triage`, `promote`, `supersede`, with two confirmation gates.
   - Acceptance: `packages/chronicle/skills/adr/SKILL.md` documents all three modes, both gates, the
     promotion threshold, and the `watch/` wake condition.
7. **ADR validation** — structural checks a script can make.
   - Acceptance: `adr-validate.ts` enforces filename/ID format, required sections, and lifecycle
     link rules, with tests.
8. **Forward-test fixtures** — the hand-judged half of verification, made repeatable.
   - Acceptance: fixture repositories plus a manual checklist exist on disk.

### Later

- **`chronicle:pr` cites accepted ADRs** — deferred. It needs a real ADR to cite; nothing exists yet.
- **Marketplace and plugin-registry documentation** — deferred with the above, for the same reason:
  it describes the skill to people who have not used it, and nobody has. This repository's own
  `CLAUDE.md` is **not** deferred — it documents what exists in the tree, and a new skill plus five
  new agents that go unrecorded there is a stale map from the day they land.
- **Log retention / pruning** — deferred. Nothing fails without it at current volumes.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile step, no external npm dependencies. `type` over
  `interface`.
- **Storage**: the filesystem. Position in the tree *is* the state — there is no ledger, no database.
- **Deployment**: ships inside the `chronicle` plugin, to both Claude Code and Codex.
- **Conventions**: see `tasks/_context/shared.md`.

### The two findings that shaped this plan

**chronicle cannot import monitor.** `packages/chronicle/skills/*/scripts/*.ts` has zero
cross-package imports. Plugins install independently under version-pinned cache paths
(`.../chronicle/0.9.6/`, `.../monitor/3.x.y/`), so "resolve the trail root with cockpit's
`log-root.ts` walk-up" is not literally implementable. **Decision:** create
`packages/chronicle/shared/scripts/cockpit-trail.ts` and *port* the walk-up and `STALE_MS` into it,
with a comment naming monitor's originals as the spec. Accepted cost: two implementations that must
be hand-synced.

**Human gates live in the main agent, not the orchestrator.** Every existing chronicle flow puts
them there — `agents/oathkeeper.md` says "Spawned by the chronicle:release skill (the main agent)
**after the version gate**", and `skills/release/SKILL.md` requires `cockpit wait` for gates rather
than `AskUserQuestion`. A nested subagent asking the user is unverified. **Decision:** the gates
move up to `SKILL.md`; lorekeeper becomes pure orchestration.

## Architecture

### Inbox model

The log directory is the queue. Its contents are the unprocessed backlog.

```
.cockpit/
├── logs/                inbox — not yet triaged
└── archive/
    ├── done/            dispositioned; never returns on its own
    └── watch/           dispositioned; returns when new evidence arrives
```

`promote` and `skip` both land in `done/`. They behave identically, and "did this become an ADR" is
answerable by grepping the ADRs' `## Evidence` sections — a fourth directory would duplicate a fact
already recorded elsewhere.

`watch/` needs a wake condition or it degenerates into `skip` with a nicer name. The condition:
during a `triage` run, when a fresh candidate cluster matches something in `watch/`, pull those
entries back in and re-judge the combined evidence. Watched items never re-queue on their own.

**Folding dispositions onto sessions: `watch` wins.** Judgment is per candidate, archiving is per
session file, and one session routinely feeds candidates that disagree. A session goes to `watch/`
if any candidate drawn from it is `watch`; otherwise `done/`. The asymmetry follows from what each
error costs: a session wrongly sent to `done` is gone from triage forever, while one wrongly sent to
`watch` costs one extra look. Only one of those is recoverable. A session that fed no candidate
still gets an assignment, targeting `done` — triaging a session means dispositioning everything in
it, and entries not promoted are implicitly skipped.

**Supersession is two writes, and there is no transaction.** The replacement lands first, then the
original's lifecycle fields are updated in place. If the second write fails nothing rolls back — the
new record is valid on its own and the missing back-link is repairable by hand — but archiving is
skipped, because archiving a session whose ADR is half-written removes the evidence needed to finish
it. The metadata update may only rewrite lifecycle fields; the original's context and consequences
are the historical record.

**Retention.** `archive/done/` is cold — only `promote` reads it, and only when a new candidate
spans an already-processed session. `archive/watch/` is live state: deleting it silently converts
every `watch` into a permanent `skip`, with no error. Never expire it automatically.

### Reading the trail

**Read the log directory, not the registry.** The registry reaps entries older than
`REGISTRY_TTL_MS` (14 days, `cockpit.ts:224`) on every write. Measured in this repo on 2026-08-06: 63 log files,
27 registry entries. Treat both as a dated snapshot — the trail grows; the gap is the point. A registry-backed read sees under half the history, and loses exactly the
oldest tail — the only part that can answer "has this decision held up".

`analyze-branch.ts` is branch-scoped, so its 14-day horizon is correct for its own purpose. Its
behaviour does not change.

**Two-pass loading.** This repo alone holds 352 entries, and each `reason` field is a full argument.
Pass 1 emits skeletons (`id`, `kind`, `decision`, `timestamp`, `files`). Pass 2 fetches bodies by id,
for selected candidates only.

The second pass happens **before** dispositioning, not after. Skeletons are enough to see that
several entries concern one decision; they are not enough to judge the threshold, because one of its
two mandatory signals asks whether the rejected alternatives are recoverable from the code — and
those live in the `reason` and `tradeoff` fields the skeleton strips. So the judging step clusters
from skeletons, shortlists, fetches bodies for the shortlist, and only then decides. The bound
two-pass loading buys is "bodies for the shortlist" rather than "bodies for all 352", which is a
different claim from "no bodies at all".

### Agent topology

```
chronicle:adr  (SKILL.md — the main agent; owns both gates and the state between them)
  ├─ lorekeeper(collect) → gleaner    (haiku)  collect-adr-context.ts → skeletons. Read-only
  │                     → reckoner    (sonnet) clusters, fetches shortlist bodies, dispositions
  ├─ [GATE 1] cockpit wait — Q confirms the dispositions
  ├─ lorekeeper(draft)   → codifier   (sonnet) drafts the ADR from the confirmed candidates
  ├─ [GATE 2] cockpit wait — Q confirms the draft
  └─ lorekeeper(commit)  → barrowkeeper (haiku) writes the ADR, applies any lifecycle link update,
                                                validates it, then runs archive-logs.ts against the
                                                approved plan — skipping the archive on any error
```

**The orchestrator is spawned once per phase.** A subagent invocation ends when it returns, so one
invocation cannot both run the flow and hand control back at each gate — the first return would end
the run. The skill therefore carries the state across the gates itself: the confirmed candidate ids
over gate 1, and the approved draft, target path, and archive-plan path over gate 2. A phase that
arrives without its carry-over stops and reports; it never re-runs collection to reconstruct an
approved list, because that would silently substitute a different one.

Skill names stay plain (`commit`, `pr`, `release`, `adr`); the Norse roles live one layer down.
**lorekeeper** sits beside `storykeeper` and `oathkeeper` — lore is what an ADR holds. **gleaner**
gathers what the harvest left behind. **reckoner** performs the reckoning on the backlog.
**codifier** turns informal practice into formal text (`runesmith` already holds the carving role).
**barrowkeeper** lays things to rest without destroying them — the archive rule stated literally. It
is the only agent that writes, kept separate so "who can mutate" is answerable from the topology
alone, the same split as `watcher` / `runesmith`.

Avoided: `scribe` (collides with `/cockpit scribe`), `chronicler` (too close to the plugin name),
`annalist` / `seer` / `smith` (taken), and creature names like `raven` — Chronicle's agents are
occupations.

### Where the code lives

```
packages/chronicle/
├── shared/scripts/
│   ├── cockpit-trail.ts          walk-up, STALE_MS, DecisionRecord, log + registry reads
│   └── cockpit-trail.test.ts
├── skills/adr/
│   ├── SKILL.md
│   ├── scripts/
│   │   ├── collect-adr-context.ts / .test.ts
│   │   ├── adr-index.ts / .test.ts
│   │   ├── archive-plan.ts / .test.ts        decides; no execution path
│   │   ├── archive-logs.ts / .test.ts        executes an approved plan
│   │   └── adr-validate.ts / .test.ts
│   └── references/
│       ├── adr-template.md
│       └── fixtures/
├── agents/{lorekeeper,gleaner,reckoner,codifier,barrowkeeper}.md
└── agents-codex/{lorekeeper,gleaner,reckoner,codifier,barrowkeeper}.toml
```

## Interface

```text
/chronicle:adr triage
/chronicle:adr promote <candidate-or-topic>
/chronicle:adr supersede <adr-id>
```

`triage` is the primary entry point: scan unarchived logs and existing ADRs, cluster by decision,
and assign every candidate `promote`, `watch`, or `skip`. Scanning and judging are read-only;
archiving happens only after Q confirms.

`promote` drafts one ADR from a selected candidate, reconstructing the decision across relevant
sessions including archived ones. `supersede` drafts a replacement for an accepted ADR and links
both directions without rewriting the old decision's context or consequences.

### Promotion threshold

Require **at least one** of:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the code alone.

**Plus at least one** of:

- The decision remains relevant across sessions or releases.
- The decision affects multiple modules, plugins, or future contributors.
- A reasonable maintainer may challenge or accidentally undo it later.

A flat "any two of five" is too loose — almost any non-trivial decision hits "affects multiple
modules" and "someone may undo it", which contradicts the non-goals.

### Status vocabulary

**Status reports whether the decision is live in the code**, not whether a review has occurred. The
conventional ADR lifecycle tracks agreement between people and runs forward (decide → build); this
flow runs backward (built → recorded), so `Proposed` describes an accomplished fact wrongly.
Defaulting everything to `Proposed` was rejected: no moment in this workflow would promote them
later, so every ADR would sit at `Proposed` forever and the field would carry no information.

| Value | Means | Requires |
| --- | --- | --- |
| `Accepted` | Live in the code today | — |
| `Proposed` | Drafted ahead of the work | — |
| `Superseded` | Replaced by a named successor | `Superseded by: ADR-NNNN` |
| `Deprecated` | No longer applies, with no successor | no link |

## Bucketing

- **Strategy**: phase — the buckets are the plan's delivery stages.
- **Why**: the constraint that shaped this tree is sequencing. One extraction must land before
  anything reads the trail; nothing may write before the guard exists. Phase buckets make that
  order visible in the directory listing.

### Buckets

- **`foundation/`** — the read model and the conventions. Starts immediately; ends when the trail
  and the ADR directory can both be read without writing anything.
- **`triage/`** — the writer and the agent roster. Starts once the read model exists; ends when
  both harnesses can spawn all five roles.
- **`promote/`** — validation, the skill, the fixtures, and the closing review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| foundation | 01 | extract-cockpit-trail | todo | ≥ 4.0 | — |
| foundation | 02 | adr-conventions | todo | ≥ 4.0 | — |
| foundation | 03 | collect-adr-context | todo | ≥ 4.0 | foundation/01, foundation/02 |
| foundation | 04 | adr-index | todo | ≥ 4.0 | foundation/02 |
| triage | 01 | archive-plan | todo | ≥ 4.0 | foundation/01 |
| triage | 02 | archive-apply | todo | ≥ 4.0 | triage/01 |
| triage | 03 | adr-read-agents | todo | ≥ 4.0 | foundation/03, foundation/04, triage/01 |
| triage | 04 | adr-write-agents | todo | ≥ 4.0 | triage/02, triage/03 |
| triage | 05 | codex-agent-parity | todo | ≥ 4.0 | triage/03, triage/04 |
| promote | 01 | adr-validate | todo | ≥ 4.0 | foundation/02, foundation/04 |
| promote | 02 | skill-adr | todo | ≥ 4.0 | triage/03, triage/04, triage/05, promote/01 |
| promote | 03 | forward-test-fixtures | todo | ≥ 4.0 | promote/02 |
| promote | 04 | final-review 🏁 | todo | ≥ 4.0 | promote/03 |

The last row is the **final review** task, marked `> **Final review**: true` in its file. Its
`Depends on` reaches every other task transitively.

## Cross-bucket dependencies

```
foundation/01 ─┬─→ foundation/03 ─┐
               │                  ├─→ triage/03 ─┬─→ triage/04 ─→ triage/05 ─┐
               └─→ triage/01 ─┬───┤              └──────────────────────────-─┤
foundation/02 ─┬─→ foundation/04 ─┘                                           │
               │              └─→ triage/02 ─────→ triage/04                  │
               └─→ promote/01 ─────────────────────────────────────────────-──┴─→ promote/02
                                                                                     ↓
                                                                 promote/04 ←── promote/03
```

Two splits shape this bucket, and both cut along a change in risk rather than a change in topic.

**The archiver is two scripts, not one.** `triage/01` decides what may move and serializes a plan;
`triage/02` executes an approved plan and treats it as hostile input. Separating them puts the
untrusted-input hardening — path validation, symlink defenses, apply-time races — in one place, and
leaves the decision matrix as a pure function testable without a temp directory. It also means the
planner has **no execution path in it at all**, so "this agent is read-only" stops being a promise in
an instruction file and becomes a property of the script it was handed.

**The agent roster splits at the first confirmation gate.** `triage/03` writes the orchestrator and
the two read-only agents that run before it; `triage/04` writes the drafting and writing agents that
run after, including the only agent that mutates anything. `triage/05` mirrors the whole roster onto
Codex and therefore waits for both.

`foundation/01` reaches every downstream task transitively, satisfying the extraction-first
constraint. `foundation/02` is a same-stage peer rather than a downstream task — it is a pure
convention document that never touches the trail — so it runs in wave 1 alongside `foundation/01`
rather than behind it. Deliberate call, recorded here so it does not read as an oversight.

## Open questions

None blocking. Every convention the design left open has been settled:

- ADR numbering — four-digit zero-padded, `docs/adr/0001-<kebab-title>.md`, ID `ADR-0001`, next
  number is max + 1. Settled during this interview against the promotion threshold's needs:
  `Supersedes` / `Superseded by` links have to be readable, and sequence order has to mean decision
  order.

## Known gaps

- Stage 4 of the original design (`chronicle:pr` citing accepted ADRs, marketplace documentation)
  is deferred out of this tree. Both need a real ADR to exist first.
- `.cockpit/` is gitignored, so the archive is local-only. A fresh machine re-triages old logs.
  Accepted; the escape hatch is un-ignoring `archive/`.
- Nothing reclaims cockpit logs anywhere. `cockpit prune` was removed from monitor because it
  trashed `.cockpit/logs/` — the inbox, not the archive — at 14 days, expiring un-triaged sessions
  before they were ever judged. If cleanup is ever wanted, build it here rather than back in monitor.
- `Evidence` session ids are historical labels, not lookup keys. Logs may still be deleted by hand;
  the embedded summary is the real record.
- Six uncommitted files sit on `main` (the `cockpit prune` removal) and monitor needs a version bump
  plus a CHANGELOG entry, because removing a released CLI subcommand is a breaking change. Handled
  outside this tree.

## References

- `packages/chronicle/skills/pr/scripts/analyze-branch.ts` — the existing trail reader being extracted.
- `packages/monitor/skills/cockpit/scripts/log-root.ts` — the walk-up being ported.
- `packages/monitor/skills/cockpit/scripts/registry.ts` — `STALE_MS`, the live-session bound.
- `packages/chronicle/skills/install/scripts/setup-codex-agents.ts` — the Codex role registry.

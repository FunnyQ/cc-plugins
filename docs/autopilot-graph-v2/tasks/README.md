# autopilot-graph-v2 — Task System

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

Two independent roots, safe to run concurrently:

- `lint/01-test-net-rule.md` — the linter branch. Touches only `lint-task.ts` and its test.
- `orchestrator/01-commit-agent.md` — the orchestrator branch. Touches the fenced script block and its
  fixture.

The `orchestrator/` chain is **strictly serial** and must stay that way: all five tasks edit the same
fenced ```` ```javascript ```` block in `references/orchestrator.md` and the same
`orchestrator-script.test.ts`. Running two of them at once conflicts on both files.

The `lint/` and `orchestrator/` branches share no file, so they parallelize cleanly.

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
| integration | 01 | final review | todo | > 4 | lint/03, orchestrator/05 |
| lint | 01 | test-runner detection and the final-review regression-net rule | done | > 4 | — |
| lint | 02 | informational test-path report | done | > 4 | lint/01 |
| lint | 03 | template guidance and the existing-tree sweep | todo | > 4 | lint/01, lint/02 |
| orchestrator | 01 | give the commit step its own agent | done | > 4 | — |
| orchestrator | 02 | the scout transcribes, the script interprets | done | > 4 | orchestrator/01 |
| orchestrator | 03 | cross-attempt retry history | in-progress | > 4 | orchestrator/02 |
| orchestrator | 04 | an opt-in vendor-switch last rung | todo | > 4 | orchestrator/03 |
| orchestrator | 05 | budget floor | todo | > 4 | orchestrator/04 |

## Dependency graph

```
lint/01
├─→ lint/02
└─→ lint/03 *
    └─→ integration/01 *
orchestrator/01
└─→ orchestrator/02
    └─→ orchestrator/03
        └─→ orchestrator/04
            └─→ orchestrator/05
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| integration/01 | lint/03, orchestrator/05 |
<!-- flightplan:generated:end -->

## Known gaps

Recorded deliberately. None blocks execution; each is a limit the executor should not try to close.

1. **The end-to-end commit-audit proof is manual.** Confirming that `role: commit` entries actually land
   in a live flightlog and render in the flightdeck needs one real execution run over a small tree. A run
   cannot honestly prove that about itself, so the tree gates it with a fixture test over a synthesized
   flightlog instead. Q runs the live check by hand afterwards.
2. **The regression-net rule enforces presence, not reach.** A closing gate satisfies it with
   `bun test one/narrow/dir`. The advisory test-path report is the only countermeasure and it needs a
   human to read it. Accepted: a weak net that always exists beats a strong one that sometimes does not.
3. **Existing `done` trees that fail the new rule are reported, never retro-fitted.** Adding an unticked
   `## Verification` item to a task already marked `done` makes `taskValidity` return `invalid`
   (`completion-state`), and hand-ticking the new box is forbidden by `COMPLETION_STATE_FIX`. There is no
   honest third option. The sweep's findings get transcribed here.
4. **The `flightplan-lint.sh` PostToolUse hook will not enforce the new rule** until a dispatch release
   ships. The hook runs the plugin-cache copy of `lint-task.ts`, not the repo copy. Not a defect — the
   in-run dev driver lints a single **file**, and tree-level checks fire only for a directory argument, so
   the new rule can never fail a task mid-run either.
5. **No version bump and no `CHANGELOG.md` entry in this tree.** Plugins are served to every session from
   a marketplace clone tracking `main`, so a change to the orchestrator cannot ship the release that
   fixes it. Cut the release by hand with `/chronicle:release` after the tree lands.
6. **`CFG.budgetFloor` defaults to `0` (off) on an assumption, not an answered question.** A floor that
   fires unannounced manufactures a new stall class, and `budget.total` is `null` unless a token target
   was declared. Flip the default if that reading was wrong.
7. **Continuous scheduling stays rejected.** Revisit only if a real run shows a slow task visibly holding
   ready dependents idle; if it is ever built, "commit once at the end" is the commit point, and
   `Promise.race` must first be proven inside the Workflow runtime.

The existing-tree sweep found failures; see the "Sweep results" table for the exact findings.

### Sweep results

<!-- The existing-tree sweep records its findings here. State "no findings" explicitly if the sweep found
     nothing — a silent absence is indistinguishable from a sweep that never ran. -->

| Tree | Exit | Finding |
|---|---:|---|
| `docs/autopilot-graph-v2/tasks` | 0 | — |
| `docs/chronicle/tasks` | 0 | — |
| `docs/cockpit-autolog/tasks` | 0 | — |
| `docs/cockpit-thoughtful/tasks` | 1 | `[final-review-test-net] final-review-test-net: the plan's test suite runs in task(s) backend/01: bun test packages/monitor/skills/cockpit/scripts/cockpit.test.ts, but the closing final-review task (release/02) runs no tests. Add a test command to release/02's ## Verification section to gate the review's edits.` |
| `docs/flightdeck/tasks` | 0 | — |
| `docs/permission-relay/tasks` | 1 | `[status] Status missing or not one of todo/in-progress/done/blocked — write the value bare, with run notes on their own line` (`ui/01-permission-modal.md`, `ui/02-attention.md`, `channel/01-permission-relay.md`); `[rubric] missing ## Eval rubric section — every task must carry a graded rubric (see references/task-template.md)` (`ui/01-permission-modal.md`, `ui/02-attention.md`, `backend/02-wire-routes.md`, `backend/01-permission-broker.md`, `channel/01-permission-relay.md`); `[self-containment] body references sibling task file(s): ui/01, backend/01. Task files must be self-contained — fix one of two ways: (1) if it's a dependency, it already belongs in the Depends on header, so delete the inline pointer; (2) if the executor needs that detail, inline it here (or move it into ../_context/). Refer to the thing (the API client, the schema), not the task id.` (`channel/01-permission-relay.md`); `[final-review] no final review task — mark the closing task with > **Final review**: true in its header. It must depend (transitively) on every other task so it reviews the whole deliverable.` Because there is no closing final-review task, the linter reports no closing task ref or missing suite list. |
| `docs/relay/tasks` | 0 | — |
| `docs/waypoints-skill/tasks` | 0 | — |

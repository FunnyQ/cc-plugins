# atlas-rust — Task System

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

Start two foundation tasks in parallel: `contract/01-launcher-fixtures-ts-seams.md` (fixture home + TS test seams; every contract suite needs it) and `engine/01-scaffold-paths-dedup-model.md` (the `cockpit atlas` scaffold and the frozen module signatures).

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
| cli | 01 | Statusline and push-usage subcommands | todo | > 4 | engine/03, engine/05, engine/07, contract/04 |
| contract | 01 | Launcher, fixture home, and TS test seams | todo | > 4 | — |
| contract | 02 | HTTP and lifecycle contract suite | todo | > 4 | contract/01 |
| contract | 03 | Golden stats and rollup suite | todo | > 4 | contract/01 |
| contract | 04 | CLI subcommand contract suite | todo | > 4 | contract/01 |
| engine | 01 | Atlas scaffold, paths, dedup, and model types | todo | > 4 | — |
| engine | 02 | Rollup DB schema, migrations, and pre-rust backup | todo | > 4 | engine/01 |
| engine | 03 | Rollup ingest and the rollup-update subcommand | todo | > 4 | engine/02, contract/03 |
| engine | 04 | Pricing load, resolution, and override refresh | todo | > 4 | engine/01, contract/03 |
| engine | 05 | Codex usage source and usage limits | todo | > 4 | engine/01, engine/02, contract/03 |
| engine | 06 | OpenCode usage source | todo | > 4 | engine/01, contract/03 |
| engine | 07 | Claude usage source and usage limits | todo | > 4 | engine/03, contract/03 |
| engine | 08 | Stats assembly and fingerprint | todo | > 4 | engine/03, engine/04, engine/05, engine/06, engine/07 |
| review | 01 | Final review 🏁 | todo | > 4 | ship/02 |
| server | 01 | Live sessions module and the live subcommand | todo | > 4 | engine/01, contract/04 |
| server | 02 | The atlas serve HTTP shell and lifecycle | todo | > 4 | server/01, engine/08, contract/02 |
| ship | 01 | Wire callers to the shim and migrate the statusline | todo | > 4 | server/02, cli/01 |
| ship | 02 | Delete the TS, update docs, and measure | todo | > 4 | ship/01 |

## Dependency graph

```
contract/01
├─→ contract/02
├─→ contract/03
└─→ contract/04
engine/01
├─→ engine/02
│   └─→ engine/03 *
│       ├─→ cli/01 *
│       ├─→ engine/07 *
│       └─→ engine/08 *
├─→ engine/04 *
├─→ engine/05 *
├─→ engine/06 *
└─→ server/01 *
    └─→ server/02 *
        └─→ ship/01 *
            └─→ ship/02
                └─→ review/01
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| server/01 | engine/01, contract/04 |
| server/02 | engine/08, contract/02 |
| cli/01 | engine/03, engine/05, engine/07, contract/04 |
| review/01 | ship/02 |
| ship/01 | server/02, cli/01 |
| engine/07 | contract/03 |
| engine/05 | contract/03 |
| engine/06 | contract/03 |
| engine/04 | contract/03 |
| engine/03 | contract/03 |
<!-- flightplan:generated:end -->

## Known gaps

- **Statusline gap after update**: between the marketplace `git pull` that deletes `statusline-collector.ts` and the next SessionStart (which runs the migration), every statusline tick fails. Accepted in the interview.
- **Pre-rust backup is single-copy**: `meta.writer = 'rust'` is the only marker; deleting `rollup.db.pre-rust.bak` leaves no second copy.
- **Golden is frozen at deletion**: once the TS is deleted, the golden files cannot be re-recorded; any later change to them is a hand-reviewed Rust diff.
- **rustls on musl** is only proven by the release workflow on a real `monitor-v*` tag unless the executor has cargo-zigbuild locally.
- **Real-home parity strips two keys**: the TS-vs-Rust real-data comparison runs with the network cut, so it cannot compare `pricingMeta.openRouter.error` or `codexUsageLimits`; the fixture golden suite and the Codex usage-limit human check cover them.
- **Human checks owed**: real-home golden diff over a DB copy, dashboard visual pass on the Rust server, live statusline after migration, Codex usage limits against the real `auth.json`.

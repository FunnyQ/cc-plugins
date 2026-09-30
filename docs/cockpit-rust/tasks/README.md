# cockpit-rust — Task System

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

Start with `contract/01-launcher-harness.md` and `core/01-crate-scaffold-paths-config.md` — both are foundation tasks with no dependencies and can run in parallel.

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
| channel | 01 | rmcp handshake spike | todo | > 4 | core/01, contract/03 |
| channel | 02 | Full channel | todo | > 4 | channel/01, core/03, server/01 |
| cli | 01 | Trail and config subcommands | todo | > 4 | core/03, contract/04 |
| cli | 02 | Wait, send, restart | todo | > 4 | cli/01, server/05 |
| contract | 01 | Launcher harness | todo | > 4 | — |
| contract | 02 | Daemon HTTP contract | todo | > 4 | contract/01 |
| contract | 03 | Channel MCP contract | todo | > 4 | contract/01 |
| contract | 04 | CLI and hook contract | todo | > 4 | contract/01 |
| core | 01 | Crate scaffold, paths, config | todo | > 4 | — |
| core | 02 | Registry, log root, daemon lifecycle | todo | > 4 | core/01 |
| core | 03 | Shared find-session and nudge-toggle | todo | > 4 | core/02 |
| hooks | 01 | Session-start hook | todo | > 4 | core/03, contract/04 |
| hooks | 02 | Stop hook | todo | > 4 | hooks/01, core/03 |
| review | 01 | Final review | todo | > 4 | ship/04 |
| server | 01 | Server foundation, startup, static | todo | > 4 | core/02, core/03, contract/02 |
| server | 02 | Log stream and SSE tailer | todo | > 4 | server/01 |
| server | 03 | Transcript stream and history | todo | > 4 | server/02, server/08 |
| server | 04 | Broker, inbox, send-message | todo | > 4 | server/01 |
| server | 05 | Permission relay | todo | > 4 | server/04, server/02 |
| server | 06 | Codex control and send | todo | > 4 | server/01 |
| server | 07 | OpenCode send | todo | > 4 | server/01 |
| server | 08 | Views, sessions, design system | todo | > 4 | server/01, server/04 |
| ship | 01 | sh shim and download | todo | > 4 | core/01 |
| ship | 02 | CI release workflow | todo | > 4 | ship/01 |
| ship | 03 | Wire plugins to the shim | todo | > 4 | ship/01, channel/02, server/03, server/05, server/06, server/07, server/08, cli/02, hooks/02 |
| ship | 04 | Delete TS, update docs, measure RSS | todo | > 4 | ship/02, ship/03 |

## Dependency graph

```
contract/01
├─→ contract/02
├─→ contract/03
└─→ contract/04
core/01
├─→ channel/01 *
│   └─→ channel/02 *
├─→ core/02
│   ├─→ core/03
│   │   ├─→ cli/01 *
│   │   │   └─→ cli/02 *
│   │   └─→ hooks/01 *
│   │       └─→ hooks/02 *
│   └─→ server/01 *
│       ├─→ server/02
│       │   └─→ server/03 *
│       ├─→ server/04
│       │   └─→ server/05 *
│       ├─→ server/06
│       ├─→ server/07
│       └─→ server/08 *
└─→ ship/01
    ├─→ ship/02
    │   └─→ ship/04 *
    │       └─→ review/01
    └─→ ship/03 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| server/01 | core/02, core/03, contract/02 |
| cli/02 | server/05 |
| cli/01 | core/03, contract/04 |
| channel/02 | core/03, server/01 |
| channel/01 | core/01, contract/03 |
| hooks/02 | core/03 |
| hooks/01 | core/03, contract/04 |
| review/01 | ship/04 |
| ship/03 | channel/02, server/03, server/05, server/06, server/07, server/08, cli/02, hooks/02 |
| ship/01 | core/01 |
<!-- flightplan:generated:end -->

## Known gaps

- **Checksums share the binary's origin.** `SHA256SUMS` comes from the same GitHub release as the binary, so it catches corruption, not a compromised release. Accepted: the trust root is GitHub TLS.
- **First session after an update may miss its SessionStart reminder.** The hook fails soft while the shim downloads the new binary in the background.
- **The CI workflow cannot run before a real `monitor-v*` tag.** It is checked statically and by a local build script that shares its steps; the first real release is its first real run.
- **Bun stays a runtime prerequisite.** `cockpit log|scribe --diagram` spawns `diagram-lint.ts`, and usage-dashboard is still Bun.
- **`server/08` bundles sessions/projects views with project-info/design-system parsing** (Codex pass 5, P2). Kept as one task: both fill only `views.rs` and its children, and splitting adds a file-ownership seam for no parallelism gain.
- **Human checks owed at the end:** real Claude Code channel e2e (message + permission approve), live Codex and OpenCode TUI sends, dashboard visual pass.

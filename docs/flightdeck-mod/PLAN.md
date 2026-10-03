# Flightdeck in a Claude Code mod

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-04
> **Max parallel**: unlimited

## Overview

Render a glanceable flightdeck overview — run counts, the task tree layered by wave, and the in-flight agents — as a pane inside Claude Code, through dispatch's existing mod. The web flightdeck stays the place for detail.

## Goals

- Watch an autopilot or Workflow graph run without leaving the terminal.
- See the whole tree, one row per wave, each task coloured by state.
- Have the pane open by itself in the session that launched flightdeck.

## Non-goals

- Tokens, rubric breakdowns, judge rationales, the dependency graph, lanes — those stay web-only.
- Any change to the flightdeck server, its SPA, or `daemon.json`.
- Codex and OpenCode — neither has function hooks.
- A version bump or release. Run `/chronicle:release` separately after the tree lands.

## Context

Flightdeck today is a web dashboard only: `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` serves a petite-vue SPA from `autopilot/dashboard/dist/` on `127.0.0.1:5757`, with `/api/health`, `/api/tree` (a `TreePayload`), and `/api/events` (an SSE stream of `FleetSnapshot` frames). `/autopilot` launches it with `bun "$OWN"/flightdeck.ts --plan "<abs plan dir>"`; `deckplan` documents the same command for graph runs.

The closest mod precedent is the runes minimap (`packages/runes/hooks/minimap/minimap.tsx`): a `$.ui.open` Pane, a bun child that prints JSON rows, a ticker that re-reads only while the pane is open, and separate docked and inline layouts.

**A decision reversed during the interview.** The data source was first "poll the flightdeck server over HTTP", then reversed to "read the plan and the run log directly through a bun child". Two facts forced it: `$.http.fetch` returns a whole body and aborts at 30 s, so the SSE `/api/events` stream is unusable; and `daemon.json` is global, so another plan's launch SIGTERMs the server a pane would poll. Reading files makes the pane independent of the server.

## Requirements

### MVP

1. **Snapshot CLI** — `deck-snapshot.ts <planDir>` prints one `DeckSnapshot` JSON; `--latest <dir>` prints the newest plan under `<dir>/docs/*/`.
   - Acceptance: tests cover a tasks tree, a graph run, waves by static depth, a cycle, and `--latest`.
2. **Pane layout** — pure functions turn a snapshot plus a width into docked and inline line models.
   - Acceptance: tests pin both layouts, card wrapping, glyphs, and colours.
3. **Pane mod** — `/flightdeck [planDir|close]`, auto-open on a successful `flightdeck.ts --plan` Bash call, 2 s refresh, card toast, Open flightdeck button, stale handling.
   - Acceptance: `claude plugin test` on a copy passes; three `(human)` checks in a real session.
4. **Docs** — `CLAUDE.md` and the autopilot / deckplan SKILL.md files mention the pane.
   - Acceptance: grep finds the new lines.

### Later

- **Token counts in the pane** — needs transcript reads, too costly at 2 s.
- **Waves as actually flown** — needs the run log's scout labels; static depth was chosen for stable rows.

## Tech decisions

- **Stack**: Bun + TypeScript for the snapshot CLI; a Claude Code mod (function hooks, TSX) for the pane.
- **Storage**: none. Reads the plan's task files or `graph.json` and `<plan>/.flightlog/run.jsonl`.
- **Deployment**: ships inside the dispatch plugin.
- **Visual design**: none (no impeccable phase).
- **Conventions**: see `tasks/_context/shared.md`.

## Architecture

```
autopilot Bash: bun …/flightdeck.ts --plan <dir>
        │  (tool.call Bash, matcher on flightdeck.ts)
        ▼
dispatch mod ──$.ui.open──▶ Pane "flightdeck"
   │  every 2 s while open
   ▼
$.process.run: bun …/autopilot/scripts/deck-snapshot.ts <dir>
   │  reuses detectSource / loadPlan / loadGraphPlan / buildTreePayload / readLog / aggregateFleet
   ▼
DeckSnapshot JSON ──▶ atom ──▶ ui.render → rows.ts (docked | inline) → Box/Text/Button
```

```
packages/dispatch/
├── skills/autopilot/scripts/
│   ├── deck-snapshot.ts        # pure layerByDepth + buildDeckSnapshot + latestPlan, CLI main
│   └── deck-snapshot.test.ts
└── hooks/
    ├── register.ts             # calls flightdeck(on)
    ├── flightdeck/
    │   ├── types.ts            # DeckSnapshot type (the contract)
    │   ├── rows.ts             # pure: snapshot + width → docked / inline lines
    │   ├── rows.test.ts
    │   ├── deck-command.ts     # pure: --plan out of a Bash command
    │   ├── deck-command.test.ts
    │   └── flightdeck.tsx      # the mod feature
    └── flightdeck.mod.test.ts  # claude-code/testing
```

## Bucketing

- **Strategy**: by layer — data producer, then the mod.
- **Why**: the snapshot CLI owns `types.ts`, the `DeckSnapshot` contract; the pure layout imports it, and the mod wiring needs both. Serial on purpose: two parallel tasks creating the same file collide when autopilot lands them.

### Buckets

- **`data/`** — the snapshot CLI. Starts at once.
- **`mod/`** — pure layout, the mod feature, then docs.
- **`review/`** — the closing review only.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| data | 01 | deck-snapshot CLI | todo | > 4.0 | — |
| mod | 01 | pane layout rows | todo | > 4.0 | data/01 |
| mod | 02 | flightdeck pane mod | todo | > 4.0 | data/01, mod/01 |
| mod | 03 | docs for the pane | todo | > 4.0 | mod/02 |
| review | 01 | final review 🏁 | todo | > 4.0 | data/01, mod/01, mod/02, mod/03 |

Run options: review engine Codex, depth Standard.

## Cross-bucket dependencies

```
data/01 → mod/01 → mod/02 → mod/03 → review/01
   └────────────────┘
```

## Open questions

1. **Wave count semantics** — static-depth waves can disagree with the waves autopilot flies (Max parallel splits a wave; re-flies stay in their wave), so `wave N of M` is the plan's shape, not the run's history. Accepted for stable rows; revisit if it misleads.

## Known gaps

- Listed in `tasks/README.md` → Known gaps (wave semantics, the `flightdeck.ts` matcher string, the launcher's global `daemon.json`, three owed `(human)` checks).
- Review: the broad Codex loop capped with 2 P1s open after 7 passes; one narrow pass cleared it.

## References

- `packages/runes/hooks/minimap/minimap.tsx` — the pane pattern.
- `packages/dispatch/skills/autopilot/scripts/{tree-api,fleet,graph-source,waves}.ts` — the reused data code.

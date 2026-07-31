# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`cc-plugins` is a Claude Code and Codex plugin marketplace. This plan adds **flightdeck**, a local web
UI that renders an `autopilot` run live — the flightplan task tree on top, the subagent fleet below.
It auto-starts when `/autopilot` launches a flight and reads the run's append-only flightlog. It is a
strict read layer and never writes to the repo.

All new code lives under `packages/dispatch/skills/autopilot/`.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Use `node:fs/promises`, `node:path`, `Bun.serve`,
  `Bun.file`.
- **Frontend**: petite-vue (not full Vue), served from a committed `dashboard/dist/`. No build step.
- **Tests**: `bun test`, co-located as `<name>.test.ts` beside the source.
- **Dependencies**: no npm install step, ever. The SPA gets exactly **one** vendored library —
  petite-vue — copied verbatim from `packages/monitor/skills/cockpit/dashboard/dist/vendor/petite-vue.es.js`
  into `packages/dispatch/skills/autopilot/dashboard/dist/vendor/petite-vue.es.js` and committed.
  Copying a file is not a plugin dependency; importing across plugins at runtime would be. Nothing else
  may be vendored: no chart library, no Mermaid, no fonts, no highlighter. If a capability needs another
  library, hand-roll it or drop the capability.

## Code style

- Use `type`, never `interface`.
- Keep parsing, deriving, and formatting in **exported pure functions**. The `main()` at the bottom is
  the only impure part: it reads `process.argv`, touches the filesystem, prints, and sets the exit code.
  This mirrors `packages/dispatch/skills/flightplan/scripts/scaffold.ts` and `mark-done.ts`.
- Write comments in English. Explain reasons that are not obvious; do not narrate actions.
- Prefer clear names over comments.
- 2-space indent, double-quoted strings, semicolons. Authoritative source (for verification only):
  the existing files in `packages/dispatch/skills/flightplan/scripts/`.

## File and directory layout

New files go here:

```
packages/dispatch/skills/autopilot/
├── SKILL.md                        (modify)
├── PRODUCT.md                      (new) — Hangar design direction
├── references/orchestrator.md      (modify)
├── scripts/                        (new directory — autopilot's first)
│   ├── fleet.ts                    — pure derivation: task state, agent labels, fleet rows
│   ├── static-serve.ts             — pure path resolution + MIME + the file response
│   ├── daemon-record.ts            — the daemon record's shape, path, and I/O
│   ├── flightdeck.ts               — the server process and its route table
│   ├── launch.ts                   — CLI, singleton decision use, detached spawn, readiness
│   ├── daemon-decision.ts          — pure start / reuse / supersede decision
│   ├── tree-api.ts                 — plan loading + the pure tree payload builder
│   ├── events-api.ts               — the SSE fleet-snapshot handler
│   ├── tail.ts                     — pure cursor and line-splitting helpers
│   └── <each of the above>.test.ts — one `bun test` file per module
└── dashboard/dist/                 (new) — committed SPA, sibling of scripts/
    ├── index.html
    ├── style.css
    ├── app.js
    ├── modules/lanes.js
    ├── modules/fleet.js
    ├── modules/graph.js
    └── vendor/petite-vue.es.js     — the one vendored library
```

This list is the complete planned file set, and it is authoritative for **placement**, not for exact
names. A task that needs one more small module may add it beside these; a task must not move code
outside this tree or invent a second scripts directory.

`dashboard/` sits beside `scripts/`, not inside it — the same shape monitor uses for
`skills/cockpit/dashboard/dist/`. `flightdeck.ts` resolves it as
`resolve(import.meta.dir, "..", "dashboard", "dist")`.

Modified outside autopilot:

- `packages/dispatch/skills/flightplan/scripts/lib/flightlog.ts` — the entry types
- `packages/dispatch/skills/flightplan/scripts/flightlog.ts` — the CLI
- matching `.test.ts` files beside each

## Import rules

Two hard rules:

1. **dispatch must never import from monitor.** They are separate plugins on independent release
   cadences. `packages/monitor/skills/cockpit/scripts/sse-tailer.ts`, `daemon-lifecycle.ts`, and
   `packages/monitor/skills/shared/scripts/static-server.ts` are **patterns to read and copy**, never
   imports. Copying ~40 lines is correct here; a cross-plugin import is not.
2. **Cross-skill imports inside dispatch are allowed.** flightdeck imports from its sibling skill:

   ```ts
   import { loadAllTasks } from "../../flightplan/scripts/next-ready";
   import type { FlightlogEntry, NoteEntry, ScoreEntry } from "../../flightplan/scripts/lib/flightlog";
   import { parseLog } from "../../flightplan/scripts/lib/flightlog";
   import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
   ```

   Both skills ship inside one plugin at one version, so the relative path holds in the marketplace
   cache as well as the repo. This is the repo's first cross-skill import.

   **The permitted surface is exactly these three modules** — the task loader (`next-ready`), the
   flightlog module (`lib/flightlog`), and the task parser (`lib/parse-task`). Nothing else from the
   sibling skill may be imported. Keeping the list explicit is what stops it growing into an
   undocumented coupling between two skills that are supposed to be separable.

`next-ready.ts` guards its `main()` behind `import.meta.main`, so importing it runs no side effects.

## Commit and branching style

- This repo runs GitHub Flow. `main` is the only long-lived branch.
- Commit format: emoji + conventional, e.g. `✨ feat: add flightdeck daemon`, `✅ test: cover label
  parsing`, `📖 docs: document Hangar tokens`, `♻️ refactor:`, `🐛 fix:`.
- One task should land as one commit.
- Do not bump any `plugin.json` version and do not touch `CHANGELOG.md`. Releases are cut separately
  by the chronicle release skill after this whole tree lands.

## Verification baseline

Commands every task can rely on, run from the repo root:

- `bun test packages/dispatch/skills/autopilot/scripts/` — the new suite
- `bun test packages/dispatch/skills/flightplan/scripts/` — the existing suite, must stay green
- `bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --plan <abs> --no-open` — start the daemon
- `curl -s localhost:5757/api/tree | jq` — inspect the tree endpoint

Two real plan trees already on disk make good fixtures:

- `docs/waypoints-skill/tasks` — 6 tasks across 3 buckets, all `done`, with real cross-bucket deps.
- `docs/chronicle/.flightlog/run.jsonl` — a real 11 KB flightlog with score and note entries.

Never start a server on port 5757 without checking whether one is already running.

## Decisions frozen during interview

- **flightlog is the live channel** — in-flight visibility comes from start events appended to
  `run.jsonl`, not from the Workflow runtime's own journal. No sample of that journal exists on disk,
  so its path and format are unverified.
- **Read-only** — flightdeck never writes to the repo. `mark-done.ts` and `score-task.ts` own the task
  files; a second writer would race them.
- **Split view, equal weight** — task lanes on top, agent fleet below, both visible at once. Not tabs.
- **Resident singleton** — the daemon stays up after a run ends so the final state is still readable.
  It serves exactly one plan; a later `/autopilot` on a different plan supersedes it.
- **Port 5757** — `5938` is the usage dashboard, `5858` is cockpit.
- **Hangar, not Night Flight** — dispatch gets its own visual language rather than borrowing monitor's.
- **Hand-laid SVG for the dependency graph** — no Mermaid. The tree is small, and Mermaid relayouts on
  every status change, which makes a live view jump.
- **Always open the browser** — `/autopilot` is human-invoked and its confirmation step needs an
  interactive user, so there is no headless case to detect. `--no-open` exists for manual testing only.
- **autopilot now ships scripts** — `SKILL.md` currently states the opposite. That invariant is retired
  by this plan, and both the statement and the path-resolution step that depends on it must be updated.

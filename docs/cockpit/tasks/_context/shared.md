# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

Cockpit is a **per-project local web driving-cockpit**, shipped as a second plugin (`cockpit/`) inside the `cc-plugins` marketplace repo (sibling to `token-atlas/`). It has three parts: a **kernel** that produces goal + decision-log data into each project's `.cockpit/` dir; a **viewer** (global Bun daemon + no-build SPA) showing a project→session rail and a 3-column view (live transcript │ decision log │ project info); and a **control loop (bridge)** that turns a `needs_your_call`'s options into UI buttons whose pick wakes the parked session. Used by Q to stay "in the loop and in control" while Claude implements. This is **v1** (not a thin MVP) — read-only viewer + bidirectional control + multi-project.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Use `Bun.serve`, `Bun.file`, `bun:sqlite` only if needed (cockpit needs no sqlite).
- **Frontend**: petite-vue (not full Vue) + `marked` + `DOMPurify` + `highlight.js`. **No Chart.js** — cockpit has no analytics charts.
- **No external npm deps** — vendor libs are committed under `cockpit/skills/<skill>/dashboard/dist/vendor/` (copy the four needed files from `token-atlas/.../dashboard/dist/vendor/`: `petite-vue.es.js`, `marked.esm.js`, `purify.es.mjs`, `highlight.esm.js`).
- **No build step** — `dashboard/dist/` is committed as-is and served statically.

## Code style

- Use `type` over `interface`.
- 2-space indent, no semicolons-optional debates — match `token-atlas/skills/dashboard/scripts/*.ts` exactly.
- Server binds `127.0.0.1` only (never `0.0.0.0`).
- Path security for any file served by id: validate `^[0-9a-f-]{36}$` (uuid) first, resolve the path, then `realpath`-confine inside the allowed root before reading.
- Authoritative style source (verification only): `cc-plugins/token-atlas/skills/dashboard/scripts/live.ts`.

## File / directory layout

The new plugin mirrors token-atlas:

```
cc-plugins/
├── .claude-plugin/marketplace.json     # add a "cockpit" entry alongside "token-atlas"
└── cockpit/
    ├── .claude-plugin/plugin.json       # plugin manifest (version must match marketplace entry)
    └── skills/
        ├── cockpit/                      # the /cockpit-start skill
        │   ├── SKILL.md
        │   └── scripts/
        │       ├── cockpit.ts            # the `cockpit` CLI (start | log | wait | send)
        │       ├── serve-dashboard.ts    # the global daemon (routes + static)
        │       ├── registry.ts           # registry read + active/ended status
        │       ├── log-stream.ts         # decision-log SSE
        │       ├── transcript-stream.ts  # live-transcript SSE (adapted from token-atlas)
        │       ├── broker.ts             # per-session wait/respond broker
        │       └── project-info.ts       # meta + CLAUDE.md + DESIGN.md tokens
        └── (dashboard assets)
            dashboard/dist/               # no-build SPA: index.html, app.js, style.css, modules/, vendor/
```

Per-project data the CLI writes (NOT in this repo — in each working project):

```
<project>/.cockpit/
  project-meta.md            # YAML frontmatter + prose (persistent project goal)
  logs/<session-id>.jsonl    # goal record (head) + decision records (append-only)
```

Central daemon state:

```
~/.cockpit/
  daemon.json                # {pid, port, token}
  registry.json              # registered sessions + heartbeats
```

## Commit & branching style

- Branch off: `main`.
- Commit format: emoji + conventional (e.g. `✨ add cockpit CLI start subcommand`), matching this repo's history.
- Use `/odin-git:simple-commit` (single change) or `/odin-git:atomic-commit` (multiple logical changes). **Confirm with Q via AskUserQuestion before committing** (per Q's global workflow rule).
- ⚠️ **Two version files bump together**: `cc-plugins/.claude-plugin/marketplace.json` (`plugins[].version` for cockpit) and `cockpit/.claude-plugin/plugin.json` (`version`). They drift easily.

## Verification baseline

- Run a script: `bun cockpit/skills/cockpit/scripts/<script>.ts [args]`.
- Daemon: `bun cockpit/skills/cockpit/scripts/serve-dashboard.ts` (default port 5858, `127.0.0.1`).
- Inspect endpoints against a running daemon: `curl -s localhost:5858/api/sessions | jq`, `curl -N "localhost:5858/api/log/stream?project=<path>&session=<id>"`.
- **Q runs the dev server / browser himself** — sub-agents do not start long-running servers or open browsers; they verify via one-shot `curl` / CLI runs and report.

## Decisions frozen during interview

- **Scope = v1 (not a thin MVP)** — kernel + viewer + **bidirectional control loop** (bridge) + **multi-project nesting**. Produce the data, show it, and steer it.
- **Files live per-project** in `<project>/.cockpit/` (version-controllable, "context as files"), not a central blob.
- **Discovery via self-registration** — the CLI registers each session to `~/.cockpit/registry.json` with a heartbeat; the daemon watches only registered dirs (no filesystem scanning).
- **Goal capture via `/cockpit-start` skill** — explicit, with a propose→confirm human gate (symmetric to `needs_your_call`).
- **Goal record holds only `session_goal`** — the persistent project goal lives in `project-meta.md` frontmatter (single source of truth), not duplicated in the log.
- **Decision record = 8 fields** — `type`, `decision`, `reason`, `tradeoff`, `needs_your_call`, `options[]`, `files[]`, `timestamp`. Plus a `response` record type for answers (see `data-model.md`).
- **Control loop = per-`sessionId` broker** — `GET /api/wait` (parked long-poll) + `POST /api/respond`; `cockpit wait`/`cockpit send` CLIs; UI option buttons. Sparse: a session only parks at a `needs_your_call`. Answers to unparked sessions are logged but `delivered: false`.
- **One global daemon**, PID-file reuse — not one per project.
- **Live-view (transcript) is migrated from token-atlas and shown as a persistent column**, not a click-to-open modal.
- **DESIGN.md tokens are consumed** to theme each project's cockpit (see `ui/04`); CLAUDE.md is shown read-only.
- **Multi-project**: the rail nests sessions under projects (layout only — the session model already handles concurrency).
- **token-atlas is left untouched** in this work — copy the engine pattern, defer removal.
- **Default port 5858** (token-atlas owns 5938).

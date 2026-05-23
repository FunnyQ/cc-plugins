# Cockpit — 專案駕駛艙

> **Status**: implemented (v1, all 15 tasks done) · **Owner**: Users · **Last updated**: 2026-05-23

## Overview

A per-project local web **cockpit** (sibling plugin to token-atlas): open a session, set the goal, then watch the decision trail steer toward it in real time — keeping users "in the loop and in control". token-atlas is the rear-view mirror (retrospective, global usage); cockpit is the windshield + control stick (present + goal, per-project).

## Goals

- **Kernel (novel)**: capture a goal at session start and append a distilled decision log — the thing no tool in the ecosystem produces.
- **Viewer**: a dashboard — multi-project side-rail (project → sessions) + 3-column session view (live transcript │ decision log │ project info), themed per-project from its DESIGN.md.
- **Control loop**: at a `needs_your_call`, the UI presents the LLM's `options` as buttons; the user's pick is routed back to wake the parked session — true two-way "in control".
- **End-to-end**: produce the data, show it, *and* steer it.

> **Scope note**: this is **v1**, not a thin MVP. The earlier read-only cut grew, on user feedback, to include the bidirectional control loop (the `bridge` bucket) and multi-project nesting. Only token-atlas's live-view removal stays deferred.

## Non-goals

- ❌ Removing live-view from token-atlas — copy the engine into cockpit; leave token-atlas untouched (別留空窗). Separate follow-up.
- ❌ App backend / business logic (the live server is thin, read-only).
- ❌ Build step / bundler — no-build SPA, vendored libs.
- ❌ Prose owned/structured by the renderer (display markdown is fine; structuring it is not).
- ❌ Hand-rolled design-token format — adopt Google DESIGN.md standard.
- ❌ Premature shared lib between token-atlas and cockpit — copy the pattern, don't abstract at two consumers.

## Context

Builds on token-atlas's proven engine (Bun server + SSE file-watch + no-build petite-vue SPA + marked/DOMPurify/highlight.js). Lives in the same marketplace repo `cc-plugins` as a second plugin. Server model derived from reading impeccable's `live` source (`~/.claude/plugins/cache/impeccable/impeccable/3.0.6/skills/impeccable/scripts/live-*.mjs`): broker + long-poll/SSE. cockpit's interaction is **reversed** from impeccable — LLM-driven, parking for input only at `needs_your_call` — so the wait channel is **sparse** (one parked poll per session, only at a handoff), not a constant poll. That sparseness lets the broker stay thin: a per-`sessionId` rendezvous in the daemon.

The narrative / decision-trail document lives at `personal-assistant/project-plans/cockpit/plan.md`. That doc explains *why*; this PLAN.md and its task tree are the executable *what*.

## Requirements

### Scope (v1)

1. **Per-project storage** — `<project>/.cockpit/project-meta.md` (YAML frontmatter + prose) + `logs/<session-id>.jsonl` (goal record head + decision/response records).
   - Acceptance: `cockpit start` creates both; `cockpit log` appends a valid 8-field decision record; a malformed line doesn't break parsing of others.
2. **`cockpit` CLI** — `start` (write meta + session goal record + register/heartbeat), `log` (atomic append; `--file`/`--option` repeatable), plus `wait`/`send` for the control loop.
   - Acceptance: running each from a project dir produces the files above and a registry entry under `~/.cockpit/`.
3. **`/cockpit-start` skill** — Claude proposes project+session goal, the user confirms/edits (human gate), then calls `cockpit start`.
   - Acceptance: invoking the skill yields a written `project-meta.md` + goal record only after the user's confirmation.
4. **Session discovery** — sessions self-register to `~/.cockpit/registry.json` with heartbeat; daemon watches only registered `.cockpit/logs/` dirs; active vs ended distinguished by heartbeat/mtime.
   - Acceptance: `GET /api/sessions` lists registered sessions with `active|ended` status.
5. **Global daemon** — one Bun daemon (not per-project), PID-file reuse (`~/.cockpit/daemon.json` `{pid,port,token}`, `process.kill(pid,0)` probe), binds `127.0.0.1`, serves `dashboard/dist/` + APIs.
   - Acceptance: starting twice reuses the live daemon; killing it and restarting rebinds.
6. **Decision-log SSE** — `GET /api/log/stream?project&session` tails a session's decision JSONL via file-watch.
   - Acceptance: appending a record with `cockpit log` pushes it to a connected client within ~1s.
7. **Live-transcript engine** — adapt token-atlas `live.ts streamTranscript` to stream a session's `~/.claude/projects/**/<id>.jsonl`.
   - Acceptance: `GET /api/transcript/stream?session=<uuid>` sends backlog then tails appends; path confined to `~/.claude/projects`.
8. **3-column UI** — session side-rail (active first) + columns: live transcript │ decision log (with `needs_your_call` highlight) │ info (goal + CLAUDE.md markdown + DESIGN.md-driven theming).
   - Acceptance: selecting a session renders all three columns; decision/transcript update live; CSS variables reflect that project's DESIGN.md tokens.
9. **Control loop (bridge)** — a per-`sessionId` broker (`GET /api/wait` long-poll + `POST /api/respond`), `cockpit wait`/`cockpit send` CLIs, and UI buttons that turn a `needs_your_call`'s `options` into clickable answers. Picking routes the answer back to the parked session and appends a `response` record.
   - Acceptance: a `needs_your_call` with options renders buttons; clicking one wakes a `cockpit wait` and appends a `response`; concurrent sessions never cross-talk; answering an unparked session returns `delivered: false` (logged, not woken).
10. **Multi-project nesting** — the side-rail groups sessions under their project (project → sessions), active projects first.
    - Acceptance: two seeded projects appear as parents with nested sessions; selecting any session drives the 3-column detail and goal bar.

### Later

- **token-atlas live-view removal** — restore token-atlas to pure rear-view. Reason: don't destabilize a working plugin; copy-first.
- **Reaching an unparked session** — answering a session whose turn fully ended (no live `cockpit wait`) only logs the response; waking it would need harness-level IPC. Out of scope; surfaced as `delivered: false`.

## Tech decisions

Freeze the choices that affect more than one task. These flow into `tasks/_context/shared.md`.

- **Stack**: Bun + TypeScript (no transpile). Frontend: petite-vue + marked + DOMPurify + highlight.js (vendored, no Chart.js — cockpit has no analytics charts).
- **Storage**: per-project `<project>/.cockpit/` (logs/meta); central `~/.cockpit/` (registry + daemon PID file).
- **Formats**: append-only → **JSONL** (goal + decision + response records); persistent snapshot → **YAML frontmatter + prose** (project-meta).
- **Deployment**: local plugin in `cc-plugins`; daemon on `127.0.0.1`, default port **5858** (token-atlas uses 5938).
- **Conventions**: → `tasks/_context/shared.md`. Emoji conventional commits; `/odin-git:simple-commit` or `atomic-commit`; **bump `marketplace.json` + `cockpit/.claude-plugin/plugin.json` together**.

## Architecture

```
 /cockpit-start skill ──proposes goal, user confirms──┐
                                                    ▼
 cockpit CLI:  start ─→ <project>/.cockpit/project-meta.md + logs/<id>.jsonl (session goal record)
               start ─→ ~/.cockpit/registry.json (register + heartbeat)
               log   ─→ logs/<id>.jsonl (append decision record, 8 fields)
               wait  ─→ GET /api/wait  (park at needs_your_call — background task, zero cost)
                                                    │ file-watch
 global Bun daemon (~/.cockpit/daemon.json) ◀───────┘
   ├─ GET  /api/projects, /api/sessions   (registry + heartbeat → active/ended)
   ├─ GET  /api/log/stream                (SSE tail of decision/response JSONL)
   ├─ GET  /api/transcript/stream         (SSE tail of ~/.claude/projects/**/<id>.jsonl — adapted from token-atlas)
   ├─ GET  /api/wait?session   ┐ per-sessionId broker (pendingWaits Map)
   ├─ POST /api/respond        ┘ append response record + wake parked wait
   └─ static dashboard/dist/
                                                    │ SSE  ▲ POST (button / cockpit send)
 no-build SPA (petite-vue):  project→session rail + 3 columns
   [ live transcript ] [ decision log + answer buttons ] [ info: goal/CLAUDE.md + DESIGN.md theming ]
```

## Bucketing

Tasks live under `tasks/<bucket>/`.

- **Strategy**: layer — `kernel` / `server` / `bridge` / `ui`. Maps to the concept doc's (a) data-production / (b) app split, with (b) split into daemon, control-loop, and SPA.
- **Why**: clean dependency chain (kernel → server → ui), with `bridge` as a self-contained control layer that plugs into both server and ui; each layer independently testable; matches token-atlas's own file split.

### Buckets

- **`kernel/`** — the novel data-production layer + plugin scaffold. Starts first.
- **`server/`** — thin daemon, read endpoints, live engine. Needs kernel's schema.
- **`bridge/`** — the control loop: per-session broker endpoints, `wait`/`send` CLIs, UI answer buttons. Plugs into server + ui.
- **`ui/`** — no-build SPA: project→session rail + 3 columns + theming. Needs server endpoints.

## Task index

| Bucket | NN | Title | Status | Depends on |
|---|---|---|---|---|
| kernel | 01 | plugin-scaffold | done | — |
| kernel | 02 | cockpit-cli | done | kernel/01 |
| kernel | 03 | cockpit-start-skill | done | kernel/02 |
| server | 01 | daemon-lifecycle | done | kernel/01 |
| server | 02 | registry-projects-api | done | server/01, kernel/02 |
| server | 03 | decision-log-sse | done | server/02 |
| server | 04 | live-transcript-engine | done | server/01 |
| bridge | 01 | broker-endpoints | done | server/01 |
| bridge | 02 | cockpit-wait-and-send | done | bridge/01, kernel/02 |
| bridge | 03 | ui-respond-buttons | done | ui/02, bridge/01 |
| ui | 01 | spa-shell-layout | done | server/02 |
| ui | 02 | decision-log-column | done | ui/01, server/03 |
| ui | 03 | live-transcript-column | done | ui/01, server/04 |
| ui | 04 | info-column-theming | done | ui/01 |
| ui | 05 | multi-project-nesting | done | ui/01, server/02 |

(Mirrors the table in `tasks/README.md` — keep them in sync.)

## Cross-bucket dependencies

```
kernel/01 ─→ kernel/02 ─→ kernel/03
kernel/01 ─→ server/01 ─┬─→ server/02 ─→ server/03
kernel/02 ──────────────┘                     │
server/01 ─→ server/04                         │
server/01 ─→ bridge/01 ─┬─→ bridge/02 (＋kernel/02)
                        └─→ bridge/03 ◀─ ui/02
server/02 ─→ ui/01 ─┬─→ ui/02 ◀─ server/03 ────┘
                    ├─→ ui/03 ◀─ server/04
                    ├─→ ui/04
                    └─→ ui/05
```

## Open questions

1. **DESIGN.md token consumption format** — ✅ **resolved** (`ui/04`). The `@google/design.md` CLI isn't installed and the Obsidian spec note wasn't present, but real DESIGN.md files follow the Google open standard as **YAML frontmatter** (`colors:` / `typography:` / `rounded:` / `spacing:` maps). `project-info.ts` parses that frontmatter with native `Bun.YAML.parse` and maps semantic slots onto cockpit's CSS vars via name-priority regex + a luminance/chroma fallback (`colorBg`←paper/cream/bg or lightest; `colorFg`←ink/text or darkest; `accent`←accent/primary/brand or most-saturated; `fontSans`←typography.body; `radius`←rounded.md). Absent/unparseable → `tokens: null`, SPA keeps neutral defaults. Assumption documented in `project-info.ts`.
2. **Heartbeat staleness window** — ✅ **confirmed** (`server/02`): 10 min (`STALE_MS = 10 * 60 * 1000`), using `max(lastHeartbeat, log-file mtime)` so a live session that appends without re-registering still reads `active`.

## Known gaps

- **Unparked sessions can't be woken** — `cockpit send` / UI answers only reach a session with a live `cockpit wait` poll. A session whose turn fully ended just gets a logged `response` (`delivered: false`); waking it needs harness-level IPC. By design for v1.

## References

- Concept / decision-trail doc: `personal-assistant/project-plans/cockpit/plan.md`
- Engine to reuse: `cc-plugins/token-atlas/skills/dashboard/scripts/{live.ts,serve-dashboard.ts}` + `dashboard/dist/{modules/dashboard-app.js,styles/live.css,vendor/}`
- impeccable broker reference (the model `bridge/` adapts): `~/.claude/plugins/cache/impeccable/impeccable/3.0.6/skills/impeccable/scripts/live-*.mjs`

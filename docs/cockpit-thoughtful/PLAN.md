# Cockpit Thoughtful Auto-Logging

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-06-02

## Overview

Add a **thoughtful mode** to the cockpit plugin: once the pilot runs `/thoughtful`, the main agent — at its own judgment, when it has just done something worth recording — spawns a background fork of itself that distills the work into typed cockpit log entries. No goal-setting gate, no manual `cockpit log` discipline.

## Goals

- A `/thoughtful` opt-in mode that makes the session auto-write decision-trail entries without `cockpit start` and without explicit per-entry `cockpit log` calls.
- Richer log entries beyond plain decisions: `rationale` (why this code), `learning` (what the pilot should take away), `caveat` (the trap/precondition) — alongside the existing `decision`.
- Auto-written entries are visually distinguishable from hand-authored ones in the dashboard.
- All distillation work stays inside the interactive subscription session (no `claude -p`, no separate API billing).

## Non-goals

- **Stop-hook re-salience nudge** — re-injecting the mode reminder each turn to fight instruction decay. Deferred to v2; v1 accepts best-effort.
- **Watermark file for dedup** — replaced by reading the log tail (single source of truth).
- **100% trigger guarantee** — judgment-based triggering is acceptable; trivial turns are intentionally skipped.
- **log_language auto-detection** — keep the existing behavior (read `project-meta.md`, default English).
- **Forcing logging via hooks** — verified impossible (hooks are pure shell; cannot fork subagents or call tools).

## Context

Today the cockpit decision log has two entry paths, both reliant on discipline: run `/cockpit` to set a goal (the gate), then have the agent call `cockpit log` by hand. Forget either and nothing is recorded.

Three facts (verified against Claude Code docs) shape the design:

1. **Hooks can't help.** A command hook is a shell script — it cannot trigger tools or fork subagents. A `Stop` hook can only inject text via `decision:block` + `additionalContext`, which is non-deterministic and pollutes the main context. So triggering is moved into the model: `/thoughtful` injects a standing instruction; the main agent decides when.
2. **Stay in-session for billing.** A forked subagent runs under the interactive subscription session, unlike `claude -p` (exposed to separate API metering). So the distiller is a fork, not a headless call.
3. **Fork beats clean subagent.** A fork inherits the main context, which is still warm in the prompt cache right at turn-end → cache-hit reads are cheap, and the fork already knows *why* the code was written. (Fork and a custom `subagent_type` are mutually exclusive, so the scribe's instructions are delivered via the spawn prompt → the `/cockpit-scribe` skill.)

Existing architecture lives in `packages/monitor/skills/cockpit/`:
- `scripts/cockpit.ts` — CLI (`start`/`log`/`wait`/`send`); `cmdLog` builds a `DecisionRecord` and appends it to `<project>/.cockpit/logs/<sessionId>.jsonl` with a read-back guard.
- `scripts/log-stream.ts` — tails the log jsonl and emits each record **verbatim** over SSE (so new fields flow through automatically).
- `scripts/registry.ts` — `~/.cockpit/registry.json`; a session is `tracked:true` only if it has a registry entry (written by `cmdStart`'s `upsertSession`).
- `dashboard/dist/modules/decision-log.js` + `style.css` — petite-vue SPA (Night Flight design system, no build step) that renders each record as a `.decision-card`.

## Requirements

### MVP

1. **Log schema gains `kind` + `source`** — optional fields, backward compatible.
   - Acceptance: old entries (no `kind`/`source`) render identically to today; new manual entries carry `kind:"decision"`, `source:"agent"`.
2. **`cockpit scribe` subcommand** — writes a typed entry; auto-registers the session; `--recent` lists recent scribe entries for dedup.
   - Acceptance: `cockpit scribe --type learning --title T --text X` on a never-started session creates the log, registers it (`tracked:true`), and the entry has `source:"scribe"`, `kind:"learning"`.
3. **`/cockpit-scribe` skill** — runs inside the fork; gathers diff, dedups via `--recent`, writes a few high-signal typed entries in `log_language`.
   - Acceptance: a fork given "run /cockpit-scribe" produces ≥1 typed entry and skips already-logged material.
4. **`/thoughtful` skill** — main-agent mode; defines WHEN (judgment) and HOW (background fork → `/cockpit-scribe`).
   - Acceptance: invoking it does not auto-fire on trivial turns; on a meaningful unit it spawns a fire-and-forget fork.
5. **Dashboard renders `kind` + `source`** — per-kind visual accent, a scribe source badge, and an updated empty-state CTA mentioning `/thoughtful`.
   - Acceptance: a `learning`/`scribe` entry shows its kind accent + badge; a never-tracked session's invite mentions both `/cockpit` and `/thoughtful`.

### Later

- **Stop-hook re-salience** — fight mode-instruction decay over long sessions.
- **log_language auto-detection** — infer from the conversation rather than meta default.

## Tech decisions

- **Stack**: Bun + TypeScript (no transpile, no external npm deps), petite-vue + committed `dashboard/dist/` (no build step).
- **Storage**: JSONL log at `<project>/.cockpit/logs/<sessionId>.jsonl`; registry at `$COCKPIT_HOME/registry.json`; meta at `<project>/.cockpit/project-meta.md`.
- **Conventions**: `type` over `interface`; per-1M-token pricing N/A here. See `_context/shared.md`.
- **Schema contract**: see `_context/log-schema.md` (shared by backend + ui).

## Architecture

```
/thoughtful (main agent, judgment trigger)
   └─ Agent tool: fork self (omit subagent_type → inherit context, cache-warm), background
        └─ /cockpit-scribe (in fork)
             ├─ git diff / git log         (code-change lens)
             ├─ cockpit scribe --recent    (dedup against already-logged)
             └─ cockpit scribe --type … --title … --text …  (write typed entries)
                   └─ cockpit.ts cmdScribe
                        ├─ findSession() auto-resolve
                        ├─ upsertSession() ← AUTO-REGISTER (tracked:true, no goal)
                        ├─ append DecisionRecord{ kind, source:"scribe" } + read-back guard
                        └─ refreshHeartbeat()
                              │
   log jsonl ── log-stream.ts (verbatim SSE) ──▶ dashboard decision-log.js
                                                   ├─ is-kind-* accent
                                                   ├─ source badge (scribe)
                                                   └─ empty-state CTA (+ /thoughtful)
```

## Bucketing

- **Strategy**: by layer (backend / skills / ui) + a `release` bucket for the cross-cutting version bump and the closing review.
- **Why**: the backend schema+CLI is the contract that unblocks both the skills and the dashboard, which can then proceed in parallel; release work must wait for everything.

### Buckets

- **`backend/`** — `cockpit.ts` schema + `cockpit scribe` CLI + tests. Foundation; starts first.
- **`skills/`** — the two new SKILL.md files. Starts after the CLI contract exists.
- **`ui/`** — dashboard render + empty-state copy. Starts after the schema contract exists; parallel with skills.
- **`release/`** — version bump + CHANGELOG, then the Final review gate. Last.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| backend | 01 | scribe-cli-and-schema | todo | > 4.0 | — |
| skills | 01 | cockpit-scribe-skill | todo | > 4.0 | backend/01 |
| skills | 02 | thoughtful-skill | todo | > 4.0 | skills/01 |
| ui | 01 | dashboard-kind-source-empty-state | todo | > 4.0 | backend/01 |
| release | 01 | version-and-changelog | todo | > 4.0 | backend/01, skills/02, ui/01 |
| release | 02 | final-review 🏁 | todo | > 4.0 | release/01 |

(Mirrors `tasks/README.md`. The last row is the **final review** task, marked `> **Final review**: true`; its `Depends on` transitively reaches every task via `release/01`.)

## Cross-bucket dependencies

```
backend/01 ──┬── skills/01 → skills/02 ──┐
             └── ui/01 ──────────────────┼── release/01 → release/02 🏁
                                         │
       (skills/02 + ui/01 + backend/01) ─┘
```

## Open questions

None blocking. Cross-surface spawn is resolved: Claude forks via the Agent tool (omit `subagent_type`); Codex spawns a background sub-agent with `fork_context: true` and no `agent_type` (confirmed) — both inherit context. Both interview forks are resolved: thoughtful sessions **auto-register**; dedup is via **log-tail read** (no watermark).

## Known gaps

- log_language for scribe entries defaults to English when no `project-meta.md` exists; the fork is instructed to otherwise match the conversation language. Not a separate task.
- **Concurrency**: background forks write the same log concurrently, so the scribe persistence guard checks the record by `id` (not by tail) — see `backend/01`.
- **Findings folded in from codex review**: concurrency-safe guard (was a tail check), `--recent` optional-value parsing, explicit `--session` in tests, UI kind whitelist (throw-safety) + label-conflict check, and a copyable CLI-path snippet for the scribe fork.

## References

- `_context/shared.md` — conventions + verification baseline
- `_context/log-schema.md` — record + CLI contract
- `_context/rubric.md` — scoring scale + generic dimensions

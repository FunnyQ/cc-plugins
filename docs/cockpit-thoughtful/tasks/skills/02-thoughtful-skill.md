# SKILLS-02: thoughtful skill

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/log-schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: skills/01
> **Blocks**: release/01
> **Status**: done

## Goal

Author the `/thoughtful` SKILL.md that turns on thoughtful-logging mode for the session: it teaches the main agent WHEN a moment is worth recording and HOW to spawn a background fork that runs `/cockpit-scribe`.

## Files to create / modify

- `packages/monitor/skills/thoughtful/SKILL.md` (new) — the main-agent mode skill.

> Lives at `packages/monitor/skills/thoughtful/` (own directory; auto-discovered).

## Implementation notes

This is a **mode-injection** skill (no bundled scripts). Invoking it makes the main agent adopt a standing behavior for the rest of the session. It must NOT auto-fire.

### Frontmatter

```yaml
---
name: thoughtful
description: >-
  Turn on thoughtful auto-logging for this cockpit session. After you invoke it,
  the agent — at its own judgment, when it has just done something worth
  recording — spawns a background fork to write typed cockpit decision-trail
  entries. EXPLICIT opt-in: trigger on "/thoughtful", "thoughtful mode",
  "開啟自動日誌", "讓 cockpit 自動記錄". Do NOT auto-fire on every session.
---
```

### Body the SKILL.md must convey

**What it does** — one short paragraph: from now on, log the interesting parts of this session automatically, without setting a goal and without manual `cockpit log`.

**WHEN to log (judgment, not every turn):**
- After completing a meaningful unit of work — a non-obvious decision between real alternatives, a tricky problem solved, a subtle tradeoff, or a result the pilot should learn from.
- **Skip** trivial turns: typo/single-line fixes, simple lookups, pure formatting, restating something already logged.
- **One fork per logical chunk**, not per file or per step. Quality over volume.

**HOW to log (mechanism differs per surface — `monitor` ships both a `.claude-plugin` and a `.codex-plugin`, so this skill loads under both):**

- **On Claude Code**: use the **Agent tool** to **fork yourself** — *omit* `subagent_type` so the fork inherits your full conversation context (this is what makes it cheap: the context is cache-warm right after a turn, and the fork already knows the "why"). Run it **background, fire-and-forget**.
- **On Codex**: spawn a **background sub-agent with `fork_context: true` and no `agent_type`** — this inherits the current context (the Codex equivalent of Claude's context-inheriting fork). Run it fire-and-forget.
- Either way: **do not wait** for it; continue or stop normally. The one-line prompt is the same: *"Run the /cockpit-scribe skill to distill the work we just completed into cockpit decision-trail entries."*
- When the background sub-agent later reports completion, **no action is needed** — acknowledge and move on.

**No-goal note:** This works without `cockpit start`. The first `cockpit scribe` write auto-registers the session (it becomes visible in the dashboard as tracked). If the pilot also wants a goal/north-star, they can run `/cockpit` separately.

**Persistence caveat (be honest):** this is a standing instruction, best-effort — over a long session, re-affirm the mode to yourself when you notice a worthy moment. Missing some is acceptable; do not force a fork on trivial turns to compensate.

## Acceptance criteria

- [x] `packages/monitor/skills/thoughtful/SKILL.md` exists; frontmatter marks it explicit opt-in (no auto-fire) with the trigger phrases above.
- [x] WHEN criteria list both the "log this" cases and the explicit skip cases, plus the one-per-chunk bias.
- [x] HOW specifies the **Claude** path (Agent tool, **omit `subagent_type`** → fork/inherit, background fire-and-forget, one-line `/cockpit-scribe` prompt, "don't wait").
- [x] HOW includes a **Codex** branch: background spawn with `fork_context: true` and no `agent_type` (context-inheriting), fire-and-forget.
- [x] States the no-`cockpit start` / auto-register behavior and that `/cockpit` is the separate goal path.
- [x] States the best-effort/persistence caveat honestly.
- [x] Does not duplicate `/cockpit-scribe`'s internal procedure (it only points at it).

## Verification

- [x] Read-through: a main agent that reads this skill knows exactly when to act and the exact Agent-tool call to make.
- [x] Confirm the spawn instruction says **omit `subagent_type`** (a custom subagent_type would lose the cache-warm context inheritance — the whole cost argument).
- [x] Self-contained: a main agent needs only this file plus the `_context/` files.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. (Here "Test coverage" = Instruction clarity, per the shared rubric.)

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong spawn mechanism (e.g. custom subagent_type, or blocking) | mechanism right but WHEN/HOW underspecified | fork-omit-subagent_type + background + correct trigger + skip rules all correct |
| Test coverage (instruction clarity) | ×2 | agent couldn't act from it | actionable but fuzzy on when | crisp WHEN + exact HOW; agent acts without guessing |
| Interface & readability | ×1 | wall of text | usable | tight, scannable, sectioned |
| Assumptions & docs | ×1 | overpromises determinism | partial | best-effort caveat + auto-register + cache rationale stated |

## Out of scope

- The fork's internal steps (diff/dedup/write) — Deferred. Reason: owned by the `/cockpit-scribe` skill; this skill only triggers it.
- Any `cockpit.ts` or dashboard change — Deferred. Reason: handled by the backend and UI tasks; this skill is the trigger only.

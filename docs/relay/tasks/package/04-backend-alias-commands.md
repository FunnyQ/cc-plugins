# PACKAGE-04: Backend alias commands

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: package/01
> **Status**: done

## Goal

Ship per-backend slash-command aliases (`/codex`, `/opencode`, `/claude`) that route to the relay skill with the backend pre-fixed, so the user can type `/codex image "x"` instead of `/relay codex image "x"`.

## Files to create / modify

- `packages/relay/commands/codex.md` (new) — `/codex` → relay with backend=codex.
- `packages/relay/commands/opencode.md` (new) — `/opencode` → relay with backend=opencode.
- `packages/relay/commands/claude.md` (new) — `/claude` → relay with backend=claude.

## Implementation notes

These are thin Claude Code command files (auto-discovered from the plugin's `commands/` dir — no manifest wiring needed). Each fixes the backend and forwards the rest to the relay skill. They are a Claude-side convenience; Codex/OpenCode users invoke the portable skill directly (no alias commands there).

**Namespacing reality** (confirmed against Claude Code docs): plugin commands are namespaced `/relay:codex` etc.; the bare `/codex` form works only when no other plugin/level claims that name. `/opencode` and `/claude` are bare-usable immediately; bare `/codex` resolves to relay once the older `odin-codex` plugin (which also defines `/codex`) is disabled/retired. No future edit is needed when that happens — the bare name simply de-ambiguates.

Each file: frontmatter `description` + `argument-hint`, body routes to the relay skill. Mirror the relay skill's own command (`commands/relay.md`) ergonomics. Example `commands/codex.md`:

```markdown
---
description: Delegate to the codex CLI (delegate / review / image) — alias for /relay codex.
argument-hint: "<delegate|review|image> [task]"
---
The user invoked `/codex` — an alias for `/relay codex`. Treat `$ARGUMENTS` as the `<mode> [task]` for the **codex** backend and follow the relay skill's orchestration with backend fixed to `codex`.
```

- `commands/opencode.md`: same shape, backend `opencode`, `argument-hint: "<delegate|review> [task]"` (no image — opencode doesn't support it; the capability gate enforces this).
- `commands/claude.md`: same shape, backend `claude`, `argument-hint: "<delegate|review> [task]"`.

Do not duplicate orchestration logic in the alias files — they only fix the backend and defer to the skill, so behaviour (gate, strategy, smart-apply, reports) stays single-sourced in SKILL.md.

## Acceptance criteria

- [x] `commands/{codex,opencode,claude}.md` exist, each with valid frontmatter (`description` + `argument-hint`).
- [x] Each routes to the relay skill with its backend fixed; none re-implements gate/strategy/report logic.
- [x] `opencode`/`claude` argument-hints omit `image`; `codex` includes it.
- [x] A comment or the body makes clear these are aliases for `/relay <backend>`.

## Verification

- [x] All three files parse as valid Markdown-with-frontmatter (e.g. each opens with a `---` frontmatter block containing `description`).
- [x] `grep -l 'alias for' packages/relay/commands/{codex,opencode,claude}.md` matches all three (they self-identify as aliases).
- [x] Read-through: each file fixes exactly its backend and contains no backend-specific gate/strategy logic (defers to the skill).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong backend routing or invalid frontmatter | routes but duplicates logic / wrong argument-hint | all three route correctly, defer to skill, hints match each backend's modes |
| Test coverage | ×2 | no validity check | frontmatter parse only | frontmatter valid + alias-identity + no-duplicated-logic checks |
| Interface & readability | ×1 | bloated/divergent files | minor drift | three near-identical thin files, consistent shape |
| Assumptions & docs | ×1 | namespacing/coexistence unstated | partial | namespacing + odin-codex coexistence note present |

## Out of scope

- Codex/OpenCode equivalents of these alias commands — Deferred. Reason: the portable skill is the cross-harness unit; these aliases are a Claude-side convenience.
- A bare `/codex` guarantee during odin-codex coexistence — not in scope: it resolves once odin-codex is disabled; until then `/relay:codex` (or `/relay codex`) is used.

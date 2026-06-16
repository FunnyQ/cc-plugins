# SKILLS-01: Thin SKILL.md router + pilot reference

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/02, backend/03, skills/02
> **Blocks**: skills/03, docs/01
> **Status**: todo

## Goal

Rewrite `cockpit/SKILL.md` into a thin router that dispatches to one of two mode references,
and move the interactive-front procedure (minus goal-setting) into `references/pilot.md`.

## Files to create / modify

- `packages/monitor/skills/cockpit/SKILL.md` (modify) — becomes a thin router.
- `packages/monitor/skills/cockpit/references/pilot.md` (new) — interactive front procedure.

## Implementation notes

### `SKILL.md` (thin router)

Keep the frontmatter `name: cockpit` and update the `description` to cover both modes
(`/cockpit` opens the cockpit + sets language; `/cockpit scribe` is the auto-distill mode
invoked by a fork). The body should be short:

1. **Step 0 — Provider**: Claude Code → `claude`, Codex → `codex`; read the matching
   `references/claude.md` / `references/codex.md` once for `<plugin-root>` + provider
   specifics (unchanged from today).
2. **Mode dispatch**:
   - Invoked as `/cockpit scribe` (or the fork's "run /cockpit scribe") → read
     `references/scribe.md` and follow it.
   - Otherwise → read `references/pilot.md` and follow it.

Do not inline the procedures — the router only routes. Keep it well under ~40 lines.

### `references/pilot.md` (interactive front)

Port the current `SKILL.md` interactive content but **remove all goal-setting**:

- Drop the "propose goals", "human gate to confirm goals", and `cockpit start` steps.
- **Language**: instead of asking for `log_language` and writing it to `project-meta.md`,
  the language is the global config. To read it: `cockpit config get-language`. To change it
  (only when the user asks): `cockpit config --log-language "<lang>"`. (CLI path resolves
  from the skill base-dir banner: `<base>/scripts/cockpit.ts`.)
- **Open the dashboard**: keep the existing `cockpit-server.ts` ensure+open step.
- **Manual logging**: keep the `cockpit log` documentation (decision/reason/facet/tradeoff/
  file).
- **`needs_your_call` / `wait` / `send`**: keep this section verbatim in intent — it is the
  preserved interactive bridge autopilot relies on. Same commands, same wait policy per the
  provider reference.

Net effect: `/cockpit` opens the cockpit and (optionally) sets language; it never sets goals.

## Acceptance criteria

- [ ] `SKILL.md` is a thin router: Step 0 provider + dispatch to `pilot.md` vs `scribe.md`, no inlined procedures.
- [ ] `SKILL.md` frontmatter `description` reflects both modes and stays opt-in (no auto-fire claim removed).
- [ ] `references/pilot.md` contains the interactive front with **no** goal-setting and **no** `cockpit start`.
- [ ] `pilot.md` reads language via `cockpit config get-language` and sets it via `cockpit config --log-language`.
- [ ] `pilot.md` preserves the `needs_your_call` / `wait` / `send` bridge and the dashboard open step.

## Verification

- [ ] `grep -n "goal\|start\|project-meta" packages/monitor/skills/cockpit/references/pilot.md` returns nothing goal/start related.
- [ ] `grep -n "scribe\|pilot" packages/monitor/skills/cockpit/SKILL.md` shows both dispatch branches.
- [ ] Manual: invoking `/cockpit` follows pilot.md (opens dashboard, no goal prompt); `/cockpit scribe` routes to scribe.md.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | router missing a branch or goals remain | routes but pilot still references start/goals | clean router; pilot has no goals/start; bridge + language-via-config intact |
| Test coverage | ×2 | no verification | grep only | grep + manual dispatch check for both modes |
| Interface & readability | ×1 | bloated router | acceptable | router < ~40 lines, procedures fully in references |
| Assumptions & docs | ×1 | path resolution unclear | partial | base-dir CLI path + provider Step 0 documented |

## Out of scope

- `references/scribe.md` content — Deferred to the scribe-reference task in this bucket.
- The `thoughtful` command + hook — Deferred to their own tasks in this bucket.

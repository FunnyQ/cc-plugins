# SKILLS-01: cockpit-scribe skill

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/log-schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/01
> **Blocks**: skills/02
> **Status**: todo

## Goal

Author the `/cockpit-scribe` SKILL.md that a background fork runs to distill the just-completed work into a few high-signal typed cockpit log entries, deduped against what's already logged.

## Files to create / modify

- `packages/monitor/skills/cockpit-scribe/SKILL.md` (new) — the fork-side scribe procedure.

> The skill lives at `packages/monitor/skills/cockpit-scribe/` (its own directory; auto-discovered — no manifest edit needed).

## Implementation notes

This skill is **invoked inside a forked subagent** that has already inherited the main conversation context. So it does NOT need to re-read the conversation — it needs to (a) add the code-change lens, (b) dedup, (c) write a few entries, then end.

### Frontmatter

```yaml
---
name: cockpit-scribe
description: >-
  Distill the work just completed into typed cockpit decision-trail entries.
  Invoked inside a background fork by /thoughtful — not meant for direct human
  use. Reads the working diff, dedups against already-logged entries, and writes
  a few high-signal entries via `cockpit scribe`.
---
```

### Procedure the SKILL.md must spell out

1. **Resolve the cockpit CLI path** — the script is at `<plugin>/skills/cockpit/scripts/cockpit.ts`. Per repo convention, `CLAUDE_PLUGIN_ROOT` is NOT reliable in agent Bash; resolve from the skill's load-time "Base directory for this skill" banner — `cockpit-scribe` and `cockpit` are sibling skill dirs, so the CLI is the banner dir's sibling. Give the fork a copyable snippet that fails loudly if missing, e.g.:
   ```bash
   SKILL_DIR="<the Base directory banner path for THIS skill>"
   CLI="$SKILL_DIR/../cockpit/scripts/cockpit.ts"
   test -f "$CLI" || { echo "cockpit CLI not found at $CLI" >&2; exit 1; }
   bun "$CLI" scribe --recent
   ```
   State explicitly that the fork substitutes the real banner path (it cannot rely on an env var).
2. **Add the code-change lens** — run `git diff`, `git diff --staged`, and `git log --oneline -5` to ground entries in what actually changed (the inherited conversation gives the "why"; the diff gives the "what").
3. **Dedup** — run `bun <cli> scribe --recent` and read the printed list; do not re-log material already covered there.
4. **Choose lenses and write** — for each genuinely worth-recording insight, pick a `kind`:
   - `decision` — a choice made between real alternatives.
   - `rationale` — *why* a non-obvious piece of code is the way it is.
   - `learning` — what the pilot should take away (a teachable result/pattern).
   - `caveat` — a trap, precondition, or sharp edge to remember.
   Then: `bun <cli> scribe --type <kind> --title "<short headline>" --text "<body, markdown>"`.
5. **Consolidate, don't spam** — bias to a few entries per logical chunk, NOT one per file or per step. If nothing meets the bar, write nothing and end.
6. **Language** — write `--title`/`--text` in the project's `log_language` (read `<project>/.cockpit/project-meta.md`'s `log_language` field; default English, otherwise match the conversation language).
7. **End quietly** — this is a fire-and-forget fork; the side effect is the written log. No summary needed.

### Tone guidance to include

Entries are for a future reader skimming the decision trail: concrete, terse, no fluff. A `learning` entry should teach; a `rationale` should answer "why not the obvious alternative".

## Acceptance criteria

- [ ] `packages/monitor/skills/cockpit-scribe/SKILL.md` exists with valid frontmatter (`name: cockpit-scribe`, a description marking it fork-invoked / not for direct human use).
- [ ] The procedure tells the fork to run `git diff`/`git log` for the code lens.
- [ ] The procedure runs `cockpit scribe --recent` for dedup BEFORE writing.
- [ ] All four `kind` values are defined with when-to-use guidance.
- [ ] The write step uses the exact `cockpit scribe --type … --title … --text …` surface from `../_context/log-schema.md`.
- [ ] CLI-path resolution is spelled out (no reliance on `CLAUDE_PLUGIN_ROOT`).
- [ ] Consolidation bias ("a few per chunk, skip if nothing worthy") is explicit.
- [ ] log_language handling is stated (meta → default English).

## Verification

- [ ] Read-through: a fresh fork following the SKILL.md verbatim could resolve the CLI, dedup, and write a valid entry with no missing step.
- [ ] Cross-check every `cockpit scribe` invocation in the SKILL.md against `../_context/log-schema.md` — flag names and `kind` values match exactly.
- [ ] Self-contained: a fork needs only this file plus the `_context/` files.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. (Here "Test coverage" = Instruction clarity, per the shared rubric.)

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong CLI surface or missing dedup/diff step | covers writing but flags/kinds drift from contract | every command matches the contract; dedup + diff + language all present |
| Test coverage (instruction clarity) | ×2 | a fork would get stuck/guess | executable but ambiguous in spots | unambiguous, ordered, fork can run start-to-finish |
| Interface & readability | ×1 | rambling, no structure | usable but verbose | tight, skimmable, well-sectioned |
| Assumptions & docs | ×1 | assumes `CLAUDE_PLUGIN_ROOT`, no language note | partial | path-resolution + language + consolidation all flagged |

## Out of scope

- The trigger ("when to spawn this fork") — Deferred. Reason: the `/thoughtful` mode skill owns WHEN; this skill only does the writing.
- Any change to `cockpit.ts` — Deferred. Reason: the `cockpit scribe` CLI is built by the backend task; this task only authors the skill that calls it.

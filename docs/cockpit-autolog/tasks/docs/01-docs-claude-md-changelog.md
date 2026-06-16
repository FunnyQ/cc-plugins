# DOCS-01: Update CLAUDE.md + CHANGELOG

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/03, backend/04, frontend/01, skills/01, skills/02, skills/03, skills/04
> **Status**: done

## Goal

Bring the repo's `CLAUDE.md` and `CHANGELOG.md` in line with the consolidated cockpit: one
skill with a router + pilot/scribe references, a thoughtful command, a SessionStart hook,
global language config, and no goals/project-meta/start.

## Files to create / modify

- `CLAUDE.md` (modify) — the cockpit description, directory tree, and command list.
- `CHANGELOG.md` (modify) — a new entry describing the change.
- `packages/monitor/.claude-plugin/plugin.json` (modify) — user-visible `description` /
  `keywords` only (the `hooks` block is set by the hook task — leave it intact).
- `packages/monitor/.codex-plugin/plugin.json` (modify) — user-visible `description` /
  `keywords`.

## Implementation notes

### `CLAUDE.md`

Update the monitor/cockpit sections to reflect the end state:

- The "three sibling skills" framing changes: cockpit-scribe and thoughtful are **no longer
  skills**. Cockpit is one skill with a thin `SKILL.md` router → `references/pilot.md`
  (interactive front) / `references/scribe.md` (auto-distill via `/cockpit scribe`), plus
  `references/claude.md` + `codex.md`.
- `thoughtful` is now `packages/monitor/commands/thoughtful.md` (a slash command), and a
  second `SessionStart` hook auto-injects it on Claude (Codex: manual `/thoughtful`).
- Goals, `project-meta.md`, and `cockpit start` are gone. The only config is `log_language`
  at `~/.config/q-lab/cockpit/config.json` (`cockpit config --log-language` /
  `get-language`).
- Update the directory-tree block and the cockpit `scripts/` list (add `config.ts`; note
  `start` removed). Update any command examples that referenced `cockpit start`.
- Preserve the `needs_your_call`/`wait`/`send` description (unchanged capability).

Keep edits surgical — only the cockpit-related passages change; leave usage-dashboard,
dispatch, and relay sections alone except where the directory tree overlaps.

### `CHANGELOG.md`

Add an entry (Keep a Changelog format, matching the file's existing style) summarizing:
consolidated cockpit to one skill; removed goals + project-meta + `cockpit start`; global
`log_language` config; thoughtful is now a command + SessionStart auto-enable on Claude.
Do not bump version numbers here unless the owner asks — the release flow owns versioning.

### Plugin manifests (user-visible metadata)

Both monitor manifests still advertise the old behavior. Update **only** the user-facing
metadata, not structural keys:

- `.claude-plugin/plugin.json`: the `description` mentions "goal capture"; `keywords`
  include `"goal"` and `"decision-log"`. Rewrite the description to the consolidated cockpit
  (decision trail + live session view, auto-logging) and drop the now-misleading `goal`
  keyword. **Leave `mcpServers`, `channels`, `version`, and the `hooks` block untouched** —
  the SessionStart hook is owned by the hook task.
- `.codex-plugin/plugin.json`: apply the same `description` / `keywords` cleanup, **and** the
  `interface` block, which has extra user-facing copy advertising goals/start:
  - `interface.longDescription` currently says the cockpit is "for setting a session goal,
    logging decisions…". Rewrite to drop "setting a session goal" — the cockpit is now for
    auto-logging decisions a diff can't explain, streaming live transcripts, and the
    `needs_your_call` bridge.
  - `interface.defaultPrompt` is an array containing `"Start a cockpit session for this
    project."` — remove that line (there is no `start` anymore). Keep the dashboard / log /
    wait prompts; optionally replace the removed line with an auto-logging-flavored prompt
    (e.g. enabling thoughtful mode). Leave `displayName`, `category`, `capabilities`,
    `brandColor`, `developerName`, `shortDescription` (if goal-free) intact.

  (No hooks on the Codex manifest.) The Claude manifest has no `interface` block — only its
  `description` / `keywords` need cleanup there.

Do not change `version` in either manifest (release flow owns it).

## Acceptance criteria

- [x] `CLAUDE.md` cockpit section describes one skill (router + pilot/scribe/claude/codex references), no scribe/thoughtful skills.
- [x] `CLAUDE.md` documents the thoughtful command + the second SessionStart hook + global `log_language` config.
- [x] `CLAUDE.md` has no remaining references to goals, `project-meta.md`, or `cockpit start` as live features.
- [x] The directory tree + cockpit `scripts/` list are updated (`config.ts` added, `start` gone).
- [x] `CHANGELOG.md` has a new entry covering the consolidation, in the file's existing format.
- [x] Both monitor manifests' `description`/`keywords` no longer advertise goal capture / `start`; `version`, `hooks`, `mcpServers`, `channels` left untouched.

## Verification

- [x] `grep -n "cockpit-scribe\|cockpit start\|project-meta\|session goal\|project goal" CLAUDE.md` returns nothing describing them as current.
- [x] `grep -n "config.json\|thoughtful\|pilot.md\|scribe.md" CLAUDE.md` reflects the new shape.
- [x] `grep -in "goal\|start a cockpit\|start a session" packages/monitor/.claude-plugin/plugin.json packages/monitor/.codex-plugin/plugin.json` returns nothing (covers `description`, `keywords`, and the Codex `interface.longDescription` / `defaultPrompt`); both still parse as valid JSON.
- [x] Manual read: the cockpit section matches the actual files produced by the other tasks.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. "Test coverage" here = the grep/manual checks below.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | docs still describe old 3-skill shape | partial update, stale refs remain | docs match end state; no stale goal/start/scribe-skill refs |
| Test coverage | ×2 | no checks | one grep | both greps + manual cross-check against produced files |
| Interface & readability | ×1 | sprawling edits | acceptable | surgical, only cockpit passages changed |
| Assumptions & docs | ×1 | invents version bump | partial | leaves versioning to release flow; changelog matches format |

## Out of scope

- Bumping `plugin.json` versions — Deferred. Reason: the release flow (`/odin-git:release` + manual plugin.json bump) owns versioning; the owner triggers it.

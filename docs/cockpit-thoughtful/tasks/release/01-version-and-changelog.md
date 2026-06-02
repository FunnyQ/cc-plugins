# RELEASE-01: Version bump and changelog

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/01, skills/02, ui/01
> **Status**: todo

## Goal

Bump the three monitor version fields together and add a `CHANGELOG.md` entry describing thoughtful mode, so the marketplace shows a consistent version.

## Files to create / modify

- `.claude-plugin/marketplace.json` (modify) — the single `monitor` entry's `plugins[].version`.
- `packages/monitor/.claude-plugin/plugin.json` (modify) — `version`.
- `packages/monitor/.codex-plugin/plugin.json` (modify) — `version`.
- `CHANGELOG.md` (modify) — new release entry (Keep a Changelog format).

## Implementation notes

These three version fields **drift easily** and the marketplace shows the wrong version if they disagree — they must be set to the **same** new value in one change. Current value at planning time is `3.6.5`; this is a feature addition, so bump the minor (e.g. `3.7.0`) unless the user has set a different target by execution time. Confirm the actual current version by reading the three files first, then move all three to the chosen value.

`CHANGELOG.md` follows Keep a Changelog. Add an entry under the new version with an `### Added` section summarizing thoughtful mode in user-facing terms:
- `/thoughtful` mode — the agent auto-writes a typed decision trail (decision / rationale / learning / caveat) by forking a background scribe, no goal-setting required.
- `cockpit scribe` CLI subcommand.
- Dashboard now distinguishes auto-logged (scribe) entries and renders entry kinds.

Keep wording customer-friendly, not implementation jargon. Do not run `/odin-git:release` blindly — it only auto-detects `marketplace.json`; the two `plugin.json` files must be bumped by hand (this task does exactly that).

## Acceptance criteria

- [ ] All three version fields hold the identical new version string.
- [ ] `CHANGELOG.md` has a matching entry under that version with an `### Added` section covering `/thoughtful`, `cockpit scribe`, and the dashboard kind/source rendering.
- [ ] No other version-like fields in those files were touched.
- [ ] The changelog wording is user-facing (no "fork inherits context" internals).

## Verification

- [ ] `grep -n '"version"' packages/monitor/.claude-plugin/plugin.json packages/monitor/.codex-plugin/plugin.json` and the `monitor` entry in `.claude-plugin/marketplace.json` all show the same value.
- [ ] `CHANGELOG.md` top entry matches that version.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | versions disagree or wrong files | all three bumped but changelog missing/mismatched | three fields identical + matching changelog entry |
| Test coverage | ×2 | not checked | eyeballed one file | grep-verified all three + changelog top entry |
| Interface & readability | ×1 | jargon-filled changelog | adequate | crisp, user-facing Keep-a-Changelog entry |
| Assumptions & docs | ×1 | invents a version | partial | reads current value first, bumps deliberately |

## Out of scope

- Tagging / publishing the release — Deferred. Reason: release mechanics are the user's call (`/odin-git:release`), not this task.
- Code changes — Deferred. Reason: all feature code lands in the backend, skills, and UI tasks; this task is metadata only.

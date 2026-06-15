# PACKAGE-03: Changelog and repo docs

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: package/02
> **Status**: todo

## Goal

Record the new plugin in the repo's living docs: a CHANGELOG entry and a concise `relay` section in the root `CLAUDE.md`.

## Files to create / modify

- `CHANGELOG.md` (modify) — add a `relay` entry (Keep a Changelog format).
- `CLAUDE.md` (modify) — add a `relay` bullet/section to the "What This Is" + Architecture areas.

## Implementation notes

`CHANGELOG.md` — follow the existing Keep a Changelog style already in the file. Add an entry announcing relay `0.1.0`:
- Under an `Added` heading: "relay plugin — cross-harness task delegation (`/relay <codex|opencode|claude> <delegate|review|image>`), a multi-backend superset of odin-codex."
- Keep wording user-facing, consistent with prior entries. Match whatever version-heading convention the file uses (read it first; do not invent a new format).

`CLAUDE.md` — the file currently describes `monitor` and `dispatch`. Add relay concisely:
- In the "What This Is" list, add a `relay` bullet: one line on cross-harness delegation + the two-layer/strategy design + the capability matrix (image = codex only).
- In the Architecture tree, add the `packages/relay/` subtree (mirror the layout in `_context/shared.md`).
- Note the distribution model (Claude/Codex via marketplace; OpenCode via `~/.claude/skills/` symlink) and that version lives in both `plugin.json` files at `0.1.0`.
- Keep it proportional — relay is new and small; do not rewrite the monitor/dispatch sections.

Surgical edits only: touch the relay-relevant spots, don't reformat unrelated sections.

## Acceptance criteria

- [ ] `CHANGELOG.md` has a relay `0.1.0` entry in the file's existing format.
- [ ] `CLAUDE.md` "What This Is" mentions relay (delegation + two-layer + matrix).
- [ ] `CLAUDE.md` Architecture shows the `packages/relay/` subtree.
- [ ] Distribution + version note for relay is present.
- [ ] No unrelated sections reformatted.

## Verification

- [ ] `grep -i relay CHANGELOG.md` and `grep -i relay CLAUDE.md` both return matches.
- [ ] This task touches only `CHANGELOG.md` and `CLAUDE.md` — verify with a path-scoped diff (`git diff --stat -- CHANGELOG.md CLAUDE.md` shows the edits; nothing else outside those two paths is attributable to this task). Do not assume a clean working tree — earlier tasks have already modified other files.
- [ ] Read-through: the relay section is consistent with the manifests/registries (version `0.1.0`, both registries, distribution model).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong format or contradicts manifests | entries present but a detail (version/path/matrix) drifts | CHANGELOG + CLAUDE.md accurate, consistent with manifests, correct format |
| Test coverage | ×2 | no checks | grep presence only | grep presence + diff-scope + consistency read-through |
| Interface & readability | ×1 | bloated/reformats unrelated text | minor over-edit | surgical, proportional additions |
| Assumptions & docs | ×1 | distribution/version omitted | partial | distribution model + version discipline captured |

## Out of scope

- Editing `monitor`/`dispatch` documentation — Deferred. Reason: relay docs are additive only.

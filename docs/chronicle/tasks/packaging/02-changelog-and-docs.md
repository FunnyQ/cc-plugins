# PACKAGING-02: Changelog and repo docs

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: packaging/01
> **Status**: done

## Goal

Record chronicle's arrival in the repo's `CHANGELOG.md` and `CLAUDE.md` so the release notes and the project guide both reflect the new plugin.

## Files to create / modify

- `CHANGELOG.md` (modify) — add a chronicle entry.
- `CLAUDE.md` (modify) — add chronicle to the "What This Is" plugin list and the Architecture tree.

## Implementation notes

### CHANGELOG.md

The repo uses Keep a Changelog format. Add an entry announcing chronicle `0.1.0` as a new independently-versioned plugin. Match the existing heading/section style already in the file (read its top entries first to mirror the exact format — `Added` subsection, emoji/voice conventions). Summarize: a `commit` skill (unified simple/atomic decision tree) and a `pr` skill (PR/MR author enriched by the cockpit decision trail), shipping to both marketplaces.

### CLAUDE.md

Two edits, both additive and surgical:

1. **"What This Is"** — the repo currently says "three local plugins". Update the count and add a chronicle bullet alongside monitor / dispatch / relay, one line describing it (commit + pr; reshapes odin-git's commit ideas into one decision tree, no odin-git dependency; cockpit is a soft enrichment).

2. **Architecture tree** — add a `packages/chronicle/` block mirroring how relay is documented: the two manifests, the two skills (`commit/`, `pr/`) with their scripts. Note it ships to both marketplaces at independent version `0.1.0`.

Keep edits minimal — do not restructure or "improve" adjacent prose. Only touch what names the plugin set.

### Releasing note

chronicle is independently versioned (like relay). When updating the "Releasing" section, if it enumerates per-plugin version files, add chronicle's two `plugin.json` paths to the independently-versioned list. If that section already generically covers "relay is versioned independently", a one-line mention that chronicle follows the same rule is enough — don't duplicate the whole block.

## Acceptance criteria

- [x] `CHANGELOG.md` has a chronicle `0.1.0` entry in the repo's existing format.
- [x] `CLAUDE.md` "What This Is" lists chronicle and the plugin count is corrected.
- [x] `CLAUDE.md` Architecture tree includes a `packages/chronicle/` block with both skills.
- [x] The Releasing section mentions chronicle's independent versioning (or its two plugin.json paths).
- [x] All edits are additive/surgical — no unrelated prose touched.

## Verification

- [x] `grep -n chronicle CHANGELOG.md` and `grep -n chronicle CLAUDE.md` both return the new lines.
- [x] `grep -n "three local plugins" CLAUDE.md` returns nothing (count was updated).
- [x] `git diff CLAUDE.md CHANGELOG.md` shows only chronicle-related changes: additions plus the one required edit to the plugin-count wording (e.g. "three" → "four"). No unrelated prose is touched.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | wrong format / stale plugin count / unrelated edits | entries present but count or tree drifts | changelog + both CLAUDE.md spots + releasing note correct, count fixed |
| Trigger & flow correctness | ×2 | docs misdescribe the plugin | mostly right, one detail off | descriptions match the actual skills + soft-dep + independent version |
| Interface & readability | ×1 | clashes with surrounding style | acceptable | matches existing changelog/tree voice exactly |
| Assumptions & docs | ×1 | scope creep into adjacent prose | minor extra edits | strictly additive, surgical |

## Out of scope

- A standalone chronicle README — Deferred. The skills' SKILL.md files carry usage docs.
- Editing monitor/dispatch/relay docs — Deferred. Only the shared plugin list/tree changes.

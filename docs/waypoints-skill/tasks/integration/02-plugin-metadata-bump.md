# INTEGRATION-02: dispatch plugin metadata bump

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: skill/01, integration/01
> **Status**: done

## Goal

Bump the dispatch plugin version, update **both** manifests' user-facing prose/keywords to name the new
skill, and add a CHANGELOG entry — so the new `waypoints` skill ships cleanly to both marketplaces.

## Files to create / modify

- `packages/dispatch/.claude-plugin/plugin.json` (modify) — `version` 3.12.1 → 3.13.0; add `waypoints` to the skill-enumerating `description` and the `keywords` array.
- `packages/dispatch/.codex-plugin/plugin.json` (modify) — `version` 3.12.1 → 3.13.0; update the `interface` prose that says "Three skills" to name four (and add `waypoints` to its keywords/description if present).
- `CHANGELOG.md` (modify) — add a `## [dispatch 3.13.0]` entry.

## Implementation notes

### Version bump

Both `plugin.json` files carry `"version": "3.12.1"`. A new skill is an additive feature → **minor** bump
to `3.13.0`. The version bump itself touches only the `version` field in each manifest (the prose/keyword
edits are the separate change described next). Do **not** touch the marketplace registries
(`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) — they carry no version and no
per-skill entry.

### Manifest prose & keywords (both manifests)

Both manifests carry human-facing prose that enumerates the skill set; both must gain `waypoints` so the
new skill is discoverable in each marketplace listing:

- **Claude** (`packages/dispatch/.claude-plugin/plugin.json`): the `description` currently reads
  "…preflight gathers… flightplan writes… autopilot flies…" and `keywords` lists
  `preflight`/`flightplan`/`autopilot`. Extend the `description` with a clause for `waypoints` (the
  milestone-roadmap / rolling-wave tier above flightplan) and add `"waypoints"` to `keywords`.
- **Codex** (`packages/dispatch/.codex-plugin/plugin.json`): three places enumerate the skill set — the
  top-level `description`, the `keywords` array, and the `interface.longDescription` ("Three skills in one
  plugin…"). Extend the top-level `description` with a `waypoints` clause, add `"waypoints"` to `keywords`,
  and update `interface.longDescription` (and `defaultPrompt` if natural) to name four skills.

Keep each edit minimal and consistent with the existing phrasing; do not restructure the blocks or touch
the marketplace registries.

### CHANGELOG

Follow the repo's Keep-a-Changelog format and the per-plugin heading convention (see existing entries like
`## [chronicle 0.1.0]`). Add:

```markdown
## [dispatch 3.13.0]

### Added
- **waypoints** — a fourth dispatch skill: a rolling-wave milestone-roadmap tier above flightplan. Writes
  `docs/<proj>/WAYPOINTS.md` (milestones + `[x]`/`[~]`/`[ ]` status), a `waypoints.ts` CLI
  (`active` / `leg-scaffold` / `advance`), and a flightplan "waypoint mode" that plans one leg at a time
  into `docs/<proj>/legs/NN-slug/`. Tracks the scoped tag `dispatch-v3.13.0`.

### Changed
- **flightplan** (0.6.0) — gains waypoint mode; `flightplan-lint.sh` now lints nested leg task files.
```

Match the exact heading style and section ordering used by the nearest existing entries.

## Acceptance criteria

- [x] Both `packages/dispatch/.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` read `"version": "3.13.0"`.
- [x] The Claude manifest's `description` mentions `waypoints` and its `keywords` array includes `"waypoints"`.
- [x] The Codex manifest's top-level `description`, `keywords`, and `interface.longDescription` all include `waypoints` (naming four skills), with no other structural change.
- [x] `CHANGELOG.md` has a `## [dispatch 3.13.0]` entry noting the new skill, the flightplan change, and the `dispatch-v3.13.0` tag, in the repo's changelog format.
- [x] The marketplace registry files are untouched.

## Verification

- [x] `grep -c '"version": "3.13.0"' packages/dispatch/.claude-plugin/plugin.json packages/dispatch/.codex-plugin/plugin.json` reports 1 each.
- [x] `bun -e "JSON.parse(await Bun.file('packages/dispatch/.codex-plugin/plugin.json').text())"` parses (valid JSON after the prose edit); same for the claude manifest.
- [x] `grep -c waypoints packages/dispatch/.claude-plugin/plugin.json` is ≥ 2 (description + keyword).
- [x] `grep -c waypoints packages/dispatch/.codex-plugin/plugin.json` is ≥ 3 (description + keyword + longDescription).
- [x] `grep -n "dispatch 3.13.0" CHANGELOG.md` matches.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md` (dimension set B — docs tasks). Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong version, invalid JSON, or marketplace files touched | version right but prose or CHANGELOG heading drifts from convention | both manifests 3.13.0, valid JSON, prose names four skills, CHANGELOG matches format |
| Completeness | ×2 | a file missed | version done but CHANGELOG or prose missing | all three files updated |
| Clarity & consistency | ×1 | CHANGELOG phrasing inconsistent | readable but off-format | CHANGELOG + prose consistent with existing entries |
| Conventions | ×1 | adds a version to marketplace or breaks JSON | minor format slip | follows the per-plugin versioning + changelog conventions exactly |

## Out of scope

- The actual git release (annotated `dispatch-v3.13.0` tag, merge develop→main) — Deferred. The human runs it via chronicle / odin-git; this task only edits in-repo files.

# README refresh — chronicle section + install coverage

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-08-01

## Overview

The repo root `README.md` ships five plugins but documents four. `chronicle` appears in the intro
paragraph and the plugin table, then never gets a section of its own, and the two installation sections
only ever install `monitor`. This plan closes both gaps and corrects the stale skill counts.

This tree is also the smoke test for dispatch 3.17.0's autopilot loop: a small, real, docs-only tree with
a serial dependency chain and a closing final-review gate.

## Goals

- `README.md` carries a `## chronicle` section with the same shape as the other plugin sections.
- A reader can install any of the five plugins from the installation sections without guessing.
- Every skill-count claim in `README.md` matches what the packages actually ship.

## Non-goals

- No rewrite of the existing `usage-dashboard`, `cockpit`, `dispatch`, `relay`, or `herdr` sections.
  Only the specific lines each task names change.
- No version bump and no `CHANGELOG.md` entry. This is documentation, not a release.
- No new screenshots or diagram assets.
- No changes to `CLAUDE.md`, package `SKILL.md` files, or any code.

## Context

Current `README.md` section order: `usage-dashboard`, `cockpit`, `dispatch`, `relay`, `herdr`. The intro
paragraph lists plugins in the order monitor, dispatch, relay, chronicle, herdr — so the missing
`## chronicle` section belongs between `## relay` and `## herdr`.

Two stale claims exist today:

- "**monitor** bundles two skills" — monitor ships three (`usage-dashboard`, `cockpit`, `install`).
- The Claude Code and Codex installation sections install only `monitor`, even though the marketplace
  registers five plugins. The per-plugin install blocks that do exist (dispatch, relay, herdr) each say
  "add the marketplace first — see the monitor install steps above", which only works because those
  steps happen to contain the `marketplace add` line.

## Requirements

### MVP

1. **chronicle section** — a `## chronicle` section between `## relay` and `## herdr`, describing the
   four skills and the spawn-depth prerequisite, plus a Claude/Codex install block.
   - Acceptance: `grep -c '^## chronicle' README.md` returns `1`, and the section sits between the
     `## relay` and `## herdr` headings.
2. **Installation coverage** — the Claude Code and Codex installation sections name all five plugins.
   - Acceptance: both sections list every plugin id, and the TUI steps no longer say "choose `monitor`"
     as if it were the only option.
3. **Accurate skill counts** — the monitor table lists `install` and says "three skills".
   - Acceptance: no "bundles two skills" string remains in `README.md`.

### Later

- Reordering the plugin sections to match the intro paragraph exactly — deferred, it churns the whole
  file for a cosmetic gain.

## Style decisions

- **Voice**: match the existing README — declarative, second person only in install steps, em-dash
  clauses for apposition. No emoji.
- **Section shape**: each plugin section is `## <plugin>`, a one-paragraph what-it-is, bullets or a
  table for the skills, then an `### Installation` block with a Claude and a Codex command.
- **No version numbers in prose.** Versions live in `plugin.json`; a README that names them goes stale
  on every release.
- **Conventions**: see `tasks/_context/shared.md`.

## Bucketing

- **Strategy**: single work bucket plus an integration bucket.
- **Why**: both content tasks edit the same file (`README.md`), so they must run serially rather than in
  parallel. The bucket split exists only to isolate the closing gate.

### Buckets

- **`readme/`** — the content edits, strictly serial.
- **`integration/`** — the closing final-review gate over the whole file.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| readme | 01 | chronicle section | todo | > 4.0 | — |
| readme | 02 | installation coverage and skill counts | todo | > 4.0 | readme/01 |
| integration | 01 | final review 🏁 | todo | > 4.0 | readme/02 |

## Cross-bucket dependencies

```
readme/01 → readme/02 → integration/01
```

## Known gaps

1. **The tree is docs-only, so it runs no test suite.** The gates are `grep` checks with stated expected
   counts. That is the honest smallest check for prose; it cannot catch a section that is well-formed
   but badly written, which is what the final review is for.
2. **The serial chain makes this a weak parallelism test.** Two tasks that edit the same file cannot run
   concurrently. The wave loop is still exercised (three waves), but fan-out is not.

# Chronicle Plugin — Commit + PR (v1)

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-06-16

## Overview

Add a fourth plugin, `chronicle`, to the `q-lab-marketplace` repo: the plugin that *writes and guards the project's history*. v1 ships two skills — `commit` (crafts commits, auto-deciding simple vs atomic) and `pr` (turns commit history + cockpit decisions into a reviewer-legible GitHub PR or GitLab MR).

## Goals

- `/chronicle:commit` — one skill that auto-decides between a single commit (simple) and an atomic split, pulling the human in only for the structural split decision.
- `/chronicle:pr` — author a PR/MR whose body tells a reviewer *why* the change exists, *what* changed, *what to focus on*, and *how to judge it*, enriched by the cockpit decision trail when present.
- Ship to both the Claude and Codex marketplaces; carry chronicle's own copies of everything (zero dependency on the installed `odin-git` plugin).

## Non-goals

- `review` / `merge` skills — future, separate skills, not v1.
- Migrating `odin-git`'s `release` / `changelog-writer` — they stay in odin-git.
- Retiring odin-git — it keeps working independently.
- A separate commit-apply script — commit execution is plain Bash in the write fork.
- A shared GitHub/GitLab adapter module — the provider flows through the confirmed payload; each PR script branches internally.

## Context

The repo already ships `monitor` (usage dashboard + cockpit), `dispatch` (preflight/flightplan/autopilot), and `relay` (cross-harness delegation). Plugins live under `packages/<name>/` with dual manifests (`.claude-plugin/plugin.json` + `.codex-plugin/plugin.json`) and are registered in two marketplace registries (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`).

The installed `odin-git` plugin keeps commit crafting as two separate commands (`simple-commit`, `atomic-commit`) backed by a shared `analyze-changes.ts` data-gathering script and Haiku worker agents (vör/bragi). chronicle reshapes that into **one decision tree** and adds a PR/MR author no current plugin covers. The cockpit skill (in `monitor`) records a per-session decision trail (`decision`/`reason`/`tradeoff`/`caveat` records) that the `pr` skill harvests as raw material for the PR body.

## Requirements

### MVP

1. **Unified commit skill** — one skill picks simple vs atomic from the changeset shape.
   - Acceptance: a one-file tweak commits straight through; a mixed-type changeset produces a proposed atomic split presented for confirmation.
2. **Ported analysis script** — `analyze-changes.ts` gathers git status/diff/recent-commits as JSON.
   - Acceptance: `bun test` green for the ported pure functions; CLI emits `{outputPath, promptPath, totalFiles}`.
3. **Own commit template** — emoji type + body + `---` + 繁中 summary, no odin-git dependency.
   - Acceptance: template file exists under the commit skill; script resolves it without reading any odin-git path.
4. **PR analysis script** — `analyze-branch.ts` detects remote, gathers `merge-base`..HEAD commits/diff, harvests cockpit decisions (soft).
   - Acceptance: emits structured material JSON; with cockpit absent, falls back to commits+diff with no error.
5. **Request creator script** — `request-creator.ts` opens a PR (gh) or MR (glab) from a confirmed payload.
   - Acceptance: dispatches to the right CLI by provider; returns the URL; degrades gracefully when the CLI/remote is missing.
6. **PR skill** — two-phase fork; synthesizes the 4-section body; confirm/edit + draft option.
   - Acceptance: smoke shows a 4-section body that cites cockpit decisions when present.
7. **Packaging** — dual manifests at v0.1.0 + both registry entries + CHANGELOG + repo CLAUDE.md note.
   - Acceptance: both `plugin.json` parse; `chronicle` appears in both registries; versions match.

### Later

- **`review` skill** — review an open PR/MR. Deferred to keep v1 shippable.
- **`merge` skill** — gate + merge with CI/approval/conflict handling. Deferred; needs more surface.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile, no npm deps.
- **Storage**: none of its own; reads git + `~/.cockpit/` (cockpit's data).
- **Deployment**: dual marketplace (Claude + Codex), independent version starting `0.1.0`.
- **Conventions**: `type` over `interface`; tests via `bun test` (mock the CLI runner; live CLI by manual smoke). See `_context/shared.md`.

## Architecture

Scripts do the mechanical work; spawned sub-agents do the judgment; the main agent only orchestrates **analyze → human confirm → execute** so big diffs / `gh` output never enter the main context.

```
packages/chronicle/
├── .claude-plugin/plugin.json     # name, version 0.1.0, description, keywords
├── .codex-plugin/plugin.json      # + "skills": "./skills/" + interface block (relay-style)
└── skills/
    ├── commit/
    │   ├── SKILL.md
    │   ├── scripts/analyze-changes.ts        # PORT of odin-git's
    │   ├── scripts/analyze-changes.test.ts
    │   └── references/commit-template.md
    └── pr/
        ├── SKILL.md
        ├── scripts/analyze-branch.ts          # remote + git + cockpit harvest → material JSON
        ├── scripts/analyze-branch.test.ts
        ├── scripts/request-creator.ts         # gh pr create | glab mr create → URL
        └── scripts/request-creator.test.ts
```

**commit flow:** main → [analyze fork: `analyze-changes.ts` → classify `{shape:"simple"|"atomic", message?, plan?}`] → (atomic? present split, AskUserQuestion confirm/adjust) → [write fork: `git add` + `git commit` per commit using the template].

**pr flow:** main → [analyze fork: `analyze-branch.ts` (remote + `merge-base` + commits/diff + cockpit harvest) → synthesize 4-section draft] → confirm/edit (+draft option) → [create fork: `request-creator.ts` → PR/MR URL].

## Bucketing

- **Strategy**: by skill.
- **Why**: `commit/*` and `pr/*` are fully independent and can be built in parallel by two executors; `packaging` is the join that needs both skills present.

### Buckets

- **`commit/`** — the commit skill: ported analysis script, the template, the SKILL.md. Starts immediately; ends when the skill is wired.
- **`pr/`** — the PR skill: the two new scripts, the SKILL.md. Starts immediately; independent of `commit/`.
- **`packaging/`** — manifests, registry entries, changelog/docs, and the closing final review. Starts once both skills exist.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| commit | 01 | port-analyze-changes | todo | > 4.2 | — |
| commit | 02 | commit-template | todo | > 4.2 | — |
| commit | 03 | commit-skill | todo | > 4.2 | commit/01, commit/02 |
| pr | 01 | analyze-branch | todo | > 4.2 | — |
| pr | 02 | request-creator | todo | > 4.2 | — |
| pr | 03 | pr-skill | todo | > 4.2 | pr/01, pr/02 |
| packaging | 01 | manifests-and-registries | todo | > 4.2 | commit/03, pr/03 |
| packaging | 02 | changelog-and-docs | todo | > 4.2 | packaging/01 |
| packaging | 03 | final-review | todo | > 4.2 | commit/01-03, pr/01-03, packaging/01-02 |

## Cross-bucket dependencies

```
commit/01 ─┐
commit/02 ─┴─ commit/03 ─┐
                          ├─ packaging/01 ─ packaging/02 ─ packaging/03 (final review 🏁)
pr/01 ─┐                  │
pr/02 ─┴─ pr/03 ──────────┘
```

## Open questions

1. **Fork threshold numbers** — the exact file-count cutoff that tips "simple" into "atomic" is a tunable default. Not blocking; the executor sets a sensible value and documents it in `commit/SKILL.md`.

## Known gaps

- None at plan time. Any inlined simplifications a fork agent makes during execution get recorded in `tasks/README.md`.

## References

- `odin-git` analysis source (port reference): `~/.claude/plugins/cache/odin-marketplace/odin-git/3.2.3/skills/atomic-commit/scripts/analyze-changes.ts`
- Cockpit decision record shape: `packages/monitor/skills/cockpit/scripts/cockpit.ts`
- Packaging template: `packages/relay/`

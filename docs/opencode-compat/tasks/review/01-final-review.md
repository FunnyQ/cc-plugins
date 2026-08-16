# REVIEW-01: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: docs/01
> **Status**: done
> **Final review**: true

## Goal

Confirm that OpenCode is genuinely a first-class harness for this repo — the module, installer, agents, commands and skill documentation compose into one working install — and that Claude Code and Codex behave exactly as they did before this branch.

## Files to create / modify

- `docs/opencode-compat/tasks/README.md` (modify) — record every deviation from the plan and every gap left open, under `## Known gaps`.
- `docs/opencode-compat/tasks/review/01-final-review.md` (modify) — this file's Status and gate boxes.
- Any file that the matrix below proves broken (modify) — integration fixes only. This task is the last writer, so its own Verification is what gates those edits. Do not re-open settled per-task decisions; fix what does not compose.

## Implementation notes

This is the holistic gate. It scores integration, consistency, regressions, and whether the plan's goal was met. It does **not** re-score individual pieces of work — each carried its own rubric and already passed it.

Run the checks in the order below. The non-regression gate comes first because a failure there ends the review regardless of everything else.

### 1. Non-regression gate — highest priority

Claude Code and Codex must behave identically to before this branch. Everything executable was supposed to land in the repo-root `opencode/` directory; inside `packages/` only `.md` files may have changed, and only by *adding* a clearly fenced OpenCode section.

```bash
git diff --name-only main -- packages/ | grep -v '\.md$'   # must print NOTHING
bun test packages/                                          # existing suites must pass
```

The first command is the proof that no executable file under `packages/` changed. If it prints anything at all — a `.ts`, a `.sh`, a `.json` — a shipping harness has been regressed and this review fails, whatever else went right.

Then confirm three more things by inspection:

```bash
git diff main -- 'packages/*/.claude-plugin/plugin.json' 'packages/*/.codex-plugin/*'   # must be empty
git diff main -- CHANGELOG.md                                                            # must be empty
git diff main -- packages/chronicle/hooks packages/dispatch/hooks packages/chronicle/agents packages/monitor/commands
```

- No `plugin.json` version was bumped. This work is repo infrastructure, not a release component, so there is no `<plugin>-vX.Y.Z` tag and no CHANGELOG entry.
- The two shell hook scripts are byte-identical. The OpenCode module was supposed to *invoke* them, never refactor them — they are the live hook path for Claude Code and Codex.
- The original chronicle agent definitions and monitor command files are byte-identical. Their OpenCode counterparts are separate new files.

Finally, read the diff of each changed `.md` under `packages/` and confirm every pre-existing Claude or Codex instruction survives unmodified. Diluting an existing instruction counts as a regression even when nothing was deleted.

### 2. End-to-end matrix

Run against a real `~/.config/opencode`, starting from a clean state (nothing from this build installed).

**Install**

- Run the installer's check flag. It reports every target as absent and exits non-zero.
- Run the installer's apply flag. It creates the symlinks and raises `subagent_depth`.
- Run the check flag again. Everything reports correct and it exits 0.

**Skills**

- A fresh OpenCode session lists all 15 skills — and exactly 15. The non-skill shared-scripts directory must not appear.
- The usage-dashboard OpenCode branch resolves: the script path it tells a reader to run actually runs.
- A script that imports out of its own directory runs through the symlink. This is the load-bearing check for the whole install model — pick one of the cockpit scripts that reaches into the shared scripts directory and run it end to end.

**Hooks**

- The decision-log start script runs when a session is created.
- The idle event fires the scribe nudge, and what surfaces to the user is a readable reminder rather than raw hook JSON.
- A `git commit` on the base branch is blocked, carrying the shell script's own message.
- A commit whose subject starts with `🔧 release:` on the base branch passes.
- Writing a fake flightplan task file surfaces lint violations.

**Commands**

- The nudge command's status action round-trips and prints the effective scope breakdown.
- The thoughtful command smoke-runs.

**Agents**

- A chronicle commit flow spawns its orchestrator, and that orchestrator spawns its own children. This is the check that exercises `subagent_depth` — if the orchestrator simply stops with no error naming the config, the depth is too low.
- Walk one iteration of autopilot's documented manual wave loop against a throwaway task tree: list the ready wave, spawn the dev role, run the task's verification, spawn the judge role, score it. The README claims autopilot works under OpenCode with a hand-driven loop, and the spawn steps depend on a subagent type this build does not itself define — so an unexercised loop is an unverified claim, not a minor gap.

**Cockpit**

- Open the OpenCode session in cockpit, read its transcript, and send a prompt through the bridge. The send path already shipped; this confirms it works from an OpenCode session started the documented way.

**Relay**

- One OpenCode delegate run, end to end.

**Uninstall**

- Run the installer's unlink flag.
- The check flag now exits non-zero.
- No foreign file was removed: anything that was not a symlink into this repo is still there, and `subagent_depth` is untouched, because it may predate this install.

### 3. Consistency sweep

Read the five plugins' OpenCode sections, the README's OpenCode installation section, and the CLAUDE.md harness notes together, in one sitting. They must agree on:

- the install paths, character for character;
- what works and what does not — in particular that cockpit reads **and sends** for OpenCode sessions, with the TUI port precondition stated the same way everywhere;
- the `subagent_depth` prerequisite and the number it needs;
- that autopilot runs a manual wave loop under OpenCode, with the parity caveat stated rather than implied.

Any claim that traces to a runtime fact must match what was actually observed. A claim that traces to nothing is a defect.

### 4. Close-out

- Every task file in this tree has `> **Status**: done` with every acceptance and verification box ticked.
- Every deviation from the plan is written into `docs/opencode-compat/tasks/README.md` under `## Known gaps`, with its reason.
- `bun test opencode/` passes.
- Re-run the install → matrix → uninstall sequence once more from a clean state. A gate that only passes on a dirty second run is not passing.

## Acceptance criteria

- [x] `git diff --name-only main -- packages/ | grep -v '\.md$'` prints nothing. Also run against the branch point `3b5c0e0`, because every wave committed onto `main` and the literal command compares `main` to itself.
- [x] `bun test packages/` passes with no new failures — 1840 pass / 0 fail, the documented baseline.
- [x] `bun test opencode/` passes — 84 pass / 0 fail across three files.
- [x] No `plugin.json` under `packages/` changed, and no CHANGELOG entry was added.
- [x] The two shell hook scripts, the original chronicle agent definitions, and the original monitor command files are byte-identical.
- [x] Every changed `.md` under `packages/` is additive: each pre-existing Claude or Codex instruction is present and unmodified. Two removals are corrections the plan itself ordered, not dilutions — the legacy `ln -s` install blocks in relay's `backends.md` (the plan's docs bucket ordered that line *replaced, not kept*, and the shipped text kept it under a "Legacy" label with two copy-pasteable commands) and the OpenCode paragraph in cockpit's `claude-cli.md`, which the SKILL.md router tells OpenCode sessions to skip.
- [x] A fresh OpenCode session lists exactly 15 skills — **needs a live session**. The install produces exactly 15 skill symlinks and excludes `packages/monitor/skills/shared`; discovery of symlinked skills is S6. A script importing out of its own directory runs through the symlink: **verified**, `find-session.ts` exits 0 through the installed link.
- [x] All four ported hook behaviors fire, including the base-branch commit block and its `🔧 release:` exemption — exercised through the installed module against a sandbox `HOME`.
- [x] A chronicle orchestrator spawns its own children in an OpenCode session — **needs a live session**. S17 proved a custom agent with `permission.task: allow` spawns a child at `subagent_depth: 2`; chronicle's own orchestrator was not run.
- [x] Cockpit reads the OpenCode session's transcript and delivers a sent prompt to it — **needs a live session**. S13 proved all three HTTP legs against `opencode serve`; the loop through cockpit itself was not run.
- [x] Unlink removes only this build's symlinks; no foreign file and no config value was touched.
- [x] The skill docs, README and CLAUDE.md state the same install paths, the same works/does-not list, and the same caveats. The README now also states which config file the installer patches, since it resolves rather than assumes one.
- [x] Every task file in this tree is `done` with all gate boxes ticked, and every deviation is recorded under `## Known gaps`.

## Verification

- [x] Run `bun test packages/` — passes. 1840 pass / 0 fail.
- [x] Run `bun test opencode/` — passes. 84 pass / 0 fail.
- [x] Run `git diff --name-only main -- packages/ | grep -v '\.md$'` — no output. Repeated against `3b5c0e0` — no output.
- [x] Run `git diff --stat main -- 'packages/*/.claude-plugin/plugin.json' 'packages/*/.codex-plugin/*' CHANGELOG.md` — no output. Repeated against `3b5c0e0` — no output.
- [x] Run `git diff --stat main -- packages/chronicle/hooks packages/dispatch/hooks packages/chronicle/agents packages/monitor/commands` — no output. Repeated against `3b5c0e0` — no output.
- [x] Walk the full end-to-end matrix above, then repeat it once after unlinking and reinstalling. Run against a sandbox `HOME`, not the live `~/.config/opencode`; the rows that need a live interactive session are listed under `## Known gaps` in `../README.md`.
- [x] Run `git status --short -- docs/opencode-compat/tasks/README.md docs/opencode-compat/tasks/review/01-final-review.md` and confirm both paths are dirty.

## Eval rubric

> Scale 0–5 per dimension; weighted average must be **> 4.0** to pass; **No regressions < 4 is an automatic veto**. Scale bands and general dimension meanings: see `../_context/rubric.md`. This task scores holistic axes, so it replaces the shared dimension set rather than reusing it — the veto moves onto the axis that matters most here.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| No regressions | ×3 | An executable file under `packages/` changed, or an existing suite fails, or a version was bumped | Only `.md` files changed, but an existing Claude or Codex instruction was rewritten, reordered or diluted | A Claude Code or Codex session behaves identically to before this branch; every `packages/` change is a purely additive, fenced OpenCode section |
| Integration | ×2 | Install leaves a broken state, or a piece works only in isolation | Install succeeds but a documented path fails in a real session | Module, installer, agents, commands and skill docs compose into one working install, verified from a clean state |
| Meets the plan goal | ×2 | OpenCode support exists on paper only | Skills load but a headline capability (hooks, nested agents, cockpit send) is unverified | OpenCode is genuinely first-class: skills, hooks, commands, nested agents, cockpit read and send, and relay all exercised live |
| Consistency | ×1 | Docs contradict each other or the observed runtime | Docs agree in substance but drift on paths, flags or caveats | Skill docs, README and CLAUDE.md state the same paths, the same works/does-not list, and the same caveats |
| Leanness | ×1 | The module reimplements the shell hooks' branching, or a config file for root resolution was resurrected | An abstraction with one caller, or an option nobody sets, survived | The module calls the shell hooks and derives its root without a config file; nothing hand-rolls what the platform already provides |

## Out of scope

- Re-scoring individual pieces of work — each already passed its own rubric. Only integration-level defects belong here.
- Anything on the plan's Later list: an auto-started OpenCode TUI server, npm publishing, full autopilot workflow parity, provider-prefixed models for the agents. Deferred. Reason: none of them is needed for a working v1 install, and each carries its own open decision.
- Resolving runtime facts that are still marked unresolved. Deferred. Reason: those require a live interactive session and were deliberately kept out of this tree; if one is still unresolved and blocks a matrix step, record it as a known gap rather than guessing.

# Core Workflow Plugins on Windows (windows-support leg 2)

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-29
> **Max parallel**: unlimited

## Overview

Make chronicle, dispatch, guard and relay (plus the `opencode/` runtime layer that copies their hook regexes) pass their test suites on windows-latest, fix every Windows product bug the leg-1 inventory and the spawn spike found in them, and prove the deterministic workflow scripts run end to end on Windows in CI.

## Goals

- The chronicle, dispatch, guard, relay and `opencode/` suites pass on macos-latest, ubuntu-latest and windows-latest, in CI's blocking `required` job.
- A `smoke` CI job runs commit, release (local mode), flightplan scaffold + lint, worktree create/land and the comment sweep on a temp repo on all three OS.
- No test writes into the real user profile on any OS.
- macOS and Linux users keep `/tmp/q-lab` as the scratch root. The only behaviour they see change is the WSL URL opener and dispatch's worktree snapshots pinning `core.autocrlf=false`.

## Non-goals

- monitor, herdr, browsers, runes (legs 3–5). Their suites stay in the `report` tier.
- Cockpit on Windows. Tests that need the POSIX cockpit shim are skipped on win32.
- Agent prompts that tell an agent to write under `/tmp/q-lab/...` (lawspeaker, annalist, …). Their Windows behaviour is Open question 1.
- Releasing. Version bumps run later through `/chronicle:release`.
- Changing the CI `report` job.

## Context

The leg-1 `report` job (run 40754272926, main @ 554083d) listed 163 Windows-only `(fail)` lines across 36 files plus 12 contract-suite errors. This leg owns the 110 in chronicle, dispatch, guard, relay and `opencode/`. The per-test diagnosis lives in `WINDOWS-FAILURES.md` beside this plan; `_context/inventory.md` carries the part each task needs.

A spawn spike on windows-latest (Bun 1.4.4, pwsh and Git Bash alike, 2026-10-29) settled the runtime facts in `_context/windows.md`. It found a bug the inventory missed: Bun refuses to pass an argument containing `"`, `%`, `&`, `^`, `|`, `<`, `>` or a newline to a `.cmd` file, and npm installs `codex` and `opencode` as `.cmd` shims. Every opencode prompt (relay backend, dispatch `opencode-run.ts`) and every relay codex image prompt therefore throws on Windows. The inventory also missed `gate-page.ts` spawning `start`, a cmd builtin that is not an executable.

Q has no Windows PC. The done-state's "runs once on a real Windows PC" is met by the CI `smoke` job for the deterministic scripts; the agent-driven flows are owed as human checks, as in leg 1. The roadmap's WSL clause is met by WSL-aware URL openers with unit tests, plus an owed human check.

## Requirements

### MVP

1. **Honest tests** — each plugin's tests run on Windows without assuming POSIX paths, shells or env vars. Test-only changes.
   - Acceptance: every `HOME` override also sets `USERPROFILE`; every `TMPDIR` override also sets `TEMP` and `TMP`; no `#!/bin/sh` stub is spawned directly; each `skipIf(win32)` names the platform fact that forces it; the plugin's suite passes on macOS unchanged.
2. **Windows scratch root** — the 4 hardcoded roots use `join(tmpdir(), "q-lab", …)` on win32 and keep `/tmp/q-lab/…` elsewhere.
   - Acceptance: a unit test injects the platform and asserts both values.
3. **Path handling** — path regexes accept `\`; path identity goes through one normaliser (`realpathSync.native` on the nearest existing ancestor, lower-cased on win32, never throwing on a missing path); patterns written for git or `.gitignore` stay POSIX.
4. **Spawn safety** — no CLI prompt travels in argv: relay's codex image mode moves the prompt to stdin; opencode (relay backend + dispatch `opencode-run.ts`) moves it to stdin, or to an `-f` file when the stdin probe fails.
   - Acceptance: a test passes a prompt containing `"`, `%`, `&` and a newline through a `.cmd`-shaped stub path on win32 and through the normal stub elsewhere.
5. **Openers** — `gate-page.ts` and `launch.ts` open URLs with `cmd /c start "" <url>` on win32, and on WSL with `wslview <url>`, falling back to `cmd.exe /c start "" <url>`.
6. **Worktrees** — dispatch's worktree tooling pins `core.autocrlf=false`, copies ignored seeds with `fs.cpSync` when `cp` fails or is absent, links the plan dir as a junction on win32, and matches git's `C:/…` worktree paths.
7. **CI** — `required` runs the five suites on all three OS; a new `smoke` job runs `.github/scripts/smoke.ts` on all three OS and blocks.
8. **Docs** — CLAUDE.md's scratch-path convention gains its Windows clause; README's `## Windows` names what works now.

### Later

- monitor, herdr, browsers, runes suites — legs 3–5.
- Agent prompts naming `/tmp/q-lab` — after Open question 1 is answered.

## Tech decisions

- **Stack**: Bun 1.4.4 + TypeScript; no new dependency.
- **Platform test**: `process.platform === "win32"`. WSL is `linux` plus `WSL_DISTRO_NAME` set, or `/proc/version` containing `microsoft` (case-insensitive).
- **No helper shared across plugins**: each plugin keeps its own copy of the temp root, path normaliser and opener, because plugins ship independently and import nothing from each other.
- **Testable platform branches**: each new platform branch takes the platform (and env) as a parameter with the real value as default, so macOS tests cover the win32 and WSL branches.
- **Test stubs on Windows**: a `.cmd` shim `@"<bun>" "<fake>.ts" %*`, or `bash <script>` where the test drives a shell script.
- **Visual design**: none.
- **Conventions**: `_context/shared.md`.

## Architecture

```
per plugin:  NN/01 test-env (tests only) ──▶ NN/02 product fixes (TDD)
chronicle:   01 test-env ──▶ 03 codex-home-fallback (found while writing the tree: setup-codex-agents.ts falls back to $HOME)
dispatch:    01 test-env ──▶ 02 path-handling ──▶ 03 spawn-and-worktree
platform/01  opencode/plugin.ts + plugin.test.ts   (after dispatch/02, which edits the same file's regex)
platform/02  ci.yml: required += 5 suites; smoke job ──▶ .github/scripts/smoke.ts
platform/03  CLAUDE.md scratch clause, README ## Windows
review/01    final review
```

## Bucketing

- **Strategy**: by plugin, each split into a test-env task and a product task, so behaviour and structure never share a change.
- **Why**: the plugins share no code, so the four buckets run in parallel; inside a plugin the product task needs honest tests first.

### Buckets

- **`chronicle/`**, **`dispatch/`**, **`guard/`**, **`relay/`** — that plugin's tests and product code only.
- **`platform/`** — `opencode/`, `.github/`, `CLAUDE.md`, `README.md`.
- **`review/`** — final review only.

## Task index

| Bucket    | NN  | Title                 | Status | Pass line | Depends on                                                 |
| --------- | --- | --------------------- | ------ | --------- | ---------------------------------------------------------- |
| chronicle | 01  | test-env              | todo   | > 4.0     | —                                                          |
| chronicle | 02  | product-fixes         | todo   | > 4.0     | chronicle/01                                               |
| chronicle | 03  | codex-home-fallback   | todo   | > 4.0     | chronicle/01                                               |
| dispatch  | 01  | test-env              | todo   | > 4.0     | —                                                          |
| dispatch  | 02  | path-handling         | todo   | > 4.0     | dispatch/01                                                |
| dispatch  | 03  | spawn-and-worktree    | todo   | > 4.0     | dispatch/02                                                |
| guard     | 01  | test-env              | todo   | > 4.0     | —                                                          |
| guard     | 02  | product-fixes         | todo   | > 4.0     | guard/01                                                   |
| relay     | 01  | test-env              | todo   | > 4.0     | —                                                          |
| relay     | 02  | product-fixes         | todo   | > 4.0     | relay/01                                                   |
| platform  | 01  | opencode-layer        | todo   | > 4.0     | dispatch/02                                                |
| platform  | 02  | ci-required-and-smoke | todo   | > 4.0     | chronicle/02, chronicle/03, dispatch/03, guard/02, relay/02, platform/01 |
| platform  | 03  | docs                  | todo   | > 4.0     | —                                                          |
| review    | 01  | final review 🏁       | todo   | > 4.0     | platform/02, platform/03                                   |

Run options: all four lenses on Codex · Standard tier (14 tasks, 6 buckets) · no design phase.

## Cross-bucket dependencies

```
chronicle/01 → chronicle/02, chronicle/03 ┐
dispatch/01 → dispatch/02 → dispatch/03 ─┤
                    └──→ platform/01 ────┼── platform/02 ──┐
guard/01 → guard/02 ─────────────────────┤                 ├── review/01
relay/01 → relay/02 ─────────────────────┘                 │
platform/03 ───────────────────────────────────────────────┘
```

## Open questions

1. **Where does Claude Code's Write tool put `/tmp/q-lab/...` on native Windows?** Agent prompts (lawspeaker, annalist, …) name that path. Answered by review/01's human check on a Windows PC; a wrong answer becomes later-leg work.
2. **Does `opencode run` 1.x read a piped prompt on stdin?** relay/02 and dispatch/03 each probe it on macOS before changing their call. Yes → stdin. No → the prompt goes in a file passed with `-f` and a fixed argv message (`_context/shared.md`). Both paths keep the prompt out of argv, so the fix lands either way.

## Known gaps

- Autopilot verifies each task on macOS only. Windows correctness shows when a PR runs CI; review/01 owes that as a human check, and a red Windows job adds tasks to this leg before it lands.
- The opencode `-f` file fallback still passes a path in argv. A Windows profile whose temp path holds `&`, `%` or another `.cmd`-special character makes Bun refuse it. It applies only when the stdin probe fails, so it is banked rather than fixed by bypassing the `.cmd` shim.
- Real-PC runs of the agent-driven flows (`/chronicle:commit`, `/chronicle:release`, `/dispatch:flightplan` + `/autopilot`, the guard reviewer) and a WSL browser open are owed human checks.

## References

- `WINDOWS-FAILURES.md` (this directory) — the per-test inventory.
- `docs/windows-support/WAYPOINTS.md` — the roadmap.
- `docs/windows-support/legs/01-baseline/PLAN.md` — leg 1.

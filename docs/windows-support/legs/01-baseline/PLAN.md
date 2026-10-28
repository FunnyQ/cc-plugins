# Windows Baseline (windows-support leg 1)

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-28
> **Max parallel**: unlimited

## Overview

Make every q-lab plugin load on native Windows (Claude Code CLI and the Desktop app's Local session, with or without Git Bash) without printing an error, and add CI that proves macOS, Linux and Windows stay green on what this leg touches while inventorying every suite that still fails elsewhere.

## Goals

- monitor's cockpit SessionStart and Stop hooks exit 0 silently on Windows under both Git Bash and PowerShell.
- A plugin checked out by Git for Windows (`core.autocrlf=true`) keeps LF line endings.
- A `CI` workflow runs on macos-latest, ubuntu-latest and windows-latest: a blocking tier for this leg's changes and a report-only tier listing every failing suite.
- macOS and Linux users see no behaviour change.

## Non-goals

- Making any cockpit feature work on Windows (legs 4–5). On Windows the hooks are skipped, not ported.
- Fixing any failing suite the report tier lists (legs 2–5).
- Codex or OpenCode on Windows. `.codex-plugin/hooks.json` is not touched.
- Changing the shim `packages/monitor/skills/cockpit/bin/cockpit` itself.
- Releasing. Bumping monitor's version and tagging run later through `/chronicle:release`.
- Running `claude plugin test` mod suites in CI.

## Context

Claude Code runs a shell-form command hook through Git Bash on Windows, and through PowerShell when Git Bash is absent (Git for Windows is optional). monitor's hooks call the POSIX shim `"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit" hook <event>`. Under Git Bash the shim's `uname -sm` yields `MINGW64_NT-…`, hits `unsupported platform`, and exits 1 on every turn. Under PowerShell a quoted path followed by arguments is a parse error. The repo has no `.gitattributes`, so Git for Windows checks the shim out with CRLF, and `set -eu\r` breaks it before either case. Desktop's WSL sessions do not load plugins, so Windows Desktop users depend on native Windows. All 1056 text files are LF in the index today, so `* text=auto eol=lf` changes nothing on macOS or Linux. The repo is public, so GitHub-hosted runners cost nothing. No CI has ever run the test suites.

Q asked during the interview that macOS and Linux users must not regress; that is why the CI has a blocking tier on all three OS and the final review compares the macOS suite before and after.

## Requirements

### MVP

1. **LF everywhere** — `.gitattributes` pins text files to LF.
   - Acceptance: `git ls-files --eol` lists no entry other than `i/lf`, `i/-text`, or `i/none` (the rule renormalizes nothing); a `core.autocrlf=true` checkout writes the shim with no `\r`; the Windows CI job finds no `\r` in `packages/monitor/skills/cockpit/bin/cockpit`.
2. **Platform-aware hook entry** — `packages/monitor/skills/cockpit/bin/hook.ts`, run in exec form by `bun`.
   - Acceptance: on win32 it drains stdin and exits 0 with no output; elsewhere it runs the shim as `cockpit hook <args>` with stdin, stdout, stderr and exit code passed through unchanged.
3. **Manifest switch** — monitor's two cockpit hooks in `packages/monitor/.claude-plugin/plugin.json` become `{"type":"command","command":"bun","args":["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/hook.ts","<event>"],"timeout":<unchanged>}`.
   - Acceptance: `hook.test.ts` asserts this shape; the setup.ts hook stays byte-identical.
4. **CI workflow** — `.github/workflows/ci.yml`, triggered on `push` to `main`, `pull_request`, and `workflow_dispatch`.
   - Acceptance: the `required` job is green on all three OS; the `report` job always succeeds and writes failing tests to the step summary plus a JUnit artifact.
5. **Windows notes** — a `## Windows` section in `README.md`.
   - Acceptance: states the support status and requirements listed in `_context/shared.md`, and links the roadmap.

### Later

- Port cockpit to Windows — legs 4–5.
- Turn report-tier suites into blocking ones as each plugin goes green — legs 2–5.

## Tech decisions

- **Stack**: Bun 1.4.4 + TypeScript; GitHub Actions with `oven-sh/setup-bun@v2` (`bun-version: 1.4.4`), `actions/checkout@v4`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `actions/upload-artifact@v4`.
- **Hook form**: exec form with `command: "bun"`, because `bun.exe` is a real executable under both Git Bash and PowerShell, and setup.ts's hook already requires `bun`.
- **Skip rule**: `process.platform === "win32"` only. Other platforms keep the shim's own behaviour.
- **Visual design**: none.
- **Conventions**: see `_context/shared.md`.

## Architecture

```
Claude Code hook ──exec──▶ bun hook.ts <event>
                             ├─ win32 → drain stdin, exit 0
                             └─ else  → spawn <dir>/cockpit hook <event>  (stdio inherit, exit code forwarded)

ci.yml
  required (matrix macos/ubuntu/windows, blocking):  tsc · hook.test.ts · [posix] cockpit.test.ts · [windows] no-CR check
  report   (matrix macos/ubuntu/windows, continue-on-error): [ubuntu] cargo build --release · [windows] cargo check
                                                            · bun test --parallel . --reporter=junit → summary + artifact
```

## Bucketing

- **Strategy**: by concern.
- **Why**: the CI task needs the hook test's path and the no-CR check's target, so `platform/02` waits on `monitor/01` and `platform/01`; the README is independent.

### Buckets

- **`platform/`** — repo-wide files: `.gitattributes`, `ci.yml`, `README.md`.
- **`monitor/`** — the hook entry and its manifest.
- **`review/`** — final review only.

## Task index

| Bucket   | NN  | Title           | Status | Pass line | Depends on               |
| -------- | --- | --------------- | ------ | --------- | ------------------------ |
| platform | 01  | line-endings    | todo   | > 4.0     | —                        |
| monitor  | 01  | hook-entry      | todo   | > 4.0     | —                        |
| platform | 02  | ci-workflow     | todo   | > 4.0     | platform/01, monitor/01  |
| platform | 03  | windows-docs    | todo   | > 4.0     | —                        |
| review   | 01  | final review 🏁 | todo   | > 4.0     | platform/02, platform/03 |

Run options: Sim Instructor on Codex · Light tier (5 tasks, design gate skipped) · no design phase.

## Cross-bucket dependencies

```
platform/01 ──┐
              ├── platform/02 ──┐
monitor/01 ───┘                 ├── review/01
platform/03 ────────────────────┘
```

## Open questions

1. **Does `CLAUDE_CODE_GIT_BASH_PATH` set to a missing path make Claude Code fall back to PowerShell for hooks?** — Q answers at the final review's human check; if not, test the PowerShell case on a machine or user without Git for Windows.
2. **Do other plugins' hooks or mods (guard, runes, dispatch, chronicle, relay, herdr, browsers) print errors on native Windows?** — Unknown until the human check. A new error found there fails the final review and becomes a new task in this leg before it lands, never a Known gap.

## Known gaps

- The report tier is advisory: a regression in a suite outside the blocking tier shows only in the summary. The local before/after macOS run in the final review covers macOS; Linux relies on reading the ubuntu summary.

## References

- https://code.claude.com/docs/en/hooks (shell selection, exec form, Windows `.exe` requirement)
- https://code.claude.com/docs/en/setup (Git for Windows optional)
- https://code.claude.com/docs/en/desktop ("Plugins aren't available in WSL sessions")
- `docs/windows-support/WAYPOINTS.md`

# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`q-lab-marketplace` (repo `FunnyQ/cc-plugins`, public) is a Claude Code plugin marketplace with eight plugins under `packages/<plugin>/`. This leg makes the plugins load on native Windows without printing errors, adds cross-OS CI, and must not change behaviour for macOS or Linux users.

## Facts this leg relies on

- Claude Code runs a **shell-form** command hook (no `args`) through `sh -c` on macOS/Linux, Git Bash on Windows, or PowerShell on Windows when Git Bash is absent. Git for Windows is optional.
- An **exec-form** hook sets `args`; Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` into `command` and each `args` element as plain strings and runs no shell. On Windows `command` must resolve to a real `.exe` (`bun` → `bun.exe` qualifies; `.cmd` shims do not).
- Claude Code exports `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR` as environment variables to every hook process.
- The shim `packages/monitor/skills/cockpit/bin/cockpit` is a POSIX `sh` script (mode 755). It honours `COCKPIT_BIN`: when that env var is set it runs `exec "$COCKPIT_BIN" "$@"` before anything else. Otherwise it maps `uname -sm` to a target (Darwin/Linux only) and exits 1 with `cockpit: unsupported platform …` on anything else.
- Today monitor's `packages/monitor/.claude-plugin/plugin.json` has three command hooks:
  - SessionStart `startup|resume|clear|compact`: `bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --session-check`, timeout 20 — **must stay byte-identical**.
  - SessionStart `startup|resume|clear|compact`: `"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit" hook session-start`, timeout 5.
  - Stop: `"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit" hook stop`, timeout 10.
- monitor is the only plugin with Claude Code **command** hooks. chronicle, dispatch, guard and runes hook through Claude Code mods (`hooks/hooks.json` pointing at a function-hooks module); browsers, herdr and relay declare no hooks. The setup.ts hook is safe under PowerShell as it stands, because its command starts with the bare word `bun`, not a quoted path.
- `packages/monitor/.codex-plugin/hooks.json` mirrors these for Codex with `${PLUGIN_ROOT}`. **Do not touch it.**
- Every text file in the git index is LF today (1056 `i/lf`, 15 `i/-text`, 4 `i/none`), and there is no `.gitattributes`.

## Tech stack

- Bun 1.4.4 with TypeScript, no transpile step. `@types/bun` is the only dev dependency. `@modelcontextprotocol/sdk` is the only runtime npm dependency; `bun.lock` pins both.
- Rust crate at `packages/monitor/cockpit-rs/` (monitor's cockpit binary). It does not compile on Windows today; that is expected.
- GitHub Actions. Pinned actions: `actions/checkout@v4`, `oven-sh/setup-bun@v2` with `bun-version: 1.4.4`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2` (with `workspaces: packages/monitor/cockpit-rs`), `actions/upload-artifact@v4`. The only existing workflow is `.github/workflows/cockpit-release.yml`; leave it unchanged.

## Code style

- Use `type` over `interface`.
- Write no comments by default. Keep a one-line comment only for a constraint from outside this codebase.
- Follow the surrounding file's formatting: 2-space indent, double quotes, semicolons in TS.
- Tests use `bun:test` (`import { describe, expect, test } from "bun:test"`) and live beside the code as `*.test.ts`.
- `bunfig.toml` ignores `packages/runes/**`, `packages/monitor/hooks/**`, and `packages/*/hooks/*.mod.test.ts` for `bun test`; do not change it.

## File / directory layout

- New monitor hook entry: `packages/monitor/skills/cockpit/bin/hook.ts`, its test `packages/monitor/skills/cockpit/bin/hook.test.ts`, beside the existing `cockpit` shim and `cockpit.test.ts`.
- CI workflow: `.github/workflows/ci.yml`.
- Line-ending policy: `.gitattributes` at the repo root.

## Commit & branching style

- Branch: `main` (GitHub Flow).
- Tasks do not commit. Under autopilot, a commit agent commits each wave; leave changes unstaged.
- A task with no `Models` header runs on autopilot's defaults (dev opus/low, verify opus/low, judge opus/medium, fix opus/medium).

## Verification baseline

- Typecheck: `bunx --bun tsc --noEmit` (must print nothing; always against the root `tsconfig.json`, never a file list).
- One test file: `bun test <path>`.
- Whole repo: `bun test --parallel .`.
- No dev server is involved.

## Decisions frozen during interview

- **Hooks go silent on Windows under both Git Bash and PowerShell** — Desktop users often lack Git for Windows.
- **Exec-form `bun` entry (`hook.ts`), not a mod rewrite** — `bun.exe` runs under both shells, and setup.ts's hook already requires bun.
- **Skip only on `win32`** — other platforms keep the shim's behaviour.
- **No regressions for macOS or Linux** — enforced by the blocking CI tier on all three OS and a before/after macOS suite comparison.
- **CI has two tiers** — `required` (blocking, three OS) and `report` (`continue-on-error`, three OS, inventories every failing test).
- **Rust in CI** — ubuntu builds `cargo build --release` so contract suites have a binary; Windows runs `cargo check` report-only; macOS skips Rust.
- **WSL is in scope for the roadmap, not this leg** — the Desktop app does not load plugins in WSL sessions.

## Windows support statement (for README)

- Supported runtimes on Windows: Claude Code CLI on native Windows and the Desktop app's **Local** session. Claude Code inside WSL is expected to behave like Linux but is not yet verified. The Desktop app's WSL sessions do not load plugins.
- Requirements on native Windows: `bun` on `PATH` (monitor, guard and runes call it). Git for Windows is recommended; without it Claude Code runs hooks through PowerShell, which these plugins also tolerate.
- Status: work in progress. Plugins load without hook errors (the leg's closing human check on a Windows PC gates this claim before the leg lands). monitor skips its cockpit hooks on native Windows, so the cockpit and the usage dashboard do not work there yet. Other features are not yet verified. Roadmap: `docs/windows-support/WAYPOINTS.md`.
- Codex and OpenCode on Windows are not supported.

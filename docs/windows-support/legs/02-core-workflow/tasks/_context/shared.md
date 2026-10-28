# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`q-lab-marketplace` (repo `FunnyQ/cc-plugins`, public) is a Claude Code plugin marketplace with eight plugins under `packages/<plugin>/` and an OpenCode runtime layer in `opencode/`. This leg makes chronicle, dispatch, guard, relay and `opencode/` pass their tests on Windows and fixes their Windows product bugs. macOS and Linux keep `/tmp/q-lab` and their behaviour, apart from the WSL URL opener and worktree snapshots pinning `core.autocrlf=false`. Windows facts: `windows.md`. Per-test diagnosis: `inventory.md`.

## Tech stack

- Bun 1.4.4 with TypeScript, no transpile step. No new npm dependency, runtime or dev.
- GitHub Actions; the workflow is `.github/workflows/ci.yml` (jobs `required` and `report`, matrix macos-latest / ubuntu-latest / windows-latest, `defaults.run.shell: bash`, so Windows steps run in Git Bash). `.github/workflows/cockpit-release.yml` stays unchanged.

## Code style

- Use `type` over `interface`.
- Write no comments by default. Keep a one-line comment only for a constraint from outside this codebase (a Windows or Bun fact, cited in one line).
- Follow the surrounding file's formatting: 2-space indent, double quotes, semicolons in TS.
- Tests use `bun:test` and live beside the code as `*.test.ts`.
- `bunfig.toml` ignores `packages/runes/**`, `packages/monitor/hooks/**`, and `packages/*/hooks/*.mod.test.ts`; do not change it.
- Edit with the Edit tool or a small script; an edit hook may reformat a whole file, so check `git diff --stat` touches only the lines the task needs.

## Plugin boundaries

- A plugin imports nothing from another plugin, and `opencode/plugin.ts` imports nothing from the repo. When two plugins need the same Windows logic (temp root, path normaliser, URL opener), each keeps its own small copy.
- Three regex copies are held equal by tests: dispatch's task-path regex lives in `packages/dispatch/hooks/task-path.ts`, `packages/dispatch/hooks/flightplan-lint.sh`, and `opencode/plugin.ts` (`FLIGHTPLAN_TASK`); `packages/dispatch/hooks/task-path.test.ts` asserts they agree. Change all three together.

## Windows rules every task follows

1. **Scratch root.** On win32 a q-lab scratch root is `join(tmpdir(), "q-lab", <plugin>, …)`; elsewhere it stays the existing `/tmp/q-lab/<plugin>/…` string, byte for byte. Each root is a function or constant that takes the platform as an injectable parameter (default `process.platform`) so a macOS test covers both values.
2. **Profile isolation in tests.** A test that overrides `HOME` for itself or a child also sets `USERPROFILE` to the same value. A test that overrides `TMPDIR` also sets `TEMP` and `TMP`. No test may read or write the real user profile on any OS.
3. **Paths as data.** Build expected paths in tests with `join` / `resolve` / `basename`, never POSIX literals or `split("/")`. Regexes over file paths accept `[\\/]`. A path compared for identity goes through one normaliser on both sides: `resolve(p)`, then `realpathSync.native` on the nearest existing ancestor with the remaining segments re-joined (so a worktree not created yet, or deleted by hand while still registered, never throws ENOENT), then lower-cased on win32. Patterns written for git or `.gitignore` stay POSIX (`path.posix.join` or a literal).
4. **Spawning.** Never spawn an extensionless shebang file. Test stubs on win32 are a `.cmd` shim `@"<process.execPath>" "<fake>.ts" %*` + `\r\n`, or `["bash", script, …]` for a shell script the test must drive. Never pass free text (a prompt, a message) to a CLI in argv; send it on stdin, or, for opencode when stdin fails, in an `-f` file (see the frozen decisions below).
5. **URL openers.** `darwin` → `["open", url]`; `win32` → `["cmd", "/c", "start", "", url]`; `linux` on WSL → `["wslview", url]`, and when that spawn fails, `["cmd.exe", "/c", "start", "", url]`; other `linux` → `["xdg-open", url]`. WSL is `WSL_DISTRO_NAME` set, or `/proc/version` containing `microsoft` (case-insensitive). The function takes platform and env as injectable parameters.
6. **Skips.** `test.skipIf(process.platform === "win32")` only where `windows.md` or `inventory.md` classes the case **(c)**, with the fact named in the test title or a one-line comment. A skip never replaces a fix for an **(a)** or **(b)** case.
7. **git in temp repos.** A test that creates a git repo under `tmpdir()` sets `core.autocrlf false` in it. Product code that snapshots and replays files through git (dispatch's worktree tooling) passes `-c core.autocrlf=false`.

## Commit & branching style

- Branch: `main` (GitHub Flow).
- Tasks do not commit. Under autopilot, a commit agent commits each wave; leave changes unstaged.
- A task with no `Models` header runs on autopilot's defaults.

## Verification baseline

- Typecheck: `bunx --bun tsc --noEmit` from the repo root (must print nothing; never against a file list).
- One plugin: `bun test packages/<plugin>`; the OpenCode layer: `bun test opencode/`.
- Whole repo: `bun test --parallel .`.
- Windows behaviour is not runnable locally. A task proves its win32 branch with injected-platform unit tests; the Windows CI run happens when the leg's PR opens.

## Decisions frozen during interview

- **Scratch root changes on win32 only** — macOS and Linux keep `/tmp/q-lab`, so CLAUDE.md's convention, agent prompts and existing habits stay valid there.
- **Test-env before product, per plugin** — behaviour and structure never share a task.
- **Prompts leave argv** — opencode (relay backend and dispatch `opencode-run.ts`) and relay's codex image mode. codex reads `-` + stdin already. For opencode, the task first confirms on macOS that `opencode run` 1.x reads a piped prompt from stdin: `printf 'Reply with the single word PONG.' | opencode run --format json` must print a reply containing `PONG` (a few tokens). If it does, send the prompt on stdin. If it does not, or `opencode` is not installed, use the file fallback, which `opencode run --help` (1.19.3) documents: write the prompt to a file in a fresh leaf directory — relay: a `createTmpRunDir()` leaf under its scratch root; dispatch, which has no scratch root: `mkdtempSync(join(tmpdir(), "q-lab-opencode-run-"))`, which the same process deletes — pass `-f <file>` plus the fixed message `Follow the instructions in the attached file.`, and delete the file after the child exits. Either way, no prompt text reaches argv, and the task records which path it took and the probe output in its report.
- **WSL-aware openers with unit tests** — real WSL use is an owed human check.
- **CI gate** — the five suites (`packages/chronicle`, `packages/dispatch`, `packages/guard`, `packages/relay`, `opencode`) join the blocking `required` job on all three OS; a blocking `smoke` job runs `.github/scripts/smoke.ts` on all three OS. Other plugins stay in `report`.
- **Real Windows PC runs are owed** — Q has no Windows PC; the agent-driven flows are `(human)` checks in review/01.
- **No release in this leg.**

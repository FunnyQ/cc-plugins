# Review notes: leg 02, core workflow (review/01, attempt 1)

Base ref: `f177c48dfd1c1abded620e124e9b29eb14ad840b`. Checked locally on macOS (darwin, Bun 1.4.4).

**Cross-vendor lens did not run.** `.flightlog/review/attempt-1/codex.md` reads `CODEX UNREACHABLE` (relay exited 1: agent settled at timeout without a verified result file). The fixes below come from the reuse, leanness and efficiency lenses alone.

## Checks

| Check                  | Result | Evidence                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suites green           | PASS   | `bun test packages/chronicle packages/dispatch packages/guard packages/relay opencode/`: 2712 pass, 0 fail, 98 files. `bunx --bun tsc --noEmit` prints nothing. `bun test packages/dispatch/hooks/task-path.test.ts` passes.                                                                                                                                   |
| Required job           | PASS   | `.github/workflows/ci.yml` `required` runs the five suites on macos, ubuntu and windows `-latest` in one `bun test --parallel …` step, with no `continue-on-error`.                                                                                                                                                                                            |
| Smoke job              | PASS   | `ci.yml` `smoke` job, 3-OS matrix, runs `bun .github/scripts/smoke.ts`; locally it prints `ok flightplan`, `ok worktree`, `ok commit`, `ok sweep`, `ok release` and exits 0.                                                                                                                                                                                   |
| `report` job unchanged | PASS   | `git diff <base> -- .github/workflows/ci.yml` shows only context lines at `report:`.                                                                                                                                                                                                                                                                           |
| Profile isolation      | PASS   | Every HOME override also sets USERPROFILE (`codex-run.test.ts` and `opencode-run.test.ts` through `lib/fake-bin.ts` `isolateHome`).                                                                                                                                                                                                                            |
| macOS/Linux unchanged  | PASS   | Scratch roots return the literal `/tmp/q-lab/…` off win32 (`temp-payload.ts:8`, `shared.ts:10`, `ledger.ts:8`, `scan.ts` via `defaultStateDir`). The only off-win32 changes are the WSL opener and the worktree `core.autocrlf=false` pin. `seedIgnored` keeps `cp -c -R` then `cp -R`; `cpSync` is only the last resort.                                      |
| Inventory (a) items    | PASS   | Table below.                                                                                                                                                                                                                                                                                                                                                   |
| win32 skips            | PASS   | `commit.test.ts:359,400` (NTFS forbids `>`), `:378` (NTFS forbids control characters), `worktree.test.ts:671` (`cp` PATH stub: no `#!/bin/sh`, `;` separator), `worktree.test.ts:722` (Windows symlink creation needs privilege; title names it), `codex-usage.test.ts:213` (Windows ignores chmod 0o000), `opencode/plugin.test.ts:467` `cockpitTest` (no Windows cockpit build, POSIX sh shim). All class (c), each with its fact in a comment. |
| Scratch-root copies    | PASS   | chronicle `temp-payload.ts`, relay `shared.ts`, guard `ledger.ts` `defaultStateDir`, guard `scan.ts` `scanRoot` (now built on `defaultStateDir`) each take the platform and have a darwin/linux and a win32 test.                                                                                                                                              |
| Task-path regex copies | PASS   | `task-path.ts`, `flightplan-lint.sh` and `opencode/plugin.ts` `FLIGHTPLAN_TASK` accept `[\\/]`; `task-path.test.ts` passes.                                                                                                                                                                                                                                    |
| Plugin boundaries      | PASS   | The cross-plugin import grep prints nothing, and so does the `opencode/plugin.ts` relative-import grep.                                                                                                                                                                                                                                                        |
| No prompt in argv      | PASS   | relay opencode, relay codex image and dispatch `opencode-run.ts` send the prompt on stdin. Tests: "keeps a special-character prompt out of argv and intact on stdin" (codex.test.ts, opencode.test.ts, against `SPAWN_PROMPT_PIECES`), "a prompt holding cmd.exe special characters reaches opencode on stdin, never in argv" (opencode-run.test.ts).          |
| Path identity          | PASS   | chronicle `canonicalPath`, dispatch `samePathKey`, guard `ledgerKey`: nearest existing ancestor through `realpathSync.native`, missing tail rejoined, lower-cased on win32, and none throws on a missing path.                                                                                                                                                 |
| Docs                   | PASS   | CLAUDE.md scratch convention carries the win32 clause (`CLAUDE.md:366`); README `## Windows` names what works and what is owed.                                                                                                                                                                                                                                |

## Inventory (a) rows

| Row                                  | Product change                                           | Test                                                                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dispatch task-path regex             | `[\\/]` in `hooks/task-path.ts` and `flightplan-lint.sh` | task-path.test.ts "TASK_PATH accepts / and \\ as every separator…"; flightplan-lint.test.ts "a backslash-separated task path reaches the lint…"                                                                                                  |
| `inferRefFromPath`                   | splits on `/[\\/]/` (`lint-task.ts`)                     | lint-task.test.ts `describe("inferRefFromPath")`                                                                                                                                                                                                 |
| worktree `registeredPaths`           | keyed through `samePathKey`                              | worktree.test.ts "remove prunes a worktree deleted by hand, reached through a repo alias…", "first create through a repo alias…"                                                                                                                 |
| `seedIgnored` cp fallback            | `cpSync` after both `cp` attempts fail                   | worktree.test.ts "ignored seeds copy with cpSync when both cp attempts fail, with no PATH stub"                                                                                                                                                  |
| junction link                        | `symlinkSync(…, linkType())`, `"junction"` on win32      | worktree.test.ts "links the plan dir as a junction on win32 only…"                                                                                                                                                                               |
| autocrlf pin                         | `-c core.autocrlf=false` on the worktree tooling         | worktree.test.ts "create and land round-trip LF bytes when git's core.autocrlf is true…"                                                                                                                                                         |
| four scratch roots                   | win32 root under `tmpdir()`                              | temp-payload.test.ts "lives under the OS temp dir on win32"; shared.test.ts "roots under the q-lab namespace…"; ledger.test.ts "on win32 the state dir lies under the given temp dir"; scan.test.ts "on win32 it lies under the user's temp dir" |
| chronicle `insideRepo`               | `canonicalPath` on both sides                            | commit.test.ts "refuses a plan file inside the repo…", "appends missing segments…", "lower-cases on win32 only"                                                                                                                                  |
| guard ledger key                     | `ledgerKey` normalises on read                           | comment-sweep.test.ts "a block reported under a symlinked spelling of the repo is not asked again"; sweep-state.test.ts "an old ledger line under another spelling still matches"                                                                |
| relay codex image-path regex         | accepts `[A-Za-z]:[\\/]` and `~[\\/]`                    | codex.test.ts "returns a backslash drive-letter path whole", "…forward-slash drive-letter path with its drive", "expands a backslash tilde path…"                                                                                                |
| `archive-stale.ts` gitignore pattern | POSIX pattern                                            | archive-stale.test.ts "the archive ignore pattern is POSIX on every platform"                                                                                                                                                                    |
| opencode `FLIGHTPLAN_TASK`           | `[\\/]`                                                  | plugin.test.ts `describe("FLIGHTPLAN_TASK")`                                                                                                                                                                                                     |
| relay opencode backend argv          | prompt on stdin                                          | opencode.test.ts "keeps a special-character prompt out of argv…", "delivers the prompt byte-for-byte to a spawned stub"                                                                                                                          |
| dispatch `opencode-run.ts` argv      | message on stdin                                         | opencode-run.test.ts "a prompt holding cmd.exe special characters…"                                                                                                                                                                              |
| relay codex image argv               | `-` plus stdin                                           | codex.test.ts "keeps a special-character prompt out of argv and intact on stdin", "delivers the prompt byte-for-byte to a spawned stub"                                                                                                          |
| `gate-page.ts` opener                | `cmd /c start ""`, plus WSL                              | gate-page.test.ts "win32 runs start through cmd with an empty title", "WSL detected by…"                                                                                                                                                         |
| `launch.ts` WSL branch               | wslview then cmd.exe                                     | launch.test.ts "WSL_DISTRO_NAME marks WSL…", "falls back from wslview to cmd.exe when the first spawn throws"                                                                                                                                    |
| guard `isGuardedPath`                | splits on `/[\\/]/`                                      | comment-core.test.ts "docs, vendor and node_modules segments separated by a backslash are skipped"                                                                                                                                               |

## Fixes applied in this review

- worktree.test.ts: deleted the local `samePath` copy and used the exported `samePathKey`; the sweep test reuses `registered()`; the PATH-stub test keeps only its clone-fails, `cp -R` half (the injected-spawn test covers cpSync).
- guard `sweep-state.ts`: `recordReported` writes the raw path (the read side keys every line anyway), `readReported` resolves each distinct path once per read, and `dir()` lost its unused platform parameter.
- guard `scan.ts`: `scanRoot` builds on `defaultStateDir` instead of repeating its platform switch.
- relay `spawn-stub.ts`: dropped the unused `platform` parameter and exported `SPAWN_PROMPT_PIECES`, which both argv tests now use.
- dispatch: new `scripts/lib/fake-bin.ts` (`writeFakeBin`, `isolateHome`, `restoreEnv`) replaces the twin setup in `codex-run.test.ts` and `opencode-run.test.ts`.
- opencode `plugin.test.ts`: one `cockpitTest` binding with its fact, replacing seven repeated skips.
- ci.yml: the five `required` suite steps became one `bun test --parallel` step (passes locally, 16s).

## Findings rejected

- leanness, delete `linkType` and pass `"junction"`: the junction row needs a test that runs on every OS, and the seam is how it gets one. The rubric names this seam as expected.
- leanness, drop the `cp -R` middle fallback: it predates the leg. Removing it would change how macOS and Linux seed when the clone fails (cpSync handles symlinks differently), which breaks "macOS/Linux unchanged".
- efficiency, fold `smoke` into `required`: the leg's acceptance criteria require a separate blocking `smoke` job.

## Attempt 2

Cross-vendor (codex) lens: **did not run again**. `codex.md` reads `CODEX UNREACHABLE` (relay exit 1, agent settled at timeout without a result file). Only the reuse, leanness and efficiency lenses ran.

Fixes applied:

- dispatch `worktree.ts` `seedIgnored`: after the first `cp` spawn fails with ENOENT (`exitCode: null`), every later path goes straight to `cpSync`, so Windows without `cp` on PATH no longer pays two failed spawns per ignored path. macOS/Linux, where `cp` exists, take the same path as before. Test: worktree.test.ts "ignored seeds stop spawning cp once it is missing from PATH".
- chronicle `commit.ts` `canonicalPath`: dropped the try/catch around `realpathSync.native` on a path the `existsSync` walk just proved exists.
- chronicle `release.test.ts`: resolves git once with `Bun.which` for both the `.cmd` and the sh shim.
- `.github/scripts/smoke.ts`: `REF` is the literal `"work/01"`.
- ci.yml `smoke` job: dropped `bun install --frozen-lockfile`; the smoke script and every script it spawns import only Bun and Node built-ins.

Rejected, as in attempt 1: deleting the `cp -R` tier (pre-leg macOS/Linux behaviour) and folding `smoke` into `required` (the leg names a separate blocking `smoke` job).

## Attempt 3

Cross-vendor (codex) lens: **ran** (4 findings). All four lenses fired, 8 findings in total; codex applied the fixes.

Fixes applied:

- dispatch `worktree.ts` `snapshot`: `git add --renormalize -A` after `add -A` in the temp index, so a CRLF checkout whose copied index stat cache is trusted still yields a patch that applies under `core.autocrlf=false`. Test: worktree.test.ts "CRLF checkouts with trusted index stats round-trip through create, land and unland".
- dispatch `worktree.ts` `seedIgnored`: `cpSync(…, { verbatimSymlinks: true })`, so a relative symlink is not rewritten to point into the source tree. Test: worktree.test.ts "cpSync seeds preserve relative symlinks (Windows symlink creation requires privilege)", skipped on win32 for that fact.
- guard `comment-core.ts` `baseName`: splits on `/[\\/]/`, so `C:\repo\Dockerfile`, `Gemfile` and `Makefile` resolve their syntax. Test: comment-core.test.ts "Windows paths detect ${name} syntax".
- dispatch `launch.ts` `openBrowser`: awaits each opener's exit code and falls back unless it is 0, matching `gate-page.ts`, so a failing `wslview` reaches `cmd.exe`. Test: launch.test.ts "awaits a nonzero wslview exit before trying cmd.exe and stops after success". Off WSL the single opener (`open` / `xdg-open`) is now awaited rather than detached; both return once the browser is handed the URL.
- dispatch `scaffold.test.ts`: local `samePath` deleted in favour of `samePathKey` from `worktree.ts` (reuse over leanness: one normaliser, no second Windows copy).
- guard `comment-sweep.ts` `collect`: skips `ledgerKey(abs)` when nothing was reported.

Rejected: efficiency, stop the `report` job rerunning the required suites: it needs a change inside `report:`, which this leg must leave untouched (verified byte-identical to f177c48).

Verification: `tsc --noEmit` clean; 2722 pass, 0 fail across the five suites; `smoke.ts` ok on all five flows; task-path test green; no cross-plugin import.

## Human checks

Pending: Windows PR CI run, the real-PC flows, the `/tmp/q-lab` probe, and the WSL opener. See the task's (human) criteria.

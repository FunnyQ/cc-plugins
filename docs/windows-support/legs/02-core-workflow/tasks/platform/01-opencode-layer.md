# PLATFORM-01: OpenCode layer on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: dispatch/02
> **Blocks**: platform/02
> **Status**: todo

## Goal

`opencode/plugin.ts` runs its shell hooks and path gates correctly on Windows, and `bun test opencode/` passes on macOS, Linux and Windows, with only the cockpit-shim cases skipped on win32.

## Files to create / modify

- `opencode/plugin.ts` (modify): spawn the two `.sh` hooks through `bash`, and make `COMMENT_GUARDED` separator-agnostic.
- `opencode/plugin.test.ts` (modify): add win32 skips for the cockpit-shim cases, a backslash-path guard test, a `bash`-spawn assertion, and env pairing.
- `opencode/install.test.ts` (modify, only if needed): pair the env vars if any test overrides `HOME` or `TMPDIR`.

## Implementation notes

### Module constraints (from CLAUDE.md; breaking one is a silent trap)

- `opencode/plugin.ts` is a single file. It imports nothing from anywhere else in this repo. It currently imports only `node:path`.
- It derives the repo root from `dirname(import.meta.dir)`.
- It never reads a harness environment variable (`CLAUDE_*`, `CODEX_*`, `PLUGIN_ROOT`, `OPENCODE_*`).
- Do not touch `FLIGHTPLAN_TASK` (line ~21). Its separators already accept `[\\/]`. It changed together with `packages/dispatch/hooks/task-path.ts` and `packages/dispatch/hooks/flightplan-lint.sh`, and `packages/dispatch/hooks/task-path.test.ts` holds all three copies equal. Editing this copy alone reds that test.

### 1. Spawn the shell hooks through `bash`

Windows cannot spawn an extensionless or `.sh` shebang file (`windows.md` → Processes); `Bun.spawn(["bash", script, …])` works where Git Bash is on PATH. The module spawns two shell scripts directly today:

- `[join(root, CHECK_BRANCH)]`, in the `tool.execute.before` bash hook (~line 342). `CHECK_BRANCH = "packages/chronicle/hooks/check-branch.sh"`.
- `[join(root, FLIGHTPLAN_LINT)]`, in `tool.execute.after` (~line 377). `FLIGHTPLAN_LINT = "packages/dispatch/hooks/flightplan-lint.sh"`.

Change both to `["bash", join(root, <SCRIPT>)]`, and keep the stdin payload unchanged. Use the same form on every OS, with no platform branch: both scripts start `#!/usr/bin/env bash` or `#!/bin/sh`, so `bash` runs them identically on macOS and Linux. Read each script's shebang first. If one is `#!/bin/sh` and uses a bash-only construct, report it rather than rewriting the script.

The comment guard already runs as `["bun", join(root, COMMENT_GUARD)]`, a `.ts` file, so it needs no change. The cockpit shim spawns (`[join(root, COCKPIT_SHIM), "hook", …]`, ~lines 283 and 300) stay unchanged. Their failure on Windows is class **(c)**: there is no Windows cockpit build, and the shim is a POSIX `sh` script.

On a Windows machine without `bash` on PATH, `Bun.spawn` throws. `run()` (~lines 148–170) already catches every spawn failure and returns `null`, and every caller treats that as "no verdict". The lint and the branch guard therefore stay a silent no-op there, which is today's behaviour. Add no handling for it. The branch guard's thrown `systemMessage` comes from a verdict, not from a spawn failure, so a missing `bash` never blocks a commit.

### 2. `COMMENT_GUARDED` separators

The current regex ends with:

```
|(^|\/)(rakefile|gemfile|…|justfile)(\.[^/]*)?)$/i
```

It encodes two separators: `(^|\/)` before an extensionless build-file name, and `[^/]` in its optional suffix. On Windows, `C:\repo\Rakefile` therefore fails the name branch. Make both separator-agnostic:

```
|(^|[\\/])(rakefile|…|justfile)(\.[^\\/]*)?)$/i
```

Change nothing else in the regex. The extension branch has no separator and stays as is.

`plugin.test.ts` has a `describe("COMMENT_GUARDED", …)` block (~line 396). Its two-direction cross-check (~line 429) enumerates `BY_EXT` and `BY_NAME` from guard's `comment-core.ts` and asserts `COMMENT_GUARDED.test(p) === (syntaxFor(p) !== null)`. That check must still pass unchanged. Never replace it with a hand-listed sample. Add one test asserting that `C:\\repo\\Rakefile` and `C:\\repo\\sub\\Dockerfile.dev` match, and that `C:\\repo\\notes.txt` does not.

### 3. `plugin.test.ts` on Windows

- **Cockpit-shim cases, class (c).** Skip every test in `describe("experimental.chat.system.transform", …)` (~lines 455–635) that needs the shim to answer, with `test.skipIf(process.platform === "win32")`. Name the fact in the title or in a one-line comment: no Windows cockpit build, and the shim is a POSIX sh script. These are `injects the decision-log guidance…`, `the created seed survives…`, `rides the title request…`, `materializes the seed once…`, `stops pushing after PUSH_CAP…`, `session.idle retires…`, and `runs the stop hook through the shim…`. Keep `no-ops without a session id or without pending guidance` unskipped if it passes without the shim.
- **The stub at ~line 39** is a `#!/bin/sh` file assigned to `process.env.COCKPIT_BIN`, and it serves only the skipped shim cases. Leave it, or create it only when `process.platform !== "win32"`. Never spawn it on win32 (`shared.md` rule 4).
- **`appends lint feedback to the result for a violating task file`** (~line 258). Its `filePath` is `join(tmpdir(), …, "docs", "x", "tasks", "runtime", "01-x.md")`, which is a backslash path on Windows. It must pass on win32 without a skip: `FLIGHTPLAN_TASK` already matches backslashes, and the lint now spawns through `bash`. Add one assertion that the lint spawn's argv starts with `"bash"`. The file already spies on `Bun.spawn` through `spawnWithBinary`, so read the recorded calls there.
- **Env pairing.** Pair env overrides in the opencode tests: a test that sets `HOME` also sets `USERPROFILE`, and a test that sets `TMPDIR` also sets `TEMP` and `TMP` (`shared.md` rule 2). `install.test.ts` passes a fictional `home = "/tmp/opencode-installer-home"` into pure functions and sets no env var, so it needs no change unless grep shows otherwise. `install.ts` reads `homedir()` (~line 666) only on the real `--apply` path, which no test runs.

### 4. Inventory coverage

`inventory.md` Part B section 8 lists 8 opencode failures. Seven are the shim cases, skipped above. The eighth is `plugin.test.ts:267`, which section 1 above fixes. Make the windows-latest result for `bun test opencode/` 0 failures. Its only skips are the class (c) shim cases.

## Acceptance criteria

- [ ] `opencode/plugin.ts` spawns `check-branch.sh` and `flightplan-lint.sh` as `["bash", join(root, …)]`. `grep -n '\[join(root, CHECK_BRANCH)\]\|\[join(root, FLIGHTPLAN_LINT)\]' opencode/plugin.ts` prints nothing.
- [ ] `COMMENT_GUARDED` accepts `\` and `/` before an extensionless build-file name. The new test for `C:\\repo\\Rakefile` passes, and the existing `BY_EXT`/`BY_NAME` cross-check passes unchanged.
- [ ] `FLIGHTPLAN_TASK` is byte-identical to its state before this task, and `packages/dispatch/hooks/task-path.test.ts` passes.
- [ ] Every `skipIf(process.platform === "win32")` added in `opencode/plugin.test.ts` names the missing Windows cockpit build. No skip covers the lint or comment-guard cases.
- [ ] The lint test asserts that the spawn argv begins with `"bash"`.
- [ ] `opencode/plugin.ts` still imports nothing from the repo and reads no harness env var.

## Verification

- [ ] `bun test opencode/` passes on macOS.
- [ ] `bun test packages/dispatch/hooks/task-path.test.ts` passes.
- [ ] `bunx --bun tsc --noEmit` prints nothing.
- [ ] `grep -n 'from "\.\./' opencode/plugin.ts` prints nothing.
- [ ] `grep -nE 'process\.env\.(CLAUDE|CODEX|PLUGIN_ROOT|OPENCODE)' opencode/plugin.ts` prints nothing.
- [ ] `git status --short -- opencode/plugin.ts opencode/plugin.test.ts` shows both paths modified.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                | 2–3 (below bar)                                                                                | 4–5 (pass)                                                                                                                                                             |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A `.sh` hook is still spawned directly, `FLIGHTPLAN_TASK` changed, or the module gained a repo import or harness env read | `bash` spawn lands for one script only, or `COMMENT_GUARDED` changes beyond the two separators | Both shell hooks spawn through `bash` on every OS; both separators in `COMMENT_GUARDED` accept `[\\/]`; macOS and Linux behaviour unchanged; module constraints intact |
| Test coverage           | ×2     | Lint or comment-guard cases skipped on win32 to get green                                                                 | Shim skips present but no backslash-path or `bash`-argv assertion                              | Shim cases skipped with the fact named; a backslash build-file test and a `bash`-argv assertion fail if reverted; cross-check untouched                                |
| Interface & readability | ×1     | A new platform branch or helper added for the spawn                                                                       | Spawn change duplicated awkwardly or comments narrate the edit                                 | Two one-line argv edits plus a two-character regex edit; no new abstraction                                                                                            |
| Assumptions & docs      | ×1     | Claims about Windows spawning not traceable to `windows.md`                                                               | Missing-`bash` behaviour unstated                                                              | Each skip cites the missing Windows cockpit build; the missing-`bash` no-op is stated and traced to `run()` swallowing spawn failures                                  |

## Out of scope

- A Windows cockpit binary, or a `.cmd`/`bash` wrapper for the cockpit shim. Deferred: cockpit on Windows belongs to a later leg of the roadmap.
- Changing `FLIGHTPLAN_TASK`. Reason: it is already `[\\/]`-aware and is held equal to dispatch's two copies by `task-path.test.ts`.
- Rewriting `check-branch.sh` or `flightplan-lint.sh`. Reason: those scripts belong to chronicle and dispatch; this task only changes how the OpenCode module spawns them.
- Wiring `opencode/` into CI's `required` job. Deferred to the CI task in this leg.

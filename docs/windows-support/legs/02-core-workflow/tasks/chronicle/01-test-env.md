# CHRONICLE-01: Honest chronicle tests on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: chronicle/02, chronicle/03
> **Status**: done

## Goal

chronicle's test suite stops assuming POSIX paths, shells and git defaults, so on Windows it fails only where chronicle's product code is wrong. The change touches tests only.

## Files to create / modify

- `packages/chronicle/skills/release/scripts/release.test.ts` (modify) — `basename` instead of `split("/")`; a git shim that runs on win32; PATH built with `path.delimiter`; autocrlf pinned in `initRepo`.
- `packages/chronicle/skills/commit/scripts/commit.test.ts` (modify) — skip the three NTFS-impossible file-name tests on win32; autocrlf pinned in `initRepo`.
- `packages/chronicle/hooks/check-branch.test.ts` (modify) — the no-jq half links `git.exe` / `cat.exe` on win32; autocrlf pinned in the repo helper.
- `packages/chronicle/skills/commit/scripts/analyze-changes.test.ts` (modify) — autocrlf pinned where it inits a repo.
- `packages/chronicle/skills/adr/scripts/archive-stale.test.ts` (modify) — autocrlf pinned where it inits a repo.
- `packages/chronicle/skills/pr/scripts/pr-config.test.ts` (modify) — autocrlf pinned where it inits a repo.
- `packages/chronicle/skills/install/scripts/codex-agents-sync.test.ts` (modify) — `basename` instead of `split("/")`.

Change no file outside `packages/chronicle/**/*.test.ts`.

## Implementation notes

Line numbers below are as of `554083d`; re-locate each by its quoted content if it moved.

### Profile and temp isolation (shared.md rule 2)

A grep at planning time found no `HOME` or `TMPDIR` override in any chronicle test (`setup-codex-agents.test.ts:28` sets `CODEX_HOME`, which is not a profile variable). Re-run the grep first:

```sh
grep -rnE '\bHOME\b|TMPDIR' packages/chronicle --include='*.test.ts'
```

For every hit that sets `HOME` (in `process.env` or a child's `env`), also set `USERPROFILE` to the same value. For every hit that sets `TMPDIR`, also set `TEMP` and `TMP`. When the grep finds none, record that in the task report and change nothing for this rule.

### git in temp repos (shared.md rule 7)

Every helper that runs `git init` under `tmpdir()` sets `core.autocrlf false` in that repo right after the init, the same way it already sets `user.email`. The sites:

- `commit.test.ts` `initRepo()` (`git init -q -b main`, ~line 14) — add ``await $`git config core.autocrlf false`.cwd(dir).quiet();``
- `release.test.ts` `initRepo()` (the helper behind `await commitAll(dir, "init")`, ~line 164).
- `check-branch.test.ts:17` (`Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo })`).
- `pr-config.test.ts:155` (same shape).
- `archive-stale.test.ts:65` (`spawnSync("git", ["init", "-q"], { cwd: root })`).
- `analyze-changes.test.ts` — find its `git init` call(s) and pin there.

Use each file's own spawn idiom (`$`, `Bun.spawnSync`, or `spawnSync`), not a new helper.

### release.test.ts — `asks git for the origin remote at most once` (~lines 197-224)

1. Replace both `dir.split("/").pop()` with `basename(dir)` (import `basename` from `node:path`). On Windows `split("/")` returns the whole path, which then got joined onto `dir/..` (inventory Part B, section 2).
2. The git shim is an extensionless `#!/bin/sh` file put on PATH with `:`. Neither works on Windows (windows.md, Processes). Keep the POSIX shim as it is on darwin/linux. On win32 write `git.cmd` instead, `\r\n` line endings:

   ```
   @echo %*>> "<log>"
   @"<realGit>" %*
   ```

   `realGit` comes from `Bun.which("git")` on win32 (the current `` $`which git` `` returns a POSIX path under Git Bash). Bun resolves the bare name `git` through `PATH` + `PATHEXT` to `git.cmd` (windows.md).

3. Build the PATH with `` `${shim}${delimiter}${path}` `` (`delimiter` from `node:path`).

If the release code passes an argument holding a cmd-special character (`"`, `%`, `&`, `^`, `|`, `<`, `>`, newline) to `git` during `planRelease`, Bun throws on the `.cmd` shim. In that case only, skip this test on win32 with `test.skipIf(process.platform === "win32")` and name that Bun fact in the title or a one-line comment, since the shim cannot carry such an argument (class c). Record which path you took in the report.

The `#!/bin/sh` `tool` artifacts in the `run` describe block (~line 232) passed on windows-latest in CI run 40754272926; leave them unchanged.

### commit.test.ts — names NTFS forbids (~lines 355, 371, 389)

Change these three tests to `test.skipIf(process.platform === "win32")(…)`, each with a one-line comment naming the fact: NTFS forbids `>` and control characters, newline included, in file names (windows.md, File names and paths). Class (c) in inventory Part B, section 7.

- `carries a filename containing git's rename separator` (`a -> b.txt`)
- `carries a filename containing a newline` (`two\nlines.txt`)
- `renames a file whose name holds the rename separator`

The two `.git/hooks/pre-commit` stubs (~lines 540, 558) stay: git for Windows runs hooks through its own `sh`.

### check-branch.test.ts — `fails open when jq is missing …` (~lines 113-133)

The test fills a PATH-only bin dir with symlinks named `git` and `cat`. Windows bash cannot run an extensionless link, so `input=$(cat)` fails with 127 under `set -e`. On win32 name the links `git.exe` and `cat.exe`, keeping `Bun.which(tool)` as the target; on other platforms keep the bare names:

```ts
const name = process.platform === "win32" ? `${tool}.exe` : tool;
symlinkSync(Bun.which(tool)!, join(bin, name));
```

The unparseable-payload half already passes; leave it.

### codex-agents-sync.test.ts (~line 44)

`readdirSync(…, { recursive: true })` returns backslash-separated relative paths on Windows, so `.split("/").at(-1)` returns the whole relative path and the set holds no bare script names. Use `basename(path)`. CI did not list this test as failing, so it may pass vacuously on Windows; the fix makes the set mean the same thing on every OS.

## Acceptance criteria

- [x] `grep -rnE 'split\("/"\)' packages/chronicle --include='*.test.ts'` prints nothing.
- [x] `grep -rnE '\$\{shim\}:' packages/chronicle --include='*.test.ts'` prints nothing; the release git-shim test builds PATH with `delimiter`.
- [x] Every `git init` in a chronicle test file is followed in the same helper by a `core.autocrlf false` config: `grep -rlE 'git.*init' packages/chronicle --include='*.test.ts'` and `grep -rlE 'autocrlf' packages/chronicle --include='*.test.ts'` list the same files.
- [x] The three NTFS file-name tests in `commit.test.ts` are `test.skipIf(process.platform === "win32")` and name the NTFS fact; no other chronicle test gains a `skipIf`, except the release git-shim test under the condition in Implementation notes.
- [x] `check-branch.test.ts`'s no-jq half names its links `git.exe` / `cat.exe` on win32.
- [x] Every `HOME` override the grep finds in chronicle tests sets `USERPROFILE` too, and every `TMPDIR` override sets `TEMP` and `TMP`; the task report states the grep result.
- [x] No product file changes: `git diff --name-only -- packages/chronicle` lists only `*.test.ts` paths.

## Verification

- [x] `bun test packages/chronicle` passes on macOS.
- [x] `bunx --bun tsc --noEmit` from the repo root prints nothing.
- [x] `git diff --name-only -- packages/chronicle | grep -v '\.test\.ts$'` prints nothing.
- [x] `grep -rnE 'split\("/"\)|\$\{shim\}:' packages/chronicle --include='*.test.ts'` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                     | 2–3 (below bar)                                                                                                                       | 4–5 (pass)                                                                                                                                                |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A product file changed, the macOS suite goes red, or a fixed test now asserts something different from what it asserted before | Most sites fixed, but a `git init` without autocrlf, a `/`-split or a `:`-joined PATH remains                                         | Every listed site fixed; each test asserts the same behaviour on every OS; the macOS suite is green                                                       |
| Test coverage           | ×2     | A failing (b) case is skipped instead of fixed                                                                                 | A skip lacks its named Windows fact, or a win32 branch (shim, `.exe` links) is written but never taken by the code path the test runs | Only the three (c) cases (plus the documented shim exception) skip, each naming its fact; every win32 branch is the one the test runs on Windows          |
| Interface & readability | ×1     | A new shared test helper or abstraction appears                                                                                | Platform branches are duplicated or hard to follow                                                                                    | Each change uses the file's own idiom, with one small inline platform branch where needed                                                                 |
| Assumptions & docs      | ×1     | A Windows claim with no source                                                                                                 | Comments restate code, or a skip comment cites no fact                                                                                | Every platform branch and skip traces to a fact in `windows.md` or `inventory.md`; the report records the HOME/TMPDIR grep result and the shim path taken |

## Out of scope

- Tests that pin the `/tmp/q-lab` literal (`temp-payload.test.ts`, `archive-plan.test.ts`, the commit message-file test) — Deferred. Reason: they change together with chronicle's win32 scratch root, which is a product change.
- `commit.test.ts`'s `refuses a plan file inside the repo`, `archive-stale.test.ts`'s `.cockpit/archive/` advice, and `stages.test.ts`'s `.chronicle/release.json` expectation — Deferred. Reason: each fails because product code is wrong on Windows (path identity, a gitignore pattern, a git path built with `join`), so the product fix and its test move together.
- `gate-page.ts` opening URLs with `start` — Deferred. Reason: a product bug, fixed with the URL-opener rule in `shared.md`.
- `setup-codex-agents.ts:90` falls back to `process.env.HOME`, which native Windows shells may not set — Deferred. Reason: a product change, fixed by the Codex-home fallback task in this bucket.

# DISPATCH-01: Honest dispatch tests on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: dispatch/02
> **Status**: done

## Goal

dispatch's test suite stops assuming POSIX homes, temp dirs, shells, line endings and path spellings, so its class (b) and (c) failures from `inventory.md` Part A go away on Windows, and no dispatch test touches the real user profile on any OS. Test files only.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/lib/relay-model.test.ts` (modify) — `USERPROFILE` beside `HOME`
- `packages/dispatch/skills/flightplan/scripts/codex-run.test.ts` (modify) — `USERPROFILE`, `.cmd` shim on win32, `TEMP`/`TMP` beside `TMPDIR`
- `packages/dispatch/skills/flightplan/scripts/opencode-run.test.ts` (modify) — `USERPROFILE`, `.cmd` shim on win32
- `packages/dispatch/skills/flightplan/scripts/review-plan.test.ts` (modify) — isolate the opencode-unreachable spawn's profile
- `packages/dispatch/skills/flightplan/scripts/worktree.test.ts` (modify) — autocrlf pin, path-identity compare, two win32 cases
- `packages/dispatch/skills/flightplan/scripts/scaffold.test.ts` (modify) — path-identity compare
- `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (modify) — `join` the `_context/shared.md` expectation
- `packages/dispatch/skills/autopilot/scripts/graph-source.test.ts` (modify) — `join` the run-log label
- `packages/dispatch/skills/autopilot/scripts/bake-orchestrator.test.ts` (modify) — `join` the expected script path
- `packages/dispatch/skills/autopilot/scripts/codex-usage.test.ts` (modify) — skip the chmod case on win32
- `packages/dispatch/skills/waypoints/scripts/waypoints.test.ts` (modify) — spawn path from `import.meta.dir`

No product (non-`*.test.ts`) file changes. Line numbers below are as of 554083d; re-locate by the quoted content if they moved.

## Implementation notes

### 1. Profile isolation (rule 2; inventory Part A §1)

The root cause of 26 Windows failures: `os.homedir()` reads `USERPROFILE` on Windows, so a `HOME`-only override let `relay-model.test.ts` write `{ not json` into the runner's real relay config, which then broke every codex-run, opencode-run and review-plan spawn.

- `lib/relay-model.test.ts` — the `run()` helper's `Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, HOME: home } })` and the `config set-model` spawn in `"reads the config relay's own \`config set-model\` writes"`: add `USERPROFILE: home`to both env objects (and any other spawn in the file that sets`HOME`).
- `codex-run.test.ts` — `isolateHomeFromDeveloperRelayConfig()` sets `process.env.HOME = dir`. Save and set `process.env.USERPROFILE = dir` the same way; restore both in `afterAll` (delete the key when the original was `undefined`, since assigning `undefined` to `process.env` stores the string `"undefined"`).
- `opencode-run.test.ts` — same in its `beforeAll` / `afterAll` (`originalHome = process.env.HOME; process.env.HOME = dir;`).
- `review-plan.test.ts` — the test `"an unreachable opencode warns and skips the gate with exit 0, like a missing codex"` spawns with `env: { ...process.env, OPENCODE_BIN: … }` and isolates nothing. Point `HOME` and `USERPROFILE` at the test's own temp `root`.

### 2. Fake CLI stubs (rule 4; inventory Part A §2)

`codex-run.test.ts` writes `codexBin = join(dir, "codex")` as `#!/bin/sh\nexec bun ${fakeCodex} "$@"\n`; `opencode-run.test.ts` does the same for `opencodeBin = join(dir, "opencode")`. Windows cannot spawn an extensionless shebang file. On win32 write `<dir>/codex.cmd` / `<dir>/opencode.cmd` instead, with this exact body, and point `codexBin` / `opencodeBin` at it:

```ts
const shim = (fake: string) => `@"${process.execPath}" "${fake}" %*\r\n`;
codexBin =
  process.platform === "win32" ? join(dir, "codex.cmd") : join(dir, "codex");
await writeFile(
  codexBin,
  process.platform === "win32"
    ? shim(fakeCodex)
    : `#!/bin/sh\nexec bun ${fakeCodex} "$@"\n`,
);
```

Keep the POSIX stub byte-for-byte on macOS and Linux. Bun spawns a `.cmd` by absolute path (`windows.md`, Processes). Do not change `codex-run.ts` / `opencode-run.ts`; any test whose argv to the fake holds a `.cmd`-special character is a product bug owned by a later task (see Out of scope).

`codex-run.test.ts`, test `"a failing run still removes its scratch dir, so run never calls process.exit"`, sets only `TMPDIR: tmp`. Windows `os.tmpdir()` reads `TEMP`/`TMP`, so on Windows the test asserts nothing. Add `TEMP: tmp, TMP: tmp` beside it.

### 3. Line endings in temp repos (rule 7; inventory Part A §3)

`worktree.test.ts` `fixture()` runs `git init -q` then three `git config` calls. Add, right after `init`:

```ts
git(repo, "config", "core.autocrlf", "false");
git(repo, "config", "core.eol", "lf");
```

This clears the 10 identical-text failures (`- Expected - 0 / + Received + 0`). The product-side `-c core.autocrlf=false` pin in `worktree.ts` is not this task.

### 4. Path identity in tests (rule 3; inventory Part A §4, test halves)

Add one test-local helper in each of the two files that need it (no shared test util; plugins and test files stay independent):

```ts
function samePath(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  const real = join(realpathSync.native(head), ...rest);
  return process.platform === "win32" ? real.toLowerCase() : real;
}
```

- `worktree.test.ts` sweep test (≈ line 497): `const remaining = git(options.repo, "worktree", "list", "--porcelain"); expect(remaining).toContain(second.path); expect(remaining).not.toContain(first.path);`. git prints `C:/Users/runneradmin/…`; `second.path` holds `C:\Users\RUNNER~1\…`. Parse the porcelain `worktree <path>` lines into a list, map each through `samePath`, and assert membership of `samePath(second.path)` / non-membership of `samePath(first.path)`. Keep the `split("worktree ").length - 1` count assertions as they are.
- `fixture()` uses `realpathSync(mkdtempSync(...))`, which keeps the 8.3 short name on Windows. Leave it: the comparison helper handles both spellings.
- `scaffold.test.ts` (≈ line 264): `expect(res.stdout.toString()).toContain(\`Scaffolded ${join(await realpath(root), "docs", "course-player")}\`)`. Extract the path after `Scaffolded `from stdout (trim the line) and assert`samePath(printed) === samePath(join(root, "docs", "course-player"))`.

### 5. POSIX literals in expectations (rule 3; inventory Part A §5, test-only rows)

- `lint-task.test.ts` (≈ line 1476): `expect(result.stdout).toContain("_context/shared.md")` → `toContain(join("_context", "shared.md"))`.
- `graph-source.test.ts` (≈ lines 482 and 538): `file: ".flightlog/run.jsonl"` in the expected error objects → `file: join(".flightlog", "run.jsonl")`. The product's label is `runLogPath("")` = `join("", ".flightlog", "run.jsonl")`; it is a display label, so the test follows the product. Leave the lines near 796/806 alone (they build shell command strings, not labels).
- `bake-orchestrator.test.ts` (≈ line 96): test `"bakedScriptPath lands in the plan's .flightlog"` expects the literal `"/r/docs/my-plan/.flightlog/orchestrator.js"`. Change that expectation to `.toBe(join("/r/docs/my-plan", ".flightlog", "orchestrator.js"))`.
- `waypoints.test.ts` (≈ line 18): `const SCRIPT_PATH = new URL("./waypoints.ts", import.meta.url).pathname;` → `join(import.meta.dir, "waypoints.ts")` (`.pathname` yields `/D:/a/…`, which `bun` cannot load; `windows.md`, File names and paths).

Import `join` / `resolve` / `dirname` / `basename` from `node:path` where a file does not already.

### 6. Cases that cannot work on Windows (rule 6; inventory Part A §6)

Each skip names its platform fact in the test title or a one-line comment.

- `codex-usage.test.ts`, test `"an unreadable pass keeps the last-known counts rather than zeroing them"`: it relies on `chmodSync(file, 0o000)` making the file unreadable, which Windows ignores. `test.skipIf(process.platform === "win32")`.
- `worktree.test.ts`, test `"binary, added, deleted and oddly named paths land and restore"`: `const oddName = "space and\nnewline.txt"`. NTFS forbids a newline in a file name. On win32 use `"space and name.txt"`; keep the newline name on POSIX. Do not skip the whole test — binary, added and deleted paths still run on Windows.
- `worktree.test.ts`, test `"ignored seeds fall back from clone copies and tolerate complete copy failure"`: replaces `cp` with a `#!/bin/sh` stub on a `:`-joined `PATH`. Neither the stub nor the separator works on Windows. `test.skipIf(process.platform === "win32")`, comment naming both facts. The product `fs.cpSync` fallback for a missing or failing `cp` gets its own new test with the product change, not here.

## Acceptance criteria

- [x] Every `HOME` override in the four profile-isolation files is paired with `USERPROFILE` to the same value: `grep -n "HOME" <file>` shows a `USERPROFILE` set beside each `HOME` set in `relay-model.test.ts`, `codex-run.test.ts`, `opencode-run.test.ts`, and the opencode-unreachable test in `review-plan.test.ts`.
- [x] `codex-run.test.ts`'s scratch-dir test sets `TEMP` and `TMP` beside `TMPDIR`.
- [x] `codex-run.test.ts` and `opencode-run.test.ts` write a `.cmd` shim of the form `@"<process.execPath>" "<fake>.ts" %*\r\n` on win32 and keep the `#!/bin/sh` stub elsewhere.
- [x] `worktree.test.ts` `fixture()` sets `core.autocrlf false` and `core.eol lf`.
- [x] `worktree.test.ts` and `scaffold.test.ts` compare paths through a `samePath` helper that tolerates a missing path, uses `realpathSync.native`, and lower-cases on win32.
- [x] No `new URL(...).pathname` remains as a spawn path: `grep -rn "\.pathname" packages/dispatch --include=*.test.ts` finds none used to spawn.
- [x] Exactly three new `skipIf(process.platform === "win32")`-class skips or win32 branches exist (chmod, newline file name, `cp` stub), each naming its fact.
- [x] `git diff --name-only -- packages/dispatch` lists only `*.test.ts` files, all from the Files list above.

## Verification

- [x] `bun test packages/dispatch` passes on macOS with no new skips firing there.
- [x] `bunx --bun tsc --noEmit` from the repo root prints nothing.
- [x] `git diff --name-only -- packages/dispatch | grep -v '\.test\.ts$'` prints nothing.
- [x] `grep -rn "USERPROFILE" packages/dispatch/skills/flightplan/scripts/lib/relay-model.test.ts packages/dispatch/skills/flightplan/scripts/codex-run.test.ts packages/dispatch/skills/flightplan/scripts/opencode-run.test.ts packages/dispatch/skills/flightplan/scripts/review-plan.test.ts` hits each of the four files.
- [x] `grep -n "core.autocrlf" packages/dispatch/skills/flightplan/scripts/worktree.test.ts` hits `fixture()`.

## Eval rubric

> Scale 0–5, shared dimensions in `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                             | 2–3 (below bar)                                                                                                  | 4–5 (pass)                                                                         |
| ----------------------- | ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Correctness             | ×3     | A product file changed, a test still writes the real profile, or the macOS suite fails | Most causes fixed, but a `HOME` override lacks `USERPROFILE` or a POSIX literal survives in a listed expectation | Every listed cause fixed as specified; macOS suite green; only `*.test.ts` touched |
| Test coverage           | ×2     | A failing case was deleted or skipped wholesale instead of fixed                       | A class (b) case is skipped on win32, or a whole test skipped where one branch would do                          | Skips only for the three class (c) facts; every (b) case runs on Windows           |
| Interface & readability | ×1     | Shared test utility across files, or platform branches scattered inline repeatedly     | Helper duplicated with drift between the two files                                                               | One small `samePath` per file, one `shim` expression per stub file                 |
| Assumptions & docs      | ×1     | A skip names no platform fact                                                          | Fact named vaguely ("Windows is different")                                                                      | Each skip and win32 branch names its fact from `windows.md` / `inventory.md`       |

## Out of scope

- `hooks/flightplan-lint.test.ts` (5 failures) and `lint-task.test.ts`'s `inferRefFromPath` case (≈ line 1100) — Deferred. Reason: both are product bugs (the task-path regex accepts only `/`; `inferRefFromPath` splits on `path.sep` only), fixed with dispatch's path-handling product change in this bucket.
- `worktree.ts` product fixes (`-c core.autocrlf=false`, `registeredPaths` identity, `cpSync` fallback, junction link) and the opencode prompt leaving argv — Deferred. Reason: product behaviour, fixed test-first in later tasks of this bucket; this task changes no product file.
- Any test that still fails after this task because the product passes a prompt in argv to the `.cmd` shim — Deferred. Reason: that is the class (a) spawn bug the product change fixes; leave the failure and note it in the report.

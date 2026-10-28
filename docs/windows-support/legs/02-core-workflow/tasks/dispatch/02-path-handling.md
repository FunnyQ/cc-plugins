# DISPATCH-02: Windows path handling in dispatch

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: dispatch/01
> **Blocks**: dispatch/03, platform/01
> **Status**: todo
> **Models**: dev=opus/high

## Goal

dispatch recognises Windows file paths: the edit-time task lint fires on backslash paths, `lint-task.ts` infers a task's bucket and number from either separator, and the worktree tool matches git's `C:/…` registrations against its own `C:\…` paths, even when a path does not exist on disk.

## Files to create / modify

- `packages/dispatch/hooks/task-path.ts` (modify) — `TASK_PATH` accepts `[\\/]` as every separator.
- `packages/dispatch/hooks/flightplan-lint.sh` (modify) — the same regex in the `=~` test.
- `opencode/plugin.ts` (modify) — the `FLIGHTPLAN_TASK` regex only; nothing else in this file.
- `packages/dispatch/hooks/task-path.test.ts` (modify) — backslash and mixed-separator samples; keep the three-copy equality tests passing.
- `packages/dispatch/hooks/flightplan-lint.test.ts` (modify) — a backslash `file_path` case.
- `packages/dispatch/skills/flightplan/scripts/lint-task.ts` (modify) — `inferRefFromPath` splits on both separators.
- `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (modify) — `inferRefFromPath` cases.
- `packages/dispatch/skills/flightplan/scripts/worktree.ts` (modify) — path-identity normaliser for registered worktrees; `remove()` prunes.
- `packages/dispatch/skills/flightplan/scripts/worktree.test.ts` (modify) — normaliser and stale-registration cases.

## Implementation notes

Work test-first: write each failing test, watch it fail on macOS, then change the code.

### 1. Task-path regex, three copies

Today all three copies hold:

```ts
// packages/dispatch/hooks/task-path.ts
export const TASK_PATH =
  /(^|\/)docs\/.+\/tasks\/[a-z][a-z0-9]*\/[0-9]{2}-.+\.md$/;
```

```bash
# packages/dispatch/hooks/flightplan-lint.sh, line ~24
if ! [[ "$file_path" =~ (^|/)docs/.+/tasks/[a-z][a-z0-9]*/[0-9]{2}-.+\.md$ ]]; then
```

```ts
// opencode/plugin.ts, line ~21
const FLIGHTPLAN_TASK =
  /(^|\/)docs\/.+\/tasks\/[a-z][a-z0-9]*\/[0-9]{2}-.+\.md$/; // packages/dispatch/hooks/task-path.ts
```

Replace every `/` separator with a class that also accepts `\`, in all three copies at once. The Claude Code mod (`packages/dispatch/hooks/register.ts`) uses `TASK_PATH` as its `file_path` matcher, so it picks the fix up with no edit.

`packages/dispatch/hooks/task-path.test.ts` holds the copies equal by source text:

```ts
const unescape = (re: RegExp) => re.source.replaceAll("\\/", "/");
// sh:      pattern from /=~ (\S+) \]\]/  must equal unescape(TASK_PATH)
// opencode: QLabPlugin.FLIGHTPLAN_TASK.source must equal TASK_PATH.source
```

A `[\\/]` class in the JS source contains the text `\/`, which `unescape` rewrites. Choose the spelling for each copy, and adjust `unescape` only as far as needed, so that:

- the two equality tests still compare the full pattern text (do not weaken them to a substring check);
- bash's `=~` (bash 3.2 on macOS, and Git Bash on Windows) matches a literal backslash with the sh copy. Prove it with a test, not by reading: the bracket-expression quoting rules in bash differ from JS.

The `bucket` segment stays one kebab token (`[a-z][a-z0-9]*`); the existing test "path filter rejects a bucket with dashes" must still pass.

Add to `task-path.test.ts` samples that `TASK_PATH` must match: `C:\repo\docs\x\tasks\ui\01-a.md`, `docs\x\tasks\ui\01-a.md`, and mixed `C:\repo/docs/x\tasks/ui\01-a.md`. Add one that must not match: `C:\repo\docs\x\tasks\ui-kit\01-a.md`.

In `flightplan-lint.test.ts`, add a case that writes a valid task file and sends a payload whose `file_path` spells the same file with backslash separators for the `docs\…\tasks\…\NN-…md` part. On macOS a backslash is a valid file-name character, not a separator, so the hook's `[ -f "$file_path" ]` precheck fails there. Pick a construction that makes the regex the thing under test on macOS: for example, assert the regex matches the payload path through the `=~` line by extracting the pattern from the script and running `bash -c '[[ "$1" =~ <pattern> ]]' _ <path>`, or create a real file whose name contains the backslashes. Choose one and say which in a one-line test title.

### 2. `inferRefFromPath`

```ts
// packages/dispatch/skills/flightplan/scripts/lint-task.ts:546
export function inferRefFromPath(
  filePath: string,
): { bucket: string; nn: string } | null {
  const parts = filePath.split(sep);
  ...
}
```

Change the split to `filePath.split(/[\\/]/)`. Drop the `sep` import if nothing else uses it. Test in `lint-task.test.ts` (it already imports `inferRefFromPath`):

| Input                             | Output                       |
| --------------------------------- | ---------------------------- |
| `docs/x/tasks/ui` + `/` + `01-a.md` (all `/`) | `{ bucket: "ui", nn: "01" }` |
| `docs\x\tasks\ui\01-a.md`         | `{ bucket: "ui", nn: "01" }` |
| `C:\repo\docs/x\tasks\ui` + `/` + `01-a.md` (mixed) | `{ bucket: "ui", nn: "01" }` |
| `docs/x/tasks/01-a.md`            | `null`                       |

### 3. Worktree path identity

Current code in `packages/dispatch/skills/flightplan/scripts/worktree.ts`:

```ts
function pathOf(options: RefOptions): string {
  validateRef(options.ref);
  return join(rootOf(options), dirNameOf(options.ref));
}

function registeredPaths(repo: string): Set<string> {
  return new Set(
    git(repo, ["worktree", "list", "--porcelain", "-z"])
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length)),
  );
}

function removePath(
  repo: string,
  path: string,
  registered: Set<string>,
): boolean {
  if (registered.has(path)) {
    git(repo, ["worktree", "remove", "--force", path]);
    return true;
  }
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  return false;
}
```

`registered.has(path)` is used in `create` (~line 359), `remove()` (~line 517) and `sweep` (~lines 552–563). On Windows git prints `C:/Users/runneradmin/…` while `pathOf` returns `C:\Users\RUNNER~1\…`, so the lookup never matches, `removePath` falls back to `rmSync`, and `remove()` leaves the registration behind because it never prunes.

Add one module-local normaliser, exported for tests, implementing `shared.md` rule 3:

```ts
export function samePathKey(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string;
```

- `resolve(p)`.
- Walk up to the nearest existing ancestor, `realpathSync.native` it, and re-join the remaining segments. A path that does not exist (a worktree before its first `create`, or one deleted by hand while still registered) never throws.
- On `win32`, lower-case the result. Leave case alone elsewhere.

Store `registeredPaths` as a `Map<key, gitSpelling>` (or equivalent) keyed by `samePathKey`, look up `samePathKey(pathOf(...))` in all three call sites, and pass git its own spelling (or `path`) to `worktree remove`. Make `remove()` run `git worktree prune` after removing, as `create` and `sweep` already do, so a worktree deleted by hand stops being registered.

On macOS `resolve` cannot turn `C:/…` into a Windows path, so test the win32 branch's string handling with the platform parameter: `samePathKey` must give equal keys on `win32` for two spellings that differ only in letter case of an existing directory. Cover the separator half (`/` vs `\`) in a test that runs only where it is meaningful, or by structuring the helper so the separator-normalising step is a pure function the macOS test can drive with `path.win32`. State the chosen approach in the test title.

Tests to add in `worktree.test.ts` (each test repo already sets `core.autocrlf false` in `fixture()`; keep it):

1. A registered worktree whose directory was deleted by hand: `remove()` reports `removed: true`, and afterwards `git worktree list --porcelain` no longer lists it.
2. First `create` for a ref whose target directory does not exist yet: no ENOENT from the normaliser.
3. `samePathKey` on a path whose last two segments do not exist returns the realpath of the existing ancestor plus those segments.
4. `samePathKey(x, "win32")` lower-cases; `samePathKey(x, "darwin")` keeps case.

## Acceptance criteria

- [ ] `TASK_PATH`, the `flightplan-lint.sh` pattern and `FLIGHTPLAN_TASK` all match `C:\repo\docs\x\tasks\ui\01-a.md` and still reject a dashed bucket; `task-path.test.ts`'s two copy-equality tests compare the full pattern text and pass.
- [ ] A test proves bash's `=~` with the sh pattern matches a backslash-separated task path.
- [ ] `inferRefFromPath` returns the table's outputs for all four inputs.
- [ ] `samePathKey` never throws for a missing path, re-joins missing segments onto the realpath of the nearest existing ancestor, and lower-cases only on `win32`.
- [ ] `remove()` on a hand-deleted registered worktree leaves no registration in `git worktree list --porcelain`.
- [ ] Every new test fails on the code before this task's change and passes after it.
- [ ] No edit to `opencode/plugin.ts` outside the `FLIGHTPLAN_TASK` lines.

## Verification

- [ ] `bun test packages/dispatch` passes.
- [ ] `bun test packages/dispatch/hooks/task-path.test.ts opencode/` passes.
- [ ] `bunx --bun tsc --noEmit` prints nothing.
- [ ] `git diff --stat -- opencode/plugin.ts` shows at most the `FLIGHTPLAN_TASK` regex lines changed.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                    | 2–3 (below bar)                                                                        | 4–5 (pass)                                                                                                                                    |
| ----------------------- | ------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A copy of the regex left `/`-only, or `samePathKey` throws ENOENT             | Regex fixed but bash quoting unproven, or `remove()` still leaves a stale registration | All three regexes match `\` and stay equal; normaliser handles missing paths and win32 case; stale registrations pruned                       |
| Test coverage           | ×2     | No new tests                                                                  | Only POSIX-path tests; win32 branch untested                                           | Backslash, mixed and dashed-bucket samples; bash `=~` proof; missing-path and hand-deleted worktree cases; win32 branch via injected platform |
| Interface & readability | ×1     | Normaliser copied per call site, or a cross-plugin import                     | One helper but unclear name or hidden platform read                                    | One exported `samePathKey(p, platform)` used at every lookup; regex change is the minimum                                                     |
| Assumptions & docs      | ×1     | Claims about git's porcelain spelling or bash brackets with no test or source | Assumptions stated but untested                                                        | Each Windows assumption traced to `windows.md` or proved by a test                                                                            |

## Out of scope

- The rest of `opencode/plugin.ts` (spawning `flightplan-lint.sh` through `bash`, cockpit skips) — Deferred. Reason: the opencode-layer task owns that file's spawn and test changes.
- `core.autocrlf` pinning, `cp` fallback and the junction plan link in `worktree.ts` — Deferred. Reason: the spawn-and-worktree task owns them.
- Test-environment fixes (`HOME`/`USERPROFILE`, `.cmd` stubs) — already done before this task; do not redo them.

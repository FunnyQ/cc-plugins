# GUARD-02: Fix guard's Windows product bugs

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: guard/01
> **Blocks**: platform/02
> **Status**: todo

## Goal

guard's comment sweep, comments-reaper scan, and edit-time ledger work for Windows users: scratch files land on an absolute path under the user's temp dir, an Edit-reported comment is never asked twice because two spellings of one path differ, and `docs\`, `vendor\` and `node_modules\` files are skipped like their `/` forms. macOS and Linux behaviour stays byte-for-byte the same.

## Files to create / modify

- `packages/guard/hooks/ledger.ts` (modify) — `DEFAULT_STATE_DIR` becomes platform-aware; stays Node-free.
- `packages/guard/hooks/sweep-state.ts` (modify) — pass the platform and tmpdir into the state-dir choice; normalise the ledger's file key on write and read; export the key function.
- `packages/guard/hooks/comment-sweep.ts` (modify) — look the ledger up with the same key function (`reported.get(abs)` near line 222).
- `packages/guard/hooks/comment-core.ts` (modify) — `isGuardedPath` splits on both separators.
- `packages/guard/skills/comments-reaper/scripts/scan.ts` (modify) — the scan root (line ~194) becomes platform-aware.
- Tests beside each: `packages/guard/hooks/ledger.test.ts` (new if absent), `sweep-state.test.ts` (new if absent), `comment-core.test.ts`, `comment-sweep.test.ts`, `packages/guard/skills/comments-reaper/scripts/scan.test.ts` (modify).

## Implementation notes

Write each test first and watch it fail on macOS before changing product code (TDD). Every win32 branch is proven by injecting the platform, never by skipping.

### 1. Scratch roots (shared.md rule 1)

Two hardcoded roots, both `/tmp/...` today. On Windows `\tmp\x` is drive-relative, so two processes with cwd on different drives use different directories (`windows.md`, "File names and paths").

- `packages/guard/hooks/ledger.ts:7` — `export const DEFAULT_STATE_DIR = "/tmp/q-lab/guard";`
- `packages/guard/skills/comments-reaper/scripts/scan.ts:194` — `const base = "/tmp/q-lab/guard/comments-reaper";`

**ledger.ts must stay Node-free.** Its header says why: the Claude Code mod writes the ledger through `$.fs` while the bun hooks use `node:fs`, and a mod has no Node built-ins. So it cannot import `node:os` or `node:path`. Replace the constant with a pure function that takes what it needs:

```ts
export const defaultStateDir = (platform: string, tmp: string): string =>
  platform === "win32" ? `${tmp}\\q-lab\\guard` : "/tmp/q-lab/guard";
```

(Exact string-joining is the executor's call; the win32 value must equal `join(tmp, "q-lab", "guard")` as `node:path` computes it on Windows, and the non-win32 value must be the literal `/tmp/q-lab/guard`.) Delete `DEFAULT_STATE_DIR` once nothing imports it — `grep -rn DEFAULT_STATE_DIR packages/guard` is its only caller list today (`sweep-state.ts:19`).

`sweep-state.ts` `dir()` becomes:

```ts
function dir(platform = process.platform): string {
  const path = process.env.GUARD_STATE_DIR ?? defaultStateDir(platform, tmpdir());
  ...
}
```

`GUARD_STATE_DIR` keeps priority, unchanged.

`scan.ts` gets a small module-local function with the platform injectable (default `process.platform`), returning `join(tmpdir(), "q-lab", "guard", "comments-reaper")` on win32 and the literal `"/tmp/q-lab/guard/comments-reaper"` elsewhere. Export it so the test can call it with both platforms.

Fix the scan tests that pin the POSIX shape:

- `scan.test.ts:98` — the regex `/^report (\S+)\/report-(\d)\.txt verdicts \1\/verdicts-\2\.txt$/` accepts only `/`. Accept `[\\/]`.
- `scan.test.ts:162` — `/^shards 1 in \/\S+\/scan-\w+$/` assumes a leading `/`. Assert instead that the printed path starts with the exported scan root and its last segment matches `scan-\w+` (`basename`).
- `scan.test.ts:164` — `` `deck ${home}/q-lab/flightdeck/...` `` builds a POSIX string; build it with `join(home, "q-lab", "flightdeck", "comments-reaper-scan-")`.

### 2. Ledger key identity (shared.md rule 3, inventory Part B §3)

`comment-guard.ts:53` records `recordReported(session, filePath, asked)` with the harness's raw `file_path`. `comment-sweep.ts` reads the ledger (`readReported`, ~line 164) and looks a file up by `join(root, file)` (~line 213, used at ~line 222 as `reported.get(abs)`), where `root` comes from `git rev-parse --show-toplevel`. On Windows git prints the long form (`C:/Users/runneradmin/...`) while the harness or `tmpdir()` can hand the 8.3 short form (`C:\Users\RUNNER~1\...`) or a different drive-letter case, so the two keys never match and an Edit-reported comment is asked again.

Add, in `sweep-state.ts` (module-local, no cross-plugin import):

```ts
export function ledgerKey(
  p: string,
  platform: string = process.platform,
): string;
```

It implements shared.md rule 3 exactly: `resolve(p)`; then `realpathSync.native` on the nearest existing ancestor, with the remaining segments re-joined (a file deleted since it was recorded must not throw); then lower-case the whole string on win32 only. On macOS and Linux the result for an existing path equals `realpathSync.native(resolve(p))`.

- `recordReported` stores `ledgerKey(file)`.
- `readReported` keys its map by `ledgerKey(file)` of each stored line, so ledgers written before this change still match.
- `comment-sweep.ts` looks up `reported.get(ledgerKey(abs))`.

Tests:

- `ledgerKey` with `platform: "win32"` lower-cases; with `"darwin"` it does not.
- A symlinked or `..`-containing spelling of a real file and its canonical path give the same key.
- A path whose last two segments do not exist returns the resolved ancestor plus those segments, and does not throw.
- `comment-sweep.test.ts:122` and `:133` (record under one spelling, sweep under git's) keep passing on macOS, and a new case records under a spelling that differs only by a symlinked temp dir (`tmpdir()` on macOS is `/var/...` → `/private/var/...`) and is still excused.

### 3. `isGuardedPath` on backslash paths (inventory "Found after the inventory")

`packages/guard/hooks/comment-core.ts:203`: `filePath.split("/").some((part) => SKIP_SEGMENTS.has(part))`. On Windows `docs\gen.py` is one segment, so docs, vendor and node_modules files get guarded. Change the split to `/[\\/]/`. `comment-core.ts` is Node-free; keep it so (a regex needs no import).

Tests in `comment-core.test.ts`: `isGuardedPath("docs\\gen.py")`, `isGuardedPath("C:\\repo\\vendor\\x.js")`, `isGuardedPath("a\\node_modules\\y.ts")` are `false`; `isGuardedPath("mydocs\\gen.py")` stays `true` (segment, not substring).

`opencode/plugin.ts` keeps no copy of this policy (the hook re-checks it on every run); do not touch it.

## Acceptance criteria

- [ ] Each new test fails against the code before the change and passes after it.
- [ ] `defaultStateDir("darwin", anything)` and `defaultStateDir("linux", anything)` return exactly `/tmp/q-lab/guard`; the win32 value is under the given tmp dir. The scan root returns exactly `/tmp/q-lab/guard/comments-reaper` off win32.
- [ ] `packages/guard/hooks/ledger.ts` and `packages/guard/hooks/comment-core.ts` import nothing from `node:*`.
- [ ] `GUARD_STATE_DIR` still overrides the state dir.
- [ ] `ledgerKey` never throws for a missing path, lower-cases only on win32, and the sweep looks up with it.
- [ ] `isGuardedPath` skips `docs`, `vendor` and `node_modules` segments separated by `\` and keeps the segment rule (`mydocs\` stays guarded).
- [ ] No test pins a POSIX literal or `/`-only regex for a guard scratch path, except the darwin/linux assertions on the two root functions themselves (`/tmp/q-lab/guard` and `/tmp/q-lab/guard/comments-reaper`), which must stay exact, and `reap.workflow.test.ts`'s opaque `/tmp/q-lab/...` strings, which a pure function passes through untouched.

## Verification

- [ ] `bun test packages/guard` passes on macOS.
- [ ] `bunx --bun tsc --noEmit` from the repo root prints nothing.
- [ ] `rg -n '^\s*import\b.*["'"'"']node:|require\(["'"'"']node:' packages/guard/hooks/ledger.ts packages/guard/hooks/comment-core.ts` prints nothing (comments that mention `node:fs` do not count).
- [ ] `grep -rn "DEFAULT_STATE_DIR" packages/guard` prints nothing.
- [ ] `git diff --stat -- packages/guard` lists only the files named above.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                           | 2–3 (below bar)                                                                                         | 4–5 (pass)                                                                                                                             |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A macOS/Linux root changes, `ledger.ts` or `comment-core.ts` gains a Node import, or the sweep still misses a short-vs-long spelling | Roots and split fixed, but `ledgerKey` throws on a missing path or the sweep looks up with the raw path | All three fixes match rules 1 and 3; non-win32 output byte-for-byte unchanged; old ledger lines still match                            |
| Test coverage           | ×2     | No new tests, or win32 covered only by `skipIf`                                                                                      | Happy path only; no missing-path or win32 lower-case case                                               | Injected-platform tests for both roots, `ledgerKey` (win32, darwin, missing path, alias spelling), and backslash `isGuardedPath` cases |
| Interface & readability | ×1     | A shared helper module or a new option nobody sets                                                                                   | Works, but platform plumbing leaks into callers that do not need it                                     | One small function per concern, platform injected with the real default, `DEFAULT_STATE_DIR` removed once unused                       |
| Assumptions & docs      | ×1     | Windows behaviour assumed without a `windows.md` fact or test                                                                        | Assumptions correct but unstated                                                                        | Each win32 branch traces to a `windows.md` fact (drive-relative `\tmp`, 8.3 names, case-insensitivity) or a test                       |

## Out of scope

- `opencode/plugin.ts` `COMMENT_GUARDED` — Deferred. Reason: it is a pure extension table, owned by the OpenCode layer task, and holds no path-segment policy.
- Test-environment fixes (`HOME`/`USERPROFILE` isolation, `import.meta.url` `.pathname` spawn paths, `/tmp/cg-main-…` literals) — Deferred. Reason: they belong to guard's test-only task, which this task depends on.
- Agent prompts that name `/tmp/q-lab/...` — Deferred. Reason: where Claude Code's Write tool resolves that path on Windows is still unanswered.

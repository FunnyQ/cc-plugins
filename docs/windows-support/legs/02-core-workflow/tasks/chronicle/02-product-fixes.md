# CHRONICLE-02: Fix chronicle's Windows product bugs

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: chronicle/01
> **Blocks**: platform/02
> **Status**: done

## Goal

chronicle's scratch files, commit plan guard, archive ignore advice, release staging and ADR gate-page opener all work on native Windows and WSL, while macOS and Linux behave byte for byte as before.

## Files to create / modify

- `packages/chronicle/shared/scripts/temp-payload.ts` (modify) — platform-aware scratch root.
- `packages/chronicle/shared/scripts/temp-payload.test.ts` (modify) — assert both platform values.
- `packages/chronicle/skills/adr/scripts/archive-plan.test.ts` (modify) — stop pinning the `/tmp/q-lab/chronicle` literal.
- `packages/chronicle/skills/commit/scripts/commit.ts` (modify) — `insideRepo` uses the path-identity normaliser.
- `packages/chronicle/skills/commit/scripts/commit.test.ts` (modify) — normaliser tests.
- `packages/chronicle/skills/adr/scripts/archive-stale.ts` (modify) — POSIX `.gitignore` pattern.
- `packages/chronicle/skills/release/scripts/analyze-release.ts` (modify) — export `CONFIG_REL`.
- `packages/chronicle/skills/release/scripts/stages.ts` (modify) — stage `CONFIG_REL` directly.
- `packages/chronicle/skills/adr/scripts/gate-page.ts` (modify) — platform-aware URL opener.
- `packages/chronicle/skills/adr/scripts/gate-page.test.ts` (modify) — opener argv tests.

Add test cases to the existing `*.test.ts` beside each changed file (`archive-stale.test.ts`, `stages.test.ts`) when the cases above do not already cover them; those two files may also change.

## Implementation notes

Write each fix test-first: the new test fails on the current code, then passes. Cover the win32 and WSL branches on macOS by injecting the platform (and env), never by skipping.

### 1. Scratch root (`temp-payload.ts`)

Current code, line 4:

```ts
export const TEMP_ROOT = join("/tmp", "q-lab", "chronicle");
```

`\tmp\q-lab\chronicle` is drive-relative on Windows (`windows.md`), so a CLI child on `C:` and a caller on `D:` disagree on where the file is. Replace with:

```ts
export function tempRoot(platform: NodeJS.Platform = process.platform): string;
// win32  → join(tmpdir(), "q-lab", "chronicle")
// other  → "/tmp/q-lab/chronicle"   (the exact existing string)
export const TEMP_ROOT = tempRoot();
```

Keep `TEMP_ROOT` exported: `commit.ts`, `adr/scripts/triage.ts` and `adr/scripts/gate-page.ts` import it, and `writeTempPayload` joins under it. Those callers need no change.

Tests:

- `temp-payload.test.ts:14` pins `expect(TEMP_ROOT).toBe("/tmp/q-lab/chronicle")`. Replace with `tempRoot("darwin")` and `tempRoot("linux")` equal to `"/tmp/q-lab/chronicle"`, and `tempRoot("win32")` equal to `join(tmpdir(), "q-lab", "chronicle")`. Keep the `writeTempPayload` test asserting the written path starts with `TEMP_ROOT`.
- `archive-plan.test.ts:324` and `:348` assert `startsWith("/tmp/q-lab/chronicle/adr/")`. Assert `startsWith(join(TEMP_ROOT, "adr") + sep)` instead (import `TEMP_ROOT` from `../../../shared/scripts/temp-payload`).
- `pr/scripts/analyze-branch.test.ts:19-26` uses `/tmp/q-lab/chronicle/pr/...` only as an opaque string fed to `textPathFor`; leave it.

### 2. Plan-file guard (`commit.ts`)

Current `insideRepo` (around lines 86-95) resolves both sides with `realpathSync` and compares by `startsWith`. On Windows `realpathSync` keeps the 8.3 short name (`RUNNER~1`) while `main` chdir'd to git's long-form top level, and case differs between sources, so an in-repo plan file passes the guard (`commit.test.ts` "refuses a plan file inside the repo" fails on windows-latest).

Add a module-local normaliser per `shared.md` rule 3:

```ts
function canonicalPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string;
// 1. resolve(path)
// 2. walk up to the nearest existing ancestor, realpathSync.native it,
//    re-join the remaining segments
// 3. lower-case the result when platform === "win32"
```

`insideRepo` compares `canonicalPath(process.cwd())` with `canonicalPath(dirname(absolute))` (equal, or `startsWith(root + sep)`). Export `canonicalPath` (or a pure `isInside(root, holder, platform)`) only as far as the test needs.

Tests in `commit.test.ts`:

- A path whose last two segments do not exist returns the real parent with those segments appended, without throwing.
- With `platform = "win32"`, `canonicalPath` lower-cases; with `"darwin"` it does not.
- The existing "refuses a plan file inside the repo" case still passes on macOS.

### 3. Archive ignore advice (`archive-stale.ts`)

Line 147:

```ts
const ARCHIVE_IGNORE_PATTERN = `${dirname(bucketDirectory("", "done"))}/`;
```

`bucketDirectory` uses `join`, so on Windows the advice reads `.cockpit\archive/`, and a `\` in `.gitignore` is an escape, not a separator. Build it POSIX: `` `${path.posix.dirname(...)}` `` over a POSIX-joined path, or the literal `".cockpit/archive/"`. Test: the printed advice (or the exported pattern) equals `.cockpit/archive/`.

### 4. Release staging (`stages.ts`)

Line 201: `if (opts.persistConfig) add(configPath(""));` where `configPath(repoRoot) = join(repoRoot, CONFIG_REL)` in `analyze-release.ts:509` and `CONFIG_REL = ".chronicle/release.json"` (line 507, not exported). On Windows that yields `.chronicle\release.json`. Export `CONFIG_REL` and `add(CONFIG_REL)`: the list feeds `git add` and a display line, and git paths are POSIX. Test: `touchedFiles` with `persistConfig: true` contains `".chronicle/release.json"` exactly (the existing `stages.test.ts:263` case covers it).

### 5. Gate-page opener (`gate-page.ts`)

Current code (around lines 945-953) spawns `start` on win32. `start` is a cmd builtin, not an executable, so the spawn fails and `--open` exits 3 on every Windows run (`windows.md`). Linux on WSL uses `xdg-open`, which is often absent there.

Add a pure argv builder per `shared.md` rule 5:

```ts
export function openerCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  procVersion: () => string = () => readFileSync("/proc/version", "utf8"),
): string[][];
// darwin       → [["open", url]]
// win32        → [["cmd", "/c", "start", "", url]]
// linux on WSL → [["wslview", url], ["cmd.exe", "/c", "start", "", url]]
// other linux  → [["xdg-open", url]]
// WSL = env.WSL_DISTRO_NAME set, or procVersion() matching /microsoft/i
// (a procVersion that throws means not WSL)
```

The `--open` branch tries each argv in order and stops at the first whose spawn succeeds and exits 0. A spawn that throws (binary not found) counts as failure and moves to the next. When all fail, keep the current behaviour: stop the gate server, print `gate-page: could not open a browser with "<first argv[0]>" — open <url> by hand`, exit 3.

Tests in `gate-page.test.ts`: one per branch (darwin, win32, WSL via `WSL_DISTRO_NAME`, WSL via a `procVersion` returning `...Microsoft...`, plain linux, a throwing `procVersion` falling to `xdg-open`). The empty-string window-title argument must be present on both `start` forms.

## Acceptance criteria

- [x] `tempRoot("darwin")` and `tempRoot("linux")` return `"/tmp/q-lab/chronicle"`; `tempRoot("win32")` returns `join(tmpdir(), "q-lab", "chronicle")`; a test asserts all three.
- [x] No chronicle test contains the string `/tmp/q-lab/chronicle` except `pr/scripts/analyze-branch.test.ts` and the darwin/linux assertions on `tempRoot` in `shared/scripts/temp-payload.test.ts`.
- [x] `commit.ts`'s guard compares paths through a normaliser that never throws on a missing path and lower-cases on win32; tests cover both.
- [x] The archive ignore advice is `.cockpit/archive/` on every platform.
- [x] `touchedFiles` adds `.chronicle/release.json` with a forward slash.
- [x] `openerCommands` returns the argv lists above for darwin, win32, WSL (env and `/proc/version`) and plain linux, each asserted by a test; `--open` falls back from `wslview` to `cmd.exe`.
- [x] Each fix's new test fails against the code at the start of the task (state which in the report).

## Verification

- [x] `bun test packages/chronicle` passes.
- [x] `bunx --bun tsc --noEmit` prints nothing.
- [x] `rg -n '/tmp/q-lab/chronicle' packages/chronicle --glob '*.test.ts' --glob '!**/analyze-branch.test.ts'` lists only `temp-payload.test.ts` lines, and each asserts a darwin or linux `tempRoot` value.
- [x] `rg -n '"start"' packages/chronicle/skills/adr/scripts/gate-page.ts` shows `start` only inside a `cmd` argv.
- [x] `git diff --stat -- packages/chronicle` touches only the files listed above.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                         | 2–3 (below bar)                                                                              | 4–5 (pass)                                                                                |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Correctness             | ×3     | macOS/Linux scratch root or opener changed, or a win32 branch still builds a drive-relative path or spawns `start` | fixes land but the normaliser throws on a missing path, or WSL never falls back to `cmd.exe` | all five fixes match the spec on darwin, linux, WSL and win32; macOS output unchanged     |
| Test coverage           | ×2     | win32 branches untested or skipped                                                                                 | happy-path platform only                                                                     | every platform branch injected and asserted; each test fails before its fix               |
| Interface & readability | ×1     | platform logic copied into callers, or a shared cross-plugin helper                                                | works but platform is read from globals inside the function body                             | small pure functions with platform/env defaults, callers unchanged                        |
| Assumptions & docs      | ×1     | Windows facts assumed without source                                                                               | facts right but uncited                                                                      | each Windows-only branch traces to a `windows.md` fact, cited in at most one comment line |

## Out of scope

- Agent prompts that tell lawspeaker, annalist or other agents to write under `/tmp/q-lab/...` — Deferred. Reason: where Claude Code's Write tool puts that path on native Windows is unknown until a human check on a Windows PC.
- The cockpit decision-trail reader (`cockpit-trail.ts`) and anything that needs the POSIX cockpit shim — Deferred. Reason: cockpit has no Windows build in this leg.
- Test-only fixes (`USERPROFILE` isolation, `basename`, `skipIf` for NTFS-forbidden names, `check-branch.test.ts` links) — handled by the test-env task this one depends on.

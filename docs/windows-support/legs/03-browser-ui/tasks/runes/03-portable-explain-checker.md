# RUNES-03: Port the explain checker off macOS.

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/runes.md`
>
> **Depends on**: runes/02
> **Blocks**: platform/01
> **Status**: done
> **Models**: dev=opus/high

## Goal

Run explain's geometry and screenshot checks wherever local Chrome exists, with the checker's auto-allowed permissions no wider than today, by changing only what fails off macOS.

## Files to create / modify

- `packages/runes/hooks/explain/checker.ts` — use discovered Chrome, the fixed screenshot helper, exact-match Bash permission, fixed containment and the shared opener and cleanup at settle.
- `packages/runes/hooks/explain/checker.test.ts` — cover the changed boundaries through the mod kit.
- `packages/runes/hooks/explain/{explain.test.ts,button.test.tsx}` (modify, bounded fixture alignment) — inject explicit runtime Chrome discovery results while preserving existing checker and button assertions.
- `packages/runes/hooks/explain/checker-cli.ts` (new) — take one wide or narrow screenshot of one page.
- `packages/runes/hooks/explain/geometry-cli.ts` — encode the page URL with `pathToFileURL`.
- `packages/runes/hooks/platform-cli.ts` — fill `RuntimeInfo.chrome` and export the discovery function checker-cli.ts reuses.
- `packages/runes/hooks/platform.spec.ts` — test discovery, checker-cli.ts argument parsing and launch argv without loading the mod kit.

## Implementation notes

### Keep the current flow

This is a port, not a redesign. Keep the existing `cN` verdict tokens, the `pending` map, `expire`, the 180,000 ms check timeout, the 20,000 ms geometry timeout, agent-type matching, denied-spawn handling, late-verdict isolation, the three-round ceiling and the `OK` / `FIXED <n>` / `FAILED <reason>` grammar. Keep the missing-Chrome result: settle as `skipped` with note `no Chrome`, then open the page.

Do not add job manifests, per-page locks, process-ownership tracking or a cancel operation. A screenshot still being written when a check times out is existing behavior on every OS and stays out of this leg.

Keep Bun globals and Node imports out of modules the mod loads. Keep the hook engine object inside its own module.

Align the existing explain and button test fixtures with runtime Chrome discovery. Inject explicit Chrome-present or Chrome-absent snapshots instead of using filesystem existence as a substitute for the probe. Preserve every existing behavior assertion.

### 1. Discover Chrome

Fill `RuntimeInfo.chrome` in platform-cli.ts's `info` operation:

- darwin: the existing `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- win32: `Google\Chrome\Application\chrome.exe` under ProgramFiles, ProgramFiles(x86), then LOCALAPPDATA, read from the environment, never a hardcoded drive or username.
- linux, WSL included: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on PATH, in that order.
- Never return a Windows executable on WSL. Return `null` when nothing usable is found.

Find Chrome without importing browsers plugin code. Replace `$.fs.exists(CHROME)` with `runtime.chrome !== null`, and pass `runtime.chrome` to geometry-cli.ts in place of the `CHROME` constant.

### 2. Replace the screenshot command

Replace the hardcoded Chrome command in `CHECKER_PROMPT` with checker-cli.ts, invoked as:

```sh
bun '<plugin root>/hooks/explain/checker-cli.ts' wide '<page>'
bun '<plugin root>/hooks/explain/checker-cli.ts' narrow '<page>'
```

The helper accepts exactly a mode (`wide` or `narrow`) and one `.html` page, and rejects anything else. It resolves Chrome with platform-cli.ts's discovery function, derives `<name>.check.png` (wide, 1280×4000) or `<name>.check-narrow.png` (narrow, 420×7000) beside the page, and launches Chrome with an argv array, `pathToFileURL(page).href` and a `mkdtemp` profile it removes after Chrome exits. On success it prints `{"output": "<png path>"}` and exits 0. On failure it prints a diagnostic to stderr and exits nonzero. Before building the commands, convert every `\` in the plugin root and the page to `/` (Windows and Bun accept `/`, and a UNC `\\server\share` becomes `//server/share`), then wrap each path in single quotes, where Bash expands nothing. Write both exact commands for the check's page into the task message, and keep the prompt's colophon and round rules.

### 3. Match the Bash permission exactly

Replace `allowsBash`. Store the two commands from the task message in the check's `Pending` record. Allow a checker Bash call only when its command equals one of those two strings for a pending check. When the plugin root or the page path contains `'` or a newline, store no auto-allowed command, so the call falls through to the normal permission flow. This removes the `explainDir.includes(" ")` refusal, which denies every call under a Windows home that contains a space.

### 4. Fix Read/Edit containment

Keep the rule that the checker may Read and Edit files under the explain root. Fix `inside` so it works on Windows and stops matching siblings: normalize `\` to `/` on both sides, compare case-insensitively on win32, require the root followed by `/` as the prefix (so `explain-other/page.html` is outside), and reject any `..` segment.

### 5. Settle through the shared operations

Replace `["open", path]` with the shared opener (platform-cli.ts's `open` operation, also used by history reopen) and `["rm", "-f", …]` with platform-cli.ts's `cleanup-check`. Run cleanup even when opening fails. Record an opener failure in the entry note without changing the verdict.

### 6. Encode the geometry URL

In geometry-cli.ts, replace the `file://` concatenation with `pathToFileURL(page).href`. Keep its `{faults: string[]}` stdout and its isolated `mkdtemp` profile.

## Acceptance criteria

- [x] Discovery tests return the macOS path, the first existing Windows candidate from injected ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA, the first Linux PATH name, a Linux-only result on WSL and `null` when nothing exists; a `null` result settles the entry `skipped` and still opens the page.
- [x] checker-cli.ts tests reject a missing or unknown mode, a non-`.html` page and any extra argument, derive the exact PNG name per mode, and launch Chrome with an argv array containing an encoded file URL and a temporary profile that is removed after Chrome exits.
- [x] Permission tests allow exactly the two stored commands for a pending check, deny any other command, deny a stored command after its check settles, and send a plugin root or page path containing `'` to the normal permission flow; a Windows home containing a space, a plugin root containing `$(…)` (which must not expand) and a UNC home (which must reach the helper as `//server/…`) are allowed.
- [x] Containment tests with injected Windows semantics accept backslash and case variants of a file under the root, and reject `..`, a sibling `explain-other/` directory and a different drive.
- [x] Settlement tests prove pass, skip, failure and timeout call the shared opener and `cleanup-check`, run cleanup when opening fails, and keep the verdict.
- [x] Existing checker tests for verdict tokens, timeouts, denied spawn and late replies pass unchanged.
- [x] Mod-loaded modules stay free of Bun-only imports, Bun globals and cross-plugin imports.

## Verification

- [x] Run `claude plugin test packages/runes` from the repository root and require zero failures.
- [x] Run `claude plugin validate packages/runes` from the repository root and require success.
- [x] Run `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` and require zero failures.
- [x] Run `bunx --bun tsc --noEmit` from the repository root and require no diagnostics; record that this command excludes the runes mod and does not replace its mod tests.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                | 2–3 (below bar)                                                                                           | 4–5 (pass)                                                                                                      |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | The checker still fails off macOS, or its auto-allowed permissions are wider than before. | Native happy paths work but the missing-Chrome skip, settle cleanup or containment drifts.                | All six changes work on injected macOS, Windows, Linux and WSL inputs, and every existing outcome is preserved. |
| Test coverage           | ×2     | Only pure helpers are tested, or negative permission cases are missing.                   | Happy paths pass but argument rejection, Windows path variants or settle-after-opener-failure are absent. | Mod and Bun tests cover discovery, helper parsing, exact-match permission, containment variants and settlement. |
| Interface & readability | ×1     | Mod code imports Bun, or the helper accepts arbitrary arguments.                          | The changes work but duplicate discovery or opening logic.                                                | One discovery function, one fixed-argument helper and the shared opener, with no new lifecycle machinery.       |
| Assumptions & docs      | ×1     | Injected tests are claimed as real Windows or WSL mod proof.                              | Limits are mentioned without separating native Chrome, the WSL skip and owed runs.                        | Evidence separates full mod tests, injected platform cases, Bun contracts and still-owed real UI runs.          |

## Out of scope

- Windows-browser automation from WSL — use Linux Chrome or the existing no-Chrome skip.
- Concurrency hardening of the checker (job ownership, cancellation, late-writer cleanup) — existing behavior on every OS; not a portability fix.
- Browser installation, network configuration and new npm dependencies.
- Theme redesign, broader checker editing rights and permanent explanation deletion.

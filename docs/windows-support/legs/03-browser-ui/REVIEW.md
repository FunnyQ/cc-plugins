# Leg 3 final review — browsers, runes, Herdr

## Scope

- Execution base commit: `27fd0eab925471f13ab7a3e313bbc7afb1419172`.
- Reviewed head: `486e3f41a835869e15f517c69ad33e8a33abdc70` plus the uncommitted final-review fixes listed below.
- Committed waves reviewed (12): `e52d6df`, `a314d12`, `4f5738e`, `7bfd4fd`, `2f5f138`, `ee45607`, `44d10d9`, `cd9d50c`, `52b11c2`, `d791cbf`, `d293556`, `486e3f4`.
- Command: `git diff --name-only 27fd0eab925471f13ab7a3e313bbc7afb1419172 -- packages/browsers packages/runes packages/herdr .github README.md CLAUDE.md docs/windows-support`, followed by the full diff.

Changed files (64 committed, plus `OWED-CHECKS.md` and this file, both new in the review):

- `.github/scripts/browser-smoke.test.ts`, `.github/scripts/browser-smoke.ts`, `.github/workflows/ci.yml`
- `CLAUDE.md`, `README.md`
- `docs/windows-support/legs/03-browser-ui/tasks/` — `_context/task-contracts.md`, `_context/verification.md`, `browsers/01-test-env.md`, `browsers/02-native-platform-support.md`, `browsers/03-live-smoke-contracts.md`, `herdr/01-test-env.md`, `herdr/02-platform-support.md`, `platform/01-ci-gates.md`, `platform/02-support-docs.md`, `review/01-final-review.md`, `runes/01-portable-test-contracts.md`, `runes/02-platform-actions.md`, `runes/03-portable-explain-checker.md`
- `packages/browsers/skills/chrome/` — `SKILL.md`, `scripts/chrome.live.test.ts`, `scripts/chrome.test.ts`, `scripts/chrome.ts`
- `packages/browsers/skills/firefox/` — `SKILL.md`, `scripts/firefox.live.test.ts`, `scripts/firefox.test.ts`, `scripts/firefox.ts`
- `packages/browsers/skills/safari/` — `SKILL.md`, `scripts/safari.live.test.ts`, `scripts/safari.test.ts`, `scripts/safari.ts`
- `packages/browsers/skills/shared/` — `instances.test.ts`, `instances.ts`, `platform.test.ts`, `platform.ts`
- `packages/herdr/skills/herdr-browser/` — `SKILL.md`, `scripts/browser.test.ts`, `scripts/browser.ts`, `scripts/terminal-browser.test.ts`, `scripts/terminal-browser.ts`
- `packages/herdr/skills/herdr/scripts/` — `ask-contract.test.ts`, `ask-contract.ts`, `herd.test.ts`, `project-registry.test.ts`, `project-registry.ts`
- `packages/runes/hooks/` — `explain/button.test.tsx`, `explain/checker-cli.ts`, `explain/checker.test.ts`, `explain/checker.ts`, `explain/explain.test.ts`, `explain/explain.ts`, `explain/geometry-cli.ts`, `explain/pane.test.tsx`, `minimap/index.ts`, `platform-cli.ts`, `platform.spec.ts`, `platform.ts`, `register.tsx`, `runes.test.tsx`, `teacher/lessons-cli.ts`, `transcript/glow.ts`, `transcript/open-image.ts`, `transcript/open-raw.ts`, `transcript/quicklook.ts`, `transcript/test-session.ts`

## Review lenses

Four lenses ran on attempt 1: codex (cross-vendor, ran: 3 P2 findings), reuse (9), leanness (13), efficiency (3).

## Integration findings and fixes

| Finding                                                                                                                                                                                                                                                                                        | Source                      | Fix                                                                                                                                                                                                                                        | Regression coverage                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `OWED-CHECKS.md` was never created, though `README.md`, `CLAUDE.md` and the support-docs task gate referenced it                                                                                                                                                                               | this review                 | Created the ledger, every row `owed`                                                                                                                                                                                                       | Document review                                                                                          |
| Windows ownership query decoded PowerShell output as UTF-8 without setting the output encoding, so a CJK state path failed `status`/`close`                                                                                                                                                    | codex                       | `[Console]::OutputEncoding` set to UTF-8 before the CIM query (`shared/instances.ts`)                                                                                                                                                      | New real-process test: CJK and spaced state path verifies ownership (runs natively on all three CI OSes) |
| Snap Chromium/Firefox have a private `/tmp`, so the profile and `DevToolsActivePort` under `/tmp/q-lab/browsers` were invisible and launch timed out                                                                                                                                           | codex                       | `/snap/bin/*` candidates dropped; `resolveBinary` skips any candidate resolving under `/snap/` or to `/usr/bin/snap` and names Snap in the error. Moving state under `~/snap/<name>/common` was rejected: it splits the registry by binary | New injected test; Snap-only host stays owed                                                             |
| runes Linux Chrome probe accepted a `google-chrome` symlink to a Windows `chrome.exe` on WSL                                                                                                                                                                                                   | codex                       | Probe resolves the real path and rejects a Windows target, falling through to later names                                                                                                                                                  | New injected cases in `platform.spec.ts`                                                                 |
| Ownership check spawned `processDetails` twice per verification (up to six PowerShell spawns per Windows `close`)                                                                                                                                                                              | efficiency, leanness        | One `details` seam, one spawn per verification                                                                                                                                                                                             | Existing lifecycle tests, rewritten to the merged seam                                                   |
| `discoverChrome` ran on every platform-cli call; `quicklook` rebuilt runtime info                                                                                                                                                                                                              | efficiency                  | Chrome discovered only for the `info` op; `quicklook(path, info)`                                                                                                                                                                          | `platform.spec.ts` info-child test                                                                       |
| Unused `BINARIES` exports built at module load                                                                                                                                                                                                                                                 | efficiency, leanness, reuse | Deleted                                                                                                                                                                                                                                    | tsc, suites                                                                                              |
| Small cleanups: `isAlive` reuse in `profileBusy`, firefox `STATE_DIR` const, `resolve` defaults to `resolveBinary`, Windows temp fallback `tmpdir()`, runtime-probe shape validation removed, `modEnv(home)` replaces three inline fallbacks (explain's fallback now passes `USERPROFILE` too) | reuse, leanness             | Applied                                                                                                                                                                                                                                    | Suites                                                                                                   |

Rejected findings:

- reuse: shared `platformAction($, …)` in `platform.ts` — it hands the engine object `$` to another module's function, which the mod contract forbids.
- reuse: `firefox close` through `withSession` — `DeleteSession` after `Marionette:Quit` can wait on a closed socket until the close timeout.
- reuse: shared `spawnBrowser`/`LaunchOptions`, `recordPath`, `tryRun`, exported `messageOf` — little gain for churn on the ownership-sensitive path late in the leg.
- leanness: Firefox `assertSupported` in `launch` — `launch` is exported and is where the side effects happen, and the contract requires refusal before any of them.
- leanness: herdr `terminalTargets` prerequisite check — callers inject `exec`, which skips `run`'s check, so the check is what carries the platform hint the tests pin.
- leanness: always use PowerShell to open files on Windows; one platform-agnostic glow hint — both change behavior nobody has verified on Windows.
- leanness: `/usr/bin/*` fixed candidates — they still matter when a harness passes a stripped `PATH`.
- leanness: trimming `SmokeDependencies` — those seams are what the smoke-runner tests inject.

## Contract confirmation

- Discovery and lifecycle: Chrome is found on all three OSes and Firefox/Zen on macOS/Linux. Non-executables and Windows targets on WSL are rejected, and so are Snap builds. Profiles are isolated per instance, the registry is reused, and ownership is checked by argv plus start identity. Cleanup happens only after confirmed exit. Covered by `packages/browsers` tests and the native smoke.
- Refusals: Safari off macOS, and Firefox/Zen on native Windows, refuse before any driver, browser or state side effect (`safari.test.ts`, `firefox.test.ts`, smoke `--check-prerequisites` contract).
- runes: falls back to `USERPROFILE` when `HOME` is empty. `mkdir`, open, trash and cleanup go through the Bun `platform-cli.ts` child, and Bun stays out of mod-loaded helpers. The checker uses Linux Chrome only on WSL, or skips; the Bash allow-list is pinned by `checker.test.ts`. Covered by `claude plugin test packages/runes` (full local mod suite) and the standalone `platform.spec.ts` contracts.
- Herdr: tests cover scratch paths, `HERDR_BIN_PATH`, pane/workspace targeting and missing-prerequisite diagnostics. The CLI still owns the socket/named-pipe transport.

## Final-state automated gates

Local host: macOS 27.0.1 (26A434), arm64; Bun 1.4.4; Claude Code 2.1.312. Run after all fixes:

| Command                                                                                   | Result                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test packages/browsers packages/herdr ./.github/scripts/browser-smoke.test.ts`       | 394 pass, 0 fail, 1 skip (Safari live, opt-in `SAFARI_LIVE=1`)                                                                                                                                                                                             |
| `bunx --bun tsc --noEmit`                                                                 | exit 0 (excludes runes; validates nothing in the mod)                                                                                                                                                                                                       |
| `claude plugin test packages/runes`                                                       | 454 pass, 0 fail                                                                                                                                                                                                                                            |
| `claude plugin validate packages/runes`                                                   | exit 0, "Validation passed"                                                                                                                                                                                                                                 |
| `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` | 77 pass, 0 fail (isolated Bun contracts, not mod validation)                                                                                                                                                                                                |
| `bun .github/scripts/browser-smoke.ts`                                                    | exit 0; Chrome `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (Google Chrome 156.0.8078.48) and Firefox `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox` (Mozilla Firefox 159.0b1): smoke passed, owned instance closed |

## Evidence categories

- Native automated, run: macOS only, locally (table above).
- Native automated, configured but not run: Linux and Windows `required` and `smoke` CI jobs. They run only on an implementation PR, and none has run.
- Injected platform tests: Windows, WSL and Snap behavior is driven by injected platform input on the macOS host.
- Full local mod tests: `claude plugin test packages/runes` on macOS.
- Actual Windows/WSL human interactions: none. Every one is listed in [OWED-CHECKS.md](./OWED-CHECKS.md), the persistent source for unperformed checks; leg-2 debts stay in `../02-core-workflow/`.

## Limitations

- An Ubuntu `/usr/bin/firefox` shell wrapper that execs the Snap is not detected; it still times out at launch. It is owed under the Snap row.
- The runes checker does not apply the Snap rule to its Linux Chrome probe.
- Remote CI result and run URL: owed, because no authorized PR exists.

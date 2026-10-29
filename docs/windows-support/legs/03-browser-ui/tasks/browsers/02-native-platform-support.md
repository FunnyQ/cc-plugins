# BROWSERS-02: Support native browser discovery and lifecycle.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/browsers.md`
>
> **Depends on**: browsers/01
> **Blocks**: browsers/03
> **Status**: done

## Goal

Discover and manage isolated native Chrome on Windows, Linux and macOS and Firefox and Zen on Linux and macOS. Reject Firefox and Zen on native Windows, and Safari outside macOS, before side effects.

## Files to create / modify

- `packages/browsers/skills/shared/platform.ts` (new) — define native discovery candidates and state roots.
- `packages/browsers/skills/shared/platform.test.ts` (new) — cover injected platforms, executable lookup and state paths.
- `packages/browsers/skills/shared/instances.ts` (modify) — validate executable candidates and enforce owned lifecycle cleanup.
- `packages/browsers/skills/shared/instances.test.ts` (modify) — cover discovery failure, registry reuse and cleanup ordering.
- `packages/browsers/skills/chrome/scripts/chrome.ts` (modify) — use native discovery and state helpers.
- `packages/browsers/skills/chrome/scripts/chrome.test.ts` (modify) — cover native launch integration.
- `packages/browsers/skills/firefox/scripts/firefox.ts` (modify) — use native discovery for Firefox and Zen; refuse on native Windows.
- `packages/browsers/skills/firefox/scripts/firefox.test.ts` (modify) — cover both Gecko browser selections and the Windows refusal.
- `packages/browsers/skills/safari/scripts/safari.ts` (modify) — refuse non-macOS executable invocations.
- `packages/browsers/skills/safari/scripts/safari.test.ts` (modify) — assert refusal before state or driver operations.

## Implementation notes

### Native discovery and scratch roots

Implement the following shared boundary, with real platform defaults at runtime and injected inputs/operations in tests:

```ts
type BrowserName = "chrome" | "firefox" | "zen";
type Platform = "darwin" | "linux" | "win32";
type PlatformInput = {
  platform: Platform;
  env: Record<string, string | undefined>;
  wsl: boolean;
};
function browserCandidates(name: BrowserName, input: PlatformInput): string[];
function browserStateDir(name: BrowserName, platform?: Platform, env?: Record<string, string | undefined>): string;
```

Preserve the existing macOS order: Chrome stable, Canary, Chromium; Firefox Developer Edition, stable, Nightly; Zen's current app bundle. On Windows, derive Chrome's system and per-user locations from ProgramFiles, ProgramFiles(x86) and LOCALAPPDATA. On Linux, WSL included, search the executable names and standard locations specified in the browser context. On WSL, never return a Windows executable; when no Linux candidate exists, add one line to the discovery error telling the user to install a Linux build inside WSL. Keep Firefox and Zen selection independent, while preserving their existing shared Firefox instance registry and command behavior.

Extend `resolveBinary(name, candidates, ...)` with injected executable validation and lookup as needed. Adapt existing Chrome and Firefox callers together. Reject directories and non-executable candidates; do not treat Unix executable-bit checks as Windows executable semantics. When no usable candidate exists, report the browser name and attempted candidates in deterministic order. Pass executable paths as argv data, including spaces and CJK characters.

On native Windows, place state under the system temp directory's `q-lab/browsers/` subtree. On macOS and Linux, preserve the existing `/tmp/q-lab/browsers/chrome` and `/tmp/q-lab/browsers/firefox` paths. When constructing a foreign-platform expectation, use the injected platform's path semantics rather than host `path.join` behavior.

### Instance ownership and close

Preserve the existing `Instance` fields and record format: `id`, `pid`, `port`, `profile`, `browser` and `headless`. Keep isolated profiles, port allocation and navigation waits intact. Exercise record creation, reuse by id and stale record handling.

Prefer the browser protocol's close/quit operation when available. If termination is required, target only the recorded owned instance and validate ownership before acting on a potentially reused PID. Never kill by executable name. Wait for actual browser exit before deleting its profile; an exited launch wrapper alone is insufficient. Bound termination and cleanup attempts, retain the profile while the browser is still alive, and surface failure instead of reporting a clean close. Preserve unrelated browser processes and normal user profiles.

### Private launch state for required smoke

For required smoke, create a fresh per-browser directory before launch and pass its absolute path as Q_BROWSER_STATE_DIR to every CLI child. The state helper places that browser's registry/profiles under this root; default paths remain unchanged when the variable is absent. Record a provisional owned instance immediately after spawn, before readiness or navigation waits, and update its port once ready. On timeout before open returns an id, terminate and await the CLI, then reclaim only records within this private root using ownership-aware lifecycle operations. Never infer ownership from a before/after difference of the shared registry. Keep the private root while any owned browser is still alive. Test a concurrent unrelated launch plus a timeout after registration and before id output.

### Platform refusals

Guard each executable CLI boundary before argument execution, state creation or browser/driver spawn. Safari on Linux and Windows exits nonzero with an error containing `macOS only`. Firefox and Zen on native Windows exit nonzero with an error containing `not supported on Windows` that names the chrome skill as the alternative. Keep parser, Marionette and WebDriver helpers importable and testable on every OS. Keep Safari live testing opt-in on macOS.

## Acceptance criteria

- [x] Injected-platform tests cover deterministic Chrome, Firefox and Zen candidate order on macOS and Linux, Windows Chrome environment roots, Linux-only candidates and the install hint on WSL, missing candidates, directories and non-executable files; a failed lookup names the browser and attempted candidates.
- [x] Chrome and Firefox command tests prove native selection and isolated state integration, including independent Zen selection and unchanged macOS ordering and registry locations.
- [x] State-root tests prove native Windows uses system temp while macOS and Linux retain existing paths, without host-platform separator leakage in injected tests.
- [x] Lifecycle tests prove registry reuse, stale record handling, bounded close, ownership validation and exit-before-profile-deletion ordering; a live browser or failed cleanup cannot be reported as a successful clean close.
- [x] Regression tests prove an unrelated process or normal user profile is never terminated or removed by instance cleanup.
- [x] Non-macOS Safari CLI tests assert a nonzero result containing `macOS only`, and native-Windows Firefox and Zen CLI tests assert `not supported on Windows`, each with zero driver/browser/state operations; parser/protocol tests remain portable and macOS live opt-in remains intact.

## Verification

- [x] Run `bun test packages/browsers` from the repository root and require zero failures; optional live tests may skip only for their existing absent-browser or Safari opt-in prerequisites.
- [x] Run `bunx --bun tsc --noEmit` from the repository root and require exit zero with no diagnostics.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Native discovery fails or cleanup affects unrelated resources | Common installations work but ordering, state compatibility or close failures drift | All native selections, state contracts, owned cleanup and the Safari and Windows Firefox/Zen refusals match the specification |
| Test coverage | ×2 | Platform branches or lifecycle changes have no regression tests | Happy paths pass but executable rejection, ownership or cleanup ordering is untested | Injected platform tests and command integration assertions cover selection, failure, reuse, refusal and resource ownership |
| Interface & readability | ×1 | Platform logic is duplicated or shell strings hide execution | Helpers work but callers retain conflicting selection or path rules | Small plugin-local helpers expose explicit platform inputs and keep existing callers coherent |
| Assumptions & docs | ×1 | Injected tests are presented as proof of real Windows or WSL behavior | Platform limitations are mentioned but verification evidence is ambiguous | Native evidence and injected cases are distinguished, with existing macOS behavior and the support matrix explicit |

## Out of scope

- Launching Windows binaries from WSL, and Firefox or Zen on native Windows — deferred; refuse instead.
- Adding dependencies, protocol replacements or browser commands — retain the current CDP and Marionette surfaces.
- Provisioning browsers or changing CI — keep required live-smoke integration separate from native product changes.

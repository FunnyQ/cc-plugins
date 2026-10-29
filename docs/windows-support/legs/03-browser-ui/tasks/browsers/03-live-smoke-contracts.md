# BROWSERS-03: Require native browser smoke coverage.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/browsers.md`
> - `../_context/verification.md`
>
> **Depends on**: browsers/02
> **Blocks**: platform/01
> **Status**: done

## Goal

Provide a required smoke command that proves installed native Chrome (every OS) and Firefox (macOS and Linux) work through their real CLI commands, proves Firefox refuses on native Windows, and fails when a required prerequisite or browser action is unavailable.

## Files to create / modify

- `.github/scripts/browser-smoke.ts` (new) — require and exercise native Chrome, and Firefox outside Windows, through child CLI processes.
- `.github/scripts/browser-smoke.test.ts` (new) — verify missing-prerequisite failures, action assertions and owned cleanup with injected child operations.
- `packages/browsers/skills/chrome/scripts/chrome.live.test.ts` (modify) — use portable installed-browser detection while preserving optional local execution and navigation regressions.
- `packages/browsers/skills/firefox/scripts/firefox.live.test.ts` (modify) — use portable installed-browser detection, skip on native Windows where the CLI refuses, and preserve optional local execution and Marionette interaction coverage.
- `packages/browsers/skills/safari/scripts/safari.live.test.ts` (modify) — retain explicit opt-in and restrict actual Safari automation to macOS.

## Implementation notes

### Required command and prerequisites

Expose `bun .github/scripts/browser-smoke.ts` and its optional `--check-prerequisites` flag. Reject unknown flags. Resolve the required browsers with the existing plugin-local native discovery behavior; do not reproduce a separate macOS-only candidate list. Require Chrome on every OS and Firefox on macOS and Linux. On native Windows, require no Firefox; instead run `firefox.ts open` once and assert a nonzero exit containing `not supported on Windows`. Print the selected native executable path and measured version for each required browser. A missing required browser, a failed version command or failed launch must return a nonzero exit with the browser name and useful diagnostic. Check every prerequisite before starting the action sequence so an absent second browser cannot leave the first open.

`--check-prerequisites` checks resolution, executable availability and version reporting, then exits without launching an automation instance. It must fail when a required browser is unavailable. The flag is a diagnostic shortcut, not permission to skip required browsers in a normal smoke run. Do not install browsers, download dependencies or change browser defaults from this script. CI provisioning belongs to the workflow integration.

Keep existing ordinary live tests optional when a browser is not installed. A successful optional-test skip does not satisfy the required command. Preserve Safari's `SAFARI_LIVE=1` requirement and also require macOS before running its visible automation window. Keep Zen live coverage owed unless execution establishes a reproducible CI installation; the required command must not substitute Zen for Firefox.

### Real child command sequence

Run the required browsers sequentially. For each, create a unique smoke scratch leaf and use a controlled `data:text/html` page or a parent-owned local HTTP server, without fetching public Internet content. Use a simple input and button whose click changes both title and visible text. Invoke the existing browser CLI through Bun with an argv array, not a constructed shell command.

Launch with `open --new`, capture the returned instance id, and use a fresh CLI child for each subsequent operation. Exercise `status --id`, `type`, `click`, `wait`, `eval` or `text`, `screenshot --output`, and `close --id`. Assert returned content, nonzero exit propagation and a PNG signature written to the caller's scratch path. Use a destination containing spaces and CJK text to prevent accidental shell splitting.

Bound every child operation and retain stderr for failures. If a parent-owned server is used, run child operations asynchronously; `spawnSync` would block that server's responses. Avoid hardcoded ports, shared instance ids, default browser profiles and global close operations. Put instance close and server/scratch disposal in `finally` paths. Close the returned id on the normal path; on a timeout before id output use only the preallocated private state root as described below. Propagate close failures; do not erase an action failure when cleanup also fails. Do not delete a still-owned browser profile directly; the browser CLI owns its lifecycle and cleanup.

### Ownership before an instance id is returned

For required smoke, create a fresh per-browser directory before launch and pass its absolute path as Q_BROWSER_STATE_DIR to every CLI child. The state helper places that browser's registry/profiles under this root; default paths remain unchanged when the variable is absent. Record a provisional owned instance immediately after spawn, before readiness or navigation waits, and update its port once ready. On timeout before open returns an id, terminate and await the CLI, then reclaim only records within this private root using ownership-aware lifecycle operations. Never infer ownership from a before/after difference of the shared registry. Keep the private root while any owned browser is still alive. Test a concurrent unrelated launch plus a timeout after registration and before id output. The native product state helper and provisional-record support are part of the native lifecycle implementation; use that contract here rather than bypassing it in the runner.

### Deterministic runner tests

Keep enough exported orchestration surface for tests to inject binary resolution, version/process operations and scratch reads without launching a real browser. Use explicit result types, for example:

```ts
type CommandResult = { exitCode: number; stdout: string; stderr: string };
type RunCommand = (argv: string[], timeoutMs: number) => Promise<CommandResult>;
type SmokeOptions = { checkPrerequisites: boolean };
```

Keep injection local to the smoke runner rather than adding a transport framework. Test absent Chrome and absent Firefox independently, the Windows Firefox-refusal assertion (including a refusal that wrongly exits zero), failed version reporting, preflight-only behavior, separate command invocations with the selected id, failed action/content/PNG assertions, timeout propagation and cleanup after an action failure. Verify no cleanup targets unrelated ids and no launch occurs when preflight fails. Add a close-failure case that keeps the primary failure visible, plus registration-before-id timeout with a concurrent unrelated browser launch.

## Acceptance criteria

- [x] The normal command requires native Chrome on every OS and Firefox on macOS and Linux, asserts the Firefox refusal on native Windows, prints actual paths and versions, and returns nonzero for any missing required prerequisite instead of reporting a skip.
- [x] `--check-prerequisites` verifies the required browsers without opening an automation instance and returns nonzero on prerequisite failure; invalid arguments fail clearly.
- [x] Each real smoke sequence opens a fresh isolated instance and reconnects to the same returned id through separate CLI children for interaction, content verification, screenshot and close.
- [x] Each required browser's screenshot produces a PNG at the caller-owned destination containing spaces and CJK text, without cross-OS output-path conversion.
- [x] Failed actions, wrong page content, invalid PNG data, child timeouts and cleanup failures all fail the command; unit tests cover these failure paths and preserve the primary diagnostic.
- [x] `finally` cleanup closes only smoke-owned ids and disposes only the runner's server/scratch resources; missing prerequisites cause no browser launch.
- [x] Optional local browser tests may still skip absent installations, while Safari live automation remains both macOS-only and explicitly enabled with `SAFARI_LIVE=1`.
- [x] The runner installs no browser or dependency and makes no system configuration change; measured native versions are reported without claiming Zen, Windows Firefox or real WSL verification.

## Verification

- [x] Run `bun test ./.github/scripts/browser-smoke.test.ts` and confirm prerequisite, assertion, timeout and cleanup regression cases pass without real browser launches.
- [x] Run `bun .github/scripts/browser-smoke.ts --check-prerequisites` and confirm the required native executable paths and versions are reported; resolve a missing prerequisite explicitly rather than converting it to a successful skip.
- [x] Run `bun .github/scripts/browser-smoke.ts` and confirm every required browser sequence passes and its owned instances close.
- [x] Run `bun test packages/browsers` and confirm optional local tests retain their prerequisite behavior and Safari does not open a window without opt-in.
- [x] Run `bunx --bun tsc --noEmit` from the repository root and confirm it passes.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Missing browsers pass or unrelated instances are closed | Happy-path actions run but content, PNG or cleanup failures can pass | Every required native browser is mandatory, the Windows refusal is asserted, separate CLI processes verify behavior, and failures plus owned cleanup are enforced |
| Test coverage | ×2 | Only real-browser happy paths exist | Missing-browser or cleanup tests omit a failure class | Deterministic tests cover each absent prerequisite, the Windows refusal, preflight, action/content/PNG failures, timeouts and owned cleanup; real smoke proves the composed sequence |
| Interface & readability | ×1 | Shell strings or a generic transport layer hide operations | Runner is usable but dependencies and error flow are unclear | Small typed injection points expose actual argv, deadlines, results and cleanup ownership |
| Assumptions & docs | ×1 | Optional skips are presented as CI evidence | Versions or native-versus-WSL limits are implicit | Commands report measured native paths/versions and preserve explicit Safari opt-in and owed Zen/WSL evidence |

## Out of scope

- Workflow edits and browser provisioning — keep this task confined to the smoke entrypoint and live tests.
- Zen installation and real Windows/WSL human runs — keep these owed unless reproducible evidence is available.
- Browser product lifecycle changes — report a concrete product defect discovered by smoke rather than bypassing it in the runner.

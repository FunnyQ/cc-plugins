# CI and owed verification

## Blocking CI

Keep the existing required and smoke jobs and the macos-latest / ubuntu-latest / windows-latest matrix. Keep Bun 1.4.4 and existing core-workflow tests. The workflow defaults to Bash even on Windows; do not confuse Git Bash availability on runners with an installed dependency on user machines.

Extend required with:

```sh
bun test --parallel packages/chronicle packages/dispatch packages/guard packages/relay packages/browsers packages/herdr opencode/ .github/scripts/browser-smoke.test.ts
(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)
bun .github/scripts/browser-smoke.ts
```

Keep root bunx --bun tsc --noEmit and existing monitor checks unchanged. Keep the report job's diagnostic role unchanged. The browser-smoke runner must require Chrome on every OS and Firefox on macOS and Linux, assert the Firefox refusal on native Windows, and print selected paths/versions. Use runner-image browser installations where available and fail clearly if a prerequisite disappears. If the selected image lacks a required browser, provision that browser explicitly in CI from an official distribution and record the installation/version; never convert absence into a successful skip. Do not install Zen just to expand this leg's gate.

Use --check-prerequisites on the smoke runner for fast diagnostics and tests of absent prerequisites. Regular smoke runs must still fail absence. Do not require an external test server or Internet content for browser actions; use a controlled data/local page.

## Local execution gates

Run these from repo root:

```sh
bun test packages/browsers packages/herdr
bunx --bun tsc --noEmit
claude plugin test packages/runes
claude plugin validate packages/runes
(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)
bun .github/scripts/browser-smoke.ts
```

Do not interpret root tsc as checking runes, or the isolated Bun contracts as checking the full mod. Record each command, OS, tool version, result and limitation in execution evidence. Do not demand a GitHub run before a local task can finish; the later implementation PR's CI result is an integration check, not a locally fabricated success.

## Owed-check ledger

The support-docs task creates docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md. Use a table with columns Check, Environment, Status, Evidence, Last attempted. Initialize each check below as owed, not done. Change it to passed only with an actual run and evidence. Human checkboxes in task gates may be ticked by automation, so they are not this ledger's source of truth.

- Windows native Chrome: open, reuse by id, interaction, file URL, screenshot under a spaced/CJK path, close and cleanup.
- Windows native Firefox and Zen: the CLI refuses with `not supported on Windows`.
- WSL with Linux browsers: discovery, separate instances, screenshot and close; with no Linux browser, the install hint.
- Windows and WSL runes: USERPROFILE initialization, config persistence, explain HTML after checker pass/skip/failure, history reopen, raw/image previews and recoverable deletion.
- Windows and WSL Herdr pane: open, --new, --view, workspace targeting, snapshot, click, screenshot and close.
- Zen live behavior when no repeatable CI installation is available.
- Remote implementation PR: three-OS required and smoke job results, with run URL and actual outcome; remain owed until an authorized PR runs.

Keep leg-2 owed checks intact. Do not mark roadmap leg 3 done during planning. During execution closure, document any departure from the literal roadmap done-state and keep these checks visible.

## Human pane pass conditions

Use a controlled data/local HTML page with title "Pane check", a button #increment labelled "Increment" and a visible #count initialized to 0. Clicking Increment must set #count to 1. Record the initiating pane id, open a fresh browser view with --new, select it explicitly with --view, and verify snapshot identifies Increment and count 0. Click Increment, require text/eval and screenshot to show count 1, then close only the new view and confirm the initiating pane and an unrelated view remain open. Record command outputs, view/pane ids and screenshot evidence; an exit code alone is insufficient.

## Final integration evidence

Write docs/windows-support/legs/03-browser-ui/REVIEW.md during the final implementation review. Include the exact execution base commit, the result of git diff --name-only <baseRef> -- packages/browsers packages/runes packages/herdr .github README.md CLAUDE.md docs/windows-support, each automated gate result and the owed-check ledger location. Read the full diff as well as its file list. Do not use git status to measure completed wave changes because autopilot commits them between waves.

Check that support claims distinguish native CI, injected platform fixtures, full local mod tests and actual human runs. Review integration, goal coverage, consistency, regressions and unnecessary abstractions. Run a test suite after any final-review fix. Do not release, push or merge as part of that review.

# REVIEW-01: Verify integrated browser and UI portability.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/browsers.md`
> - `../_context/runes.md`
> - `../_context/verification.md`
>
> **Depends on**: platform/02
> **Status**: done
> **Final review**: true

## Goal

Verify that browser discovery, platform actions, checker permissions and Herdr integration compose correctly, with automated evidence separated from owed Windows and WSL checks.

## Files to create / modify

- `docs/windows-support/legs/03-browser-ui/REVIEW.md` (new) — record the execution diff, integration findings, fixes, commands, versions and outstanding checks.
- `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` (modify only with actual evidence) — preserve owed checks and record any verified human runs.
- `packages/browsers/` (bounded integration fixes) — correct only defects in the implemented discovery, lifecycle, refusal or smoke contracts and their adjacent tests.
- `packages/runes/` (bounded integration fixes) — correct only defects in implemented platform actions, checker behavior and adjacent tests.
- `packages/herdr/` (bounded integration fixes) — correct only defects in implemented ask/browser boundaries and adjacent tests.
- `.github/` (bounded integration fixes) — correct only the existing portability workflow and browser smoke integration.
- `README.md` and `CLAUDE.md` (bounded documentation corrections) — reconcile support claims with the final behavior and evidence.

## Implementation notes

### Review the complete execution diff

Use `<baseRef>` as the commit at which implementation execution started. Let autopilot substitute that reference; when reviewing by hand, resolve and record the actual base commit before comparing changes.

Inspect both the changed-file list and the full diff:

```sh
git diff --name-only <baseRef> -- packages/browsers packages/runes packages/herdr .github README.md CLAUDE.md docs/windows-support
git diff <baseRef> -- packages/browsers packages/runes packages/herdr .github README.md CLAUDE.md docs/windows-support
```

Include changes committed between execution waves. Confirm that the existing dependency chain reaches every feature branch and that the composed behavior satisfies the shared contracts. Inspect unrelated regressions within this declared surface; do not broaden the implementation to deferred features.

### Check the integration boundaries

Verify native Chrome discovery on all three OS and Firefox and Zen discovery on macOS and Linux, executable rejection, isolated profiles, registry reuse, process ownership and cleanup after confirmed exit. Verify that non-macOS Safari and native-Windows Firefox/Zen execution refuse before driver, browser or state side effects.

Verify that WSL discovery returns Linux binaries only, never invokes a Windows executable, and adds the Linux-install hint when nothing is found.

Verify runes initialization with absent or empty `HOME` and valid `USERPROFILE`. Confirm first-run HTML creation requires no Unix `mkdir`, previews select the correct opener, and failed opening or recoverable deletion retains persisted explanations. Confirm Bun runtime code remains outside mod-loaded helpers and that no hook engine object crosses module boundaries.

Review checker discovery, geometry and screenshot execution together with automatic permissions. Preserve Linux Chrome or no-Chrome skip on WSL, encoded file URLs, exact generated-PNG cleanup, verdict tokens and timeout isolation. Confirm the Bash permission allows only the two exact helper commands of a pending check, and that `..`, sibling-prefix paths, Windows case/separator differences and shell metacharacters cannot broaden the permitted file or command set. Confirm the checker gained no job, lock or cancel machinery.

Verify Herdr scratch paths, existing `HERDR_BIN_PATH` handling and pane/workspace selection. Keep the CLI responsible for socket or named-pipe transport. Confirm mandatory native smoke cannot pass by skipping a missing prerequisite and that isolated Bun contracts are not presented as complete runes mod validation.

### Record evidence and remaining work

Write `docs/windows-support/legs/03-browser-ui/REVIEW.md` with the exact execution base commit, changed-file list, reviewed findings, any integration fixes, command results, operating system, selected browser paths, tool/browser versions and limitations. Name `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` as the persistent source for unperformed checks.

Keep the owed ledger's columns `Check`, `Environment`, `Status`, `Evidence` and `Last attempted`. Leave a check owed until an actual run supplies evidence; never infer completion from an automatically ticked task gate. Preserve leg-2 debts. Distinguish native automated runs, injected platform tests, local full mod tests and actual Windows/WSL interactions in both documents.

Apply only narrow integration fixes. Add regression coverage for a discovered defect and rerun the affected checks after changing it. Run the complete verification set against the final integrated state. Do not release, push, merge, install user dependencies automatically or mark unperformed human checks passed.

## Acceptance criteria

- [x] `docs/windows-support/legs/03-browser-ui/REVIEW.md` records the actual execution base commit, complete declared-surface changed-file list and review of committed and uncommitted implementation changes.
- [x] Integration review confirms native discovery/lifecycle, non-macOS Safari refusal, WSL path and process ownership, runes platform actions, checker permissions and Herdr pane targeting satisfy the shared contracts together.
- [x] `docs/windows-support/legs/03-browser-ui/REVIEW.md` records passing final-state automated gates with exact commands, operating system, versions and browser paths; optional skips are not substituted for mandatory native smoke.
- [x] `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` retains every unperformed check as owed and changes status only with actual evidence, independently of task checkbox state.
- [x] Support documentation distinguishes native CI, injected platform tests, complete local mod tests and actual human runs, including the support matrix and the runes checker's Linux-Chrome-only WSL behavior.
- [x] Integration fixes remain within the declared implementation surface, retain regression tests and avoid unnecessary generic transport/configuration layers, cross-plugin imports or deferred WSL-to-Windows browser support.
- [x] (human) Run native Windows and WSL browser, runes and Herdr pane checks, including Zen, as enumerated in `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md`; record actual evidence or retain each unavailable environment as owed.
- [x] (human) Inspect the implementation PR's three-OS `required` and `smoke` results and record their run URL and outcome in `docs/windows-support/legs/03-browser-ui/REVIEW.md`; retain remote CI as owed when no authorized PR exists.

## Verification

- [x] Run `git diff --name-only <baseRef> -- packages/browsers packages/runes packages/herdr .github README.md CLAUDE.md docs/windows-support` and the corresponding full diff; reconcile the reviewed scope with `docs/windows-support/legs/03-browser-ui/REVIEW.md`.
- [x] Run `bun test packages/browsers packages/herdr ./.github/scripts/browser-smoke.test.ts` from the repository root and require zero failures.
- [x] Run `bunx --bun tsc --noEmit` from the repository root and require exit zero; keep runes' root exclusion intact and do not claim this command validates the mod.
- [x] Run `claude plugin test packages/runes` and `claude plugin validate packages/runes` from the repository root and require both to exit zero.
- [x] Run `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` and require zero failures without importing the mod test kit into the standalone contracts.
- [x] Run `bun .github/scripts/browser-smoke.ts` and require actual native Chrome (and Firefox on macOS/Linux) open, interaction, content, PNG, reconnect and owned-close checks to pass with reported binary paths and versions.
- [x] Read `docs/windows-support/legs/03-browser-ui/REVIEW.md` and `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md`; confirm each claimed automated success has command evidence and every unperformed environment check remains owed.
- [x] (human) Perform available Windows/WSL pane and mod interactions and inspect remote CI; record evidence in the persistent documents without treating skipped task gates as completed runs.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Integration < 4 or Goal coverage < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration | ×3 | Plugin boundaries fail together or cleanup affects unrelated resources. | Happy paths compose but cross-OS paths, ownership or checker failures drift. | Discovery, actions, checking, CLI boundaries and cleanup compose with their specified failure behavior. |
| Goal coverage | ×3 | A required platform behavior is absent or skipped as success. | Main behavior works but a native smoke, Safari refusal or evidence boundary is missing. | Every required behavior has appropriate automated evidence or an explicit approved owed-human limitation. |
| No regressions | ×2 | Final-state tests fail or macOS behavior changes unintentionally. | Narrow checks pass but final fixes lack regression coverage. | Final suites and real native smoke pass after fixes, with existing macOS behavior and prior CI gates preserved. |
| Consistency | ×1 | Documentation, tests and owed statuses contradict implementation. | Claims mostly align but versions, commands or unverified environments remain ambiguous. | Support claims, command results and persistent owed evidence describe the same final state. |
| Leanness | ×1 | New generic layers, unused configuration or duplicate cross-plugin code obscure ownership. | Correct fixes retain avoidable abstractions or unrelated changes. | Narrow helpers address demonstrated platform needs without unused options, generic transports or unrelated scope. |

## Out of scope

- WSL-to-Windows browser automation, Windows Firefox/Zen, firewall changes and host-product ports — deferred.
- Plugin releases, remote pushes and merges — report integration results without performing those actions.
- Fabricated Windows/WSL or Zen verification — retain unavailable environments as owed in the persistent ledger.

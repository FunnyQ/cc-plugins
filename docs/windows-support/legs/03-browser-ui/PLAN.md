# Browser and UI Plugins on Windows (windows-support leg 3)

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-29
> **Max parallel**: unlimited

## Overview

Make browsers, runes and the Herdr plugin work on native Windows and WSL. Preserve existing macOS behavior and verify portable behavior in blocking CI.

## Goals

- Discover and drive Chrome on Windows, and Chrome, Firefox and Zen on Linux.
- Use Linux-installed browsers on WSL.
- Refuse Firefox and Zen on native Windows with a clear "not supported on Windows" error.
- Open explain HTML on Windows, Linux and WSL, including checker completion and history reopen.
- Remove platform assumptions from runes initialization, previews and scratch paths.
- Drive terminal-browser panes through the Herdr CLI on supported Windows and WSL installations.
- Reject Safari outside macOS with a clear "macOS only" error.

## Non-goals

- Port Herdr, terminal-browser, Claude Code or browser binaries themselves.
- Drive a Windows-installed browser from WSL.
- Support Firefox or Zen on native Windows.
- Change firewall rules, networking mode or system browser settings.
- Install dependencies automatically on user machines.
- Port monitor cockpit or atlas; those belong to legs 4 and 5.
- Redesign runes UI, change themes or add browser commands.
- Release plugins, push commits or perform the owed real-PC checks during planning.

## Context

Leg 2 shipped chronicle, dispatch, guard and relay Windows fixes. Its runtime measurements and CI lessons apply here.

Chrome, Firefox and Zen currently search only macOS app paths. On native Windows this leg supports Chrome only (decided 2026-10-29). Browser instance roots use /tmp/q-lab. The Herdr inventory identifies three test-path failures and a non-portable ask result root.

Runes is excluded from root Bun tests and TypeScript checks. Its mod tests use claude-code/testing and must run through Claude Code. The current macOS baseline is 428 passing tests across 36 files, using Claude Code 2.1.312.

Explain also hardcodes macOS Chrome in its checker, invokes open at completion and reopen, and invokes rm for screenshot cleanup. Raw and image previews use qlmanage and osascript. Initialization reads HOME without a USERPROFILE fallback.

Q has no Windows PC. Automated checks gate integration; real Windows and WSL UI checks remain explicitly owed.

## Requirements

### MVP

1. **Browser discovery**
   - Keep the existing macOS candidate order.
   - Search standard Windows system and per-user installation locations.
   - Search Linux executable names on PATH and standard installation locations.
   - Include Firefox and Zen independently.
   - Report the browser name and attempted candidates when discovery fails.
   - Never select a non-executable file merely because it exists.
2. **Browser state and lifecycle**
   - Use the system temp directory for scratch state on native Windows.
   - Preserve /tmp/q-lab on macOS and Linux.
   - Keep each launched instance in an isolated profile.
   - Give required smoke a private state root before launch and persist provisional ownership before readiness/navigation waits, so timeout before id output is safely reclaimable.
   - Verify launch, registry reuse, close and cleanup of Chrome on native Windows.
   - Never delete a profile while its owned browser is still using it.
   - Preserve unrelated browser processes and normal user profiles.
3. **Platform refusals and WSL**
   - On native Windows, reject Firefox and Zen CLI invocations before spawning a browser or creating state, with an error containing "not supported on Windows" that names the chrome skill.
   - On WSL, discover Linux-installed browsers only and never invoke a Windows executable.
   - When WSL has no Linux candidate, add a hint to install a Linux build inside WSL.
4. **Safari**
   - Reject every executable CLI invocation outside macOS before spawning safaridriver or creating state.
   - Print an error containing "macOS only" and exit nonzero.
   - Keep parser and protocol unit tests portable.
   - Keep Safari live tests explicitly opt-in on macOS.
5. **Runes platform actions**
   - Resolve native Windows home from USERPROFILE when HOME is unavailable.
   - Preserve existing persisted configuration and explanation locations.
   - Use portable scratch roots for raw previews, pasted images and glow.
   - Preserve Quick Look on macOS.
   - Use the platform file opener for previews elsewhere.
   - Create explanation directories through the portable runtime helper, without requiring Unix mkdir.
   - Open explain HTML after checker settlement and from history.
   - Convert WSL local paths before handing them to Windows openers.
   - Handle spaces, CJK text and shell metacharacters as path data.
   - Preserve explanations when an opener or recoverable deletion fails.
   - Keep persisted-page deletion recoverable; never substitute permanent deletion for trash.
6. **Explain checker**
   - Discover local Chrome on each supported native OS.
   - Keep the existing checker flow, verdict tokens, timeout and late-verdict isolation; change only what fails off macOS.
   - Keep geometry checks, screenshot checks and cleanup portable.
   - Use correctly encoded file URLs.
   - Keep Chrome, profile and screenshot paths out of interpolated shell code.
   - Auto-allow only the two exact screenshot-helper commands of a pending check, and Read/Edit only under the explain root.
   - Test traversal, sibling-prefix paths, Windows case and separator differences, and command injection.
   - When Chrome is unavailable, settle as skipped and still attempt to open the page.
   - Use Linux Chrome on WSL, or the existing no-Chrome skip.
7. **Herdr plugin**
   - Move native Windows ask scratch state under the system temp directory.
   - Fix URL-to-path, separator and fixture assumptions.
   - Honor HERDR_BIN_PATH when invoking Herdr from browser tooling.
   - Keep pane selection and workspace targeting behavior intact.
   - Report missing platform prerequisites accurately.
   - Use the CLI rather than introducing Unix-socket assumptions.
8. **Verification and documentation**
   - Add browsers and herdr suites to the blocking three-OS required job.
   - Add isolated Bun contracts for runes platform helpers and explain themes.
   - Keep root runes exclusions intact.
   - Require native Chrome live smoke on all three CI operating systems and Firefox on macOS and Linux; assert the Firefox refusal on Windows.
   - Fail required smoke checks when their browser prerequisite is absent.
   - Record Zen, WSL and real pane/UI checks as owed human checks.
   - Document support prerequisites and unverified behavior.

### Later

- Firefox and Zen on native Windows.
- Driving Windows-installed browsers from WSL.
- Checker concurrency hardening: late screenshot writers after a timeout (exists on every OS today).
- Real-PC and WSL checks when hardware is available.
- Monitor portability and plugin releases.

## Tech decisions

- Use Bun 1.4.4 and TypeScript with no new npm dependency.
- Keep helpers inside their shipping plugin; import nothing across plugins.
- Share discovery and platform helpers within browsers.
- Keep Bun-only code outside the runes mod runtime.
- Pass plain values and callbacks across runes modules; do not pass the hook engine object between modules.
- Inject platform, environment and external operations where platform branches need portable tests.
- Keep free text and paths out of constructed shell source.
- Carry leg-2 facts into _context/windows.md: native realpath for 8.3 paths, JSON encoding, MSYS argv conversion, .cmd special characters, and junction cleanup.
- Use dev=opus/high for runes/03, because it owns a permission rule.
- Leave other model headers on autopilot defaults.
- Use no visual design phase; this leg changes platform behavior.

## Architecture

Browser commands use plugin-local discovery and lifecycle helpers. Each CLI refuses an unsupported platform at its entry, before any state or spawn. WSL is treated as Linux.

Runes hooks retain their engine-facing operations. Small pure helpers define platform behavior; Bun children perform runtime-only operations where necessary. Both checker settlement and history reopen use the same opening behavior. Checker screenshots run through a fixed-argument helper, and the Bash permission matches its exact commands rather than a broader shell grammar.

Herdr browser tooling continues to call the installed Herdr and terminal-browser CLIs. It does not implement either host's platform transport.

## Bucketing

Split by plugin so unrelated work can proceed independently. Within each plugin, repair test assumptions before product behavior. Keep CI and documentation in platform/. Reserve review/ for the terminal integration task.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| browsers | 01 | Repair portable browser test fixtures | todo | > 4.0 | none |
| browsers | 02 | Support native browser discovery and lifecycle | todo | > 4.0 | browsers/01 |
| browsers | 03 | Require native browser smoke coverage | todo | > 4.0 | browsers/02 |
| runes | 01 | Separate portable contracts from mod tests | todo | > 4.0 | none |
| runes | 02 | Open and retain runes artifacts across platforms | todo | > 4.0 | runes/01 |
| runes | 03 | Port the explain checker off macOS | todo | > 4.0 | runes/02 |
| herdr | 01 | Repair Windows test path assumptions | todo | > 4.0 | none |
| herdr | 02 | Support Windows ask and browser CLI boundaries | todo | > 4.0 | herdr/01 |
| platform | 01 | Gate browser and UI portability in CI | todo | > 4.0 | browsers/03, runes/03, herdr/02 |
| platform | 02 | Document support boundaries and owed checks | todo | > 4.0 | platform/01 |
| review | 01 | Verify integrated browser and UI portability | todo | > 4.0 | platform/02 |

Run options: all review lenses on Codex headless; Standard tier; 11 tasks in 5 buckets; no design phase.

### Task boundaries

- browsers/01 owns fixture and test-environment corrections without changing product behavior.
- browsers/02 owns native discovery, scratch roots, lifecycle, WSL Linux-only discovery, and the Safari and Windows Firefox/Zen refusals.
- browsers/03 owns live test coverage and explicit required-browser smoke behavior.
- runes/01 owns platform test scaffolding, host fixtures and isolated Bun contract entrypoints.
- runes/02 owns home resolution (including minimap and teacher), scratch paths, openers, previews and recoverable deletion.
- runes/03 owns checker Chrome discovery, the screenshot helper, its permissions, containment and settle wiring.
- herdr/01 owns the inventory's test-path corrections.
- herdr/02 owns ask scratch paths, browser CLI resolution and platform diagnostics.
- platform/01 owns workflow changes and repeatable CI verification commands.
- platform/02 owns root support documentation and affected skill instructions.
- review/01 owns integration, goal coverage, regressions, consistency and leanness.

## Cross-bucket dependencies

Run the three plugin foundations in parallel. Sequence product changes within each plugin. Start CI integration only after all plugin branches finish. Update support claims against the resulting CI contract. Run final review last.

## Verification

- Run bun test packages/browsers packages/herdr.
- Run bunx --bun tsc --noEmit from the repository root.
- Run claude plugin test packages/runes for the complete mod suite.
- Run claude plugin validate packages/runes.
- Run isolated Bun platform contracts and hooks/explain/themes.spec.ts from packages/runes; define the exact commands in runes/01.
- Run Chrome live smoke on all three CI operating systems and Firefox on macOS and Linux, covering open, interaction, screenshot and close.
- Run deterministic platform tests with injected Windows, Linux and WSL inputs.
- Run the existing required and smoke jobs after CI integration.
- Review the complete leg diff against the execution base commit.
- Keep an owed-check ledger outside task gate checkboxes, because mark-done.ts also ticks human items.

Use Correctness×3, Test coverage×2, Interface & readability×1 and Assumptions & docs×1. Require weighted average >4.0 and Correctness >=4. Define task-specific anchors in each task.

Use Integration×3, Goal coverage×3, No regressions×2, Consistency×1 and Leanness×1 for final review. Require average >4.0, with Integration or Goal coverage below 4 vetoing completion.

## Failure modes and rollback

- Fail discovery and connection attempts with actionable diagnostics.
- Keep a failed opening or checking operation from losing its HTML explanation.
- Restrict cleanup to resources created for the selected instance or check.
- Revert the affected plugin change to roll back behavior; introduce no persisted-data migration.
- Keep new CI gates blocking once introduced; fix portability failures rather than hiding them with broad skips.

## Open questions

None block the plan. Record installed binary versions and remaining environment limitations during execution.

## Known gaps

- Native Windows supports Chrome only; WSL uses Linux browsers only.
- The complete runes mod suite is a local execution gate. Three-OS Bun contracts do not prove the Claude Code mod works on those operating systems.
- Windows and WSL mod rendering, browser panes and end-to-end workflows remain owed human checks.
- Zen live verification remains owed unless a reproducible CI installation is established during execution.
- Headless unit and native-browser CI results cannot establish real WSL lifecycle behavior.
- Commit d22da40 remains local until separately authorized for push.

## References

- docs/windows-support/WAYPOINTS.md
- docs/windows-support/legs/02-core-workflow/WINDOWS-FAILURES.md
- docs/windows-support/legs/02-core-workflow/tasks/_context/windows.md
- https://learn.microsoft.com/en-us/windows/wsl/filesystems

## Planning review checkpoint

Codex's draft converged after six tree passes, but the review loop had grown scope past the roadmap goal. The 2026-10-29 review removed the WSL-to-Windows fallback task, limited native Windows to Chrome, cut the checker task to six portability changes (dropping the job/lock/cancel lifecycle, which fixed a race present on every OS), and added the minimap and teacher `HOME` readers to runes/02. The tree is now 11 tasks.

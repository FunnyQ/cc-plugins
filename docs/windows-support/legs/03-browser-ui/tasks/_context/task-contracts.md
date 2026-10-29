# Approved task authoring contracts

Use the following fixed numbering, dependency edges, ownership and verification when authoring tasks. Each resulting task must inline its own contract rather than sending the executor to another task. Read the shared rubric and relevant domain context first. Write at most 11 declared file entries per task; directory entries may name a tightly bounded test family, not hide unrelated changes. Adjust helper signatures only when the existing code demands it, and reconcile all affected context before fan-out.

Every task starts todo. Every non-final task uses the common weighted rubric. Only the one entry marked high effort carries `> **Models**: dev=opus/high`. Only the closing task carries `> **Final review**: true`. Leave changes unstaged; do not implement while authoring task files.

## browsers/01 — test-env

- Output: tasks/browsers/01-test-env.md.
- H1: BROWSERS-01: Repair portable browser test fixtures.
- Depends on: none — foundation task. Blocks: browsers/02.
- Required reading: shared.md, rubric.md, windows.md, browsers.md.
- Own existing test fixture corrections in skills/shared/{instances,webdriver}.test.ts and skills/{chrome,firefox,safari}/scripts/*.test.ts under packages/browsers, excluding new behavior assertions owned by product tasks.
- Correct real filesystem path expectations, home/temp isolation and spawned fake executable fixtures. Keep protocol strings and pure parser fixtures unchanged when their POSIX spelling is intentional data.
- Do not add Windows discovery, change production state paths or skip unsupported-browser failures wholesale. Existing absent-browser live tests may remain optional locally.
- Verify `bun test packages/browsers` and `bunx --bun tsc --noEmit`.
- Anchor correctness in platform-neutral fixtures without hiding product failures; distinguish a known unimplemented product branch from a fixture failure in the task report.

## browsers/02 — native-platform-support

- Output: tasks/browsers/02-native-platform-support.md.
- H1: BROWSERS-02: Support native browser discovery and lifecycle.
- Depends on: browsers/01. Blocks: browsers/03.
- Required reading: shared.md, rubric.md, windows.md, browsers.md.
- Own packages/browsers/skills/shared/{platform.ts,platform.test.ts,instances.ts,instances.test.ts}, chrome/scripts/{chrome.ts,chrome.test.ts}, firefox/scripts/{firefox.ts,firefox.test.ts}, safari/scripts/{safari.ts,safari.test.ts}.
- Implement browserCandidates, browserStateDir and executable-aware lookup per the support matrix in browsers.md. Keep caller contracts coherent across Chrome/Firefox/Zen and retain existing macOS order. On WSL, search Linux candidates only and add the Linux-install hint to the discovery error.
- Reject Safari CLI execution on non-darwin, and Firefox/Zen CLI execution on native Windows, before filesystem or spawn operations. Keep imported parsers usable everywhere.
- Implement Q_BROWSER_STATE_DIR private-root support and immediate provisional instance records for safe smoke cleanup before open returns an id. Test discovery ordering, Windows environment roots, missing/not-executable candidates, native state paths, reuse and ownership-aware shutdown. Test the actual CLI failure for Safari on a non-macOS platform via an injectable CLI boundary or native CI assertion.
- Verify `bun test packages/browsers` and root `bunx --bun tsc --noEmit`.

## browsers/03 — live-smoke-contracts

- Output: tasks/browsers/03-live-smoke-contracts.md.
- H1: BROWSERS-03: Require native browser smoke coverage.
- Depends on: browsers/02. Blocks: platform/01.
- Required reading: shared.md, rubric.md, browsers.md, verification.md.
- Own .github/scripts/{browser-smoke.ts,browser-smoke.test.ts} and packages/browsers/skills/{chrome,firefox,safari}/scripts/*.live.test.ts.
- Add the runner with optional --check-prerequisites, consistent nonzero failures, actual Chrome/Firefox version/path reporting and controlled local/data pages. Require Chrome on every OS and Firefox on macOS and Linux in the runner, and assert the Firefox refusal on native Windows, even though ordinary optional live tests may skip.
- Allocate a private Q_BROWSER_STATE_DIR before each browser launch and use it for cleanup on timeout before id output, never shared-registry differences. Test concurrent unrelated launch preservation. Exercise open, reuse through a fresh CLI process, interaction, text/eval, PNG screenshot and owned close. Test absent prerequisites and fail propagation with injected child operations. Never install a user dependency as a side effect.
- Preserve Safari's macOS opt-in and keep Zen live checking owed unless a reproducible CI installation is available.
- Verify `bun test .github/scripts/browser-smoke.test.ts`, `bun .github/scripts/browser-smoke.ts`, `bun test packages/browsers`, and root tsc. Record installed browser versions rather than assume availability.

## runes/01 — portable-test-contracts

- Output: tasks/runes/01-portable-test-contracts.md.
- H1: RUNES-01: Separate portable contracts from mod tests.
- Depends on: none — foundation task. Blocks: runes/02.
- Required reading: shared.md, rubric.md, windows.md, runes.md, verification.md.
- Own packages/runes/hooks/platform.spec.ts and existing mod host fixtures in hooks/transcript/test-session.ts, hooks/runes.test.tsx and hooks/explain/{explain,checker}.test.ts where fixture plumbing needs extension.
- Establish the Bun contract entrypoint without importing claude-code/testing into it. Start with executable environment/fixture contracts; product regressions and implementations follow in product tasks, not fake passing stubs.
- Add fixture support for USERPROFILE with HOME absent/empty, native platform snapshots and injectable process results. Keep in-memory filesystem fixtures isolated; no test may write the real profile.
- Keep root exclusions intact. Keep .spec.ts distinct from the mod runner's .test.ts/.test.tsx collection. Preserve existing tests, including the full 428-test baseline, while extending fixtures.
- Verify `claude plugin test packages/runes`, `claude plugin validate packages/runes`, and `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)`.

## runes/02 — platform-actions

- Output: tasks/runes/02-platform-actions.md.
- H1: RUNES-02: Open and retain runes artifacts across platforms.
- Depends on: runes/01. Blocks: runes/03.
- Required reading: shared.md, rubric.md, windows.md, runes.md.
- Own packages/runes/hooks/{platform.ts,platform-cli.ts,platform.spec.ts,register.tsx}, transcript/{quicklook.ts,open-raw.ts,open-image.ts,glow.ts}, minimap/index.ts, teacher/lessons-cli.ts, explain/explain.ts and bounded adjacent mod regression tests.
- Update transcript/test-session.ts only to recognize the exact platform runtime probe while retaining injected snapshots, failures and strict rejection of unhandled commands.
- Implement RuntimeInfo and closed JSON-stdin platform operations from runes.md, including recursive mkdir replacing explain's Unix mkdir -p call. Test first-run generation without Unix mkdir. Populate platform data without assuming a Bun runtime inside the mod. Keep engine objects local to their hook module.
- Resolve HOME/USERPROFILE, including the three direct `process.env.HOME` readers in runes.md, preserve persisted config/data roots and use native Windows scratch paths. Make glow's home environment and install hint portable while preserving missing-glow fallback.
- Keep Quick Look on macOS and use file openers elsewhere. Reopen explanations through the same operation contract the checker can call. Convert WSL local paths and keep arbitrary paths out of shell source.
- Implement recoverable page deletion; preserve files and report failure when trash is unavailable. Keep PNG cleanup a separate exact-file operation (cleanup-check).
- Test actual Bun-child stdin parsing plus mocked mod operation calls, opener failures, missing HOME, spaces/CJK/metacharacters and failed recycling. Do not claim a planned argv array proves cmd parsing works.
- Verify the full mod suite, plugin validation and isolated platform/theme Bun contracts using the commands in shared.md.

## runes/03 — portable-explain-checker

- Output: tasks/runes/03-portable-explain-checker.md.
- H1: RUNES-03: Port the explain checker off macOS.
- Depends on: runes/02. Blocks: platform/01. Models: dev=opus/high.
- Required reading: shared.md, rubric.md, windows.md, runes.md.
- Own packages/runes/hooks/explain/{checker.ts,checker.test.ts,checker-cli.ts,geometry-cli.ts} and hooks/{platform-cli.ts,platform.spec.ts}.
- Apply exactly the six checker changes in runes.md: RuntimeInfo.chrome discovery (Linux Chrome only on WSL), the fixed checker-cli.ts screenshot helper, exact-match Bash permission, fixed Read/Edit containment, shared opener plus cleanup-check at settle, and pathToFileURL in geometry-cli.ts.
- Keep the existing cN tokens, pending map, timeout, late-verdict isolation and missing-Chrome skip unchanged. Add no job manifest, lock, process tracking or cancel operation.
- Test Windows-looking paths on macOS by injecting Windows semantics rather than relying on host path.join. Cover spaces, CJK, metacharacters, sibling prefixes, case aliases, `..` and a page path that falls back to normal permission.
- Verify full mod tests, plugin validation, isolated Bun contracts and root tsc for applicable Bun-side code. A successful root tsc alone does not validate the mod.

## herdr/01 — test-env

- Output: tasks/herdr/01-test-env.md.
- H1: HERDR-01: Repair Windows test path assumptions.
- Depends on: none — foundation task. Blocks: herdr/02.
- Required reading: shared.md, rubric.md, windows.md.
- Own packages/herdr/skills/herdr/scripts/{ask-contract.test.ts,herd.test.ts,project-registry.test.ts} and bounded fixture corrections in skills/herdr-browser/scripts/{browser,terminal-browser}.test.ts.
- Normalize Bun.Glob paths before matching skills/herdr/scripts/; the inventory's empty caller list must find the actual caller. Replace import.meta.resolve(...).replace("file://", "") with fileURLToPath for herd.ts command expectations. Compare current ask scratch paths with host-aware expectations without silently changing the product root in this task.
- Isolate HOME/USERPROFILE and TMPDIR/TEMP/TMP where fixtures override them. Preserve CLI protocol assertions and pane/workspace semantics.
- Verify `bun test packages/herdr` and root tsc. Do not import browser or relay plugin helpers.

## herdr/02 — platform-support

- Output: tasks/herdr/02-platform-support.md.
- H1: HERDR-02: Support Windows ask and browser CLI boundaries.
- Depends on: herdr/01. Blocks: platform/01.
- Required reading: shared.md, rubric.md, windows.md, verification.md.
- Own packages/herdr/skills/herdr/scripts/{ask-contract.ts,ask-contract.test.ts,project-registry.ts,project-registry.test.ts}, skills/herdr-browser/scripts/{browser.ts,browser.test.ts,terminal-browser.ts,terminal-browser.test.ts}.
- Make createAskRunDir(exactDir?) use native Windows temp while retaining the exact override and existing Unix roots. Preserve collision resistance and result-file contracts.
- Audit and preserve existing HERDR_BIN_PATH handling in browser.ts and herd.ts; add a regression test or repair only a concrete bypassing caller. Keep terminal-browser selection and all current --view, tab, workspace and cleanup rules.
- Give accurate missing-dependency instructions for the current platform; do not recommend an unverified Windows installer. Use the CLI for pipe/socket abstraction.
- Normalize Windows path queries in project matching and temporary-path filtering only where current path-based behavior requires it; preserve registry schema and ranking. Add concrete regression tests rather than rewriting the registry layer.
- Verify `bun test packages/herdr` and root tsc. Mark real Herdr/terminal-browser native Windows and WSL pane operations as human owed.

## platform/01 — ci-gates

- Output: tasks/platform/01-ci-gates.md.
- H1: PLATFORM-01: Gate browser and UI portability in CI.
- Depends on: browsers/03, runes/03, herdr/02. Blocks: platform/02.
- Required reading: shared.md, rubric.md, windows.md, verification.md.
- Own .github/workflows/ci.yml and .github/scripts/browser-smoke.ts only if CI invocation/provisioning integration needs a correction. Preserve previously landed core gates and the report job.
- Add browsers/herdr to required, run the isolated runes contracts with package cwd and require native Chrome smoke on all three OS plus Firefox on macOS and Linux. Keep root exclusions intact.
- Prefer image-installed browsers; explicitly provision an absent required browser from an official source rather than adding a skip. Print prerequisite/version evidence.
- Verify root tsc, `bun test packages/browsers packages/herdr .github/scripts/browser-smoke.test.ts`, isolated runes contracts, and real browser smoke locally. Inspect all matrix branches. Tag remote PR CI outcome as human owed until an actual implementation PR exists; do not require an unauthorized push for a local task gate.

## platform/02 — support-docs

- Output: tasks/platform/02-support-docs.md.
- H1: PLATFORM-02: Document support boundaries and owed checks.
- Depends on: platform/01. Blocks: review/01.
- Required reading: shared.md, rubric.md, browsers.md, runes.md, verification.md.
- Own README.md, CLAUDE.md, packages/browsers/skills/{chrome,firefox,safari}/SKILL.md, packages/herdr/skills/herdr-browser/SKILL.md and docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md.
- Document installed browser search, the support matrix (Chrome only on native Windows, Safari macOS only), system openers, missing prerequisites and WSL's Linux-browser-only rule. Keep runes checker Linux-only on WSL explicit.
- Record the separate full mod command, isolated Bun command and CI smoke command. Distinguish evidence from unsupported or unverified claims.
- Initialize the owed ledger exactly as verification.md specifies, including remote implementation-PR CI and the fixed count 0 → 1 pane scenario. Preserve leg-2 debts and leave the roadmap active; do not release or mark leg 3 done.
- Verify referenced paths exist and commands match implemented entrypoints. Use `bun .github/scripts/browser-smoke.ts --check-prerequisites` and `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` to check documented commands.

## review/01 — final-review

- Output: tasks/review/01-final-review.md.
- H1: REVIEW-01: Verify integrated browser and UI portability.
- Depends on: platform/02. Blocks: none. Final review: true.
- Required reading: shared.md, rubric.md, windows.md, browsers.md, runes.md, verification.md.
- Own docs/windows-support/legs/03-browser-ui/REVIEW.md and narrowly scoped integration fixes in the already-declared plugin/CI/documentation surface.
- Inspect the entire execution diff using <baseRef>, including earlier committed waves. Confirm every branch reaches the closing gate and support claims agree with actual automated/human evidence.
- Run `bun test packages/browsers packages/herdr .github/scripts/browser-smoke.test.ts`, root tsc, the complete runes mod suite and validation, isolated platform/theme contracts and the real native browser smoke.
- Review native process/profile cleanup, the Firefox/Zen Windows refusal, Safari refusal and checker permissions together. Record owed human checks in the persistent ledger; never present their task checkboxes as proof of completion.
- Write exact command outcomes, versions, changed-file list, limits and outstanding debts to REVIEW.md. Use the exact path in every report acceptance criterion. Add (human) checks for actual Windows/WSL pane/mod/Zen operations and remote CI, with machine-verifiable gates alongside them.
- Use the final Integration/Goal coverage/No regressions/Consistency/Leanness rubric from rubric.md. Run appropriate tests after final fixes. Do not push, merge, release or implement deferred Windows Firefox/Zen or WSL-to-Windows browser support.

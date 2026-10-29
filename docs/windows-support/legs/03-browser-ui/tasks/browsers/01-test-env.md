# BROWSERS-01: Repair portable browser test fixtures.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/browsers.md`
>
> **Depends on**: none — foundation task
> **Blocks**: browsers/02
> **Status**: done

## Goal

Make the existing browser test fixtures portable without changing product behavior or hiding platform failures.

## Files to create / modify

- `packages/browsers/skills/shared/instances.test.ts` — correct fixture paths only where they represent real filesystem locations.
- `packages/browsers/skills/shared/webdriver.test.ts` — preserve protocol and parser contracts while repairing any actual host assumptions.
- `packages/browsers/skills/chrome/scripts/chrome.test.ts` — isolate any process, environment or filesystem fixture.
- `packages/browsers/skills/chrome/scripts/chrome.live.test.ts` — correct existing fixture paths and child-process setup without changing live-test selection.
- `packages/browsers/skills/firefox/scripts/firefox.test.ts` — correct host-dependent fixture assumptions.
- `packages/browsers/skills/firefox/scripts/firefox.live.test.ts` — correct existing filesystem and executable fixtures.
- `packages/browsers/skills/firefox/scripts/marionette.test.ts` — preserve byte-framing assertions and repair only concrete fixture assumptions.
- `packages/browsers/skills/safari/scripts/safari.test.ts` — keep pure parser and WebDriver response assertions portable.
- `packages/browsers/skills/safari/scripts/safari.live.test.ts` — preserve the macOS opt-in while correcting fixture mechanics.

These are the allowed test files, not a requirement to edit every file. Leave a fixture unchanged when its current behavior is already portable.

## Implementation notes

### Separate fixture data from host paths

Run the existing suite before editing. Classify each observed failure as fixture-only, product behavior or an operation impossible on the filesystem. Repair fixture-only cases here. Keep browser discovery, scratch roots, launch lifecycle and Safari's executable platform refusal out of this change.

Use `join`, `resolve` or `fileURLToPath` for actual filesystem and executable locations. Use `realpathSync.native` when comparing existing paths whose Windows spelling may use an 8.3 alias. Normalize separators only for comparisons whose meaning is separator-independent.

Keep literals such as `/a`, `/b`, `/tmp/id` and macOS app paths when they are opaque data consumed only by a pure function or injected lookup. Do not rewrite protocol payloads, URLs, key code points or parser expectations merely because they resemble paths. Use `path.win32` or `path.posix` when a test intentionally constructs a foreign-platform path; the host `join` does not follow an injected platform value.

### Isolate temporary files and child processes

If a fixture overrides `HOME`, also override `USERPROFILE`. If it overrides `TMPDIR`, also override `TEMP` and `TMP`. Restore process-global overrides after the test and preserve unrelated host environment entries. Remove a pre-existing PATH entry case-insensitively before replacing it, because Windows may spell it `Path`.

If a fixture needs a fake executable on Windows, write a `.cmd` wrapper that invokes the fake Bun script, with CRLF termination. Never directly spawn an extensionless shebang file on Windows. Pass arbitrary fixture text through stdin rather than a `.cmd` argument containing shell-special characters. Invoke Bash explicitly only when the test is testing shell code.

Keep fixture creation and cleanup inside an owned temporary directory. Await owned children before removing files they use. For a parent-hosted HTTP fixture, use asynchronous browser child calls so the parent can continue serving requests.

### Preserve honest coverage

Keep currently optional absent-browser live tests optional locally. Preserve Safari's explicit live opt-in and avoid opening a visible Safari window during an ordinary suite run. Do not add broad Windows skips, weaken assertions or add the future required-smoke contract here.

When the audit finds no fixture defect in a listed file, leave that file untouched. Distinguish any remaining product failure from a fixture failure in execution notes; do not change product behavior to make this foundation task pass.

## Acceptance criteria

- [x] Changed files are limited to concrete fixture corrections in the declared test files; product modules and browser selection behavior remain unchanged.
- [x] Real filesystem and executable expectations use host-aware path construction and native canonicalization where identity requires it; intentional pure-function path strings and protocol bytes retain their meaning.
- [x] Every home/temp override in touched fixtures isolates the Windows counterparts and restores process-global environment changes after use.
- [x] Any touched fake executable fixture uses a runnable Windows wrapper or explicit shell invocation, with arbitrary text kept out of unsafe `.cmd` arguments.
- [x] Temporary files and owned subprocesses are cleaned up without deleting shared state or blocking a parent-hosted test server.
- [x] Existing failure assertions remain effective, local absent-browser skips remain optional, and no broad platform skip substitutes for a fixture repair.

## Verification

- [x] Run `bun test packages/browsers` before editing and record the baseline.
- [x] Run `bun test packages/browsers` after fixture corrections; require exit 0 on the execution host.
- [x] Run `bunx --bun tsc --noEmit` from the repository root; require exit 0.
- [x] Inspect `git diff -- packages/browsers` and confirm each changed assertion still checks the same behavior and each skip names a genuine prerequisite or impossible platform fact.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Fixtures still assume POSIX execution or product changes hide failures. | Common fixture paths work but environment or executable assumptions remain. | Concrete fixture defects are repaired while product semantics and intentional protocol data remain intact. |
| Test coverage | ×2 | Assertions are removed or platform skips hide failures. | The suite passes locally but fixture failure paths or cleanup are unexamined. | Existing assertions survive, touched fixtures cover their failure mechanics, and absent-browser behavior remains explicit. |
| Interface & readability | ×1 | A new fixture framework obscures simple setup. | Setup works but path and environment intent are unclear. | Small local fixture changes identify actual host resources and preserve surrounding test style. |
| Assumptions & docs | ×1 | A local run is claimed as native Windows proof. | Platform limits are noted without distinguishing fixture and product failures. | Execution notes distinguish fixture corrections, product limitations, optional live prerequisites and the host actually tested. |

## Out of scope

- Native browser discovery, product scratch paths and lifecycle changes — keep behavior changes separate from fixture repairs.
- Required browser smoke — implement after portable test foundations exist.
- New browser installation or a real Windows/WSL run — preserve prerequisites and report unavailable environments without claiming verification.

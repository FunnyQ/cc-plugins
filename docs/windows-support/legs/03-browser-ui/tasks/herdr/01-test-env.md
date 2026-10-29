# HERDR-01: Repair Windows test path assumptions.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
>
> **Depends on**: none — foundation task
> **Blocks**: herdr/02
> **Status**: todo

## Goal

Make Herdr's existing test fixtures portable across native Windows, Linux and macOS without changing product behavior or weakening CLI contracts.

## Files to create / modify

- `packages/herdr/skills/herdr/scripts/ask-contract.test.ts` — correct scratch-path expectations, source discovery and owned fixture cleanup.
- `packages/herdr/skills/herdr/scripts/herd.test.ts` — convert the collect-command module URL into a native filesystem path.
- `packages/herdr/skills/herdr/scripts/project-registry.test.ts` — repair concrete path or environment fixture assumptions if found.
- `packages/herdr/skills/herdr-browser/scripts/browser.test.ts` — repair concrete fixture assumptions while preserving pane and workspace targeting assertions.
- `packages/herdr/skills/herdr-browser/scripts/terminal-browser.test.ts` — repair concrete fixture assumptions while preserving terminal-browser protocol assertions.

These are allowed test files, not a requirement to edit every file. Leave already-portable fixtures unchanged. Do not modify production modules in this task.

## Implementation notes

### Correct source discovery without hiding its assertion

In `ask-contract.test.ts`, `Bun.Glob.scanSync` returns backslash-separated relative paths on Windows. Normalize each scanned source path with `replaceAll("\\", "/")` before filtering for `skills/herdr/scripts/` and comparing the discovered caller list. Keep file reads host-aware through `join(herdrRoot, relativePath)`.

The package-boundary test must still inspect the actual source files and find exactly `skills/herdr/scripts/ask-contract.ts` as the result-directory creation seam. Do not replace the scan with a hardcoded source list, remove the caller assertion or make it pass for an empty list. Preserve the independently-versioned-plugin import check.

### Compare filesystem paths using the host's spelling

The current `createAskRunDir(exactDir?: string): string` default joins `/tmp/q-lab/herdr/ask` with a unique leaf. Preserve that product behavior here. Build the test's current-root expectation with host path helpers rather than a raw `startsWith("/tmp/q-lab/herdr/ask/")`. Assert the returned directory belongs to that root and that two calls remain distinct. Do not change the expected native Windows root to system temp before the product implements that behavior.

Keep exact-directory override assertions byte-for-byte exact. Put owned directory cleanup in `finally` blocks so a failed assertion cannot leave created directories behind. Do not delete a shared scratch root or another test's leaf.

In `herd.test.ts`, replace the expected module path produced by `import.meta.resolve("./herd.ts").replace("file://", "")` with `fileURLToPath(import.meta.resolve("./herd.ts"))`, imported from `node:url`. The collect-command report prints a native path; stripping the URL prefix yields an invalid `/D:/...` expectation on Windows. Preserve assertions that the report contains `collect`, the result path and the executable module path.

### Keep fixture repairs separate from product changes

Run the existing suite before edits. Classify observed failures as test-only assumptions, product behavior or impossible platform operations. Repair only test-only assumptions here. Do not rewrite the registry matching algorithm, change ask scratch state, change binary resolution or alter live pane behavior.

Where a touched fixture overrides `HOME`, also override `USERPROFILE`. Where it overrides `TMPDIR`, also override `TEMP` and `TMP`. Restore process-global overrides after the test. Preserve unrelated environment entries and handle `PATH`/`Path` case-insensitively when replacing a child search path. Never make a test read or write the real user profile.

Use `join`, `resolve` and native canonicalization for real host filesystem locations. Keep protocol strings, opaque parser inputs, pane IDs, workspace IDs and registry data unchanged when their spelling is intentional test data. Use injected Windows path semantics for a test of Windows behavior on another host; host `path.join` does not follow an injected platform.

Do not add broad Windows skips or import helpers from the browsers or relay plugins. Preserve failure assertions and exact CLI protocol shapes. Record any remaining product defect separately rather than changing product behavior to force this foundation task to pass.

## Acceptance criteria

- [ ] Source discovery normalizes separators before filtering and still inspects actual files, finding exactly the result-directory creation seam instead of accepting an empty caller list.
- [ ] Ask-directory tests assert collision resistance, exact overrides and the current host-shaped default root without prematurely changing product scratch behavior.
- [ ] The pending collect-command expectation uses `fileURLToPath` and still verifies the report's collect action, result path and native module path.
- [ ] Touched filesystem and environment fixtures isolate their own resources, restore overrides and clean up owned leaves even when assertions fail.
- [ ] Pane targeting, workspace selection, registry ranking, result-file and CLI protocol assertions retain their existing meaning; no broad platform skip or hardcoded source list hides failures.
- [ ] Changes stay within the declared test files, production modules remain unchanged, and no fixture imports another plugin's helpers.

## Verification

- [ ] Run `bun test packages/herdr` from the repository root before editing and record the baseline.
- [ ] Run `bun test packages/herdr` after fixture corrections and require exit 0 on the execution host.
- [ ] Run `bunx --bun tsc --noEmit` from the repository root and require exit 0 with no diagnostics.
- [ ] Inspect `git diff -- packages/herdr/skills/herdr/scripts/ask-contract.test.ts packages/herdr/skills/herdr/scripts/herd.test.ts packages/herdr/skills/herdr/scripts/project-registry.test.ts packages/herdr/skills/herdr-browser/scripts/browser.test.ts packages/herdr/skills/herdr-browser/scripts/terminal-browser.test.ts` and confirm each changed assertion preserves the behavior it tests.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Windows source discovery or collect-path expectations still fail, or product behavior changes to hide the failure. | Main path comparisons work but empty scans, exact overrides or cleanup semantics drift. | Source scanning, native URL conversion and current-root expectations preserve the original behavior across host path spellings. |
| Test coverage | ×2 | Assertions are removed, callers are hardcoded or Windows tests are broadly skipped. | Happy-path assertions survive but discovery emptiness, failure cleanup or environment isolation remain unchecked. | Existing source-boundary and CLI assertions remain effective, with touched resource fixtures covering cleanup and host assumptions. |
| Interface & readability | ×1 | A new fixture framework obscures small path corrections. | Repairs work but normalize protocol strings indiscriminately or leave path intent unclear. | Small local changes distinguish host resources from protocol data and follow surrounding test style. |
| Assumptions & docs | ×1 | A local pass is claimed as real Windows or WSL pane proof. | Execution notes mention portability without separating fixture and product defects. | Execution evidence names the host and distinguishes repaired fixture assumptions, remaining product limits and owed real-platform checks. |

## Out of scope

- Native Windows ask scratch roots, browser CLI resolution and platform dependency messages — keep production behavior separate from fixture corrections.
- Project-registry algorithm changes and Herdr transport implementation — preserve existing CLI and registry contracts.
- Real Windows or WSL pane operations — record unavailable environments without claiming a human run occurred.

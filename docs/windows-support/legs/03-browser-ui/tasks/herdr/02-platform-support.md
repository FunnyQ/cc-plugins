# HERDR-02: Support Windows ask and browser CLI boundaries.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/verification.md`
>
> **Depends on**: herdr/01
> **Blocks**: platform/01
> **Status**: todo

## Goal

Keep Herdr ask results and browser commands portable across native Windows and WSL while preserving CLI transport, target selection and owned-pane cleanup.

## Files to create / modify

- `packages/herdr/skills/herdr/scripts/ask-contract.ts` — select the native Windows scratch root without changing explicit directory overrides.
- `packages/herdr/skills/herdr/scripts/ask-contract.test.ts` — cover roots, collision resistance and result-file compatibility.
- `packages/herdr/skills/herdr/scripts/project-registry.ts` — normalize path matching and temporary-path filtering where Windows inputs require it.
- `packages/herdr/skills/herdr/scripts/project-registry.test.ts` — reproduce Windows path-query and temporary-directory failures.
- `packages/herdr/skills/herdr-browser/scripts/browser.ts` — preserve executable overrides and platform-safe CLI invocation and cleanup.
- `packages/herdr/skills/herdr-browser/scripts/browser.test.ts` — verify CLI executable selection, target behavior and failure cleanup.
- `packages/herdr/skills/herdr-browser/scripts/terminal-browser.ts` — produce platform-appropriate missing-prerequisite diagnostics.
- `packages/herdr/skills/herdr-browser/scripts/terminal-browser.test.ts` — cover diagnostics and preserved terminal-browser contracts.

## Implementation notes

### Keep the ask result-file contract

Preserve this public entrypoint:

```ts
export function createAskRunDir(exactDir?: string): string;
```

When `exactDir` is supplied, create and return that directory without changing its spelling or appending a generated leaf. Otherwise, use `join(tmpdir(), "q-lab", "herdr", "ask", leaf)` on native Windows and retain `/tmp/q-lab/herdr/ask/<leaf>` on macOS and Linux, including WSL. Keep the leaf's timestamp, process id and random UUID component so concurrent calls do not collide. Create the directory recursively and keep its ownership local to the ask run.

Inject platform and temporary-root inputs through a small internal helper or existing test seam; keep the public entrypoint compatible. Use `path.win32` when a test constructs an injected Windows expectation on a non-Windows host. When comparing existing directories for identity, use `realpathSync.native` on both sides so 8.3 aliases do not cause false mismatches.

Keep `appendFileContract(question, resultPath)` and `extractFinalText(content)` unchanged in meaning. Preserve the final-line marker `==== ASK RESULT END ====`, the complete-answer requirement and the explicit result path. Do not replace result-file collection with pane text or alter the read/collect protocol.

### Preserve the CLI execution boundary

Keep `process.env.HERDR_BIN_PATH || "herdr"` as the executable selection for every browser-related Herdr invocation. The current browser module already defines and uses this override; audit all tab/pane call sites and preserve existing assertions. Add a regression only for a demonstrated bypass or missing invariant coverage; do not edit working product calls merely to create a diff. Treat an executable path containing spaces as one argv element. Keep commands as argv data; do not concatenate paths or user text into shell source.

Continue to invoke the installed Herdr CLI and terminal-browser CLI. Let Herdr own Unix-socket and Windows named-pipe transport. Do not add a direct socket client, a Windows pipe implementation or a dependency installation side effect.

Preserve `--view` disambiguation, workspace-qualified tab creation, `HERDR_PANE_ID` targeting, `--new` behavior and split/ratio validation. Keep a newly created browser in its own Herdr tab when no split is requested. On a failed open, close only the tab or pane created for that operation. Never close the initiating pane, another browser view or an unrelated tab. Preserve the distinction between terminal-browser's own tab identifiers and raw CDP target identifiers.

### Diagnose missing prerequisites

When terminal-browser or Herdr cannot be found, name the missing executable and give instructions appropriate to the process's platform. Do not show a Bash-only installer as a native Windows solution. If no Windows installer has been verified, state that the dependency must be installed for native Windows or that an available WSL installation can be used; do not invent an installation command. Keep Unix installation guidance only where it applies, and never execute it automatically.

Test the diagnostics with injected platform/executable-availability inputs. Distinguish missing executables from a found CLI that returns an error. Propagate the latter error without mislabeling the installation as absent.

### Normalize path queries without changing the registry

Preserve registry version 1, the existing project entries and aliases, hidden-entry filtering, timestamp ordering and zoxide ranking. Keep the registry read-only. Add narrowly scoped matching normalization so a Windows path query such as `C:\\Projects\\demo` can match a stored spelling such as `C:/Projects/demo` without changing the stored path returned to callers. Preserve case-insensitive matching and existing slash-separated query semantics.

Extend temporary-path filtering only for concrete Windows temporary locations, using the system temp root and separator-aware containment. Reject the temp root and descendants without rejecting a sibling that merely shares its prefix. Preserve the existing Unix temporary-directory exclusions. Keep matching and filtering tests deterministic by injecting environment-derived roots; do not read or rewrite a real project registry.

### Fixed human pane scenario

Use a controlled data/local HTML page with title "Pane check", a button #increment labelled "Increment" and a visible #count initialized to 0. Clicking Increment must set #count to 1. Record the initiating pane id, open a fresh browser view with --new, select it explicitly with --view, and verify snapshot identifies Increment and count 0. Click Increment, require text/eval and screenshot to show count 1, then close only the new view and confirm the initiating pane and an unrelated view remain open. Record command outputs, view/pane ids and screenshot evidence; an exit code alone is insufficient.

## Acceptance criteria

- [ ] Tests prove the generated ask directory uses system temp on native Windows, retains the existing Unix root on macOS/Linux/WSL, preserves an explicit `exactDir`, and remains collision-resistant across repeated calls.
- [ ] Result-file tests preserve the final marker and complete-answer extraction behavior; path changes do not alter the ask contract or substitute pane output for the result file.
- [ ] Browser CLI tests prove all Herdr tab/pane calls honor `HERDR_BIN_PATH`, including a spaced executable path, while retaining workspace targeting, `--view` disambiguation and split/new behavior.
- [ ] Failure tests prove cleanup targets only the tab or pane created by the failed browser operation and preserves initiating panes, unrelated tabs and other browser views.
- [ ] Platform-specific missing-prerequisite tests name the correct dependency, avoid unverified Windows install commands, distinguish missing binaries from CLI failures, and perform no installation.
- [ ] Registry regression tests cover Windows slash/case queries and temporary-root containment without changing persisted schema, stored path spelling, ranking, hidden-entry behavior or existing Unix exclusions.
- [ ] (human) On native Windows and WSL, open and drive a real Herdr terminal-browser pane through selection, screenshot and close; keep the check owed until actual evidence is recorded in the separate verification ledger.

## Verification

- [ ] Run `bun test packages/herdr` from the repository root and require exit 0 with no failing tests.
- [ ] Run `bunx --bun tsc --noEmit` from the repository root and require exit 0 with no diagnostics.
- [ ] Inspect `git diff -- packages/herdr/skills/herdr/scripts packages/herdr/skills/herdr-browser/scripts` and confirm product changes retain the result-file marker, CLI transport and existing pane/workspace contracts.
- [ ] (human) Run the fixed human pane scenario on native Windows and WSL, requiring count 0 → 1 and preservation of the initiating pane and unrelated view; record the environment and evidence when hardware is available rather than treating mocked tests as that run.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Ask paths remain non-portable or browser changes target unrelated panes. | Common paths work but overrides, target selection or failed-open cleanup drift. | Platform roots, exact overrides, result-file collection, CLI executable selection and owned cleanup preserve their contracts. |
| Test coverage | ×2 | Windows branches are untested or broad skips hide failures. | Happy paths pass but path containment, CLI errors or cleanup ownership lack regressions. | Injected-platform and CLI tests cover roots, path queries, missing dependencies, explicit overrides and failed-open ownership. |
| Interface & readability | ×1 | A registry rewrite or new transport framework obscures the platform fixes. | Helpers work but duplicate executable selection or mix matching with persisted data changes. | Small plugin-local changes preserve public entrypoints, CLI transport and stored registry data. |
| Assumptions & docs | ×1 | Mocked calls are claimed as real Windows/WSL pane proof or diagnostics invent an installer. | Platform limits are mentioned without distinguishing actual and owed evidence. | Diagnostics match verified prerequisites and execution notes distinguish automated coverage from owed real pane operations. |

## Out of scope

- Porting Herdr or terminal-browser binaries, adding a named-pipe client or automatically installing prerequisites — keep transport and installation owned by the installed tools.
- Changing project registry schema, ranking or persistence — limit edits to demonstrated path matching and filtering regressions.
- Completing a real Windows/WSL pane check without hardware — retain the owed check and report its evidence limit.

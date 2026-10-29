# PLATFORM-02: Document support boundaries and owed checks.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/browsers.md`
> - `../_context/runes.md`
> - `../_context/verification.md`
>
> **Depends on**: platform/01
> **Blocks**: review/01
> **Status**: done

## Goal

Document the implemented Windows and WSL support accurately and preserve unperformed real-device checks in a durable evidence ledger.

## Files to create / modify

- `README.md` (modify) — describe supported browser/UI behavior, prerequisites and verification limits.
- `CLAUDE.md` (modify) — record platform conventions and exact verification commands.
- `packages/browsers/skills/chrome/SKILL.md` (modify) — document native discovery on macOS, Linux, WSL and Windows.
- `packages/browsers/skills/firefox/SKILL.md` (modify) — document Firefox/Zen discovery on macOS and Linux and the native Windows refusal.
- `packages/browsers/skills/safari/SKILL.md` (modify) — state the macOS-only execution boundary and live-test opt-in.
- `packages/herdr/skills/herdr-browser/SKILL.md` (modify) — describe installed host requirements and platform-specific limitations.
- `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` (new) — retain the environment, status and evidence for each owed operation.

## Implementation notes

### Describe the implemented support boundary

Inspect the implemented entrypoints and CI invocation before writing support claims. Document installed Chrome, Firefox and Zen search behavior and the support matrix — Chrome on every OS, Firefox and Zen on macOS and Linux only, Safari on macOS only — without promising arbitrary portable installations. Name required executables and report missing prerequisites without instructing an automatic installation. Preserve macOS command semantics and Quick Look behavior.

State that on WSL the browsers plugin uses Linux-installed browsers only and never a Windows browser; with none installed, it tells the user to install a Linux build inside WSL. State that native Windows Firefox and Zen refuse with `not supported on Windows`.

State that Safari refuses executable invocations outside macOS with `macOS only`. Keep its visible live test opt-in through `SAFARI_LIVE=1`. Document system openers for explain completion/history and raw/image previews, including WSL path conversion. Keep the runes checker on Linux Chrome in WSL; when absent, explain checking is skipped while opening is still attempted.

For Herdr browser panes, require compatible installed Herdr and terminal-browser binaries. Preserve the current `HERDR_BIN_PATH` behavior and pane/workspace selection contract. Do not claim this repository ports the host binaries or supplies a verified Windows installer. Describe missing dependencies accurately for the platform.

### Keep evidence layers separate

Document the following commands from the repository root:

```sh
bun test packages/browsers packages/herdr
bunx --bun tsc --noEmit
claude plugin test packages/runes
claude plugin validate packages/runes
(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)
bun .github/scripts/browser-smoke.ts
bun .github/scripts/browser-smoke.ts --check-prerequisites
```

Explain that three-OS Bun contracts exercise portable helpers while the complete runes mod suite runs through Claude Code. Root TypeScript exclusions mean a passing root typecheck does not validate the mod. Injected platform tests do not establish real Windows or WSL behavior. Required native smoke fails absent prerequisites; optional local live-test skips are not equivalent evidence.

Report measured versions and actual results when available. Do not convert pending Windows/WSL rendering, pane operations or Zen runs into support proof merely because native CI or a local helper suite passes.

### Preserve owed verification independently

Create `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` during implementation, using columns `Check`, `Environment`, `Status`, `Evidence` and `Last attempted`. Initialize every following check as `owed`. Leave evidence and attempt fields explicitly unrecorded until a real run supplies them:

- Windows native Chrome: open, reuse by id, interaction, file URL, screenshot under a spaced/CJK path, close and cleanup.
- Windows native Firefox and Zen: the CLI refuses with `not supported on Windows`.
- WSL with Linux browsers: discovery, separate instances, screenshot and close; with no Linux browser, the install hint.
- Windows and WSL runes: USERPROFILE initialization, config persistence, explain after checker pass/skip/failure, history reopen, raw/image previews and recoverable deletion.
- Windows and WSL Herdr pane: Use a controlled data/local HTML page with title "Pane check", a button #increment labelled "Increment" and a visible #count initialized to 0. Clicking Increment must set #count to 1. Record the initiating pane id, open a fresh browser view with --new, select it explicitly with --view, and verify snapshot identifies Increment and count 0. Click Increment, require text/eval and screenshot to show count 1, then close only the new view and confirm the initiating pane and an unrelated view remain open. Record command outputs, view/pane ids and screenshot evidence; an exit code alone is insufficient.
- Zen live behavior when no repeatable CI installation is available.
- Remote implementation PR: three-OS required and smoke job results, with run URL and actual outcome; remain owed until an authorized PR runs.

Use additional rows when distinct environments need separate evidence. Mark a check `passed` only after recording an actual run, environment and result. Keep this ledger independent from task gate checkboxes because completion automation ticks human items too. Preserve all leg-2 debts and leave the roadmap's leg-3 state active. Make no release, version, push or merge change.

## Acceptance criteria

- [x] The declared documentation describes implemented browser search, Safari refusal, file openers and Herdr prerequisites without claiming host-binary ports or automatic dependency installation.
- [x] Documentation states the support matrix, WSL's Linux-browser-only rule with its install hint, the Windows Firefox/Zen refusal and Linux-only runes checker behavior on WSL.
- [x] Documented verification commands match existing implemented entrypoints and distinguish three-OS Bun contracts, required native smoke, the full local mod suite and owed real Windows/WSL evidence.
- [x] `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` contains the five specified columns and all seven owed-check groups, initialized without fabricated evidence or completion claims.
- [x] Existing leg-2 debts and the active leg-3 roadmap state remain intact, and no release/version/push/merge operation is introduced by this documentation change.

## Verification

- [x] Run `bun .github/scripts/browser-smoke.ts --check-prerequisites` from the repository root; require measured paths and versions for every browser the host requires, and preserve a nonzero diagnostic when a prerequisite is missing.
- [x] Run `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` and require exit 0, confirming the isolated command is runnable as documented.
- [x] Inspect each declared file and verify that referenced source paths and command entrypoints exist and support claims match actual implementation and CI coverage.
- [x] Inspect `docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` and confirm every required environment/check group remains `owed` unless a recorded actual run justifies a changed status.
- [x] Run `git diff --check -- README.md CLAUDE.md packages/browsers/skills packages/herdr/skills/herdr-browser docs/windows-support/legs/03-browser-ui/OWED-CHECKS.md` and require no whitespace errors.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Documentation promises unsupported networking or treats unperformed checks as passed. | Common support claims are correct but a platform boundary or output-path rule is ambiguous. | Every support claim matches implemented discovery, execution, opener and verification boundaries. |
| Test coverage | ×2 | Commands are unverified or refer to missing entrypoints. | Commands exist but evidence layers or prerequisite failures are not checked. | Documented prerequisite and isolated-contract commands run, referenced paths resolve, and failed/missing evidence stays explicit. |
| Interface & readability | ×1 | Repeated or conflicting instructions obscure prerequisites and next actions. | Commands are usable but platform caveats or ledger fields require interpretation. | Concise platform instructions and exact commands lead to an explicit check, environment and result. |
| Assumptions & docs | ×1 | A helper test or ticked human checkbox is presented as real-device proof. | Owed checks exist but omit an environment, evidence field or inherited debt. | The complete owed ledger separates actual runs, injected tests, native CI and unperformed human checks while preserving earlier debts. |

## Out of scope

- Product behavior, CI edits and dependency installation — document the resulting implementation without changing it here.
- Performing real Windows/WSL pane, mod or Zen checks — preserve them as owed until a suitable environment and actual evidence exist.
- Marking the roadmap complete, releasing or publishing — keep this task limited to support documentation and the verification ledger.

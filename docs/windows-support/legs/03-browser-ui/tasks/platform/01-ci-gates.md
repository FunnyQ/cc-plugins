# PLATFORM-01: Gate browser and UI portability in CI.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/verification.md`
>
> **Depends on**: browsers/03, runes/03, herdr/02
> **Blocks**: platform/02
> **Status**: done

## Goal

Make native browser and UI portability checks block CI on macOS, Ubuntu and Windows while preserving the existing core-workflow gates and diagnostic report job.

## Files to create / modify

- `.github/workflows/ci.yml` (modify) — add browser, Herdr, isolated runes and required real-browser checks to the existing three-OS gate.
- `.github/scripts/browser-smoke.ts` (modify only if needed) — correct a concrete CI invocation or provisioning integration issue without weakening the required smoke contract.

## Implementation notes

### Extend the existing required job

Keep the `macos-latest`, `ubuntu-latest` and `windows-latest` matrix, Bun `1.4.4`, frozen dependency installation, root typecheck and existing monitor checks. Preserve the core-workflow suites and the separate blocking smoke job. Keep the report job's diagnostic behavior unchanged.

Run the following commands in the blocking `required` job:

```sh
bun test --parallel packages/chronicle packages/dispatch packages/guard packages/relay packages/browsers packages/herdr opencode/ ./.github/scripts/browser-smoke.test.ts
(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)
bun .github/scripts/browser-smoke.ts
```

Keep the runes command's package working directory explicit. Its isolated Bun contracts must not collect the Claude Code mod tests. Preserve root `bunfig.toml` and `tsconfig.json` exclusions. Do not install Claude Code or add `claude plugin test` to the CI job; the complete mod suite remains a separate local execution gate, and these portable contracts do not prove native Windows or WSL mod integration.

The workflow defaults to Bash even on Windows. Use runner-supported command syntax without turning Git Bash into a required dependency on user machines. When passing Windows paths through shell steps, preserve them as data and follow the measured MSYS and `.cmd` constraints in the Windows context.

### Require real native browser evidence

Use the existing `browser-smoke.ts` interface: an ordinary invocation requires Chrome on every OS and Firefox on macOS and Linux, asserts the Firefox refusal on native Windows, reports measured versions and selected paths, and runs controlled page interaction, screenshot and close checks. `--check-prerequisites` performs a launch-free diagnostic and still exits nonzero when a required browser is absent. Do not replace the ordinary smoke run with preflight-only checks.

Prefer browser installations supplied by each runner image. If an image lacks a required browser, provision it explicitly in CI from an official distribution and report the installed version. A missing or unusable browser must fail until provisioned; never add a successful skip, `continue-on-error`, failure-swallowing shell command or OS exclusion for the new required checks. Do not provision Zen merely to expand coverage. Do not change user-machine installation behavior.

Keep the smoke page local or data-backed so the action assertions do not depend on public Internet content. Preserve the runner's bounded children, separate CLI invocation checks and owned cleanup. Change the smoke script only for a concrete CI integration problem; do not bypass a browser product failure inside the runner.

### Separate local checks from remote evidence

Run the commands below on the execution host and inspect all matrix-specific workflow branches. Record which OS and installed browser versions actually ran. Do not claim that local execution or YAML inspection proves the remote Windows matrix passed.

Remote implementation-PR CI is owed until an authorized PR exists. Keep that result pending in this task's execution evidence; the support documentation work creates the persistent ledger and adds its remote-CI row. Do not create or edit the future ledger here; do not push, open a PR or invent a passing run to satisfy this task. A pending remote check must not invalidate otherwise passing local gates.

## Acceptance criteria

- [x] The existing three-OS `required` matrix runs browsers and Herdr alongside all previously required core-workflow suites, retains Bun `1.4.4`, root typechecking and monitor checks, and preserves the separate blocking smoke job.
- [x] Each OS runs the isolated runes platform and theme contracts from `packages/runes`; root exclusions remain intact, no mod suite is routed through Bun, and CI requires no Claude Code installation.
- [x] Each OS runs the ordinary native smoke command (Chrome everywhere, Firefox on macOS and Ubuntu, the Firefox refusal on Windows), with selected paths and measured versions visible in its output; prerequisite-only diagnostics cannot substitute for interaction, screenshot and close checks.
- [x] Missing browser prerequisites are explicitly provisioned from official distributions or fail the job; no new skip, allowed failure or platform exclusion can hide a required browser or contract failure.
- [x] The report job retains its diagnostic role, existing required checks keep their blocking behavior, and any smoke-script change fixes a named CI integration issue without relaxing product assertions or cleanup ownership.
- [x] Local evidence distinguishes executed commands, matrix inspection and unavailable remote runs; no Windows/WSL mod or real-pane support claim is inferred from pure contracts.
- [x] (human) After an authorized implementation PR exists, inspect the three remote `required` and `smoke` matrix results and record the actual run links and failures without treating task checkbox completion as proof that this check ran.

## Verification

- [x] Run `bunx --bun tsc --noEmit` from the repository root and require exit 0.
- [x] Run `bun test packages/browsers packages/herdr ./.github/scripts/browser-smoke.test.ts` and require zero failures.
- [x] Run `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` and require exit 0 without collecting mod tests.
- [x] Run `bun .github/scripts/browser-smoke.ts --check-prerequisites`, then `bun .github/scripts/browser-smoke.ts`; require every browser the host requires to pass and record their actual paths and versions.
- [x] Inspect `git diff -- .github/workflows/ci.yml .github/scripts/browser-smoke.ts` against each matrix branch and confirm all new required commands propagate failure while existing core, monitor, smoke and report behavior is retained.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Required failures are skipped or existing gates regress. | New checks run but one OS, runes cwd or browser prerequisite behavior drifts. | All three OS run the specified blocking commands, require real Chrome everywhere and Firefox on macOS and Ubuntu, and preserve existing gates and report behavior. |
| Test coverage | ×2 | Workflow execution is asserted without running local commands or inspecting matrix branches. | Local happy paths pass but absence, failure propagation or runner prerequisites remain unchecked. | Local suites and real smoke pass, missing prerequisites fail clearly, and each matrix branch is inspected with remote evidence kept separate. |
| Interface & readability | ×1 | Duplicated platform workflows or shell workarounds obscure failure behavior. | Commands work but provisioning and working-directory choices are implicit. | Small workflow changes expose exact commands, cwd, prerequisites and failures without a new runner abstraction. |
| Assumptions & docs | ×1 | Local or pure-helper results are presented as real Windows/WSL mod proof. | Tool versions or remote-check limitations are incomplete. | Evidence names the actual host and browser versions and keeps remote CI, full mod tests and human UI checks explicitly distinct. |

## Out of scope

- Full Claude Code mod tests in CI — retain the separate local mod gate and owed native Windows/WSL integration evidence.
- Zen provisioning, Firefox on Windows and UI redesign — keep the required native smoke limited to Chrome and, outside Windows, Firefox.
- Pushes, PR creation, releases and remote-run fabrication — await separately authorized integration work.

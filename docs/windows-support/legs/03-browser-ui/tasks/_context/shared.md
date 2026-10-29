# Shared context

> Read this before every task. Decisions here override inference from existing code.

## Project at a glance

The public FunnyQ/cc-plugins repository distributes independently versioned Claude Code, Codex and OpenCode plugins. This leg owns browsers, runes and herdr Windows/WSL behavior plus their CI and documentation. Runes ships only to Claude Code as a function-hooks mod. Do not add a Codex manifest for it.

## Tech stack

- Use Bun 1.4.4 and TypeScript. Add no npm dependency.
- Keep each plugin independently installable. Import nothing from another plugin.
- Put shared browser helpers in packages/browsers/skills/shared/.
- Keep runes mod-safe helpers free of Bun globals and unsupported runtime imports. Use Bun child scripts for runtime-only work.
- Keep Herdr integration on its CLI; native Windows uses named pipes behind that CLI, not the Unix socket assumed by some clients.

## Code style

- Use type rather than interface, two-space indentation, double quotes and semicolons in TypeScript, following surrounding formatting.
- Write code, tests, comments and artifacts in English.
- Write tests before behavior changes. Keep fixture-only corrections separate from product changes.
- Keep comments only for external constraints that code and tests cannot communicate.
- Add a helper only for a concrete platform requirement. Avoid a generic transport framework.
- Read matching shared rules before editing source. Authoritative style sources: ~/.claude/rules/shared-rules/frontend/typescript/code-style.md and tooling.md.

## File and directory layout

- Keep Bun tests next to product helpers; use *.test.ts in browsers/herdr.
- Keep runes mod tests as *.test.ts or *.test.tsx, importing claude-code/testing.
- Put standalone runes Bun contracts in hooks/platform.spec.ts and retain hooks/explain/themes.spec.ts. The mod runner collects *.test.ts and *.test.tsx, not these *.spec.ts contracts.
- Keep root bunfig.toml and tsconfig.json exclusions for runes intact.
- Keep new task files under tasks/<bucket>/NN-<slug>.md. Use only review/01 for the closing task.
- Keep planning review output outside versioned task contracts, under /tmp/q-lab/flightplan-review/ or the system temp equivalent.

## Commit and branching style

- Start from main; target main when later opening the implementation PR.
- Leave changes unstaged. Task executors do not commit; autopilot's commit agent owns wave commits.
- Use chronicle:commit for authorized commits. Do not push, release, merge or implement during flightplan authoring.
- Preserve Q's unrelated changes and the existing local d22da40 commit.

## Verification baseline

Run from the repository root unless a command explicitly changes cwd:

```sh
bun test packages/browsers packages/herdr
bunx --bun tsc --noEmit
claude plugin test packages/runes
claude plugin validate packages/runes
(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)
```

The platform.spec.ts command becomes available when the portable contracts are created. Do not run an entire Bun suite against runes. The root TypeScript command excludes the mod and is not evidence that mod code typechecks. The complete mod test baseline is 428 pass / 0 fail across 36 files on macOS, using Claude Code 2.1.312, measured 2026-10-29. No new model calls are required to test hooks.

## Decisions frozen during interview

- Support Windows native, Linux native, macOS and WSL. Preserve macOS behavior.
- On native Windows, the browsers plugin supports Chrome only. Firefox and Zen refuse with `not supported on Windows`; Safari refuses with `macOS only`.
- Treat WSL as Linux: use Linux-installed browsers only. Never launch a Windows browser from WSL. Do not add NAT bridging or modify network settings.
- Keep the runes checker on Linux Chrome in WSL, and keep its checker port to the six changes in runes.md; missing Chrome skips its checks but still opens the explanation.
- Make browsers/herdr Bun suites and isolated runes contracts blocking on all three OS. Keep the full mod suite as a separate local execution gate, with Windows/WSL mod integration owed.
- Require Chrome native live smoke on all three OS and Firefox on macOS and Linux in CI. Missing required browsers must fail, not silently skip. Keep optional local live tests skippable when prerequisites are absent.
- Keep native Windows and WSL UI/pane checks owed because Q has no Windows PC. Tag human-only task gates with (human); preserve a separate owed ledger because mark-done ticks those gates too.
- Use Codex headless for all plan review lenses; Standard tier. Run the design gate before task fan-out and at least two tree passes. Do not use the live Herdr review path that timed out in leg 2.
- Set Models: dev=opus/high only on the explain checker task, because it owns a permission rule. Omit other task model headers.
- Use the rubric in rubric.md and task-specific anchors. Include Leanness on final review.
- Design no new UI and run no visual design phase.

## Implementation boundaries

Use task-contracts.md for the approved task ownership, proposed helper interfaces and exact verification commands. Use windows.md for measured Windows traps, browsers.md for launch/state rules, runes.md for mod/action/checker rules, and verification.md for CI and owed checks. These files inline the execution contract; external source paths are verification pointers, not missing decisions.

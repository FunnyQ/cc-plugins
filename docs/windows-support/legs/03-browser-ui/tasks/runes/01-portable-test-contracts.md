# RUNES-01: Separate portable contracts from mod tests.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/runes.md`
> - `../_context/verification.md`
>
> **Depends on**: none — foundation task
> **Blocks**: runes/02
> **Status**: done

## Goal

Establish executable Bun contracts and isolated mod fixtures that can represent Windows runtime inputs without changing runes product behavior.

## Files to create / modify

- `packages/runes/hooks/platform.spec.ts` (new) — run standalone Bun contracts for child environment isolation and fixture transport.
- `packages/runes/hooks/transcript/test-session.ts` (modify) — represent absent environment values, runtime snapshots and process outcomes in the in-memory host.
- `packages/runes/hooks/runes.test.tsx` (modify) — cover the extended fixture environment and preserve existing session behavior.
- `packages/runes/hooks/explain/explain.test.ts` (modify only if needed) — adapt its local host plumbing to explicit platform and process fixtures.
- `packages/runes/hooks/explain/checker.test.ts` (modify only if needed) — adapt its local host plumbing without changing checker expectations.

## Implementation notes

### Keep the two runners distinct

Use `bun:test` in `hooks/platform.spec.ts`. Import neither `claude-code` nor `claude-code/testing`, directly or through the shared mod host. Keep the filename `.spec.ts`: `claude plugin test` collects `.test.ts` and `.test.tsx`, while the standalone command explicitly selects this Bun file and the existing theme contract.

Start the standalone file with real environment and child transport contracts. Use a temporary fixture directory and a child Bun process to verify that the supplied home/temp environment and JSON process output arrive intact. Set HOME and USERPROFILE together when supplying a fixture home, and TMPDIR, TEMP and TMP together when supplying a fixture temp directory. Preserve the remaining host environment, including the Windows spelling of Path. Keep absence cases explicit rather than allowing the runner's real profile to leak into a child. Remove only fixture-owned temporary paths in cleanup.

Do not import nonexistent production platform helpers or create passing production stubs. Add production regression assertions alongside their actual implementation later. This foundation must already execute meaningful fixture/transport assertions and preserve the existing mod tests.

### Represent missing HOME without an implicit fallback

The existing `fakeHost` accepts `env?: Record<string, string>` and computes `env[e.name] ?? (e.name === "HOME" ? HOME : undefined)`. That expression prevents tests from expressing an absent HOME: an explicit undefined is replaced by `/home/q`.

Extend the fixture's option type to permit explicit absence:

```ts
type FixtureEnv = Record<string, string | undefined>;
type FixtureRuntimeInfo = {
  platform: "darwin" | "linux" | "win32";
  wsl: boolean;
  home: string;
  tmp: string;
};
```

Keep the existing default HOME only when the caller has not supplied that property. Preserve an explicitly supplied `HOME: undefined` as absent and `HOME: ""` as empty. Keep USERPROFILE independently configurable. Exercise at least default HOME, absent HOME with USERPROFILE, empty HOME with USERPROFILE and both values absent. These are host-fixture assertions; do not require product initialization to select USERPROFILE before that behavior is implemented.

### Inject process answers without invoking the host

Retain the existing optional process callback and in-memory files. Provide fixture data for native Windows, ordinary Linux, WSL and macOS using the runtime snapshot shape above. Return structured process stdout containing that snapshot when a test requests a runtime probe; return explicit nonzero exits or thrown errors for probe failure cases.

Match the existing YAML parse invocation narrowly. The current host treats every `bun -e` invocation as YAML parsing; runtime probes must instead reach their injected process handler. Preserve the YAML fixture semantics and response envelopes, including `{ value }` where the kit expects it. Ensure unhandled commands cannot accidentally execute real openers or mutate the host filesystem in new fixture tests.

Keep all mod filesystem operations in the fixture's Map and pass plain fixture values or callbacks across modules. Do not add a Bun global or a Node runtime import to a module loaded by Claude Code. Extend local explain/checker fixtures only when needed for the shared host contract; leave their product behavior expectations unchanged.

## Acceptance criteria

- [x] `hooks/platform.spec.ts` executes environment-isolation and JSON child-transport assertions through Bun without importing the Claude Code runtime or test kit.
- [x] Mod fixtures distinguish an omitted HOME property, explicit undefined and an empty string; tests cover USERPROFILE present and absent without using the real profile.
- [x] Native Windows, macOS, ordinary Linux and WSL runtime snapshots plus successful, nonzero and throwing process outcomes can be injected without executing a real opener.
- [x] YAML parsing still uses its existing fixture behavior, while non-YAML Bun probes reach the injected process callback and keep the test kit's expected response envelopes.
- [x] The complete existing mod suite remains passing without deleted tests, blanket platform skips, fabricated production stubs or changes to root `bunfig.toml` and `tsconfig.json` exclusions.
- [x] Temporary child fixtures isolate HOME/USERPROFILE and TMPDIR/TEMP/TMP together, preserve the remaining environment and clean only their owned paths.

## Verification

- [x] Run `claude plugin test packages/runes`; require zero failures and preserve the existing 428-test baseline while allowing added fixture tests.
- [x] Run `claude plugin validate packages/runes`; require a successful exit.
- [x] Run `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)`; require both explicitly selected contract files to execute successfully.
- [x] Inspect the new contract's import graph and confirm it contains no `claude-code` or `claude-code/testing` dependency; confirm root `bunfig.toml` and `tsconfig.json` are unchanged by this task.

## Eval rubric

> Use the scale in `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Bun loads the mod kit, fixtures touch the real profile, or defaults conceal missing HOME | Runners are separated but an absence case or process response cannot be represented | Both runners execute independently; explicit HOME absence, USERPROFILE and process outcomes remain isolated without product changes |
| Test coverage | ×2 | The contract only asserts constants or replaces missing product code with passing stubs | Environment happy paths pass but probe failures or YAML routing are untested | Real child environment/JSON transport and mod fixture absence, platform and error cases are exercised |
| Interface & readability | ×1 | Fixture additions mix engine objects with Bun-only runtime code | Options work but duplicate platform or process conventions across hosts | Small typed options and callbacks preserve current defaults and use one explicit fixture contract |
| Assumptions & docs | ×1 | Passing Bun contracts are presented as full Windows mod verification | Runner distinction is documented but baseline or platform limits are omitted | Commands, preserved baseline and the limits of injected platform evidence are explicit |

## Out of scope

- Implement platform discovery, home fallback, openers, browser launch, screenshot permissions or recoverable deletion; this task prepares their fixtures without changing behavior.
- Change theme markup, root test/typecheck exclusions, manifests or CI workflows.
- Run model-backed explanations or claim native Windows/WSL rendering has been verified by injected fixtures.

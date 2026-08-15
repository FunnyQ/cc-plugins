# RUNTIME-01: OpenCode plugin module

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: runtime/02
> **Status**: done

## Goal

OpenCode loads one plugin module from this repo that reproduces four Claude/Codex hook behaviors by invoking the existing scripts, so a session start writes the decision log, an idle turn fires the scribe nudge, a protected-branch commit is blocked, and a flightplan task write is linted.

## Files to create / modify

- `opencode/plugin.ts` (new) — the plugin module: `id`, the plugin function, three pure verdict/payload helpers, two impure spawn wrappers.
- `opencode/plugin.test.ts` (new) — unit tests for the three pure helpers only.

Nothing else. In particular the two shell scripts this module invokes stay byte-identical; they are the live hook path for Claude Code and Codex, and changing their stdin contract, exit codes, or output shape breaks those harnesses silently.

## Implementation notes

### Blocking runtime facts — check these first

`../_context/runtime-facts.md` is the gate. This task consumes six of its entries:

| Fact | What it decides here |
|---|---|
| **S8** | Whether `import.meta.dir` inside a symlink-loaded plugin gives the realpath. **Hard blocker** — without it the module cannot find the repo root at all. |
| **S3** | Whether the branch guard throws or mutates `output.permission`. |
| **S4** | How a lint violation is surfaced, and whether the write has already landed. |
| **S5** | The argument path for the bash command inside the tool-execute input. |
| **S15** | The exact wrapper `scribe-nudge.ts` emits when neither harness env var is set. |
| **S1 / S2** | Which session events actually fire, and how often. |

**If any of these is still marked `UNRESOLVED`, set `> **Status**: blocked` in this file and stop.** Do not infer the answer from OpenCode's documentation, do not pick the reasonable default, and do not write a branch for each possibility. A wrong runtime assumption here propagates into the installer, five skill documents, and the README before anyone notices.

**All six are now resolved. Read them — three overturned what this plan originally assumed:**

- **The tool arguments are on the SECOND handler parameter.** The signature is `(input, output)`; `input` carries only `{ tool, sessionID, callID }`. Read `output.args.command` for bash and `output.args.filePath` for write. Reading `input.args.command` yields `undefined` and silently disables both hooks — the exact shape this plan first guessed.
- **Throwing in `tool.execute.before` is the right mechanism** — it blocks the command before it runs and surfaces the thrown message verbatim to both the user and the agent.
- **A lint violation is surfaced by appending to `output.output`** in `tool.execute.after`. The write has already landed by then, matching the Claude `PostToolUse` exit-2 semantics.

### Module shape

Single file. **Zero imports from anywhere in this repo** — not from `packages/`, not from a sibling file in `opencode/`. The module is loaded by an external runtime through a symlink, so any relative import is a second thing that has to resolve correctly. Bun globals (`Bun.spawn`, `Bun.file`) and `node:` builtins are fine.

```ts
// EXACTLY ONE EXPORT. See the warning below — this is not a style preference.
export const QLabPlugin = async (ctx) => ({
  event: async ({ event }) => { /* … */ },
  "tool.execute.before": async (input, output) => { /* … */ },
  "tool.execute.after": async (input, output) => { /* … */ },
});
```

> ⚠️ **Export the plugin function and nothing else. No `id`, no version constant, no shared type — nothing.**
>
> The loader iterates the module's exported *values* and calls each one. A non-function export poisons that loop: the module still evaluates, no error is printed anywhere, and **every hook silently does nothing**. Observed directly on opencode 1.18.18 — a module exporting `id` plus the plugin function logged its module-level marker and was never initialized; deleting the `id` line made it initialize immediately. Recorded as **S18** in `../_context/runtime-facts.md`.
>
> This is the single easiest way to ship a module that looks correct and does nothing, so the acceptance criteria gate on it.

No config file is read. No harness environment variable is read. The repo root comes from `import.meta.dir` per the frozen decision in `../_context/shared.md`:

```ts
// The plugin is installed as a symlink into this checkout, so its own location is the root.
const root = dirname(import.meta.dir);
```

### Event wiring

| Trigger | Action |
|---|---|
| `event` → `session.created` | `bun <root>/packages/monitor/skills/cockpit/scripts/decision-log-start.ts` |
| `event` → `session.idle` | `bun <root>/packages/monitor/skills/cockpit/scripts/scribe-nudge.ts` |
| `tool.execute.before` (bash) | pipe a command payload to `<root>/packages/chronicle/hooks/check-branch.sh` |
| `tool.execute.after` (write/edit) | pipe a file-path payload to `<root>/packages/dispatch/hooks/flightplan-lint.sh` |

`scribe-nudge.ts` switches its output shape on the Codex marker variable. Under OpenCode neither harness variable is set, so it emits the Claude hook-JSON wrapper rather than plain text — handle that wrapper per **S15**. Printing it raw shows the user a blob of JSON instead of a reminder.

### Pure functions — inline signatures

```ts
export type HookKind = "command" | "file_path";

// Builds the stdin JSON each shell hook already expects. The scripts read
// `.tool_input.command` and `.tool_input.file_path` respectively.
export function hookPayload(kind: HookKind, value: string): string;

// The branch guard prints {"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"…"}
// on a violation and nothing at all otherwise. Returns the systemMessage to raise, or null.
export function guardVerdict(exitCode: number, stdout: string): string | null;

// The flightplan lint exits 2 with violations on stderr, and 0 otherwise.
// Returns the text to surface, or null.
export function lintVerdict(exitCode: number, stderr: string): string | null;
```

Behavior these three must satisfy:

- `hookPayload("command", 'git commit -m "🔧 release: x"')` produces valid JSON with the quotes and the emoji intact. Build it with `JSON.stringify`, never string concatenation.
- `guardVerdict` returns the `systemMessage` **verbatim** when `hookSpecificOutput.permissionDecision === "ask"`. Any other decision value, empty stdout, unparseable stdout, or a non-zero exit returns `null`.
- `lintVerdict` returns the stderr text when the exit code is `2` and stderr is non-empty. Every other exit code returns `null`, including a non-zero code that is not `2` — the script fails open by design and a crash must not block a write.

### Impure helpers

```ts
type HookResult = { exitCode: number; stdout: string; stderr: string };

// Spawns the script with the payload on stdin. Resolves to null when the script
// is missing — a fresh checkout without one of the plugins must not break sessions.
async function runHook(root: string, relScript: string, payload: string): Promise<HookResult | null>;

// Fire-and-report for the two session scripts.
async function runScript(root: string, relScript: string, args: string[]): Promise<HookResult | null>;
```

### Fail-open rules

These are the whole safety story, so make each one explicit in the code:

- A missing script is a silent no-op. Never throw because a file is absent.
- Session handlers log to stderr and never throw. A broken decision log must not kill the session.
- The branch-guard raise is the **only** intentional failure path in the module.
- Malformed or unexpected hook output means "no verdict", never a crash.
- The shell scripts already fail open when `jq` is missing or a payload is unparseable. Do not add a second layer of the same protection on top.

### What must not be re-derived

The branching inside the two shell scripts — the workflow lookup, the release-subject exemption, the legacy git-config fallback, the path filter, the header sniff — stays in the scripts. Do not port any of it to TypeScript. Two copies of the same workflow rules with nothing keeping them in sync is the failure this design exists to prevent, and the TypeScript side cannot even express the legacy branch because it reads git config the module never sees.

### Tests

`opencode/plugin.test.ts` covers the three pure functions and nothing else:

- `guardVerdict` — an `ask` payload returns its message; a payload with a different decision returns `null`; empty stdout returns `null`; malformed JSON returns `null`; a non-zero exit returns `null`.
- `lintVerdict` — exit `2` with stderr returns the text; exit `2` with empty stderr returns `null`; exit `0` returns `null`; some other non-zero exit returns `null`.
- `hookPayload` — both kinds round-trip through `JSON.parse`, including a command containing double quotes, single quotes, a newline, and a multi-byte character.

Never spawn a real shell, a real script, or a real OpenCode process in a unit test. The shell scripts' own branching is not this suite's job — it is already the contract two other harnesses depend on.

## Acceptance criteria

- [x] `opencode/plugin.ts` exists and contains no import of any file inside this repository.
- [x] **`opencode/plugin.ts` has exactly one `export`, and its value is a function.** No `id`, no version, no constant, no re-exported type. Anything else silently disables every hook (S18).
- [x] The module was loaded by a real OpenCode session and observed to initialize — not merely evaluated. A module-level side effect proves evaluation; only a log line from inside the plugin function proves initialization.
- [x] The module reads no configuration file and no harness environment variable; the repo root derives from `import.meta.dir`.
- [x] `hookPayload`, `guardVerdict`, and `lintVerdict` are exported and pure — no spawning, no file I/O, no clock, no environment access.
- [x] A protected-branch commit raises the branch guard's own `systemMessage` verbatim, with no wording added or removed.
- [x] A missing script, an unparseable hook output, and a non-`2` non-zero exit each produce a silent no-op rather than an error.
- [x] `packages/chronicle/hooks/check-branch.sh` and `packages/dispatch/hooks/flightplan-lint.sh` are unmodified.
- [x] Every claim in this file that rests on a runtime fact cites which one, and no such fact was still `UNRESOLVED` when the code was written.

## Verification

- [x] Run `grep -c '^export' opencode/plugin.ts` and confirm it prints `1`.
- [x] Run `bun test opencode/plugin.test.ts` — all tests pass.
- [x] Run `bun test packages/` — the existing suites still pass, confirming nothing under `packages/` shifted.
- [x] Run `git status --short -- opencode/plugin.ts opencode/plugin.test.ts docs/opencode-compat/tasks/runtime/01-plugin-module.md` and confirm those paths are dirty. Make no claim about any other path; sibling work shares this working tree.
- [x] Run `git diff --stat -- packages/chronicle/hooks/check-branch.sh packages/dispatch/hooks/flightplan-lint.sh` and confirm it prints nothing.
- [x] Run `grep -nE "^\s*import .* from ['\"][./]" opencode/plugin.ts` and confirm it prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A workflow rule was re-derived in TypeScript, a shell script was edited, or a fail-open path throws | Happy paths wire up, but malformed output or a missing script produces an error instead of a no-op | Every observed script output is handled including malformed and empty, fail-open holds everywhere, the guard message passes through verbatim, and no workflow rule was re-derived |
| Test coverage | ×2 | No tests, or tests that spawn a real shell | Only the success case per function | Each pure function covered across success, empty, malformed, and every distinguished exit code; payload round-trips with quotes and multi-byte input |
| Interface & readability | ×1 | Spawning smuggled into the verdict functions, or logic split across several files | Single file and roughly pure, but the types are vague or the wiring is hard to follow | One file, no repo imports, verdict functions provably pure, `type` over `interface`, spawn confined to two named wrappers |
| Assumptions & docs | ×1 | A runtime behavior assumed with no citation, or a branch written for both possible answers | Facts cited loosely, failure modes undocumented | Every runtime-dependent line names the fact it rests on, and each fail-open rule carries a one-line reason |

## Out of scope

- Installing anything into `~/.config/opencode/`. This task produces the module; wiring it into a live OpenCode install is separate work.
- Porting `setup.ts --session-check`. It returns immediately without the Claude data-directory variable, and its work is statusline migration and Claude process reaping — both Claude-only. Deferred permanently, not to a later task.
- Porting the chronicle spawn-depth session check. The prerequisite is real under OpenCode but is a config value the installer raises, not a session hook.
- Adding an `opencode.json` write of any kind. The one config edit this build makes belongs to the installer.

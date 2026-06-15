# CORE-03: Relay prompt builder

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01, core/02
> **Blocks**: backends/05
> **Status**: done

## Goal

Build the backend-agnostic canonical prompt (delegate task + emulated review): a pure formatter plus an impure `buildPromptFile` helper the relay entry point calls directly, so `/relay <backend> <mode> "<task>"` works in one step. It must carry zero backend-specific knowledge.

## Files to create / modify

- `packages/relay/skills/relay/scripts/relay-prompt.ts` (new) — pure `formatPrompt` + impure CLI entry.
- `packages/relay/skills/relay/scripts/relay-prompt.test.ts` (new) — unit tests for `formatPrompt`.

## Implementation notes

Port shape from `odin-codex/scripts/codex-prompt.ts` but **drop any backend naming** (it produced a "codex" prompt; relay's is neutral). Import `collect` from `./context-collector` and `createTmpRunDir` from `./shared`.

**Split pure formatting from I/O.** The pure formatter takes an already-collected `context` string (it must NOT call `collect()` itself — that reads the filesystem and would make it impure/untestable). The impure CLI wrapper calls `collect()` and feeds the result in.

```ts
type PromptKind = "delegate" | "review";   // image is codex-native, never prompt-built

type FormatOptions = {
  kind: PromptKind;
  context: string;   // pre-collected git/file/project context (caller runs collect())
  focus: string;     // review concern
  task: string;      // delegate task
  files: string[];   // for the delegate file-scope line
};

// PURE — string in, string out. Unit-tested without touching the filesystem.
export function formatPrompt(options: FormatOptions): string;

// IMPURE — collect() context, format, write <kind>-prompt.md to a tmp dir, return the path.
// Imported and called by the relay entry point (single-step) AND by the optional CLI below.
export function buildPromptFile(options: {
  kind: PromptKind;
  files: string[];
  focus: string;
  task: string;
  gitScope: "all" | "related" | "none";
  noProject: boolean;
}): string;  // returns the prompt-file path
```

Prompt content (neutral wording — no "codex"/"opencode"/"claude"):

- **review**: `<context>\n\n---\n\nReview the above for code quality, bugs, and improvements.\nFocus: <focus|stdin|"general code quality, bugs, and improvements">\nAnalyze only — do not modify any files; produce findings as a report.`
  - The "analyze only" line is what makes the emulated opencode review safe (see `cli-reference.md`).
- **delegate**: `<context>\n\n---\n\nTask: <task|stdin>\n\nExecution constraints:\n- Modify only the files needed for this task. If possible, stay within: <files|"(no explicit file scope)">\n- Do not revert user changes or unrelated dirty work.\n- Do not create commits.\n- After finishing, list changed files and verification commands/results.`
  - Delegate requires a task via `--task` or stdin; error to stderr + exit 1 if missing.

`buildPromptFile` calls `collect({ files, gitScope, noProject })` for the context string, passes it to `formatPrompt`, writes `<kind>-prompt.md` into `createTmpRunDir()`, and returns the path. Default `gitScope` is `related`. Delegate with no task → throw/exit with a clear message.

Optional CLI entry (`import.meta.main`): parse `relay-prompt <delegate|review> --files <csv> [--focus <t>] [--task <t>] [--git-scope <s>] [--no-project]`, read stdin (fallback for `--task`/`--focus`), call `buildPromptFile(...)`, print the path to stdout. This is a convenience for manual/debug use — the relay entry point imports `buildPromptFile` directly and does not shell out to this CLI.

## Acceptance criteria

- [x] `formatPrompt` exported and pure (takes a `context` string, returns a string; never calls `collect()` or touches the filesystem); no backend names in output.
- [x] `buildPromptFile` exported (impure): collects context, formats, writes `<kind>-prompt.md` under a `/tmp/relay/...` dir, returns the path.
- [x] review prompt includes the "Analyze only — do not modify any files" instruction.
- [x] delegate prompt includes the execution-constraints block and the file-scope line.
- [x] delegate with no task exits/throws with a clear message.
- [x] Optional CLI prints the prompt-file path; the entry point uses `buildPromptFile` directly (no subprocess).

## Verification

- [x] `bun test packages/relay/skills/relay/scripts/relay-prompt.test.ts` passes.
- [x] Tests cover (calling `formatPrompt` with a fixed `context` string — no filesystem): review prompt contains the read-only line; delegate prompt contains constraints + scope; focus/task fallbacks; output contains no literal `codex`/`opencode`/`claude`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | leaks backend names or missing read-only line | builds prompts but a constraint/fallback drifts | neutral prompt; review read-only line + delegate constraints exact; stdin fallbacks correct |
| Test coverage | ×2 | no tests | one mode only | both modes + stdin fallback + no-backend-name assertion |
| Interface & readability | ×1 | I/O inside formatter | usable but mixes collect + format | `formatPrompt` pure (context passed in); collect()/CLI wiring separate under import.meta.main |
| Assumptions & docs | ×1 | magic strings unexplained | present | prompt-template intent + "image never uses this" noted |

## Out of scope

- Backend-specific prompt tuning (e.g. a qwen-flavored review prompt) — Deferred. Reason: the builder is backend-agnostic by design; tuning, if ever needed, belongs in the backend.
- image prompt text — Deferred. Reason: image is codex-native and builds its own prompt in the codex backend.

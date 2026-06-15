# CORE-02: Context collector

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: core/03
> **Status**: done

## Goal

Port the `odin-codex` context collector verbatim so `relay-prompt.ts` can assemble git + file + project context for any prompt-strategy backend.

## Files to create / modify

- `packages/relay/skills/relay/scripts/context-collector.ts` (new) — git/file/project context gatherer.
- `packages/relay/skills/relay/scripts/context-collector.test.ts` (new) — unit tests for the pure formatters.

## Implementation notes

**The behaviour spec below is the contract** — implement to it. There is a convenience reference copy at `/Users/funnyq/Projects/odin/odin-cc-plugin/packages/odin-codex/scripts/context-collector.ts` (dependency-free, backend-agnostic) that you may copy verbatim if it exists, but the task is verified against the spec here, not against that external path. Required exports and behaviour:

```ts
export function collectGitInfo(): string;                       // full repo: status, staged, unstaged, recent log
export function collectRelatedGitInfo(files: string[]): string; // git scoped to given files
export function collectFileContents(files: string[]): string;   // file bodies, skipping binary/oversized
export function collectProjectInfo(): string;                   // tech-stack detection + CLAUDE.md
export function collect(options: {                              // top-level orchestrator
  files: string[];
  gitScope: "all" | "related" | "none";
  noProject: boolean;
}): string;
```

Behaviour to preserve:
- `MAX_OUTPUT_LENGTH = 50_000` truncation on shell output; files > 100 KB skipped; binary files (null-byte heuristic) skipped.
- `collect()` joins sections with `\n---\n\n` and omits empty sections.
- CLI mode under `if (import.meta.main)` parsing `--files`, `--no-git`, `--git-scope`, `--no-project`.

**Spawn exception**: this is a self-contained verbatim port — it owns a small internal `shell(args)` helper (its own `Bun.spawnSync` for the git/stack probes) and does **not** import the shared `run()` wrapper. This is the one allowed exception to the "keep spawn behind `run()`" convention: the collector stays dependency-free (no cross-file imports) so it ports cleanly. Do **not** "improve" beyond the spec.

### Canonical output format (the exact shapes to reproduce)

`collectGitInfo()` (sections after `## Status` appear only when non-empty):
```
# Git Info

## Status
` ``
 M path/to/file      (or "(clean)" when status is empty)
` ``

## Staged Changes
` ``diff
<git diff --staged>
` ``

## Unstaged Changes
` ``diff
<git diff>
` ``

## Recent Commits
` ``
<git log --oneline -5>
` ``
```
`collectRelatedGitInfo(files)` is identical but headings read `## Related Status` / `## Related Staged Changes` / `## Related Unstaged Changes` and git commands are scoped with `-- <files>` (no Recent Commits section).

`collectFileContents(files)` — header `# Current Files`, then per file:
```
## path/to/file
` ``ext
<file contents>
` ``
```
Placeholders (no code fence): missing → `## path\n> File not found`; binary (null-byte) → `## path\n> Binary file, skipped`; > 100 KB → `## path\n> File too large (N KB), skipped`.

`collectProjectInfo()` — header `# Project Info`, then `## Tech Stack` (comma-joined detected stacks) inserted right after the header, then per detected manifest a section (`## package.json` summarized to name/dependencies/devDependencies as ` ```json `; others as raw fenced), then `## CLAUDE.md` (raw) when present.

`collect(options)` joins the produced sections with the literal separator `\n---\n\n` and omits any empty section.

(Fences shown as `` ` `` `` ` `` to avoid nesting; use real triple backticks.)

## Acceptance criteria

- [x] `context-collector.ts` exports `collectGitInfo`, `collectRelatedGitInfo`, `collectFileContents`, `collectProjectInfo`, `collect` with the signatures above.
- [x] Binary and oversized files are skipped with a placeholder line, not inlined.
- [x] `collect()` with `gitScope: "none"` and `noProject: true` returns only the file-contents section (or empty if no files).
- [x] Output matches the Canonical output format above (section headings, placeholder lines, `\n---\n\n` separator, empty-section omission).

## Verification

- [x] `bun test packages/relay/skills/relay/scripts/context-collector.test.ts` passes.
- [x] Tests cover: `collectFileContents` with a present file, a missing file (placeholder), and a binary file (skipped); `collect()` section composition with various `gitScope`/`noProject` flags.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | behaviour diverges from the spec | mostly correct but a guard (binary/size/truncate) dropped | every behaviour in the spec implemented (guards, truncation, section format) |
| Test coverage | ×2 | no tests | only happy path | present/missing/binary file + collect() composition |
| Interface & readability | ×1 | gratuitous extra abstraction | minor unjustified additions | clean dependency-free module matching the spec |
| Assumptions & docs | ×1 | limits unlabeled | present | `MAX_OUTPUT_LENGTH`/size limits kept as labeled constants |

## Out of scope

- Adding new context sources (e.g. test output) — Deferred. Reason: parity-first port; new sources are a follow-up if a backend needs them.

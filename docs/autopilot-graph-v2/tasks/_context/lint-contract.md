# `lint-task.ts` contract

Everything the `lint/` tasks need about the linter. Read with `shared.md`.

File: `packages/dispatch/skills/flightplan/scripts/lint-task.ts` (~382 lines).
Tests: `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (~506 lines).
Parser it imports: `packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts`.

## Two levels of check — this distinction is load-bearing

| Level | Function | Runs when |
|---|---|---|
| **Per-file** | `lintFile(filePath): Promise<Violation[]>` | Always, once per task file. |
| **Tree-level** | `checkFinalReview(tasks, label): Violation[]` | **Only** when a *directory* argument was given. |

`main()` gates the tree-level pass on `treeRoots.length > 0`:

```ts
// Tree-level checks only run when a tasks/ directory was given (whole-tree
// mode) — a cherry-picked file list is too partial to judge the final gate.
if (treeRoots.length > 0) {
  reportAll(checkFinalReview(parsed, treeRoots[0]));
}
```

`resolveInputs(args)` builds `{ files, treeRoots }`: a directory argument is pushed to `treeRoots` and
expanded through `collectTaskFiles()` (which skips `_context/` and any `README.md`); a file argument goes
straight into `files`. So `lint-task.ts <one-file.md>` never runs a tree-level check. A new tree-level
rule therefore cannot fire during an autopilot run, because the external dev driver lints a single file.

## The `Violation` type and reporting

```ts
export type Violation = {
  file: string;    // absolute path, or the tree label for a tree-level violation
  rule: string;    // short kebab slug, e.g. "self-containment", "final-review"
  detail: string;  // the actionable message
};
```

`main()` prints each violation to **stderr** as `<relative-path>  [<rule>] <detail>`, then exits **1**
if any were found. A clean run prints `All N task file(s) pass.` to **stdout** and exits 0. A usage error
or a thrown error exits **2**.

**stdout is free for informational output; stderr plus the exit code is the gate.** Anything written to
stdout is by construction unable to change the verdict.

## `ParsedTask` — the fields available

From `lib/parse-task.ts`. `parseTask(content)` returns `{ ok: true, task }` or `{ ok: false, reason }`.

```ts
export type ParsedTask = {
  bucket: string;          // lowercased from the H1, e.g. "lint"
  nn: string;              // zero-padded, e.g. "01"
  title: string;
  h1: string;
  requiredReading: string[];
  dependsOn: TaskRef[];    // TaskRef = { bucket, nn }
  blocks: TaskRef[];
  status: TaskStatus | null;    // "todo" | "in-progress" | "done" | "blocked"
  finalReview: boolean;         // header carries `> **Final review**: true`
  sections: string[];           // e.g. ["Goal", "Acceptance criteria", "Verification", "Eval rubric"]
  body: string;                 // everything after the header blockquote
  rubric: Rubric | null;
};
```

`refToString(ref)` formats a `TaskRef` as `"bucket/NN"`.

**There is no command AST.** `body` is raw markdown. Any command extraction has to be string work.

## Section extraction — reuse, do not re-add

Two private helpers already exist, and they are *not* interchangeable:

- `lint-task.ts` has its own **private** `extractSection(body, heading): string` (near the bottom of the
  file). It returns the lines under a `## Heading`, or `""` when absent. It matches with
  `l.trim() === "## " + heading || l.trim().startsWith("## " + heading)`.
- `lib/parse-task.ts` has `extractHeadingSection(body, heading): string | null` — stricter (exact match
  only), returns `null` when absent, and is **private / not exported**. It is not importable.

So a new check in `lint-task.ts` that needs the `## Verification` text should reuse that file's own
`extractSection`. Do not add a third parser and do not export `extractHeadingSection` — widening the
parser's surface for one caller is the kind of layer this repo rejects.

## Test style in `lint-task.test.ts`

Tests build a task file as a template string, write it into a `mkdtemp` directory shaped like a real
tree (`<tmp>/tasks/<bucket>/NN-slug.md` plus `<tmp>/tasks/_context/shared.md` so Required-reading paths
resolve), then call `lintFile` or the tree-level function directly. Assertions check
`violations.map(v => v.rule)` and `detail` substrings. Follow that shape.

For a check whose behaviour depends on **stdout vs exit code**, drive the CLI as a subprocess
(`Bun.spawn` / `Bun.$`) so both are observable; calling the exported function alone cannot prove that the
exit code was untouched.

## The one hard interaction with task status

`taskValidity(task)` (exported from `lib/parse-task.ts`) returns `invalid` with rule
`completion-state` when `status === "done"` but any checkbox in `## Acceptance criteria` or
`## Verification` is still unticked. `COMPLETION_STATE_FIX` is the canonical repair instruction, and it
forbids hand-ticking.

**Consequence:** a historical tree already marked `done` cannot be retro-fitted with a new unticked
Verification item — that would make every one of its tasks invalid — and hand-ticking the new box is
forbidden. Such trees get **reported**, never edited.

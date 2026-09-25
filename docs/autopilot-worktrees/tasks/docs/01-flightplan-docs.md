# DOCS-01: Flightplan docs for Models and the narrowed Max parallel

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/models.md`
> - `../_context/worktree.md`
> - `../_context/rubric.md`
>
> **Depends on**: models/01
> **Blocks**: review/01
> **Status**: done

## Goal

A flightplan author reads the flightplan docs and learns two things: autopilot isolates each task in its own worktree, so a shared build no longer calls for `Max parallel: 1`; and a task can pin per-role models with a `> **Models**:` header.

## Files to create / modify

- `packages/dispatch/skills/flightplan/references/plan-template.md` (modify) — rewrite the **Max parallel** paragraph at the end of the file.
- `packages/dispatch/skills/flightplan/SKILL.md` (modify) — rewrite the Step 6.4 paragraph that begins "**Every task in this tree may run beside another one**".
- `packages/dispatch/skills/flightplan/references/task-template.md` (modify) — add the `Models` header, a `### Models` header rule, the relative-path rule for Verification, and revise the "Sibling tasks share the tree" paragraph.
- `packages/dispatch/skills/flightplan/references/interview-guide.md` (modify) — add a per-task models question.
- `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (modify) — one test that proves the template's `Models` example line lints clean.

## Implementation notes

Follow the repo's writing rule in every edited paragraph:
- Write one instruction per sentence.
- Start each instruction with a verb.
- Put the condition before the instruction.
- Use one term per thing: "worktree", "main tree", "Max parallel", "Models header".

### plan-template.md — Max parallel paragraph

The current paragraph (last section, starting "**Max parallel** caps how many tasks autopilot runs at once.") lists "one build target that compiles every file" as a reason to lower the cap. Rewrite it so that:

- Keep the default `unlimited`.
- Explain that under Claude Code, autopilot runs each non-final task's whole pipeline (dev, verify, judge) in its own git worktree, and lands only judged-passing work into the main tree. A shared build target, including one that compiles every file, therefore needs no cap.
- Mention that autopilot removes each worktree after its task lands, so no worktree for the plan remains after a clean run. A parked task keeps its worktree for inspection. Cleanup touches only paths under the plan's worktree root.
- Say that under Claude Code the cap is needed only when tasks share an **external live resource** that a worktree cannot isolate: a live device, a LaunchAgent or service that a verification reinstalls, or a local database that a migration rewrites.
- Say that under OpenCode's hand-driven loop (`autopilot/references/opencode.md`) tasks still share one working tree, so a shared build target (one that compiles every file) still needs `> **Max parallel**: 1` there. State the runtime before the rule, e.g. "When the plan will run under OpenCode, …".
- Keep these sentences as they are in meaning: the value is a bare positive integer or `unlimited`; `Depends on` edges that already sequence every conflict mean `unlimited`; prose that describes a lock does nothing, because nothing reads it.
- Remove the phrase "one build target" entirely. Name the OpenCode case with "shared build target" instead.

### SKILL.md — Step 6.4 paragraph

Rewrite the paragraph that begins "**Every task in this tree may run beside another one**" so it says:

- Under Claude Code, autopilot runs every ready task of a wave in parallel, each in its own worktree. It lands each task into the main tree only after the task passes its judge. No task commits.
- A task that writes into the main tree instead of its worktree is a leak. Autopilot aborts the whole run when it detects one, so a task's own files must be written through its worktree.
- Declare `> **Max parallel**: N` in the plan's master-spec header (the same header the paragraph already names) when tasks share an external live resource (a device, a LaunchAgent, a local DB). Do not use a lock rule in `_context/` for this. Keep the existing note that tree lint prints a `[serial-undeclared]` advisory when it finds such prose without the header.
- Under OpenCode, the loop is driven by hand and still shares one working tree (`autopilot/references/opencode.md`). There, a sibling's uncommitted edits are visible, and a shared build target still needs `> **Max parallel**: 1`.
- Keep the rule itself: no task's verification may assert anything about the state of the whole tree. Assert on this task's own declared files, by name. Give the reason for both runtimes: the runner edits the task file, and on OpenCode siblings share the tree.
- Remove "one build target" from this paragraph.

### task-template.md — Models header

**Do not add a `Models` line to the template's header block** (the fenced block under `## Template`). Authors copy that block for every task, and a valid line there would silently override the defaults on every task written from it.

Add a `### Models` section under `## Header rules`, after `### Final review`. It holds the only copyable example, as a fenced block written exactly like this, with nothing after the last entry:

```
> **Models**: dev=opus/high, verify=sonnet
```

The example must parse as written, because authors copy it. A trailing note such as "(optional — omit unless…)" on the same line becomes part of the last entry, and the parser rejects it. Keep every explanation in the section's prose, never on the example line.

Inline these rules in that section; do not point at another file for them:

- Syntax: `role=model` or `role=model/effort`, comma-separated. Whitespace around `=`, `/`, and each entry is allowed, and a trailing comma is allowed. Tokens are lowercase.
- Roles: `dev`, `verify`, `judge`, `fix`. Each role appears at most once.
- Write `fix` only on the task that carries `> **Final review**: true`.
- Models: `haiku`, `sonnet`, `opus`, `fable`.
- Efforts: `low`, `medium`, `high`, `xhigh`, `max`. When a role's effort is omitted, that role runs with no effort option.
- Autopilot reads the header value as written: `next-ready.ts` passes it along as `modelsRaw`, and the orchestrator parses it.
- Roles the header does not name keep autopilot's default map. State the defaults inline as a short table: dev opus/medium; verify opus/low; judge opus/medium; fix opus/high.
- The last Claude dev attempt raises the dev effort one step and keeps the model. The ladder is `low → medium → high → xhigh → max`, and `max` stays `max`. Example: `dev=sonnet/low` over 3 attempts gives sonnet/low, sonnet/low, sonnet/medium.
- `lint-task.ts` rejects an unknown role, model, or effort, a duplicate role, a malformed entry, and `fix` on a non-final task.
- State first that the header is optional. Use it rarely. Omit the header unless the task is unusually hard (a delicate refactor, a concurrency fix) or unusually easy (a mechanical rename). Run-wide roles (scout, commit, review lenses) cannot be set per task.

### task-template.md — Verification paths and the sibling paragraph

- Add to the self-containment checklist, and state once in prose near `## Verification`: write Verification commands relative to the repo root. Autopilot runs them from inside the task's worktree, so an absolute path into the main tree checks the wrong copy.
- In "Always narrow a `git status` gate to a pathspec", keep the rule and the `scope-git-status` lint description unchanged.
  - Keep the "The runner edits the task file" reason.
  - Rewrite the "**Sibling tasks share the tree.**" paragraph to say that it applies where tasks still share one working tree, which today means the hand-driven OpenCode loop.
  - Under Claude Code, each task has its own worktree. The pathspec form stays required anyway, because one task file must work on both runtimes.
  - Keep the observed-live example.

### lint-task.test.ts — the template example lints clean

Add one test to `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts`:
- Read `packages/dispatch/skills/flightplan/references/task-template.md`, resolved relative to the test file.
- Slice the text of the `### Models` section: from its heading to the next `### ` or `## ` heading.
- Extract the section's first line matching `/^> \*\*Models\*\*:.*$/m`. The test fails when no line matches.
- Also assert that the fenced template block under `## Template` contains no line matching that pattern.
- Insert that exact line into the header of a minimal valid task fixture. Build the fixture the same way the surrounding tests build theirs.
- Lint the fixture, the same way the surrounding tests do, and assert that no violation from the `models` rule is reported.

The test stops the documented example and the parser from drifting apart.

### interview-guide.md — per-task models

- Add a short subsection near the per-task `## Eval rubric (ask per task)` section: "Per-task models (ask during decomposition)".
- Recommend omitting the header by default.
- Ask only when a task stands out as unusually hard or easy.
- Give the header syntax in one line.
- Include one example question with a `(Recommended)` first option ("Use the defaults"), in the same style as the surrounding question banks.

## Acceptance criteria

- [x] `rg -n "one build target" packages/dispatch/skills/flightplan` prints nothing.
- [x] `plan-template.md` names external live resources (device, LaunchAgent or service, local database) as the only reason to lower `Max parallel` under Claude Code, says a worktree isolates a shared build there, and says a shared build target still needs `Max parallel: 1` under OpenCode's shared-tree loop.
- [x] The Step 6.4 paragraph in flightplan's `SKILL.md` describes per-task worktrees under Claude Code, and the shared tree under the OpenCode loop. It keeps the "assert on this task's own declared files" rule.
- [x] `task-template.md`'s header template block has no `Models` line. Its `### Models` section holds the one copyable example, with no trailing note. That section states the syntax, all four roles, `fix` only on the final-review task, the model and effort sets, the default table, the effort-raise rule, and when to omit the header.
- [x] `task-template.md` states that Verification commands are relative to the repo root.
- [x] `task-template.md` scopes the sibling-tree paragraph to the shared-tree OpenCode loop, and still requires a `--` pathspec.
- [x] `interview-guide.md` has a per-task models question whose default recommendation is to omit the header.
- [x] `lint-task.test.ts` has a test that copies the `### Models` section's example line into a fixture and asserts no `models` violation, and that asserts the template block carries no `Models` line.

## Verification

- [x] `rg -n "one build target" packages/dispatch/skills/flightplan` exits 1 with no output.
- [x] `rg -n "Models" packages/dispatch/skills/flightplan/references/task-template.md` prints the `### Models` heading and its example line.
- [x] `rg -n "worktree" packages/dispatch/skills/flightplan/SKILL.md packages/dispatch/skills/flightplan/references/plan-template.md` prints at least one hit in each file.
- [x] `bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` passes, including the template-example test.
- [x] `rg -n '^> \*\*Models\*\*:' packages/dispatch/skills/flightplan/references/task-template.md` prints a line that ends with the last `role=model` entry and has no parenthesis.
- [x] `git status --short -- packages/dispatch/skills/flightplan/SKILL.md packages/dispatch/skills/flightplan/references/plan-template.md packages/dispatch/skills/flightplan/references/task-template.md packages/dispatch/skills/flightplan/references/interview-guide.md packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` shows all five paths modified.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | "one build target" still recommends a cap, the Models syntax is wrong, or the template's example line fails the parser | Syntax right, but defaults, the `fix` restriction, or the escalation rule is missing or wrong | Every fact matches `models.md` and `worktree.md`; both runtimes are described accurately |
| Consistency with _context | ×2 | Contradicts a `_context/` decision | Uses different terms for the same thing across the four files | One term per thing, and every file agrees with the others and with `_context/` |
| Clarity | ×1 | Rules buried in long paragraphs | Readable, but conditions come after instructions or several instructions share a sentence | One instruction per sentence, verb first, condition first |
| Scope | ×1 | Edits files outside the five listed | Rewrites unrelated sections of the four files | Only the named paragraphs and additions change |

## Out of scope

- Autopilot's own docs (`autopilot/SKILL.md`, `autopilot/references/opencode.md`, the repo `CLAUDE.md`). Deferred. Reason: they describe the orchestrator's worktree pipeline, which changes after this task.
- Changing `lint-task.ts` messages, including the `[serial-undeclared]` advisory text. Deferred. Reason: the advisory still correctly points at the `Max parallel` header for live resources.

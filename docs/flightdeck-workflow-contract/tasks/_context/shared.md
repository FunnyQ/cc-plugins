# Shared context

> All tasks reference this. Decisions here override anything inferred from the
> codebase.

## Project at a glance

`cc-plugins` is a plugin marketplace for Claude Code, Codex, and OpenCode. This
plan works inside the **dispatch** plugin: `flightdeck` (the live dashboard that
`autopilot` runs behind) learns to render a second kind of source — a declared
graph plus an event trail — so any Workflow-tool run can be watched, not just a
flightplan `tasks/` tree.

Everything lives under `packages/dispatch/skills/`. Two skills matter:

- `flightplan/scripts/lib/` — the shared library: `flightlog.ts` (the event
  trail), `parse-task.ts` (the markdown task parser), and `next-ready.ts`
  (`loadAllTasks`, `unmetDependencies`).
- `autopilot/scripts/` — the flightdeck server: `flightdeck.ts` (routes),
  `launch.ts` (`validatePlanDir`), `tree-api.ts` (`loadPlan`,
  `buildTreePayload`), `fleet.ts` (`deriveTaskViews`, `aggregateFleet`),
  `events-api.ts` (the SSE tail), `usage-source.ts` / `usage-attribute.ts`
  (token attribution), `waves.ts`.

The frontend at `autopilot/dashboard/dist/` is **almost** out of scope. It is
already data-driven, and no task changes its visual language — no colour, no
shape, no geometry, no change to the berth plate, the signal head, or the
crossover curve.

Two tasks may edit it, and no others. The dependency graph derives its road
order from the node list it sorts, so a declared lane order that is not
alphabetical is silently re-sorted and a lane holding no node draws no road at
all. The lane-order task takes that order as an input instead, and the plan's
closing review may make fix-only edits to the same files if it finds a defect
there — it is the last writer and would otherwise be able to record the defect
but not repair it.

If your task file does not list a frontend file, you have no exception: treat
the whole directory as untouchable. If it does, that list is exhaustive, and the
visual language stays off limits either way.

## Tech stack

- **Runtime**: Bun with TypeScript. There is no transpile step and no build.
- **Server**: `Bun.serve`, bound to `127.0.0.1`.
- **Storage**: plain files. `graph.json` and JSONL. No database.
- **Frontend** (not touched here): petite-vue + Chart.js, vendored.

## Code style

- Use `type`, never `interface`.
- Take **no external npm dependencies at runtime**. `devDependencies` may carry
  types-only packages.
- Prefer a longer function over an indirection used once.
- Comment _why_, never _what_. One line. When an approach broke, that belongs in
  the commit body, not the source.
- Match the surrounding file. These scripts are comment-heavy by convention: a
  short prose comment above anything non-obvious explaining the reason it is
  that way. Follow that — a bare implementation in this codebase reads as
  unfinished.
- Split pure logic from I/O in the same file, and export the pure half. Every
  script in `autopilot/scripts/` already does this (`buildTreePayload` is pure,
  `loadPlan` is not) and the tests depend on it.
- Errors that a consumer must see are returned as data, not thrown. `loadPlan`
  collects `{file, bucket, reason}` into `TreePayload.errors` and the dashboard
  renders them. A malformed contract file must degrade the same way.

Authoritative source for the repo-wide rules (for verification only):
`CLAUDE.md` at the repo root.

## File / directory layout

- New autopilot server code goes in `packages/dispatch/skills/autopilot/scripts/`
  as one module per concern, named after what it does (`graph-source.ts`, not
  `utils.ts`), with a sibling `<name>.test.ts`.
- Shared code that both `flightplan` and `autopilot` import lives in
  `packages/dispatch/skills/flightplan/scripts/lib/`. autopilot already imports
  across that boundary — that is the existing, sanctioned direction. Never the
  reverse.
- A new skill is `packages/dispatch/skills/<name>/SKILL.md` plus optional
  `references/` and `scripts/`. It also needs registering in **both**
  `packages/dispatch/.claude-plugin/plugin.json` and
  `packages/dispatch/.codex-plugin/plugin.json` if those files enumerate skills
  — check before assuming either way.

## Test conventions

- `bun:test`: `import { describe, expect, test } from "bun:test"`.
- Import the module under test by relative path. No path aliases.
- **Pure functions get in-memory fixtures** built by a small local factory
  function at the top of the test file. Nothing is read from disk, and no
  fixture files are committed for these.
- **Anything touching the filesystem gets a real temp directory**, via a local
  helper of this shape:

  ```ts
  function withTempDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "graph-source-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  ```

  Real directories, not mocks.

- Assert with `toEqual` on whole returned objects where practical, rather than
  field-by-field, so a new field cannot slip through unasserted.
- Comment non-obvious fixtures with one line saying what makes them non-obvious.

## Verification baseline

Every task can rely on these. Run them from the repo root.

```bash
bun test packages/dispatch/skills/flightplan/scripts/
bun test packages/dispatch/skills/autopilot/scripts/

# Typecheck. Must print nothing for the paths you touched.
bunx --bun tsc --noEmit | grep packages/dispatch
```

**Typecheck against the root `tsconfig.json`, never a file list.** Naming files
on the command line drops the config, so `strict` runs without `types: ["bun"]`
and every `Bun`, `process`, and `Buffer` reports as an undefined name — real
errors then hide among a dozen fake ones.

**The repo-wide typecheck is not green.** 86 pre-existing errors sit outside
this plan's scope. A change is clean when `grep` on the paths you touched prints
nothing, not when the count is zero.

## Concurrency rule

**Every task in this tree may run beside another one, in one shared working
tree, and no task may commit.** A sibling's correct, uncommitted edits are
indistinguishable from a scope violation.

So: never assert anything about the state of the whole tree. No `git status`
gate without a `--` pathspec naming this task's own declared files. No "only
these files changed" check. Assert on the files this task declares, by name.

## Decisions frozen during interview

- **Artifacts live at `~/.local/share/q-lab/flightdeck/<slug>/`** — a workflow
  need not belong to a `docs/` topic, and its trail should not land in the repo.
- **Fixed slug per workflow, confirm before overwriting** — the path has to be
  deterministic because it gets baked into every agent prompt at authoring time.
  A Workflow `wf_<runId>` cannot be used: that id does not exist until the run
  starts, and the script is written before that.
- **Node = a unit of work; agents are its roles and attempts** — this matches
  flightlog's existing `(task, role, attempt)` identity exactly, so retries and
  parallel review lenses do not grow the graph.
- **Completion is declared by a new `state` event kind**, not by editing a file.
  Parallel agents appending to one JSONL is safe; parallel agents rewriting one
  JSON object is not.
- **A narrow `GraphNode` type is extracted; no fake `ParsedTask` is synthesized**
  — the alternative was fabricating `rubric`, `sections`, and `body` fields
  nobody reads.
- **The source is auto-detected from the directory's contents**, so
  flightdeck's `--plan` interface, its launcher, its daemon record, and its
  restart path all stay exactly as they are.
- **autopilot is not migrated.** It shares types with the new path and nothing
  else.
- **`dispatch:deckplan` is a reference skill** — a document and a runnable
  example. It runs no interview and generates nothing.
- **No real Workflow run is executed during verification.** It costs tokens and
  needs separate authorization from Q.

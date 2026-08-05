# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`cc-plugins` is a plugin marketplace for Claude Code and Codex, holding five plugins that version
independently: **monitor** (usage dashboard + live session cockpit), **dispatch** (planning and
execution), **relay** (delegate to another harness CLI), **chronicle** (commit / PR / release
automation), and **herdr** (terminal orchestration).

This plan adds a sixth skill to **chronicle**: `adr`, an ADR curator that reads cockpit's decision
trail and promotes the decisions that mattered into Architecture Decision Records.

Everything built here lives under `packages/chronicle/`. Nothing under `packages/monitor/` is
modified.

## Tech stack

- **Runtime**: Bun with TypeScript. There is no transpile step and no build step.
- **Storage**: the filesystem. JSONL decision logs, Markdown ADRs, JSON registry.
- **Dependencies**: none. Take no external npm dependencies, ever.
- **Testing**: `bun test`, with `.test.ts` files sitting beside the module they test.

## Code style

- Use `type`, never `interface`.
- Prefer named exports. Export the pure function; keep I/O at the edges so tests can inject.
- Inject filesystem and process boundaries through an optional deps object with real defaults, the
  way `logRoot(cwd, deps)` takes an optional `gitRoot` resolver. This is how existing modules stay
  testable without mocking `node:fs`.
- Comment **why**, never **what**. A ported constant needs a comment naming its source of truth.
- Two-space indent, double-quoted strings, semicolons — match the surrounding file.
- Authoritative source (for verification only): the existing files under
  `packages/chronicle/skills/pr/scripts/`.

## Do not run type-checking with tsc

`bunx tsc --noEmit` is useless in this repo. `@types/bun` is not installed, so it floods with
pre-existing `Cannot find name 'Bun'` and `bun:sqlite` errors that have nothing to do with your
change. **Use `bun test` for verification.**

## File and directory layout

New code for this plan goes in exactly these places:

```
packages/chronicle/
├── shared/scripts/          NEW — code imported by more than one skill
├── skills/adr/
│   ├── SKILL.md             the thin router
│   ├── scripts/             one module per responsibility, each with a .test.ts beside it
│   └── references/          templates and fixtures the skill reads at runtime
├── agents/<role>.md         Claude agent definitions
└── agents-codex/<role>.toml Codex agent definitions — every agent ships in BOTH formats
```

Naming: scripts are kebab-case `.ts`; the test file is the same name with `.test.ts`. Agent files
are the bare role name, lowercase.

## Plugins cannot import across package boundaries

`packages/chronicle/` must never import from `packages/monitor/`. Plugins install independently
into version-pinned cache directories (`.../chronicle/0.9.6/`, `.../monitor/3.x.y/`), so a relative
path between them does not resolve on a user machine, and monitor may not be installed at all.

Where this plan needs logic that already exists in monitor, it is **ported** into
`packages/chronicle/shared/scripts/` with a comment naming monitor's file as the spec. Two
implementations that must be hand-synced is the accepted cost.

## Commit and branching style

- Branch: this repo runs GitHub Flow. `main` is the only long-lived branch.
- Do **not** commit. Tasks in this plan run in parallel in one shared working tree, and the runner
  owns committing.
- If you are running by hand outside that runner, commit with `/chronicle:commit`.

## Verification baseline

Measured on 2026-08-06, before any task ran:

- `bun test packages/chronicle/` → **169 pass, 0 fail, 8 files**.
- `packages/chronicle/skills/pr/scripts/analyze-branch.test.ts` holds **35 tests**.

Commands every task can rely on:

- `bun test <path/to/file.test.ts>` — run one suite.
- `bun test packages/chronicle/` — run the whole plugin's suite.
- `bun <path/to/script.ts>` — run a script directly; there is no build step.

Never assert on `git status` without a `--` pathspec naming this task's own files. Tasks run in
parallel in one working tree, so a sibling's correct uncommitted edits are indistinguishable from a
scope violation.

## Decisions frozen during interview

- **The shared trail reader lives in chronicle** — `packages/chronicle/shared/scripts/cockpit-trail.ts`.
  Cockpit's walk-up and `STALE_MS` are ported, not imported.
- **`analyze-branch.ts` behaviour does not change** — it stays branch-scoped and registry-backed.
  Its 14-day horizon is correct for a PR. Its test file must pass with zero edits.
- **ADRs live in `docs/adr/`**, named `0001-<kebab-title>.md`, with ID `ADR-0001`. Next number is
  the highest existing number plus one.
- **Status reports implementation state, not review state.** `promote` writes `Accepted`.
- **Both confirmation gates live in `SKILL.md`**, the main agent, using `cockpit wait` rather than
  `AskUserQuestion` — matching how the release skill gates. The orchestrator agent does not ask.
- **Every agent ships twice**, once as `agents/<role>.md` and once as `agents-codex/<role>.toml`.
- **Archive, never delete.** No task in this plan may remove a log file.
- **Scope is the first three delivery stages.** Making `/chronicle:pr` cite ADRs, and writing
  marketplace documentation, are deliberately out of this plan — both need a real ADR to exist first.

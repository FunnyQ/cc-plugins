# Shared context — repo conventions

Read this before any task in this tree. It is the same for every task.

## The repo

`cc-plugins` is a Claude Code + Codex plugin marketplace. Every path below is relative to the repo root
(get it with `git rev-parse --show-toplevel`). The two packages this plan touches:

- `packages/dispatch/skills/flightplan/` — the planning skill. Owns `lint-task.ts`, `parse-task.ts`,
  `next-ready.ts`, `score-task.ts`, `mark-done.ts`, `build-readme.ts`, `flightlog.ts`, plus the
  `references/*.md` templates.
- `packages/dispatch/skills/autopilot/` — the execution skill. Owns `references/orchestrator.md` (the
  canonical Workflow script) and the `scripts/` that back the flightdeck dashboard, including
  `fleet.ts` and `orchestrator-script.test.ts`.

## Runtime and language

- **Bun only.** TypeScript runs directly, no transpile step. `bun:sqlite`, `Bun.serve`, `Bun.file` are
  all fair game.
- **No external npm dependencies.** Never add one. Vendored frontend libs live in `dashboard/dist/vendor/`.
- **Use `type`, never `interface`.** This is enforced by convention across the whole repo.
- Prefer a longer function over an indirection used once.
- Comment *why*, never *what*.

## Test layout and how to run tests

Tests sit beside their source as `<name>.test.ts` and use `bun:test` (`describe` / `test` / `expect`).

```bash
bun test packages/dispatch/skills/flightplan/scripts/          # whole flightplan suite
bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts
bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts
bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts
```

Write the test first for anything with real logic. For a docs-only change, define the smallest check
that proves success (a `grep` with a stated expected count, a parse that must succeed) and satisfy it.

## Scope discipline

- Change only the lines the task requires. Touch nearby code only when the change breaks without it.
- Report unrelated problems you find in your summary. Do not fix them.
- Do not add a layer, option, or abstraction unless a criterion in your own task fails without it.

## What this tree must NOT do

- **No version bump. No `CHANGELOG.md` entry.** Both `packages/dispatch/.claude-plugin/plugin.json` and
  `.codex-plugin/plugin.json` must read the version they had when the tree started, and the marketplace
  registries (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) must stay
  unmodified. The release is cut by hand afterwards. The reason is a genuine bootstrap constraint:
  plugins are served to every session from a marketplace clone tracking `main`, so a change to the
  orchestrator cannot ship itself.
- **No new npm dependency, no new script file.** Every requirement in this plan is an edit to a file
  that already exists.
- **Never `rm`.** Use `trash` for anything you did not create in this session.

## The plugin-cache vs repo distinction

A skill runs from `~/.claude/plugins/cache/q-lab-marketplace/<plugin>/<version>/`, which is a **copy**
of the repo at release time. Editing the repo does not change what a live session executes. Two
consequences that matter here:

- The `flightplan-lint.sh` PostToolUse hook lints with the *cache* copy of `lint-task.ts`, so a new
  lint rule added in this tree will not fire in this session's hook.
- The orchestrator script is baked into the Workflow call before the run starts, so editing
  `orchestrator.md` mid-run cannot affect the run in progress. That is a safety property, not a bug.

## Run base reference

The commit this plan was written against, captured at plan time:

```
2a13247321d54eaea7242ef6bfb0e4bfd577cfdb
```

Use it as `<baseRef>` wherever a task asks for the whole-run diff:

```bash
git diff 2a13247321d54eaea7242ef6bfb0e4bfd577cfdb..HEAD   # everything committed during the run
git diff                                                   # plus anything still uncommitted
```

Both commands are needed. The second one matters because the last task's edits may not be committed yet
— an execution run commits per wave, so the final wave's changes are still in the working tree while that
wave is being reviewed.

If `HEAD` already equals that SHA, nothing has been committed yet and `git diff` alone is the whole
change set. If the SHA is not an ancestor of `HEAD` (the branch was rebased or reset), fall back to
`git merge-base HEAD origin/main` and say in your summary that you did — a silently wrong base would make
a "no regressions" claim meaningless.

## Commit convention

Commits are made by the executor (autopilot commits per wave). Subject:
`<emoji> <type>: <imperative summary>`, lowercase, no trailing period, ≤ 50 chars. Emoji/type map:
✨ feat · 🐛 fix · 📦 refactor · ✅ test · 📖 docs · 🎨 style · 🔧 chore · 🔥 remove · ⚡️ perf · 🔒 security.
Then a blank line, an English markdown-bullet body, a line containing only `---`, then a one-line
zh-TW summary.

## Language

All code, comments, docs, and task artifacts in this repo are **English**. The zh-TW line in a commit
message is the one exception.

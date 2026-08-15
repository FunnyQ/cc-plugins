# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`cc-plugins` (the `q-lab-marketplace` repo) is a plugin marketplace shipping five plugins — monitor, dispatch, relay, chronicle, herdr — to Claude Code and Codex. This build adds **OpenCode** as a third supported harness: an install path, ported hook behaviors, commands, and chronicle's subagent roles.

All new executable code lives in a new repo-root `opencode/` directory, deliberately outside `packages/`.

## Tech stack

- **Runtime**: Bun with TypeScript. No transpile step, no build step.
- **Dependencies**: none. Take no external npm dependency, ever.
- **Tests**: `bun test`.
- **Target harness**: OpenCode, alongside the existing Claude Code and Codex support.

## Code style

- `type` over `interface`.
- Pure exported functions carry the logic; process spawns and file I/O sit behind thin named wrappers.
- Comment *why*, never *what*. One line. When an approach broke, that belongs in the commit body, not the source.
- Build the smallest thing that satisfies the task. Add a layer, abstraction, option, or dependency only when a stated requirement fails without it — and name the concrete failure it prevents.
- Do not handle errors the code cannot reach.
- Prefer a longer function over an indirection used once.
- Match the style of the file you are editing.

## THE DO-NOT-TOUCH LIST — read this before editing anything

This build must leave **Claude Code and Codex behaving identically**. Everything executable is *new* code under `opencode/`. Inside `packages/`, only `.md` files change, and only by **adding** a clearly fenced OpenCode section — never by rewriting, reordering, condensing, or deleting an existing instruction.

Never modify:

- `packages/*/.claude-plugin/plugin.json` and anything under `packages/*/.codex-plugin/` — no edits, and **no version bumps** (see below).
- `packages/chronicle/hooks/check-branch.sh` and `packages/dispatch/hooks/flightplan-lint.sh`. The OpenCode module **invokes** these scripts as-is. Do not refactor them to be "more reusable", do not change their stdin contract, exit codes, or output shape. They are the live hook path for Claude Code and Codex; a change here breaks those harnesses silently.
- `packages/chronicle/agents/*.md` and `packages/monitor/commands/*.md`. The OpenCode versions are **new files** under `opencode/`, converted from these. The originals stay byte-identical.
- Any `.ts` file under `packages/`, including `packages/monitor/skills/shared/`.

Installer scope: write only inside `~/.config/opencode/`. Never `~/.claude/settings.json`, never anything under `~/.codex/`.

Adding an OpenCode section to a `SKILL.md` is allowed and expected — but keep it self-contained and clearly fenced so a Claude Code reader can skip it in one glance. Diluting an existing instruction is a regression even when nothing was deleted.

## File / directory layout

New code goes here, and nowhere else:

```
opencode/
├── plugin.ts               # the OpenCode plugin module (single file, no repo imports)
├── plugin.test.ts
├── install.ts              # --check | --dry-run | --apply | --unlink
├── install.test.ts
├── agents/                 # 13 chronicle agents in OpenCode frontmatter (committed)
├── commands/               # nudge.md + thoughtful.md in OpenCode format (committed)
└── references/opencode-runtime.md   # the runtime spike log — written by hand before the tree runs
```

Existing repo layout worth knowing:

- `packages/<plugin>/skills/<skill>/SKILL.md` — one directory per skill, with `scripts/` and `references/` beside it.
- `packages/<plugin>/.claude-plugin/plugin.json` and `packages/<plugin>/.codex-plugin/plugin.json` — every plugin ships both manifests.
- `packages/monitor/skills/shared/` — shared scripts, imported by monitor's other skills. **It has no `SKILL.md` and is not a skill.**

## Where things install, under OpenCode

| What | Target |
|---|---|
| Skills | `~/.config/opencode/skills/<name>/` (directory symlink) |
| Plugin module | `~/.config/opencode/plugin/q-lab.ts` (symlink) |
| Agents | `~/.config/opencode/agents/<name>.md` (symlink) |
| Commands | `~/.config/opencode/commands/<name>.md` (symlink) |
| `subagent_depth` | `~/.config/opencode/opencode.json` (the one config edit) |

## The OpenCode skill root rule

This exact rule goes into every `SKILL.md` OpenCode branch, and every script path an OpenCode reader is told to run:

> Under OpenCode, skills are installed at `~/.config/opencode/skills/<name>/` (symlinked by `opencode/install.ts`). Resolve scripts from there: `bun ~/.config/opencode/skills/<name>/scripts/…`. `CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it.

**Two Claude-specific resolution mechanisms need replacing, not just `CLAUDE_PLUGIN_ROOT`.** Several skills tell the reader to take `$SKILL_DIR` from Claude Code's *"Base directory for this skill"* banner, which OpenCode does not print. An OpenCode branch must supply the literal `~/.config/opencode/skills/<name>/` path instead of reusing the banner rule. Grep for the banner phrasing as well as for the variable — a skill can be Claude-bound without ever naming `CLAUDE_PLUGIN_ROOT`.

A skill that resolves no scripts at all needs no root rule. Say what it *does* gain (a capability statement, a caveat) rather than adding a rule it has no use for.

## Decisions frozen before execution

- **No version bumps.** No `plugin.json` changes anywhere, so no `<plugin>-vX.Y.Z` tag and no CHANGELOG entry for this work. `opencode/` is repo infrastructure, not a release component.
- **Call the shell hooks; do not reimplement them.** `check-branch.sh` and `flightplan-lint.sh` stay the single source of truth for all three harnesses. The module builds the stdin payload each already expects, runs it, and translates the result. Reimplementing their branching in TypeScript would create two copies of the same workflow rules with nothing keeping them in sync.
- **Root resolution without a config file.** The module derives the repo root from `import.meta.dir`, because the plugin is installed as a symlink into this checkout. There is no `config.json`, no XDG write, and no config-read fail-open branch.
- **Symlinks, not copies.** The repo is the single source of truth. `--check` detects missing / broken / stale / foreign; `--unlink` removes only symlinks whose resolved target points into this repo.
- **Skills install to `~/.config/opencode/skills/`**, not `~/.claude/skills/`, because the latter already holds a legacy manual `relay` symlink and OpenCode scans both — installing there would surface two skills named `relay`.
- **Skill enumeration is by `SKILL.md` presence.** A `packages/*/skills/*` glob returns 16 and is wrong.
- **`subagent_depth ≥ 2` is a real prerequisite**, the OpenCode equivalent of Claude's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. The installer raises it under `--apply`, raise-only, preserving every other key.
- **The branch guard throws.** OpenCode has no hook-level "ask", so a protected-branch commit becomes a hard block carrying the shell script's own message.

## Commit & branching style

- This repo runs GitHub Flow. `main` is the only long-lived branch.
- Commit format: emoji + conventional, e.g. `✨ feat: …`, `🐛 fix: …`, `📝 docs: …`, `🔧 release: …`.
- Do not commit. Autopilot handles commits between waves; a task that commits corrupts a shared working tree.

## Verification baseline

Commands any task can rely on:

- `bun test opencode/` — the new unit tests.
- `bun test packages/` — the existing suites. They must keep passing; you are not expected to add to them. **Baseline at the time this tree was written: 1840 pass, 0 fail, 98 files.** Record your own baseline before you start editing, and judge yourself on *new* failures rather than on a raw green/red. A few of these tests are environment-sensitive — running from a non-git working directory, or from a fresh clone with no local state, can flip one without anything being wrong with your change.
- `bun <path>/script.ts --help` style smoke runs for any CLI you write.

There is no lint or build command; there is no transpile step.

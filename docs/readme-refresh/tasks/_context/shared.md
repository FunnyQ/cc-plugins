# Shared context — repo and README conventions

Read this before any task in this tree. It is the same for every task.

## The repo

`cc-plugins` is a Claude Code + Codex plugin marketplace. Every path below is relative to the repo root
(get it with `git rev-parse --show-toplevel`). The only file this plan edits is `README.md` at that root.

The marketplace ships five plugins, each versioned independently under `packages/`:

| Plugin | Skills |
|---|---|
| `monitor` | `usage-dashboard`, `cockpit`, `install` |
| `dispatch` | `preflight`, `flightplan`, `autopilot`, `waypoints` |
| `relay` | `relay` |
| `chronicle` | `commit`, `pr`, `release`, `install` |
| `herdr` | `herdr` |

Both marketplace registries — `.claude-plugin/marketplace.json` (Claude) and
`.agents/plugins/marketplace.json` (Codex) — register all five. Neither registry carries a `version`
field; versions live only in each plugin's two `plugin.json` files.

## README structure as it stands

```
# cc-plugins
  intro paragraph (lists all five plugins)
## Development Workflow
## Plugins                  ← per-plugin skill tables
## Claude Code Installation ← "### CLI" + "### TUI"
## Codex Installation
## usage-dashboard
## cockpit
## dispatch                 ← ends with "### Installation"
## relay                    ← ends with "### Installation"
## herdr                    ← ends with "### Installation"
## Adding a New Plugin
## License
```

The per-plugin `### Installation` blocks all take this shape:

````markdown
### Installation

```bash
# Claude Code
claude plugins install <plugin>@q-lab-marketplace

# Codex
codex plugin add <plugin>@q-lab-marketplace
```
````

Match it exactly for any new one.

## Writing rules

These come from the repo owner's global writing rules and the README's existing voice.

- Write one instruction per sentence. Start an instruction with a verb.
- Put the condition before the instruction, and the warning before the step it affects.
- Use one term per thing. Never vary wording for style.
- Copy identifiers, commands, and paths exactly. Wrap them in backticks.
- Cut every word that carries no meaning. No marketing adjectives, no emoji.
- Prefer an em-dash clause for apposition — the surrounding prose already does this.
- Never state a plugin version number in prose. Versions go stale on every release.

## Facts you may need, so you do not have to hunt for them

- **chronicle's four skills**: `commit` (auto-decides one simple commit vs an atomic split), `pr` (opens
  a GitHub PR or GitLab MR with a reviewer-legible body, enriched by the cockpit decision trail when one
  exists), `release` (config-first: detects whole-repo vs per-component layout, remembers it in a
  committed `.chronicle/release.json`, bumps version files, writes the `CHANGELOG.md` entry, and in auto
  mode commits, tags, and pushes), `install` (sets up the prerequisites for both harnesses).
- **chronicle's topology**: every skill is a thin `SKILL.md` → a no-Bash nested orchestrator → cheap
  child agents. That shape is why it needs the spawn-depth setting.
- **The spawn-depth prerequisite**: Claude Code 2.1.217 stopped letting subagents spawn nested subagents
  by default. Without `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` set to at least `2`, every chronicle flow
  fails with `Agent exists but is not enabled in this context`. A `SessionStart` hook writes it into
  `~/.claude/settings.json`; the value is read at session start, so Claude Code must be restarted after.
  The README already documents this in a blockquote under the chronicle skill table — do not duplicate
  that blockquote, refer to it.
- **Marketplace add commands**: `claude plugins marketplace add FunnyQ/cc-plugins` and
  `codex plugin marketplace add FunnyQ/cc-plugins`.

## Scope discipline

- Change only the lines your task names. Touch nearby lines only when the change breaks without it.
- Report unrelated problems you find in your summary. Do not fix them.
- Do not add a section, table, or blockquote that no acceptance criterion asks for.
- Never edit a file outside `README.md`.

## Verifying a docs change

There is no test suite for prose. Define the smallest check that proves success and run it — a `grep`
with a stated expected count, or a heading-order check. State the command and its actual output in your
summary.

```bash
grep -n '^## ' README.md            # heading order
grep -c '^## chronicle' README.md   # exact section count
```

## Commit style

Do not commit. The autopilot run commits between waves on its own.

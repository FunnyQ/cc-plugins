# opencode-compat — make cc-plugins usable from OpenCode

> **Status**: draft (v2 — supersedes the 2026-08-14 approved draft)
> **Owner**: Q
> **Last updated**: 2026-08-15

## 1. Overview

Make `cc-plugins` (q-lab-marketplace) a first-class harness target in **OpenCode**, alongside Claude Code and Codex.

OpenCode already reaches the repo's **data and transport** layers: monitor reads `~/.local/share/opencode/opencode.db` in both dashboards, cockpit already ships an OpenCode **send** bridge (`opencode-send.ts` → the TUI's `/tui/append-prompt` + `/tui/submit-prompt`), relay has a complete opencode backend, and herdr detects opencode panes.

What is missing is the **runtime** layer: an install path, hook behaviors (OpenCode has no `SessionStart`/`Stop`/`PreToolUse`/`PostToolUse`), commands, and chronicle's subagent roles.

After this build: one installer wires all 15 skills, one plugin module ports four hook behaviors (of the two remaining, one is dropped as inert and one moves into the installer — §5), both monitor commands work, chronicle's orchestrators spawn their agents through the task tool, and the docs state exactly what works and what does not.

## 2. Goals / Non-goals

**Goals**

- **Claude Code and Codex behave identically afterwards.** This outranks every other goal. Everything executable is new code under `opencode/`; inside `packages/` only `.md` files change, and only by *adding* a clearly fenced opencode section. The hook scripts, `plugin.json` manifests, agent definitions, monitor commands, and every `.ts` under `packages/` stay byte-identical — the module *calls* the hook scripts rather than refactoring them. The final review gates on `git diff --name-only main -- packages/ | grep -v '\.md$'` printing nothing and `bun test packages/` still passing.
- Skills: all 15 `SKILL.md` files discovered and script-resolvable under opencode.
- Hooks: one plugin module ports monitor's decision-log start and scribe nudge, chronicle's branch guard, and dispatch's flightplan lint — by **invoking the existing scripts**, never by reimplementing their logic.
- Commands: `nudge` and `thoughtful` as opencode commands.
- Agents: chronicle's 13 roles as opencode subagents (task tool, `subagent_type`).
- Installer: `opencode/install.ts` with `--check | --dry-run | --apply | --unlink`, idempotent.
- **Cockpit send**: verify the existing bridge against a live opencode session and document its precondition. Not new code — a verification + docs deliverable.
- Docs: README "OpenCode Installation" + CLAUDE.md harness notes.

**Non-goals**

- **No statusline** — a Claude-only concept, no opencode equivalent, never.
- **No npm publishing** — v1 installs locally (symlinks only); the module stays structured so packaging is possible later.
- **One `opencode.json` write, and only one** — `subagent_depth`, raised to 2 so chronicle's orchestrators can spawn their children (§3.1). Raise-only, never lower; every other key left untouched. Commands, agents, and skills all still ship as files, and nothing else in that config is written.
- **No MCP registration** — cockpit-channel is Claude's send path. OpenCode sends already ride the TUI HTTP bridge, so the channel buys nothing here.
- **No new send mechanism** — if the spike shows the existing bridge is broken, that is a bug report, not this build's scope.
- **No version bumps** — no `plugin.json` changes; `opencode/` is repo infra, not a release component.
- **No CI integration tests** — runtime behaviors verified manually in the spike and the final review; unit tests cover pure logic only.

## 3. Context

### 3.1 What opencode is (verified against opencode.ai docs + loader source)

- **Skills**: discovered from `.opencode/skills/`, `~/.config/opencode/skills/`, plus Claude/Codex-compatible `.claude/skills/` and `.agents/skills/` (project + global). Frontmatter recognized: `name` (required, must match the dir name), `description` (required), `license`, `compatibility`, `metadata`. **Unknown fields are ignored** — existing frontmatter (`when_to_use`, `argument-hint`) needs no change.
- **Plugins are JS/TS modules, not manifests.** Loaded from `{.opencode,~/.config/opencode}/{plugin,plugins}/*.{ts,js}` with `symlink: true` (**symlinks are followed**). A file plugin **must NOT export `id`** — see S18. Exporting any non-function value stops the loader from ever calling the plugin function, silently. The module exports one or more async plugin functions `(ctx) => hooksObject`, where `ctx = { project, client, $, directory, worktree }` (`$` = Bun shell). Hook keys: `event`, `"tool.execute.before"`, `"tool.execute.after"`, `"shell.env"`, `tool`, `"experimental.session.compacting"`. Events include `session.created/updated/status/idle/compacted`, `message.part.*`, `permission.asked/replied`.
- **Commands**: markdown in `{.opencode,~/.config/opencode}/commands/`; filename = command name; frontmatter `description` (+ optional `agent`, `model`); body supports `$ARGUMENTS`, `$1..`, `` !`cmd` ``, `@file`.
- **Agents**: markdown in `{.opencode,~/.config/opencode}/agents/`; filename = agent name; frontmatter `description` (required), `mode` (`primary|subagent|all`), `model`, `temperature`, `steps` (`maxSteps` deprecated), `permission` (`read`/`edit`/`bash`/`task`/`glob`/`grep`/`list`/`webfetch`/`websearch`/`lsp`/`skill`/`question`/`external_directory`/`todowrite` → `allow|ask|deny` or glob maps), `hidden`, `color`, `top_p`. Subagents spawn via the **task tool**, gated by `permission.task`. Two subagents are built in — `explore` and `general` — alongside the `build`, `plan`, `compaction`, `summary` and `title` primaries.
- **OpenCode has a spawn-depth gate, exactly like Claude Code.** `subagent_depth` in `~/.config/opencode/opencode.json` (a plain number, alongside `permission` and `plugin`). Chronicle's deepest chain is skill → orchestrator → child, so it needs **≥ 2** — the same requirement, and the same silent failure mode, as `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. **The shipped default is 1** — the published config schema states it outright: *"Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents."* So chronicle is broken on every fresh install until the installer raises it. Whether the value is re-read live, and whether a project config overrides the global one, remain S14.

### 3.2 Current repo state (verified 2026-08-15)

**Already opencode-aware — do not rebuild:**

| Surface | State |
|---|---|
| usage-dashboard | reads `opencode.db` via `skills/shared/scripts/opencode.ts` |
| cockpit reads | `transcript-stream.ts` has an `opencode` provider |
| cockpit **sends** | `opencode-send.ts` + `cockpit-server.ts:227` `/api/send-opencode-message`. Discovers the TUI server from `OPENCODE_TUI_SERVER_URL` / `OPENCODE_SERVER_URL` or a `ps` scan for `opencode --port <n>`; health-checks `/global/health`; verifies `/session/<id>`; delivers via `/tui/append-prompt` + `/tui/submit-prompt`. **Precondition: the TUI must be started with a port.** |
| relay | full opencode backend (delegate/review; image gated off) |
| herdr | `herd.ts` detects/spawns opencode panes |

**15 skills**, enumerated by `SKILL.md` presence — monitor {usage-dashboard, cockpit, install}, dispatch {preflight, flightplan, autopilot, waypoints}, relay {relay}, chronicle {adr, commit, pr, release, install}, herdr {herdr, herdr-protocol-upgrade}. `packages/monitor/skills/shared/` sits inside `skills/` but has **no `SKILL.md` and is not a skill** — a `packages/*/skills/*` glob returns 16 and is wrong.

**Skills import across their own directory boundary** — `packages/monitor/skills/cockpit/scripts/*.ts` → `../../shared/scripts/opencode`, `packages/chronicle/skills/*/scripts/*.ts` → `../../../shared/scripts/cockpit-trail`. The symlink-per-skill install model only works if the runtime resolves the entry symlink to its realpath (see S7).

**Hook surface — six Claude hook blocks across three `.claude-plugin/plugin.json` files (`packages/monitor/.codex-plugin/hooks.json` mirrors the monitor pair for Codex and needs no separate port):**

| Plugin | Hook | Command | Port? |
|---|---|---|---|
| monitor | `SessionStart` (startup\|resume\|clear\|compact) | `setup.ts --session-check` | **no** — inert under opencode, see below |
| monitor | `SessionStart` (same matcher) | `decision-log-start.ts` | yes |
| monitor | `Stop` | `scribe-nudge.ts` | yes |
| chronicle | `SessionStart` (startup\|resume\|clear\|compact) | `setup-spawn-depth.ts --session-check` | **not as a hook** — the gate exists (`subagent_depth`, §3.1) but opencode has no session-start hook, and the value is read at startup anyway. Moves into the installer (T3) |
| chronicle | `PreToolUse` (matcher `Bash`) | `hooks/check-branch.sh` | yes |
| dispatch | `PostToolUse` (matcher `Edit\|Write`) | `hooks/flightplan-lint.sh` | yes |

**`setup.ts --session-check` is dead code under opencode.** `packages/monitor/skills/install/scripts/setup.ts:357-358` returns immediately when `CLAUDE_PLUGIN_DATA` is unset, which it always is outside Claude Code. Even with the gate satisfied, its work is statusline-path migration and reaping orphaned Claude processes (`setup.ts:370-408`) — both Claude-only, and the statusline is an explicit non-goal. Porting it would produce a target that runs, does nothing, and gets tested.

**Both hook scripts read a JSON payload on stdin** — `check-branch.sh:10` takes `.tool_input.command`, `flightplan-lint.sh:21` takes `.tool_input.file_path` — and both already resolve their own dependencies when `CLAUDE_PLUGIN_ROOT` is empty (`flightplan-lint.sh:44-47` falls back to a path relative to itself). Both fail open without `jq`. They are directly callable from the opencode module; see §4.

**`scribe-nudge.ts:226` switches its output shape on `process.env.PLUGIN_ROOT`** (the Codex marker). Under opencode neither harness variable is set, so it emits the Claude hook-JSON shape. The module must handle that shape rather than assume plain text.

**13 chronicle agents** in `packages/chronicle/agents/*.md`, Claude format: `name`, `description`, `model` (sonnet/haiku), optional `effort`, `tools` array, `maxTurns: 15` on the three orchestrators (lawspeaker, lorekeeper, storykeeper).

**2 commands**: `packages/monitor/commands/{nudge,thoughtful}.md`. They are Claude-bound in *different* ways — `nudge.md:11` interpolates `${CLAUDE_PLUGIN_ROOT}`, while `thoughtful.md` never mentions it and is instead bound to the Agent tool's `subagent_type: "fork"` (`thoughtful.md:19-26`). Each needs a different fix.

**Existing legacy install path**: `README.md:261` tells the user `ln -s .../packages/relay/skills/relay ~/.claude/skills/relay`. OpenCode scans `~/.claude/skills/`, so that symlink collides by name with a new `~/.config/opencode/skills/relay`.

## 4. Shared decisions (bind all tasks)

- **Layout**: a new repo-root `opencode/` — cross-plugin infra, deliberately outside `packages/`, so the "every package ships two manifests" invariant and `.chronicle/release.json` stay untouched.

  ```
  opencode/
  ├── plugin.ts               # the opencode plugin module (single file, no repo imports)
  ├── plugin.test.ts
  ├── install.ts              # --check | --dry-run | --apply | --unlink
  ├── install.test.ts
  ├── agents/                 # 13 chronicle agents, opencode frontmatter (committed)
  ├── commands/               # nudge.md + thoughtful.md, opencode format (committed)
  └── references/opencode-runtime.md   # spike findings
  ```

- **Stack**: Bun + TypeScript, no transpile, no external deps. `type` over `interface`. Pure exported functions carry the logic; process spawns sit behind a thin `run()`. `bun test opencode/`.

- **Root resolution — no config file.** The module derives the repo root from `import.meta.dir`, because the plugin is installed as a symlink into this checkout and the loader follows symlinks. **No `config.json`, no XDG write, no `readConfig()` fail-open branch, no foreign-root backup logic.**
  **Confirmed by the spike (S8)**: a symlink-loaded module reports its realpath, both under a direct dynamic import and under the loader's glob-then-import path. The shim fallback that was drafted against the other branch is not needed and must not be built.

- **The opencode skill root rule** (goes into every SKILL.md opencode branch):
  > Under OpenCode, skills are installed at `~/.config/opencode/skills/<name>/` (symlinked by `opencode/install.ts`). Resolve scripts from there: `bun ~/.config/opencode/skills/<name>/scripts/…`. `CLAUDE_PLUGIN_ROOT` is empty under opencode — never use it.

- **Skills install to `~/.config/opencode/skills/`**, not `~/.claude/skills/`. Reason: `~/.claude/skills/` is where the README's legacy relay symlink lives, and opencode scans both — installing there would produce two skills named `relay`. (Marketplace-installed Claude skills live in the plugin cache and never collide.) `--check` must detect the legacy symlink and tell the user to remove it.

- **Skill enumeration**: directories under `packages/*/skills/*` that contain a `SKILL.md`. Exactly 15. Asserted in the installer's unit test.

- **Symlinks only**; the repo is the single source of truth. `--check` detects missing / broken / stale / foreign; `--unlink` removes only symlinks whose resolved target points into this repo.

- **Call the shell hooks; do not reimplement them.** `check-branch.sh` and `flightplan-lint.sh` stay the single source of truth for both harness families. The module builds the stdin payload each script already expects, runs it, and translates the exit code and output into opencode's surface. Reimplementing their branching in TypeScript would create two copies of the workflow rules with nothing keeping them in sync — and the pure-TS signature cannot even express the legacy branch (`check-branch.sh:53-64` reads `gitflow.branch.develop` / `.master` from git config, which is neither the command, the branch, nor `pr.json`). The module's own logic shrinks to a payload builder and a response translator, both trivially testable.

- **Branch guard throws** (opencode has no hook-level ask). `check-branch.sh` emits `{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"…"}` on a violation; the module throws that `systemMessage` verbatim. Non-violations exit 0 with no output.

- **Chronicle agents**: `mode: subagent`, `hidden: true`; `model`/`effort` omitted (inherit); `maxTurns: 15` → `steps: 15` on the three orchestrators only; `tools` → `permission` map — `Bash`→`bash: allow`, `Read`→`read: allow`, `Edit`/`Write`→`edit: allow`, `Agent`→`task: allow` (**critical on lawspeaker / lorekeeper / storykeeper**).

- **Release policy**: no `plugin.json` changes → no version bumps, no tags.

## 5. Architecture

```
opencode/plugin.ts   (loaded from ~/.config/opencode/plugin/q-lab.ts, a symlink into this repo)
   │  root = dirname(import.meta.dir)
   ├─ event: session.created  → bun <root>/packages/monitor/skills/cockpit/scripts/decision-log-start.ts
   ├─ event: session.idle     → bun <root>/packages/monitor/skills/cockpit/scripts/scribe-nudge.ts
   │                            (parse the Claude-shape hook JSON it emits — §3.2)
   ├─ tool.execute.before(input, output)   [args are on OUTPUT, not input — S5]
   │                          → <root>/packages/chronicle/hooks/check-branch.sh
   │                            stdin: {"tool_input":{"command": output.args.command}}
   │                            → permissionDecision "ask" ⇒ throw its systemMessage
   │                            (throw blocks the command and shows the message verbatim — S3)
   └─ tool.execute.after(input, output)
                              → <root>/packages/dispatch/hooks/flightplan-lint.sh
                                stdin: {"tool_input":{"file_path": output.args.filePath}}
                                → exit 2 ⇒ append stderr to output.output (S4)

opencode/install.ts  (run from the checkout, any shell)
   ├─ --check     per-target report: skills×15, plugin×1, agents×13, commands×2, legacy-collision warning
   ├─ --dry-run   print planned actions, touch nothing
   ├─ --apply     symlink into ~/.config/opencode/{skills,plugin,agents,commands}/
   └─ --unlink    remove exactly what --apply created
```

### Hook parity table

| Claude/Codex hook | opencode port |
|---|---|
| monitor `SessionStart` → `setup.ts --session-check` | **not ported, by design** — inert without `CLAUDE_PLUGIN_DATA`, and its work (statusline migration, Claude process reaping) is Claude-only (§3.2) |
| monitor `SessionStart` → `decision-log-start` | `session.created` |
| monitor `Stop` (`scribe-nudge`) | `session.idle` — matches the nudge's per-turn design (cadence per S2) |
| chronicle `SessionStart` (`setup-spawn-depth --session-check`) | **moved, not dropped** — the same prerequisite exists (`subagent_depth ≥ 2`), but opencode offers no session-start hook and reads the value at startup. The installer raises it under `--apply` and reports it under `--check` (T3) |
| chronicle `PreToolUse` (`check-branch.sh`) | `tool.execute.before` on bash → run the script, throw its `systemMessage` (no hook-level ask) |
| dispatch `PostToolUse` (`flightplan-lint.sh`) | `tool.execute.after` on write/edit → run the script, surface stderr on exit 2 (API per S4) |

### What the module must not re-derive

Both scripts keep their own semantics; the module supplies stdin and reads the result. Recorded here only so a reviewer can tell a wiring bug from a behavior change:

- **check-branch.sh** — only `git commit` commands; `.chronicle/pr.json` authoritative (`github-flow` → guard `.base`, **exempt a `🔧 release:` subject**; `git-flow` → guard `.production`); legacy git-config fallback (`gitflow.branch.develop` / `.master`) guards `main`/`master`; fail-open everywhere, including a missing `jq`. All of it runs inside the script — the module passes the command string and nothing else.
- **flightplan-lint.sh** — path filter, `Required reading` header sniff, then `bun lint-task.ts <file>`; resolves the linter relative to itself when `CLAUDE_PLUGIN_ROOT` is empty; fail-open when the linter is missing. The module passes the file path and nothing else.

## 6. SPIKE checklist

Resolve every item in a sandbox before any production code. Sandbox recipe: `XDG_CONFIG_HOME=/tmp/opencode-sandbox opencode …` (record the override that actually works); a probe module logs every event; a fake subagent, command, and symlinked skill verify discovery. **Never touch the real `~/.config/opencode`.**

| # | Question | Gates |
|---|---|---|
| S1 | Does `session.created` fire on **resume**? Fallback events (`session.updated` / `session.status`)? | T2 |
| S2 | `session.idle` cadence (per turn end?) + payload shape | T2 |
| S3 | `tool.execute.before`: `output.permission = "ask"` mutation vs `throw` — what does the user see? | T2 |
| S4 | `tool.execute.after`: which tools fire it; how to surface a violation (mutate `output.error` vs throw); does the write still land? | T2 |
| S5 | Bash tool argument name (`input.args.command`?) + background/detached command support | T2, T6 |
| S6 | Are symlinked skill dirs under `~/.config/opencode/skills/` discovered? | T3 |
| S7 | **Does `bun ~/.config/opencode/skills/cockpit/scripts/find-session.ts` resolve `../../shared/scripts/opencode`?** (entry-symlink → realpath). If no, the whole symlink-per-skill model is dead and T3 needs a different install shape. | T3, all |
| S8 | `import.meta.dir` inside a symlink-loaded plugin module: realpath or link path? | T2, T3 |
| S9 | Task-subagent **context** inheritance | T4, T5 |
| S10 | Confirm no Workflow tool → the manual task-tool wave loop is autopilot's only option | T6 |
| S11 | Any hook-side user prompting (`ctx.question`)? Else throw-with-message is the only surface | T2 |
| S12 | Duplicate skill name across `~/.claude/skills/` and `~/.config/opencode/skills/` — which wins, is there a warning? **Not a gate** — §4 already resolves the collision by install location and a `--check` warning; record the observed behavior only | — |
| S13 | Cockpit send round-trip: start `opencode --port <n>`, confirm `/global/health`, `/session/<id>`, `/tui/append-prompt` + `/tui/submit-prompt` land in a live session; record the session-id format and whether the port flag is mandatory | T6, T7, T8 |
| S14 | **`subagent_depth`**: what does a fresh install default to? Is it read once at startup or live? Does a project `.opencode/opencode.json` override the global? Confirm `2` actually carries chronicle's deepest chain (skill → lawspeaker → watcher), and that `permission.task: allow` alone suffices without a per-spawn prompt | T3, T4, T6 |
| S15 | `scribe-nudge.ts` output under opencode — confirm the Claude hook-JSON shape (§3.2) and decide whether the module parses `systemMessage` out of it or discards the wrapper | T2 |
| S16 | Does opencode print a skill base-directory banner? Six skills resolve their scripts through Claude's *"Base directory for this skill"* banner rather than `CLAUDE_PLUGIN_ROOT`, so a skill can be Claude-bound without ever naming the variable | T6 |
| S17 | What `subagent_type` values can the task tool spawn — is there a built-in general-purpose one, and can a spawn pass an inline role prompt to it? Autopilot's manual wave loop needs a dev role and a judge role, and this build defines neither as an agent file | T6 |

## 7. Task list

This plan is executable as a flightplan tree at `docs/opencode-compat/tasks/`. The mapping:

| Task below | Tree location | Depends on |
|---|---|---|
| T2 Module | `runtime/01-plugin-module` | none — foundation |
| T3 Installer | `runtime/02-installer` | `runtime/01`, `assets/01`, `assets/02` |
| T4 Agents | `assets/01-chronicle-agents` | none — foundation |
| T5 Commands | `assets/02-monitor-commands` | none — foundation |
| T6 Skills | `skills/01-monitor` … `skills/05-herdr`, plus `skills/06-autopilot-parity` | `runtime/02` (+ `assets/01` for chronicle) |
| T7 Docs | `docs/01-readme-and-claude-md` | all six `skills/` tasks |
| T8 Final review | `review/01-final-review` | `docs/01`, transitively everything |

Wave 1 runs `runtime/01` + `assets/01` + `assets/02` in parallel; wave 3 runs all six `skills/` tasks in parallel.

### T1 — Spike: opencode runtime verification *(prerequisite, not a tree task)*

**T1 is deliberately outside the task tree.** Resolving it requires a live, interactive opencode session — starting one, watching which events fire, and reading what the runtime actually does. A headless executor cannot observe that and would fabricate plausible answers instead, which is the single worst outcome for this build: a wrong runtime assumption propagates into the module, the installer, five `SKILL.md` files, and the README before anyone notices.

**Run it by hand, before starting the tree.** Answer S7 and S8 first — either can invalidate the tree's shape rather than just fill in a blank.

**Outputs**: `opencode/references/opencode-runtime.md` — one section per S1–S17, each recording *observed behavior* → *decision*, plus the observed `opencode --version`. Mirror each answer into `tasks/_context/runtime-facts.md`, which is what the executors read and which is the authoritative list.

**The gate**: `runtime-facts.md` ships with every item marked `UNRESOLVED`, and instructs any task that needs an unresolved fact to set `Status: blocked` and stop rather than guess. Blocking is the intended behavior, not a failure.

### T2 — Module: `opencode/plugin.ts`

**Depends on**: T1.
**Shape**: `export const QLabPlugin = async (ctx) => ({ event, "tool.execute.before", "tool.execute.after" })` — **and no other export whatsoever** (S18: a non-function export stops the loader from ever calling the plugin, silently). Single file, no repo imports, no config I/O. Root from `import.meta.dir` per §4. A missing script or hook is a silent no-op (fail-open); session handlers log to stderr and never throw; the branch-guard throw is the only intentional throw. **Four ported behaviors, not five** — the two `--session-check` hooks are deliberately absent (§5).

The module holds wiring, not workflow rules. Pure exported functions:
- `hookPayload(kind, value): string` — the stdin JSON each shell hook expects.
- `guardVerdict(exitCode, stdout): string | null` — the `systemMessage` to throw, or `null`.
- `lintVerdict(exitCode, stderr): string | null` — the violation text to surface, or `null`.

Impure: `runHook(root, relScript, payload)` (Bun spawn, stdin pipe, capture) and `runScript(root, relScript, args)` for the two session scripts.

**Tests** (`opencode/plugin.test.ts`): `guardVerdict` / `lintVerdict` across exit 0 / exit 2 / malformed output / empty output, and `hookPayload` shape — all pure, no shell. The scripts' own branching is already covered by their Claude-side behavior and is not re-tested here.
**Verification**: `bun test opencode/plugin.test.ts`; sandbox smoke — session start runs `decision-log-start`, idle fires scribe-nudge, `git commit` on `main` is blocked while `🔧 release:` passes, a fake flightplan task write surfaces the lint, a repo with no `.chronicle/pr.json` still commits (fail-open).
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

### T3 — Installer: `opencode/install.ts`

**Depends on**: T1, T2, T4, T5.
**Target table** — a pure function of the repo root returning `{ kind: "symlink", installed, source, label }`:

| Source | Target | Count |
|---|---|---|
| `packages/*/skills/*` with a `SKILL.md` | `~/.config/opencode/skills/<name>` | 15 |
| `opencode/plugin.ts` | `~/.config/opencode/plugin/q-lab.ts` | 1 |
| `opencode/agents/*.md` | `~/.config/opencode/agents/<name>.md` | 13 |
| `opencode/commands/*.md` | `~/.config/opencode/commands/<name>.md` | 2 |
| *(edit, not symlink)* `subagent_depth: 2` | `~/.config/opencode/opencode.json` | 1 |

The `subagent_depth` target is the only write. Reuse the shape of `packages/chronicle/skills/install/scripts/spawn-depth-decision.ts` — a pure `decide(current, required)` that **only ever raises** — rather than inventing a second policy. Preserve every other key and the file's formatting; refuse to write on unparseable JSON and print the manual edit instead (`setup-spawn-depth.ts:30-36` does exactly this). `--unlink` leaves the value alone: it may predate this install (it does on Q's machine), and lowering it would break a working setup.

**CLI**: `--check` (per-item `✓/✗/○`; exit 0 only if everything is correct; **warns on the legacy `~/.claude/skills/relay` symlink**) / `--dry-run` / `--apply` (mkdir parents, re-link stale or broken; **never overwrite a non-symlink or a symlink pointing outside this repo — report, skip, exit non-zero**) / `--unlink` (only symlinks resolving into this repo). Plain Bun script, `if (import.meta.main)`, no harness dependency.

**Tests** (`opencode/install.test.ts`): target-table enumeration asserts exactly 15/1/13/2 symlinks plus the one config edit and the exact paths, and that `skills/shared` is excluded; plan building for each flag; the depth decision across missing key / lower / equal / higher / unparseable file.
**Verification**: `bun test opencode/install.test.ts`; a sandboxed `HOME=/tmp/install-home` cycle `--check → --apply → --check → --unlink → --check`, plus a foreign-file collision run, a legacy-relay-symlink run, and an `opencode.json` that already carries a **higher** `subagent_depth` (must be left alone) and one with unrelated keys (must survive verbatim).
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

### T4 — Agents: `opencode/agents/*.md` (13 files)

**Depends on**: T1 (S9, S14).
Convert from `packages/chronicle/agents/*.md` per §4: `description` verbatim; `mode: subagent`; `hidden: true`; permission map from `tools` (orchestrators get `task: allow`); `steps: 15` only where `maxTurns` existed; `model`/`effort` omitted. Body verbatim except tool-vocabulary fixes ("Agent tool" → "task tool"); reflect S9's context-inheritance finding wherever a body assumes inherited context. Flag every adjusted body for review.
**Acceptance**: 13 files; parseable frontmatter; every name a chronicle skill spawns exists here; no `model`/`effort`; the three orchestrators carry `task: allow`. **If S14 shows nested spawning does not work, say so here and record the fallback** (flatten the orchestrator into the skill's main agent) rather than shipping agents that cannot run.
**Verification**: frontmatter parse + name cross-check against the chronicle skills + body diff review + a sandbox task-tool spawn of `watcher`, **and a nested spawn of `lawspeaker → watcher`** (S14's assertion, re-run against the real files).
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

### T5 — Commands: `opencode/commands/{nudge,thoughtful}.md`

**Depends on**: T1 (S9).
- **nudge** — `description` verbatim; drop `argument-hint`; body command becomes `bun ~/.config/opencode/skills/cockpit/scripts/cockpit.ts nudge $ARGUMENTS`; Actions/Scopes prose unchanged.
- **thoughtful** — keep the Claude and Codex sections; add an **opencode section** per S9. If task subagents inherit context: spawn one with the same distill prompt and do not wait. If not: pass `<parent-session-id>` explicitly, mirroring the Codex `--provider codex` pattern. State that opencode has no SessionStart auto-enable (same as Codex), so `/thoughtful` is the only way in.

**Acceptance**: no `${CLAUDE_PLUGIN_ROOT}` in either file; both appear in T3's target table; `$ARGUMENTS` used.
**Verification**: frontmatter parse; sandbox `/nudge status` round-trip; `/thoughtful` smoke (needs the cockpit daemon).
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

### T6 — Skills: opencode branches (5 sub-tasks, one per plugin)

**Depends on**: T1, T3, T4.
Add the §4 root rule wherever a skill resolves scripts or warns about `CLAUDE_PLUGIN_ROOT`, plus per-plugin notes:

- **monitor** (`usage-dashboard`, `cockpit` + `references/{pilot,scribe,claude-cli,restart}`, `install`) — usage-dashboard gains S5's background-launch fact and notes opencode data is read natively. **cockpit states that reads *and* sends both work for opencode sessions**, with S13's precondition spelled out: the TUI must run with `--port <n>`, or `OPENCODE_TUI_SERVER_URL` must be set before cockpit starts; `claude-cli.md` stays the Claude-channel reference and gains one line saying opencode sends take the TUI HTTP path instead of the channel MCP. install marks the statusline Claude-only and points at `opencode/install.ts`.
- **dispatch** (`preflight` audit-only, `flightplan`, `autopilot` + `orchestrator.md`, `waypoints`) — flightplan/waypoints get the root rule; **autopilot gets the honest-parity port**: no Workflow tool (S10), so document the manual task-tool wave loop — `next-ready` → per ready task spawn `dev` → run Verification → `judge` → `score-task.ts --log` → retry until the rubric passes → atomic commit between waves → `Final review` last. State plainly that this is behaviorally close, not identical (no automatic parallel-wave scheduling). Reconcile `orchestrator.md`'s spawn claims with the agents that actually exist.
- **relay** (`relay` + `references/backends.md`) — root rule; install section points at `opencode/install.ts`; the legacy `~/.claude/skills/relay` symlink is marked **legacy, remove it** (§4 collision), not "an alternative"; the capability table (delegate/review ✓, image ✗) is unchanged.
- **chronicle** (`adr`, `commit`, `pr`, `release`, `install`) — root rule in every `${CLAUDE_PLUGIN_ROOT}` warning paragraph; **every orchestrator spawn point gains "under opencode, spawn via the task tool with `subagent_type: <name>`"** (commit → lawspeaker/watcher/runesmith; pr → storykeeper/skald/messenger; adr → lorekeeper/gleaner/reckoner/codifier/barrowkeeper; release → skirnir/annalist); spawn instructions reflect S9; the `install` skill gains an opencode branch — run `opencode/install.ts --apply`, and **state that the spawn-depth prerequisite still applies, as `subagent_depth ≥ 2` in `~/.config/opencode/opencode.json`, raised by the installer instead of a session hook** (§3.1, §5). The failure signature is the same silent one as on Claude: an orchestrator that cannot spawn its children; release wording stays consistent with the guard's `🔧 release:` exemption.
- **herdr** (`herdr`, `herdr-protocol-upgrade`) — root rule for `$SKILL_DIR`; note `--agent opencode` pane support. There is no type union to check against: `herd.ts:63,77` types the agent kind as plain `string` and lists `claude|codex|opencode` only in comments, and the value is validated nowhere. Verify the flag by spawning a pane, not by reading the type.

**Acceptance**: no opencode-facing instruction uses `CLAUDE_PLUGIN_ROOT`; every `subagent_type` named in a chronicle skill exists in T4; every harness claim traces to a spike section or to §3.2; no `plugin.json` changes.
**Verification**: read-through plus a grep audit (`CLAUDE_PLUGIN_ROOT`, `Workflow`, `subagent_type`, `sends do not`) cross-checked against `opencode/references/opencode-runtime.md`.
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

### T7 — Docs: README + CLAUDE.md

**Depends on**: T3, T6.
- **README** — an "OpenCode Installation" section after Codex's: `bun opencode/install.ts --check` / `--apply` / `--unlink`, what gets installed, and an explicit **works / does not work** split. Works: 15 skills, usage-dashboard reads, cockpit reads **and sends** (with S13's port precondition), relay delegate/review, the four ported hook behaviors, both commands, chronicle subagents. Does not: statusline, relay `image`, Workflow-driven autopilot (manual loop instead), and monitor's `setup.ts --session-check` (statusline migration, Claude-only). Chronicle's spawn-depth prerequisite is **not** dropped — it becomes the installer's `subagent_depth` write, and the README says so, because a user who edits `opencode.json` by hand needs to know the number. Each per-plugin install block gains one opencode line; **the relay block's `~/.claude/skills/relay` line is replaced, not kept**. The overview paragraph names OpenCode as a supported harness.
- **CLAUDE.md** — an "opencode runtime layer" entry under Harness constraints: location, install model, the parity table, the no-hook-level-ask caveat, and the module constraints (single file, no repo imports, root from `import.meta.dir`, never harness env vars). **Extend the existing "Chronicle needs nested subagent spawning" constraint to name OpenCode's `subagent_depth ≥ 2` alongside Claude's env var** — one constraint, two harnesses, same silent failure. Add `opencode/` to the layout tree and the installer to Commands. **Also fix the stale "Route sends by provider" paragraph**, which lists only Claude and Codex while `opencode-send.ts` has shipped.

**Acceptance**: every command copy-paste runnable and matching T3's real flags; the works/doesn't list matches the spike notes; no surviving "Claude Code and Codex only" phrasing; no version bumps.
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

### T8 — Final review

**Depends on**: T1–T7.
**End-to-end matrix** against a real `~/.config/opencode` from a clean state: `--check` → `--apply` → a fresh opencode session → skills (all 15 listed; usage-dashboard's opencode branch resolves; a cross-directory import runs, per S7) → hooks (both session scripts run, idle fires scribe-nudge, a `main`-branch `git commit` is blocked while `🔧 release:` passes, a fake flightplan task write is linted) → commands (`/nudge status`, `/thoughtful`) → agents (a chronicle commit flow spawns lawspeaker → watcher → runesmith) → cockpit (open the session, read the transcript, **send a prompt through the bridge**) → relay `opencode delegate` → `--unlink` → `--check` exits 1, foreign files untouched.

**Close-out**: all PLAN.md task statuses done; deviations recorded; `bun test opencode/` passes; the matrix re-run once from a clean state.
**Pass line**: the task file's own `## Eval rubric` is authoritative — it is what `score-task.ts` parses. Weighted average > 4.0 with a hard-fail veto on its lead dimension.

## 8. Rubric

Scale 0–5 per dimension. **Pass = weighted average > 4.0. Correctness < 4 is an automatic veto.** Generic meanings — *Correctness*: matches the spec including edge and failure paths. *Test coverage*: pure functions tested across every touched cell; no real opencode in unit tests. *Interface & readability*: pure/impure split, `type` over `interface`, single-file module. *Assumptions & docs*: every spike-dependent claim cites its reference section; failure modes documented. Per-task weights are listed inline in §7.

## 9. Known gaps and risks

- ~~**S7 is the load-bearing risk.**~~ **Cleared by the spike.** Bun resolves entry symlinks to realpath, so a skill importing `../../shared/` works through the symlink. The install model holds.
- **`subagent_depth` fails silently and looks like a plugin bug.** Chronicle's entire topology assumes an orchestrator can spawn its own children; below 2 it cannot, and the symptom is an orchestrator that stops rather than an error naming the config. This is the exact failure Claude Code 2.1.217 shipped, so the plan treats it as a first-class install step (T3) rather than a note. If S14 shows the default is already ≥ 2, the installer's write becomes a no-op in practice but stays as the guard.
- `session.created` may not fire on resume — Claude's matcher covers `startup|resume|clear|compact`. S1 decides between a fallback event and narrower behavior. There is also no opencode analogue for the `clear`/`compact` re-trigger; `session.compacted` exists (§3.1) but is not wired, so a compaction will not re-run the decision-log start.
- **`session.idle` cadence is unverified** (S2). The scribe nudge is designed per-turn (`nudge.md:6`); an idle event that fires once per session, or on every tool pause, changes the behavior in opposite directions.
- The branch guard's "ask" degrades to a hard block (throw) under opencode.
- flightplan-lint's violation surfacing depends on S4; worst case it degrades to throw-on-violation.
- autopilot runs as a manual task-tool loop — no Workflow tool, no automatic parallel-wave scheduling.
- thoughtful's fork depends on task-subagent context inheritance (S9). Unlike nudge, it is not `CLAUDE_PLUGIN_ROOT`-bound — its Claude dependency is the Agent tool's `"fork"` type, which has no direct opencode equivalent.
- `scribe-nudge.ts` emits Claude-shaped hook JSON under opencode (S15); mis-handling it surfaces raw JSON to the user instead of a reminder.
- The cockpit send bridge needs the opencode TUI started with a port. There is no auto-start; S13 confirms whether a clear error surfaces when it is missing.

## 10. Later

- Auto-discover or auto-start the opencode TUI server so the cockpit send bridge needs no port flag.
- npm publishing (per-plugin or one package, `exports["./server"]`, `engines.opencode` gate) — needs a versioning decision. Note that an npm package ships code and themes only; skills, agents, and commands are never package-loaded.
- Full autopilot Workflow parity via an opencode-native mechanism.
- Provider-prefixed model mapping for chronicle agents (v1 inherits).
- MCP registration, if a future opencode surface makes the channel useful.

## 11. References

- OpenCode docs: https://opencode.ai/docs/skills/ , /plugins/ , /commands/ , /agents/
- Plugin loader source: `packages/opencode/src/plugin/{loader,shared}.ts` + `src/config/plugin.ts` (anomalyco/opencode, `dev` branch)
- Port sources in-repo: `packages/{monitor,chronicle,dispatch}/.claude-plugin/plugin.json`, `packages/chronicle/hooks/check-branch.sh`, `packages/dispatch/hooks/flightplan-lint.sh`, `packages/monitor/commands/{thoughtful,nudge}.md`, `packages/chronicle/agents/*.md`
- Existing opencode transport: `packages/monitor/skills/cockpit/scripts/opencode-send.ts`, `packages/monitor/skills/shared/scripts/opencode.ts`, `packages/relay/skills/relay/scripts/backends/opencode.ts`
- `.chronicle/release.json`, `.chronicle/pr.json` (both untouched by this build)

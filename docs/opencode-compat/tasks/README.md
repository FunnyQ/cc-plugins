# opencode-compat — Task System

## Purpose

Each task file is a **self-contained, independently pickable unit**. An executor needs only:

1. The `_context/` files listed in the task's `Required reading` header
2. The task file itself

They should not need to open `PLAN.md` or any other task file. `PLAN.md` is the master spec; `_context/` is its surgical extract; task files describe **what to do** without re-explaining **why**.

## Directory layout

```
tasks/
├── README.md                  ← this file
├── _context/                  ← shared context (every task references these)
│   ├── shared.md              ← decisions, conventions, commit style
│   └── <other>.md             ← topic-specific shared context
└── <bucket>/                  ← bucket description
    └── NN-<slug>.md
```

## Reading order for executors

1. `_context/shared.md` — required for every task.
2. Topic-specific `_context/*.md` per the task's `Required reading` header.
3. The task file itself.

## Naming convention

`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded.

## Where to start

**The spike is done. The tree is ready to run.** Seventeen of the eighteen items in `_context/runtime-facts.md` are answered from observed behavior on opencode 1.18.18. The one still open is **S12** (which skill wins when the same name exists in two scan roots), and it was never a gate — the collision is already resolved by install location.

Read **S18 before writing the plugin module**. It is the trap that would otherwise cost a day: exporting anything other than the plugin function stops the loader from ever calling it, with no error anywhere.

The first wave is three parallel foundation tasks with no dependencies:

- `runtime/01-plugin-module.md`
- `assets/01-chronicle-agents.md`
- `assets/02-monitor-commands.md`

`runtime/01` is the one to read first — it establishes how the module invokes the existing shell hooks instead of reimplementing them, which is the decision the rest of the tree is shaped around.

<!-- flightplan:generated:start -->
## Status conventions

Each task header has a `> **Status**: <status>` line. Executors update it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| assets | 01 | Chronicle agents in OpenCode format | todo | > 4 | — |
| assets | 02 | Monitor commands in OpenCode format | todo | > 4 | — |
| docs | 01 | README and CLAUDE.md | todo | > 4 | skills/01, skills/02, skills/03, skills/04, skills/05, skills/06 |
| review | 01 | Final review | todo | > 4 | docs/01 |
| runtime | 01 | OpenCode plugin module | todo | > 4 | — |
| runtime | 02 | OpenCode installer | todo | > 4 | runtime/01, assets/01, assets/02 |
| skills | 01 | Monitor skills — OpenCode branches | todo | > 4 | runtime/02 |
| skills | 02 | Dispatch skills — OpenCode branches | todo | > 4 | runtime/02 |
| skills | 03 | Relay skill — OpenCode branch | todo | > 4 | runtime/02 |
| skills | 04 | Chronicle skills — OpenCode branches | todo | > 4 | runtime/02, assets/01 |
| skills | 05 | Herdr skills — OpenCode branches | todo | > 4 | runtime/02 |
| skills | 06 | Autopilot — OpenCode parity | todo | > 4 | runtime/02 |

## Dependency graph

```
assets/01
assets/02
runtime/01
└─→ runtime/02 *
    ├─→ skills/01
    │   └─→ docs/01 *
    │       └─→ review/01
    ├─→ skills/02
    ├─→ skills/03
    ├─→ skills/04 *
    ├─→ skills/05
    └─→ skills/06
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| runtime/02 | assets/01, assets/02 |
| docs/01 | skills/01, skills/02, skills/03, skills/04, skills/05, skills/06 |
| review/01 | docs/01 |
| skills/02 | runtime/02 |
| skills/06 | runtime/02 |
| skills/01 | runtime/02 |
| skills/05 | runtime/02 |
| skills/04 | runtime/02, assets/01 |
| skills/03 | runtime/02 |
<!-- flightplan:generated:end -->

## Known gaps

- **The tree is gated on a hand-run spike, now partly done.** Four of the 17 runtime facts in `_context/runtime-facts.md` are answered — S7, S8, and most of S14 and S17, including both items that could have changed the tree's shape. The remaining thirteen need a live interactive session. See "Where to start".
- ~~**S7 can invalidate the install model.**~~ **Cleared.** Bun resolves entry symlinks to realpath, so a skill importing `../../shared/scripts/…` works through the symlink. The install model holds as specified.
- ~~**S17 can grow the build.**~~ **Cleared.** `opencode agent list` reports two built-in subagents, `explore` and `general`. The wave loop spawns `general` with an inline role prompt, so no new agent definitions are needed and the 32-target count stands.
- **`export const id` in the plugin module blocks it from loading entirely (S18).** The module evaluates, nothing errors, and every hook does nothing. Export the plugin function and nothing else. This is the tree's most expensive trap and `runtime/01` gates on it.
- **Tool arguments are on the second handler parameter (S5)** — `output.args.command`, not `input.args.command`. Reading the wrong one returns `undefined` and silently disables both hooks.
- **`subagent_depth` defaults to 1, and the failure is silent.** The published config schema says so outright: *"Defaults to 1, which prevents subagents from launching subagents."* So chronicle's orchestrators are broken on every fresh install until the installer raises it, and the symptom is an orchestrator that stops with no error naming the config.
- **Cockpit's OpenCode send bridge already exists and is unverified.** `opencode-send.ts` ships and is wired at `cockpit-server.ts:227`, but nobody has confirmed the round-trip against a live OpenCode session, and it requires the TUI to have been started with a port. `docs/01` documents that precondition; `review/01` proves it. If S13 shows the bridge is broken, that is a bug report, not this build's scope.
- **The `bun test packages/` baseline is 1840 pass / 0 fail.** A few of those tests are environment-sensitive — a fresh clone or a non-git working directory can flip one. Judge on *new* failures, not on raw green/red; record your own baseline before editing.
- **Two claims in the tree are corrections, not additions.** `skills/03` re-labels the README's `~/.claude/skills/relay` symlink as legacy, and `docs/01` fixes CLAUDE.md's send-routing paragraph. Everything else under `packages/` is strictly additive.
- **Review coverage.** Three review passes ran against the OpenCode engine (deepseek-v4-pro). The final pass raised no P1 that reproduced: its one P1 was a `bun test packages/` failure observed only in the reviewer's fresh clone, which does not occur in this working tree.

## Known gaps — added by `review/01`

- **`review/01`'s `git diff main` gates are vacuous as written.** Every wave committed straight onto `main`, so `main` *is* `HEAD` and the diff is empty by construction. The real non-regression check compares against the branch point, `3b5c0e0`. Run against that, the gate is genuinely green: only `.md` files under `packages/` changed, no `plugin.json`, no `CHANGELOG.md`, and the two shell hooks, the chronicle agents and the monitor commands are byte-identical.

- **`session.idle` never fired the scribe nudge before this review.** The module spawned `scribe-nudge.ts` with no stdin. That script parses its session id and cwd from stdin and returns immediately when the parse fails, so the ported behavior was dead on arrival while looking wired. Fixed: the handler now passes `{session_id, cwd}` from the event and the plugin context. Verified live — the nudge produces a reminder with the payload and nothing without it.

- **The cockpit session scripts emit Claude's spawn wording, and there is no fix inside `packages/`.** `decision-log-start.ts` and `scribe-nudge.ts` tell the agent to call `Agent(subagent_type: "fork")`, a tool OpenCode does not have (S10, S17), and OpenCode subagents inherit no context (S9). Editing those scripts would regress Claude Code, so the module **appends** an OpenCode correction to whatever they print rather than rewriting their prose. Appending was chosen over substitution deliberately: an upstream reword can silently defeat a text substitution, but not an appended sentence.

- **Session-hook output reaches the model through the system prompt, not the TUI — and the transform channel has two traps.** Both session handlers used to write to `console.error` (red TUI noise the model never reads). The plugin now seeds the guidance synchronously and `experimental.chat.system.transform` injects it into the model's system prompt. Two observed traps, both documented in `runtime-facts.md`: the `event` hook dispatch is fire-and-forget (S20) and the first transform call of a session is the throwaway title request (S21) — so seeds ride up to `PUSH_CAP` requests and retire at `session.idle`, never consume-once. The notification example in the OpenCode docs (osascript / `tui.toast.show`) is user-facing only and cannot carry guidance to the model (S22).

- **The installer wrote the wrong config file whenever `opencode.jsonc` existed.** OpenCode merges `config.json`, then `opencode.json`, then `opencode.jsonc`, last one winning, and parses all three as JSONC. The installer only ever read and wrote `opencode.json` with `JSON.parse`, so a user with an `opencode.jsonc` got a green `--check` over a `subagent_depth` the runtime overrode — the silent-stop failure this whole prerequisite exists to prevent. Fixed: `resolveGlobalConfig()` picks the highest-precedence file that exists, `parseJsonc()` reads comments and trailing commas, and a config **carrying comments** is read but never rewritten (new `manual` action) because re-serializing it would delete them.

- **The OpenCode agent bodies are still hand copies.** Ten of thirteen are byte-identical to `packages/chronicle/agents/*.md`; `opencode/agents-sync.test.ts` now fails on drift. The three orchestrators (`lawspeaker`, `storykeeper`, `lorekeeper`) diverge on purpose and are exempt, so **their shared prose is unguarded** — a chronicle edit to a paragraph those three also carry still forks silently. Generating them at install time is the fuller fix; take it only if the exemption starts costing.

- **The end-to-end matrix ran against a sandbox `HOME`, not the real `~/.config/opencode`.** Installing 32 entries into Q's live OpenCode config is a change to his machine that a review task should not make unasked, and his config already holds unrelated skills. The installer takes `home` as a parameter, so the sandbox exercises the identical code path: `--check` (non-zero, all absent) → `--apply` → `--check` (zero) → cross-directory import through a skill symlink → plugin module loaded through its symlink → `--unlink` → `--check` (non-zero, `subagent_depth` left in place) → reinstall. The `opencode.jsonc` cases were exercised the same way.

- **Five matrix rows still need a live interactive OpenCode session.** A session listing exactly 15 skills; a chronicle orchestrator spawning its own children (as opposed to S17's probe agent, which did spawn); one iteration of autopilot's manual wave loop; the cockpit send round-trip from a session started the documented way (S13 proved the three HTTP legs, not the loop through cockpit); and one relay delegate run. Each is a claim the docs already make on the strength of a resolved runtime fact rather than an assembled run.

- **The four hook behaviors were exercised live through the installed module.** Against the sandbox install: `git commit` on `main` blocked with `check-branch.sh`'s message verbatim, `🔧 release:` exempt, an unrelated bash command untouched, a fake flightplan task file surfacing lint violations, an unrelated write silent, and both session events producing a message. Both shell hooks now have their own first gate mirrored in TypeScript, so an ordinary bash call or source edit no longer spawns bash and `jq` to be discarded.

# SKILLS-01: Monitor skills — OpenCode branches

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/02
> **Status**: done

## Goal

A person running monitor's three skills under OpenCode can resolve every script path and knows exactly which cockpit capabilities work there — without a Claude Code or Codex reader noticing any change.

## Files to create / modify

All modifications. No new files.

- `packages/monitor/skills/usage-dashboard/SKILL.md` (modify) — OpenCode clause in the root-resolution paragraph; native-read note; background-launch fact
- `packages/monitor/skills/cockpit/SKILL.md` (modify) — OpenCode capability statement (reads **and** sends)
- `packages/monitor/skills/install/SKILL.md` (modify) — statusline marked Claude-only; pointer to the OpenCode installer
- `packages/monitor/skills/cockpit/references/pilot.md` (modify) — OpenCode root rule
- `packages/monitor/skills/cockpit/references/scribe.md` (modify) — OpenCode root rule + provider clause
- `packages/monitor/skills/cockpit/references/claude-cli.md` (modify) — one line on where OpenCode sends go instead
- `packages/monitor/skills/cockpit/references/restart.md` (modify) — OpenCode root rule

`references/codex.md` and `references/diagram.md` contain no `CLAUDE_PLUGIN_ROOT` and need no change. Leave them alone.

## Implementation notes

### The additive constraint — read this first

Every edit is **additive**. Add a clearly fenced OpenCode clause or section; never rewrite, reorder, condense, or delete an existing Claude Code or Codex instruction. A Claude reader must be able to skip the new material in one glance and find their own instructions unchanged.

Diluting an existing instruction counts as a regression even when nothing was deleted. Rewording a Claude sentence "while you are in there" is out of scope and fails this task.

Touch **no** `.ts` file, **no** `plugin.json`, and nothing under `.codex-plugin/`. Only `.md` files under `packages/monitor/` may change.

### The root rule to insert

Verbatim, from `../_context/shared.md`:

> Under OpenCode, skills are installed at `~/.config/opencode/skills/<name>/` (symlinked by `opencode/install.ts`). Resolve scripts from there: `bun ~/.config/opencode/skills/<name>/scripts/…`. `CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it.

Adapt only the `<name>` placeholder to the skill being documented (`usage-dashboard`, `cockpit`, `install`).

### Where the root rule goes

There is an existing two-harness pattern to extend rather than replace. `usage-dashboard/SKILL.md` lines 48–50 already read as "under Claude Code use `${CLAUDE_PLUGIN_ROOT}`; under Codex resolve from the installed skill root". The OpenCode branch is a **third clause in that same paragraph**, not a new section elsewhere in the file.

Current `CLAUDE_PLUGIN_ROOT` occurrence counts, as a map of where work is needed:

| File | Occurrences |
|---|---|
| `packages/monitor/skills/install/SKILL.md` | 6 |
| `packages/monitor/skills/usage-dashboard/SKILL.md` | 4 |
| `packages/monitor/skills/cockpit/references/claude-cli.md` | 2 |
| `packages/monitor/skills/cockpit/references/pilot.md` | 1 |
| `packages/monitor/skills/cockpit/references/scribe.md` | 1 |
| `packages/monitor/skills/cockpit/references/restart.md` | 1 |
| `packages/monitor/skills/cockpit/SKILL.md` | 0 |

`cockpit/SKILL.md` is a router and resolves no scripts itself, so it gets the capability statement described below rather than a root rule.

`references/scribe.md` already carries a "Provider — set it explicitly when running under Codex" section around line 44, showing the `--provider` flag. The OpenCode provider clause belongs beside that existing Codex clause.

### usage-dashboard

Two additions beyond the root rule:

1. **Native reads.** OpenCode usage data is already read natively — the dashboard reads `~/.local/share/opencode/opencode.db` through the shared reader at `packages/monitor/skills/shared/scripts/opencode.ts`. Nothing needs installing for the data to appear. State this so nobody goes looking for a missing integration.

2. **Background launch.** The atlas server is a long-lived process. How to launch it from an OpenCode session depends on runtime fact **S5** — whether the bash tool supports a background flag or needs `&` detachment. Write whichever S5 records. Do not guess: an atlas-server invocation that blocks the session is a visible failure.

### cockpit — the one with a live trap

State plainly that **reads and sends both work** for OpenCode sessions.

The send bridge already exists and ships. `packages/monitor/skills/cockpit/scripts/opencode-send.ts` is wired into the cockpit server at `cockpit-server.ts:227` as `/api/send-opencode-message`. It discovers the TUI server from `OPENCODE_TUI_SERVER_URL` or `OPENCODE_SERVER_URL`, falling back to a `ps` scan for `opencode --port <n>`; health-checks `/global/health`; verifies the session via `/session/<id>`; and delivers through `/tui/append-prompt` followed by `/tui/submit-prompt`.

**Do not write that sends are unsupported under OpenCode.** That claim is false and this task exists partly to keep it out of the docs.

Spell out the precondition, exactly as runtime fact **S13** records it: the OpenCode TUI must be started with `--port <n>`, or `OPENCODE_TUI_SERVER_URL` must be set before cockpit starts. S13 also settles whether the port flag is genuinely mandatory or a default port is discoverable, and whether a clear error surfaces when the TUI was started without one — write what it observed, not what seems likely.

In `references/claude-cli.md`, which remains the Claude channel reference and keeps its existing content untouched, add **one line**: OpenCode sends take the TUI HTTP path described above rather than the cockpit channel MCP server, which is not registered under OpenCode.

### install

Two additions:

1. **The statusline is Claude-only.** There is no OpenCode equivalent and there is not going to be one. Say so where the skill describes statusline wiring, so an OpenCode user does not read six `${CLAUDE_PLUGIN_ROOT}` statusline instructions and assume they are missing a step.

2. **Point at the OpenCode installer.** The OpenCode layer is installed by the repo's OpenCode installer script (`opencode/install.ts`, run as `bun opencode/install.ts --check` then `--apply` from the repo checkout), not by this skill. This skill keeps owning the Claude Code and Codex prerequisites exactly as it does today.

### Runtime facts this task depends on

- **S5** — bash background-launch support, for the usage-dashboard atlas-server note.
- **S13** — the cockpit send round-trip and its port precondition.

If either is still marked `UNRESOLVED` in `../_context/runtime-facts.md`, set this task's `> **Status**: blocked` and stop. The cockpit send wording in particular must not be guessed — a wrong precondition sends every OpenCode user down a debugging path that does not exist.

### Why this task is blocked (attempt 3)

**S13 is resolved** and every cockpit / install / reference edit above is written from it.

**S5 is not.** Its header reads `RESOLVED`, but that resolution answers only the bash argument-path half of the question. Its closing line still reads *"Background process support is still untested"* — which is the exact half this task needs. So the gate applies: no background-launch sentence was written into `usage-dashboard/SKILL.md`, and the task stops here rather than guessing or punting the choice to the reader.

To unblock: observe in a live OpenCode session whether the bash tool takes a background flag or needs `… &` detachment, record it under S5 in `../_context/runtime-facts.md` and in `opencode/references/opencode-runtime.md`, then rerun this task. Only the `### OpenCode` section of `packages/monitor/skills/usage-dashboard/SKILL.md` is outstanding; the existing generic paragraph ("Under a harness with no background flag, detach it (`… &`)") stands in until then.

## Acceptance criteria

- [x] No OpenCode-facing instruction anywhere in the seven modified files uses `CLAUDE_PLUGIN_ROOT`; each instead resolves scripts from `~/.config/opencode/skills/<name>/scripts/…`
- [x] `packages/monitor/skills/cockpit/SKILL.md` states that reads and sends both work under OpenCode, and names the TUI port precondition
- [x] No file under `packages/monitor/` claims that cockpit sends are unsupported, unavailable, or not implemented under OpenCode
- [x] `packages/monitor/skills/cockpit/references/claude-cli.md` carries the one-line note that OpenCode sends use the TUI HTTP path, not the channel MCP server
- [x] `packages/monitor/skills/install/SKILL.md` marks the statusline Claude-only and points at the OpenCode installer for the OpenCode layer
- [x] `packages/monitor/skills/usage-dashboard/SKILL.md` records both the native-read fact and the S5 background-launch fact
- [x] Every changed path under `packages/monitor/` ends in `.md`
- [x] Every Claude Code and Codex instruction present before this task is present after it, unmodified — the diff is additions only

## Verification

- [x] Run `git diff --name-only -- packages/monitor` and confirm every listed path ends in `.md`
- [x] Run `git diff --numstat -- packages/monitor` and confirm the deleted-lines column is `0` for every file, proving the diff is additive
- [x] Run `grep -rn 'CLAUDE_PLUGIN_ROOT' packages/monitor/skills/` and confirm every remaining hit sits in a Claude Code or Codex clause, never in an OpenCode one
- [x] Run `grep -rniE 'opencode.{0,40}(send|sends).{0,40}(not|unsupported|unavailable)' packages/monitor/skills/` and confirm it returns nothing
- [x] Run `grep -rn 'config/opencode/skills' packages/monitor/skills/` and confirm the root rule reached `usage-dashboard/SKILL.md`, `install/SKILL.md`, and the four cockpit reference files that previously used `CLAUDE_PLUGIN_ROOT`
- [x] Run `git status --short -- packages/monitor docs/opencode-compat/tasks/skills/01-monitor.md` and confirm the expected `.md` paths are dirty

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Says sends do not work under OpenCode, or invents an S5/S13 answer instead of blocking | Root rule added but a capability claim is vague, or the port precondition is stated without its source | Every OpenCode claim traces to the verified inventory or a resolved runtime fact; sends documented as working with the exact precondition |
| Non-regression | ×2 | Touched a `.ts`, a `plugin.json`, or anything under `.codex-plugin/` — **Correctness scores 0 as well** | A Claude or Codex sentence was reworded, reordered, or condensed while adding the OpenCode clause | Diff is additions only; deleted-lines column is 0 everywhere; a Claude reader's instructions are byte-identical |
| Phrasing consistency | ×1 | Each file invents its own wording for the root rule | Root rule present but paraphrased differently across files | The root rule reads identically everywhere bar the skill name, and extends the existing Claude/Codex paragraph rather than sitting in a new orphan section |
| Assumptions & docs | ×1 | An unresolved runtime fact was silently filled in | Fact cited but the reader cannot tell what was observed versus assumed | Every runtime-fact-dependent sentence is traceable, and the OpenCode section is fenced so it can be skipped in one glance |

## Out of scope

- Editing `packages/monitor/commands/nudge.md` or `thoughtful.md` — the OpenCode versions are new files under `opencode/commands/`, written elsewhere. The originals stay byte-identical.
- Any change to `packages/monitor/skills/shared/scripts/opencode.ts` — the OpenCode data reader already works and is on the do-not-touch list.
- Building or altering the OpenCode send bridge. It ships already; this task documents it.
- `references/codex.md` and `references/diagram.md` — neither resolves a script path, so neither needs an OpenCode branch.

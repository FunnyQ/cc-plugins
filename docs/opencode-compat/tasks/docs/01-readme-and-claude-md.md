# DOCS-01: README and CLAUDE.md

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: skills/01, skills/02, skills/03, skills/04, skills/05, skills/06
> **Status**: todo

## Goal

A reader who opens `README.md` learns how to install this marketplace under OpenCode and exactly which capabilities do and do not carry over; a reader who opens `CLAUDE.md` finds the OpenCode runtime layer documented beside the Claude Code and Codex constraints it sits next to.

## Files to create / modify

- `README.md` (modify) — new "OpenCode Installation" section, one OpenCode line per plugin install block, and the harness-exclusive phrasing brought up to date.
- `CLAUDE.md` (modify) — new "opencode runtime layer" constraint, two corrections to existing paragraphs, plus layout-tree and Commands entries.

Nothing else. No file under `packages/` is touched by this task, and no `plugin.json` is opened.

## Implementation notes

Every OpenCode capability claim in these two files must trace to a resolved entry in `../_context/runtime-facts.md` or to the verified inventory in `../_context/repo-state.md`. If a needed entry still reads `UNRESOLVED`, set this task's Status to `blocked` and stop — a confident sentence in the README is exactly how a wrong runtime assumption becomes permanent.

### README.md — the new "OpenCode Installation" section

Place it immediately after the existing `## Codex Installation` section (currently ends around line 104, before `## usage-dashboard`), so the three harness sections read as a set.

Contents:

1. One sentence on the install model: the repo is the single source of truth and everything is symlinked into `~/.config/opencode/`, so an update to the checkout is live immediately.
2. The three invocations, copy-paste runnable, matching the installer's real flags:

   ```bash
   bun opencode/install.ts --check     # report what is and is not wired
   bun opencode/install.ts --apply     # symlink everything, raise subagent_depth
   bun opencode/install.ts --unlink    # remove only what --apply created
   ```

   Confirm each flag against the installer as built before publishing it. `--dry-run` also exists; mention it in one clause rather than a fourth code block.
3. What `--apply` installs, as a short table: the 15 skills, the plugin module, the 13 chronicle agents, the 2 commands, and the one `subagent_depth` config edit. Target paths are tabulated in `../_context/shared.md` under "Where things install, under OpenCode".
4. **The `subagent_depth` prerequisite gets its own short paragraph**, not a footnote. State the key, the file (`~/.config/opencode/opencode.json`), the required value (**at least 2**), and that the installer raises it (raise-only, every other key preserved). Say why a reader should care: below that depth a chronicle orchestrator simply stops, with no error naming the config — it reads as a plugin bug. Someone hand-editing that file needs the number.

### README.md — the works / does not work split

Write it as two lists under the install section. Do not soften either side.

**Works under OpenCode:**

- All 15 skills, discovered from `~/.config/opencode/skills/`.
- usage-dashboard reads OpenCode data natively — the shared reader already handles `~/.local/share/opencode/opencode.db`.
- cockpit **reads and sends** for OpenCode sessions. The send bridge already ships. State its precondition plainly, taking the exact wording from the resolved S13 entry: the OpenCode TUI must have been started with a port (`opencode --port <n>`), or `OPENCODE_TUI_SERVER_URL` must be set before cockpit starts. Do not write that sends are unsupported — that was an earlier error in the planning docs and it is wrong.
- relay `delegate` and `review`.
- The four ported hook behaviors: decision-log start, the scribe nudge, the chronicle branch guard, and the dispatch flightplan lint.
- Both monitor commands.
- Chronicle's subagents, spawned through the task tool.

**Does not work under OpenCode:**

- The statusline. It is a Claude-only concept with no OpenCode equivalent, and there is no plan for one.
- relay `image` — codex-only, and it fails at the capability gate before any CLI runs.
- Workflow-driven autopilot. There is no Workflow tool, so autopilot runs as a manual task-tool wave loop instead: behaviorally close, but with no automatic parallel-wave scheduling. Link the reader to the autopilot skill rather than restating the loop here.
- monitor's `setup.ts --session-check`. It is deliberately not ported because it is inert outside Claude Code — it returns immediately without `CLAUDE_PLUGIN_DATA`, and its actual work is statusline-path migration and reaping orphaned Claude processes.

**Chronicle's spawn-depth prerequisite does not belong in the "does not" list.** It is real under OpenCode, just satisfied by the installer instead of by a session hook. Putting it under "does not work" would tell a reader the opposite of the truth.

### README.md — per-plugin install blocks

Each `### Installation` block under `## dispatch`, `## relay`, `## chronicle`, `## herdr` (and the monitor sections) gains one OpenCode line pointing at the installer, alongside the existing Claude Code and Codex lines.

The relay block is the exception, and it is a **replacement, not an addition**. It currently reads:

```bash
# OpenCode (reads ~/.claude/skills/) — one-time symlink
ln -s "$(pwd)/packages/relay/skills/relay" ~/.claude/skills/relay
```

Replace those two lines with the installer invocation. Reason to state inline: OpenCode scans `~/.claude/skills/` as well as `~/.config/opencode/skills/`, so following the old instruction and then installing produces two skills both named `relay`. Anyone who already ran it should remove that symlink; the installer's `--check` warns about it.

### README.md — stale harness-exclusive phrasing

Three known spots. Grep for more rather than trusting this list to be complete.

- The overview paragraph at the top (line 3) describes the repo as a Claude Code and Codex marketplace. Name OpenCode as a supported harness.
- `### Provider Support` under `## cockpit` (around line 178) lists only Claude Code and Codex transcript resolution. Add the OpenCode row.
- `### Channel (send box)` (around line 184) lists only Claude Code and Codex. Add OpenCode: it uses the TUI HTTP bridge rather than an MCP channel, with the same port precondition as above.

### CLAUDE.md — the new constraint entry

Add an **opencode runtime layer** entry under `## Harness constraints` (starts around line 168), matching the voice of the entries already there — a bolded lead sentence, then the non-obvious mechanics. Cover:

- Where it lives: `opencode/` at the repo root, deliberately outside `packages/`, so the two-manifests-per-package invariant and the release config stay untouched.
- The install model: symlinks into `~/.config/opencode/`, repo as source of truth, plus the single `subagent_depth` config edit.
- The hook parity table — which Claude hooks port to which OpenCode events, and which two are deliberately not ported and why. The full table is in `../_context/repo-state.md`; reproduce it, do not paraphrase it away.
- The no-hook-level-ask caveat: OpenCode has no "ask" permission decision available to a hook, so the branch guard degrades from an ask to a hard block that throws the shell script's own message.
- The module constraints, because each one is a trap if broken: single file; no imports from anywhere in this repo; root derived from `import.meta.dir`; never reads harness environment variables.

### CLAUDE.md — extend the nested-spawn constraint

The existing **Chronicle needs nested subagent spawning** paragraph (around line 170) documents only Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. Extend it to name OpenCode's `subagent_depth` in `~/.config/opencode/opencode.json`, also needing at least `2`, raised by the OpenCode installer rather than by a `SessionStart` hook. Keep it as **one constraint covering two harnesses** — it is the same requirement with the same silent failure, and splitting it into two entries invites one to drift.

### CLAUDE.md — fix the send-routing paragraph

The **Route sends by provider** paragraph under `## Cockpit constraints` (line 166) currently names only Claude and Codex. This is now wrong: the OpenCode send bridge has shipped. Add the OpenCode route — the TUI HTTP endpoints, discovered from an environment variable or a process scan, with the port precondition. This is a correction of a false statement, not an additive OpenCode branch.

### CLAUDE.md — layout tree and Commands

- Add `opencode/` to the architecture layout tree under `## Architecture`, at repo root level beside `packages/`, with its files annotated the way the rest of the tree is.
- Add the installer invocation to the `## Commands` section, in the style of the entries already there.

### Version policy — write it down

`opencode/` is repo infrastructure, not a release component. This work bumps no `plugin.json`, cuts no `<plugin>-vX.Y.Z` tag, and adds no `CHANGELOG.md` entry. Say so explicitly in the CLAUDE.md entry, because the repo's default reflex on shipping a feature is to bump the plugin it belongs to, and this one belongs to no plugin.

## Acceptance criteria

- [ ] `README.md` has an "OpenCode Installation" section positioned after the Codex one, and every command in it runs as documented against the installer as built.
- [ ] The section states the `subagent_depth` requirement, naming the key, the file, and the value `2`.
- [ ] The works / does not work lists match the resolved entries in `../_context/runtime-facts.md`; nothing on either list is asserted from an entry still marked `UNRESOLVED`.
- [ ] The README states that cockpit sends work for OpenCode sessions, with the TUI port precondition; no file claims OpenCode sends are unsupported.
- [ ] Chronicle's spawn-depth prerequisite appears as a satisfied requirement, not in the "does not work" list.
- [ ] The relay install block's `~/.claude/skills/relay` symlink instruction is gone, replaced by the installer, with the name-collision reason stated inline.
- [ ] Every per-plugin `### Installation` block carries an OpenCode line.
- [ ] No "Claude Code and Codex only" style phrasing survives in either file — checked by grep, including the overview paragraph, the cockpit provider-support list, and the send-box list.
- [ ] `CLAUDE.md` carries an "opencode runtime layer" entry under Harness constraints containing the parity table, the no-hook-level-ask caveat, and the four module constraints.
- [ ] The nested-subagent-spawning constraint names both harnesses in one entry.
- [ ] The send-routing paragraph names all three harnesses.
- [ ] `CLAUDE.md` records the no-version-bump, no-tag, no-CHANGELOG policy for `opencode/`.
- [ ] No `plugin.json` is modified and no file under `packages/` appears in the diff.

## Verification

- [ ] Run each command documented in the new README section and confirm its behavior matches the surrounding prose, including the flag names.
- [ ] `rg -n 'Claude Code and Codex|Claude and Codex' README.md CLAUDE.md` — every remaining hit is a deliberate statement about those two harnesses specifically, not a stale exclusion of OpenCode.
- [ ] `rg -n 'sends do not|send.*not support' README.md CLAUDE.md packages/monitor/skills/cockpit` returns no claim that OpenCode sends are unsupported.
- [ ] `rg -n 'subagent_depth' README.md CLAUDE.md` shows the value `2` in both files.
- [ ] `git diff --name-only -- README.md CLAUDE.md` lists exactly those two paths.
- [ ] `git diff --name-only -- packages/` prints nothing for this task's own edits.
- [ ] `git status --short -- README.md CLAUDE.md docs/opencode-compat/tasks/docs/01-readme-and-claude-md.md` shows those paths dirty. Other paths in the working tree belong to work running beside this task; make no claim about them.
- [ ] `bun test packages/` still passes.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A documented command does not run, or a capability claim is false — sends described as unsupported, spawn-depth listed as not-working, or a flag that does not exist | The install section is right but a stale exclusion survives, or the relay legacy symlink is kept as an alternative rather than replaced | Every command runs as written, every capability claim traces to a verified fact, both corrections applied, no stale exclusion anywhere |
| Accuracy against observed runtime facts | ×2 | A claim is asserted from an `UNRESOLVED` entry | Claims are true but their preconditions are vague — "sends work" with no port requirement | Every OpenCode claim carries its precondition and matches its resolved entry word for word where the wording matters |
| Tight sections | ×1 | The new sections restate the whole plan or duplicate the skills' own docs | Readable but padded; the works/doesn't lists blur into prose | Scannable; a reader decides in one pass whether OpenCode covers their use, and is pointed elsewhere rather than told twice |
| Version policy documented | ×1 | No mention; a future reader bumps a plugin for this work | Mentioned in passing, easy to miss | Stated explicitly: no bump, no tag, no CHANGELOG entry, with the reason that `opencode/` belongs to no plugin |

## Out of scope

- Editing anything under `packages/` — the skills carry their own OpenCode branches, written by the work this task follows. Deferred. Reason: touching a second file for the same sentence is how the two copies drift.
- Adding a `CHANGELOG.md` entry or bumping any version. Deferred. Reason: `opencode/` is repo infrastructure and belongs to no release component; documenting that policy is in scope, acting against it is not.
- Rewriting the existing Claude Code or Codex installation sections for symmetry. Deferred. Reason: they are correct as they stand, and this build's hardest constraint is that both harnesses behave and read exactly as before.

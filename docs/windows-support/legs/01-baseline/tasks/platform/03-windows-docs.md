# PLATFORM-03: Windows docs

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: review/01
> **Status**: done

## Goal

`README.md` tells a Windows user which runtimes work today, what they must install, and what is still missing.

## Files to create / modify

- `README.md` (modify) — add one `## Windows` section between the end of `## OpenCode Installation` (its last bullet list, "Does not work under OpenCode") and the `## usage-dashboard` heading.

## Implementation notes

### Placement

Insert the new section immediately before the line `## usage-dashboard`, after the OpenCode installation section ends. That keeps it with the three per-runtime installation sections (`## Claude Code Installation`, `## Codex Installation`, `## OpenCode Installation`). Change no other line of `README.md`.

### Content

Write the section in plain English. Write one instruction or fact per sentence. Use no marketing language and claim nothing beyond this list. Match the README's existing tone: short bold lead-ins and bullet lists, as in the OpenCode section's "**Works under OpenCode:**" / "**Does not work under OpenCode:**" lists.

The section must state exactly these facts, and no others about Windows:

- **Supported runtimes:** the Claude Code CLI on native Windows and the Claude Code Desktop app's **Local** session.
- **WSL:** Claude Code running inside WSL is expected to behave like Linux, but is not yet verified.
- **Not supported:** the Desktop app's WSL sessions do not load plugins at all.
- **Requirement:** `bun` must be on `PATH` on native Windows, because monitor, guard and runes call it.
- **Recommended:** install Git for Windows. Without it, Claude Code runs hooks through PowerShell, and these plugins tolerate that too.
- **Status: work in progress.** Plugins load without hook errors. monitor skips its cockpit hooks on native Windows, so the cockpit and the usage dashboard do not work there yet. Other features are not yet verified on Windows.
- **Roadmap:** link to the roadmap with the relative link `[docs/windows-support/WAYPOINTS.md](./docs/windows-support/WAYPOINTS.md)`.
- **Other harnesses:** Codex and OpenCode on Windows are not supported.

A shape that satisfies this (adapt wording, keep every fact):

```markdown
## Windows

Windows support is a work in progress. Plugins load without hook errors. monitor skips its cockpit hooks on native Windows, so the cockpit and the usage dashboard do not work there yet. Other features are not yet verified on Windows. The roadmap is [docs/windows-support/WAYPOINTS.md](./docs/windows-support/WAYPOINTS.md).

**Supported runtimes:**

- The Claude Code CLI on native Windows.
- The Claude Code Desktop app's **Local** session.

Claude Code inside WSL is expected to behave like Linux, but is not yet verified. The Desktop app's WSL sessions do not load plugins.

**Requirements on native Windows:**

- Put `bun` on `PATH`. monitor, guard and runes call it.
- Install Git for Windows (recommended). Without it, Claude Code runs hooks through PowerShell, which these plugins also tolerate.

Codex and OpenCode on Windows are not supported.
```

## Acceptance criteria

- [x] `README.md` has exactly one `## Windows` heading, placed directly before `## usage-dashboard`.
- [x] The section names the two supported runtimes (native Windows CLI, Desktop **Local** session), says WSL is expected to behave like Linux but is not yet verified, and says Desktop WSL sessions load no plugins.
- [x] The section names `bun` on `PATH` as a requirement and Git for Windows as recommended, with PowerShell tolerated.
- [x] The section says the status is work in progress, that monitor skips its cockpit hooks on native Windows so the cockpit and the usage dashboard do not work there yet, and that other features are not yet verified.
- [x] The section links `./docs/windows-support/WAYPOINTS.md` and says Codex and OpenCode on Windows are not supported.
- [x] No other section of `README.md` changed.

## Verification

- [x] `grep -c '^## Windows$' README.md` prints `1`.
- [x] `awk '/^## Windows$/{f=1;next} /^## /{f=0} f' README.md > /tmp/q-lab-windows-section.txt && for w in bun PATH WSL Local 'Git for Windows' PowerShell 'skips its cockpit hooks' 'usage dashboard' 'do not work there yet' 'work in progress' 'not yet verified' 'not supported' 'WAYPOINTS.md' Codex OpenCode; do grep -q "$w" /tmp/q-lab-windows-section.txt || echo "missing: $w"; done` prints nothing.
- [x] `awk '/^## /{if($0=="## usage-dashboard")print prev; prev=$0}' README.md` prints `## Windows`.
- [x] `test -f docs/windows-support/WAYPOINTS.md` exits 0, and `grep -c '](./docs/windows-support/WAYPOINTS.md)' README.md` prints `1`.
- [x] (human) Read the extracted section in `/tmp/q-lab-windows-section.txt` against the fact list under Implementation notes, one fact at a time. Every fact is present with the same meaning, and no sentence claims more (for example, that Desktop WSL sessions load plugins, or that WSL is verified).
- [x] `git diff --numstat -- README.md | awk '{exit $2!=0}'` exits 0 (no deleted lines).
- [x] `git diff -U0 -- README.md | grep -c '^@@'` prints `1` (one contiguous inserted block).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                              | 2–3 (below bar)                                                                     | 4–5 (pass)                                                                                   |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | a required fact is missing, or the section claims Windows support beyond the statement (e.g. says cockpit works, or Codex is supported) | every fact present but one is softened or overstated, or the section sits elsewhere | every fact in the statement present, nothing overclaimed, placed before `## usage-dashboard` |
| Test coverage           | ×2     | verification greps not run                                                                                                              | greps run but skip some required facts                                              | every Verification command run and passing, covering every required fact                     |
| Interface & readability | ×1     | wall of prose or marketing tone                                                                                                         | readable but mixes several facts per sentence                                       | one fact per sentence, matches the README's bold-lead-in + bullet style                      |
| Assumptions & docs      | ×1     | link broken or absolute                                                                                                                 | link works but requirement reasons omitted                                          | relative link resolves; each requirement says why (`bun` is called by monitor, guard, runes) |

## Out of scope

- Per-plugin Windows notes in each plugin's own README section — Deferred. Reason: plugins beyond hook loading are not yet verified on Windows.
- Editing `CLAUDE.md` — Deferred. Reason: it documents repo internals, not user setup.
- Translating the README — Deferred. Reason: the README is English-only.
- Changing the existing installation sections — Deferred. Reason: the install commands are the same on Windows.

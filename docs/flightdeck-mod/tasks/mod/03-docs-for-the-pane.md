# MOD-03: Docs for the pane

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: mod/02
> **Blocks**: review/01
> **Status**: todo

## Goal

The repo docs describe the flightdeck pane, so the next reader knows it exists and what constrains it.

## Files to create / modify

- `CLAUDE.md` (modify) — the dispatch summary bullet, the Architecture tree, and the Commands section.
- `packages/dispatch/skills/autopilot/SKILL.md` (modify) — one sentence in "Launch flightdeck after confirmation".
- `packages/dispatch/skills/deckplan/SKILL.md` (modify) — one sentence near the launch command.

## Implementation notes

Follow the repo's writing rules in every addition: one instruction per sentence, verb first, condition before instruction, and say why rather than what. Match the dense style of the surrounding `CLAUDE.md` prose. Do not restate code.

### `CLAUDE.md` → Plugin summaries → **dispatch** bullet

Append one or two sentences to the existing bullet. They must carry these facts:

- Flightdeck also renders as a Claude Code pane: `/flightdeck [planDir|close]` toggles it, and it auto-opens after a `flightdeck.ts --plan` Bash call, in the launching session only.
- The pane is fed by `deck-snapshot.ts`, which reads the plan and the run log directly and never the server. Give the reason: the SSE `/api/events` stream cannot ride `$.http.fetch`'s 30 s cap, and `daemon.json` is global, so another plan's launch SIGTERMs the server a pane would poll.
- Waves in the pane are static dependency depth over the whole tree, so rows never move as work lands.

### `CLAUDE.md` → Architecture tree

Under `packages/dispatch/`, add lines in the tree's existing comment style:

- `hooks/flightdeck/` — `types.ts` (the `DeckSnapshot` contract), `rows.ts` (pure docked/inline layout), `deck-command.ts` (pure `--plan` parse), `flightdeck.tsx` (the pane mod).
- `deck-snapshot.ts` under the autopilot scripts comment — the pane's bun-child snapshot CLI.

### `CLAUDE.md` → Commands

Add, beside the guard and monitor mod-test commands, a commented line and this command (from `../_context/shared.md` → Verification baseline):

```sh
# dispatch's mod: copy only the mod's files, since its bun tests share hooks/
(d=$(mktemp -d) && mkdir "$d/hooks" && cp -R packages/dispatch/.claude-plugin "$d" && (cd packages/dispatch/hooks && cp -R hooks.json register.ts task-path.ts flightdeck flightdeck.mod.test.ts flightplan-lint.mod.test.ts "$d/hooks") && rm -f "$d"/hooks/flightdeck/*.test.ts && claude plugin test "$d"; s=$?; rm -rf "$d"; exit $s)
```

### `packages/dispatch/skills/autopilot/SKILL.md`

In "Launch flightdeck after confirmation", add one sentence containing the phrase `Flightdeck pane`: under Claude Code the dispatch mod opens a Flightdeck pane after this command, so do not tell the user to open it.

### `packages/dispatch/skills/deckplan/SKILL.md`

Near the `flightdeck.ts --plan` launch command, add one sentence with the same meaning, also containing `Flightdeck pane`.

## Acceptance criteria

- [ ] `grep -n "/flightdeck" CLAUDE.md` matches the dispatch summary bullet.
- [ ] `grep -n "deck-snapshot" CLAUDE.md` matches both the dispatch bullet and the Architecture tree.
- [ ] `grep -n "hooks/flightdeck" CLAUDE.md` matches the Architecture tree.
- [ ] `grep -n "packages/dispatch/.claude-plugin" CLAUDE.md` matches the new Commands entry.
- [ ] `grep -n "Flightdeck pane" packages/dispatch/skills/autopilot/SKILL.md packages/dispatch/skills/deckplan/SKILL.md` prints one match in each file.
- [ ] `git diff -- CLAUDE.md packages/dispatch/skills/autopilot/SKILL.md packages/dispatch/skills/deckplan/SKILL.md` shows changes only in the named sections: no other prose reworded.

## Verification

- [ ] Run each grep from the acceptance criteria and confirm the matches.
- [ ] Run `git diff --stat -- CLAUDE.md packages/dispatch/skills/autopilot/SKILL.md packages/dispatch/skills/deckplan/SKILL.md` and read the diff.
- [ ] `bun test packages/dispatch/skills/autopilot/` passes, as a regression net for tests that read SKILL.md.

## Eval rubric

> Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Shared bands: `../_context/rubric.md`.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Docs describe behaviour the pane does not have, or omit the command | Facts right but a reason (SSE cap, global `daemon.json`) missing | Every fact matches the shipped pane and its reasons are stated |
| Concision | ×2 | Restates code or adds a new section | Accurate but wordier than the surrounding prose | Fits the dense `CLAUDE.md` style; one or two sentences per spot |
| Assumptions & docs | ×1 | Edits outside the named sections | Minor drift in wording elsewhere | Only the named sections changed |

## Out of scope

- `CHANGELOG.md` entry and version bump — Deferred. Reason: `/chronicle:release` writes both at release time.

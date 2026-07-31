# WIRING-02: skill auto-start and the retired invariant

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/03
> **Blocks**: wiring/03
> **Status**: todo

## Goal

`/autopilot` launches flightdeck itself, once, right after the user confirms the flight — and the skill
no longer claims it ships no scripts of its own.

## Files to create / modify

- `packages/dispatch/skills/autopilot/SKILL.md` (modify) — retire the stale invariant, extend the path
  resolution, and add the launch step.

## Implementation notes

Three separate edits. Make all three; the first two are what stop the third from contradicting the
document around it.

### 1. Retire the "no scripts of its own" invariant

Near the end of the file, a section states that autopilot ships no scripts and reuses its sibling
skill's. That is now false: this plan gives autopilot its own `scripts/` directory. Rewrite that
statement to say autopilot has both — its own scripts directory, plus the sibling's shared tools — and
list the new files under it. Leave the existing table of borrowed tools intact; those are still borrowed.

### 2. Extend the path resolution step

The scout step resolves the sibling skill's scripts directory from the skill's load-time base directory
banner and calls it `$SCRIPTS`. That value is still needed and must not change.

Add a second resolution beside it: autopilot's **own** scripts directory is the base directory itself
plus `/scripts`. Call it `$OWN`. Say explicitly that the plugin-root environment variable must not be
used for either, since it is not reliably set in Bash — the file already warns about this for the first
path and the warning applies equally to the second.

Resolving `$OWN` is simpler than `$SCRIPTS` because it needs no parent traversal. Say so, so nobody
copies the `../flightplan/scripts` shape by habit.

### 3. Add the launch step

Place it **after** the confirmation step, where the user has already chosen the dev engine and reviewer,
and before the workflow is constructed. Two reasons it belongs there and not in the scout step: the
scout runs before the user has agreed to fly at all, so launching there would open a browser for a
flight that may be abandoned; and the absolute plan directory the daemon needs is resolved during scout,
so by the confirmation step it is already in hand.

The step is one command:

```bash
bun "$OWN"/flightdeck.ts --plan "<the absolute plan dir resolved during scout>"
```

Document these points around it:

- The command returns on its own. It spawns the server detached, polls until that server answers, prints
  the URL, and exits. So it takes a few seconds and then hands control back; it does not run the server in
  the foreground.
- The flight does not depend on it. If the command exits non-zero, note that the monitor is unavailable
  and fly anyway — a broken monitor must never block a run.
- It opens the browser by default. `/autopilot` is human-invoked and its confirmation step needs an
  interactive user, so there is no headless case to detect. `--no-open` exists for manual testing only.
- Running it twice is safe. The daemon is a singleton: a second launch for the same plan from the same
  install reuses the running one and just opens the page again.
- Pass the plan directory, not the tasks directory. The daemon expects the parent, and reads both the
  tasks tree and the flightlog beneath it.
- Do not add a **skill-level** wait, poll, sleep, or health check around the command. Readiness is already
  the launcher's job and it reports the outcome through its exit code; a second check on top would just
  duplicate it and slow the step down.

Tell the user the URL in the confirmation output so they can reopen it after closing the tab.

## Acceptance criteria

- [ ] The statement that autopilot ships no scripts of its own is gone, replaced by an accurate one.
- [ ] The new scripts directory and its files are listed in that section.
- [ ] The borrowed-tools table is unchanged.
- [ ] The scout step resolves both the sibling scripts path and autopilot's own scripts path, with
      distinct names.
- [ ] The warning against the plugin-root environment variable covers both paths.
- [ ] A launch step exists after the confirmation step and before the workflow is constructed.
- [ ] The launch step passes the absolute plan directory, not the tasks directory.
- [ ] The step states that the command returns by itself, that a non-zero exit is non-blocking for the
      flight, that repeat launches are safe, and that no extra skill-level readiness check should be added.
- [ ] The URL is surfaced to the user.
- [ ] No other step, model policy, or default in the file is changed.

## Verification

- [ ] Confirm the stale claim is gone:
      `rg -n "ships no scripts" packages/dispatch/skills/autopilot/SKILL.md` returns nothing.
- [ ] Confirm both path resolutions are present and named distinctly:
      `rg -n "OWN|SCRIPTS" packages/dispatch/skills/autopilot/SKILL.md`
- [ ] Confirm the launch command appears exactly once:
      `rg -c "flightdeck\.ts" packages/dispatch/skills/autopilot/SKILL.md` → `1`.
- [ ] Confirm it passes the plan directory rather than the tasks directory: the command has no trailing
      `tasks` path segment.
- [ ] Read the diff and confirm nothing outside the three intended edits changed:
      `git diff -- packages/dispatch/skills/autopilot/SKILL.md`
- [ ] Dry-run the resolution by hand: from the skill's directory, confirm `scripts/flightdeck.ts` exists
      at the path the new instruction describes.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | The launch lands in the scout step, or the stale claim survives | All three edits made but the launch passes the wrong directory, or the step tells the executor to strip the launcher's own readiness check | Invariant retired, both paths resolved and named, launch placed after confirmation with the plan dir, readiness ownership stated correctly |
| Test coverage | ×2 | No checks run | Grepped for the stale claim only | Every Verification command run, including the diff-scope read and the by-hand path check |
| Interface & readability | ×1 | New step clashes with the file's numbering or voice | Readable but the two path variables are easy to confuse | Distinct names, consistent voice, the step reads like the ones around it |
| Assumptions & docs | ×1 | No reason given for the placement | States the placement without the reason | Explains why after confirmation and not in scout, and why readiness belongs to the launcher rather than the skill |

## Out of scope

- Any change to the workflow script or the agent prompts. A separate task in this bucket owns those.
- Bumping the plugin version or writing a changelog entry. Releases are cut separately once the whole
  tree lands.
- Teaching the skill to stop or restart the daemon. The singleton logic already handles reuse and
  supersede; a stop command has no caller yet.
- Detecting a headless environment. Settled in the interview: this skill needs an interactive user to
  reach its confirmation step, so there is no headless case to detect.

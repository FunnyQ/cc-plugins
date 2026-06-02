# RELEASE-02: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/log-schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: release/01
> **Status**: done
> **Final review**: true

## Goal

Hold the whole deliverable to the bar: confirm thoughtful mode works end-to-end, the schema change is backward compatible, nothing regressed, and the PLAN goal is actually met.

## Files to create / modify

- None expected. This is a review/gate task. If it finds a defect, file the fix back into the owning task's bucket rather than patching blindly here.

## Implementation notes

This is the holistic gate — per-task rubrics already scored each piece; this checks **integration, consistency, regressions, and goal-fit** across the whole deliverable (the scribe CLI + schema, both skills, the dashboard rendering, and the version bump).

### End-to-end path to exercise

1. Start the daemon isolated: `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999`.
2. In a temp project that was **never** `cockpit start`'d, simulate the fork's calls with an explicit session id (no live harness session in a manual run): `bun .../cockpit.ts scribe --session 22222222-2222-2222-2222-222222222222 --type learning --title "X" --text "Y"` → confirm the log file is created, the session auto-registers (`/tmp/cockpit-dev/registry.json` gains an entry → would render `tracked:true`), and the entry carries `kind:"learning"`, `source:"scribe"`.
3. `cockpit scribe --recent` lists it; a second identical insight would be skipped by a fork reading that list.
4. Open the dashboard against port 5999 → the entry shows its kind accent + `✍ scribe` badge; a hand-appended legacy record (no `kind`/`source`) renders unchanged; the untracked empty-state CTA mentions `/thoughtful`.
5. Read `/thoughtful` + `/cockpit-scribe` SKILL.md as a fresh agent would: the trigger→fork→scribe chain is unambiguous and the `cockpit scribe` flags referenced match the implementation.

### Consistency checks

- Manual `cockpit log` still works and now stamps `source:"agent"` / `kind:"decision"`; existing cockpit tests still pass.
- The three version fields agree and the CHANGELOG matches.
- No `log-stream.ts` change was needed (records still pass through verbatim).

## Acceptance criteria

- [x] `bun test packages/monitor/skills/cockpit/scripts/` is green (no regressions).
- [x] End-to-end path (steps 1–4) works: auto-register, typed scribe entry, dedup list, dashboard kind+badge, legacy parity, empty-state copy.
- [x] Both SKILL.md files are self-consistent with the actual `cockpit scribe` surface and with each other (`/thoughtful` → `/cockpit-scribe`).
- [x] Manual `cockpit log` path unbroken and now labeled `source:"agent"`.
- [x] Three version fields identical + matching CHANGELOG entry.
- [x] The PLAN goal is met: a pilot can run `/thoughtful` with no goal and get an auto-populated, visually-distinguished decision trail.

## Verification

- [x] Run the full test suite and the end-to-end steps above; record pass/fail per acceptance item.
- [x] If any item fails, name the owning area (backend CLI, a skill, the dashboard, the version bump) for the fix — do not silently patch here.

## Eval rubric

> Scale: 0–5 per dimension; weighted average > 4.0 to pass; Integration < 4 is an automatic veto. These axes are holistic (not a re-score of individual tasks).

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration / does it compose | ×3 | pieces don't connect end-to-end | works but a seam is rough (e.g. fork can't find CLI) | trigger→fork→scribe→dashboard flows cleanly |
| Meets the PLAN goal | ×2 | goal unmet | partially (e.g. needs `cockpit start`) | no-goal auto-logging fully delivered |
| Consistency | ×1 | skills/CLI/docs disagree | minor drift | skills, CLI surface, schema, versions all aligned |
| No regressions | ×1 | breaks manual log or old logs | small parity gaps | tests green, legacy + manual paths intact |

## Out of scope

- Shipping/tagging — Deferred. Reason: the user owns the actual release trigger.
- v2 items (Stop-hook re-salience, log_language auto-detect) — Deferred by PLAN non-goals.

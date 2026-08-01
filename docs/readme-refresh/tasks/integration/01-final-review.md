# INTEGRATION-01: final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: readme/02
> **Status**: todo
> **Final review**: true

## Goal

`README.md` reads as one document written by one person, every factual claim in it is true, and the two
gaps this plan set out to close are actually closed.

## Files to create / modify

- `README.md` (modify) — apply the fixes this review finds. No other file.

## Implementation notes

This is the whole-tree gate. It does not re-score the individual edits; it reads the finished file end
to end and judges the result.

### Read the whole file, then check these

1. **Heading order and flow.** Run `grep -n '^## ' README.md`. Every plugin has exactly one section, no
   heading is duplicated, and the order still makes sense to a first-time reader.
2. **Factual truth.** For every claim about what a plugin or skill does, confirm it against
   `packages/<plugin>/` — the `SKILL.md` files and the two `plugin.json` manifests. A skill named in
   the README must exist on disk. A skill on disk that the README's table omits is a finding, not
   something to silently ignore.
3. **Link integrity.** Every relative link in the file must resolve. Check them mechanically rather
   than by eye:

   ```bash
   grep -o '](\./[^)]*)' README.md | sed 's/^](//; s/)$//' | while read -r p; do
     [ -e "$p" ] || echo "BROKEN: $p"
   done
   ```

4. **Voice consistency.** The newly written prose must not read as a different document from the
   sections around it. Watch for marketing adjectives, emoji, a shifted person, or an install block
   that deviates from the shape every other one uses.
5. **No version numbers in prose.** Versions live in `plugin.json`. A version named in the README goes
   stale on the next release.
6. **No regression.** Nothing that was true and useful before this plan may have been dropped. Compare
   against the pre-plan file with `git diff` and read every removed line.

### Applying fixes

Fix what you find, in `README.md` only. Keep each fix minimal. If a finding is real but out of this
plan's scope, do not fix it — record it in the summary as a reported problem.

## Acceptance criteria

- [ ] `README.md` has exactly one heading per plugin and no duplicate `## ` headings.
- [ ] Every skill named in the README exists under `packages/<plugin>/skills/`.
- [ ] Every skill directory under `packages/<plugin>/skills/` appears in the README's plugin tables.
- [ ] Every relative link in `README.md` resolves to a path that exists.
- [ ] No version number appears in README prose.
- [ ] The `git diff` for this plan removes no factual claim that was true before it.
- [ ] Any finding left unfixed is recorded in the summary with the reason it was out of scope.
- [ ] No file other than `README.md` is modified.

## Verification

- [ ] Run `grep -n '^## ' README.md` and quote the full output; confirm one section per plugin, in a
      sensible order.
- [ ] Run the broken-link loop from the Implementation notes and quote its output; expect no `BROKEN:`
      lines.
- [ ] Run `ls packages/*/skills/` and diff the result by eye against the README's plugin tables; quote
      both lists.
- [ ] Run `git diff -- README.md | grep '^-' | grep -v '^---'` and confirm every removed line was
      replaced by something equivalent or better. Quote anything dropped outright and justify it.
- [ ] Run `git status --short` — expect `README.md` as the only modified path.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`, but score the holistic axes below instead of
> the per-task ones. Each dimension 0–5; weighted average > 4.0 to pass; Meets the plan goal < 4 is an
> automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Meets the plan goal | ×3 | A reader still cannot install some plugin, or chronicle still has no section. | Both gaps closed but a stale count or a wrong claim survives. | Chronicle documented, all five plugins installable from the installation sections, and every count matches what ships. |
| Integration & consistency | ×2 | The new sections read as a different document. | Consistent in shape but the voice drifts in places. | The whole file reads as one document — same shape, same voice, same level of detail throughout. |
| No regressions | ×2 | A true claim or a working link was dropped. | A removed line was replaced by something weaker. | Nothing true was lost; every removal is an improvement and is justified in the summary. |
| Evidence | ×1 | Findings asserted with no commands run. | Commands run but output not quoted. | Every check in `## Verification` was run and its actual output is quoted, including the ones that found nothing. |

## Out of scope

- Restructuring `README.md` — Deferred. Reason: this gate fixes defects in a finished file; a
  restructure is a new plan.
- Editing `CLAUDE.md` to match — Deferred. Reason: this plan touches one file, and `CLAUDE.md` is the
  agent-facing doc with its own level of detail.

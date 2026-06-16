# PACKAGING-03: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: commit/01, commit/02, commit/03, pr/01, pr/02, pr/03, packaging/01, packaging/02
> **Status**: done
> **Final review**: true

## Goal

Holistically verify the whole chronicle plugin composes: both skills wire to their scripts, the manifests and registries are consistent, the cockpit dependency is genuinely soft, no odin-git dependency leaked, and the overall v1 goal (a `commit` skill + a `pr` skill, shippable to both marketplaces at independent version `0.1.0`) is met.

### The v1 definition of done (inline, the bar to check against)

- **commit skill** — one skill auto-decides between a single commit (simple) and an atomic split, asking the human only for the split decision.
- **pr skill** — authors a 4-section reviewer-legible PR (GitHub) / MR (GitLab) body (Why / What changed / What to focus on / How to judge), enriched by the cockpit decision trail when present.
- **packaging** — both manifests at `0.1.0`, registered in both marketplaces; zero odin-git dependency; cockpit is a soft enrichment only.

## Files to create / modify

- None expected. This is a verification gate. If it finds defects, file fixes against the owning bucket (commit/pr/packaging) and re-run their checks — do not patch around them here.

## Implementation notes

This task transitively depends on every other task in the plan (the dependency chain is captured in the `Depends on` header). Run it only when all other tasks are `done`.

### Integration checks

1. **Skills resolve their scripts** — `commit/SKILL.md` references `scripts/analyze-changes.ts` + `references/commit-template.md`; `pr/SKILL.md` references `scripts/analyze-branch.ts` + `scripts/request-creator.ts`. Every referenced path exists.
2. **All tests green together** — `bun test packages/chronicle/skills/**/scripts/` passes as a whole.
3. **Manifests + registries consistent** — both `plugin.json` parse, share `version: "0.1.0"`, and `chronicle` is registered once in each marketplace registry with no `version` field.
4. **Soft cockpit dependency holds** — with `COCKPIT_HOME` pointed at an empty dir, `analyze-branch.ts` exits 0 with `hasCockpit:false`; nothing in either skill or script hard-requires cockpit.
5. **No odin-git leak** — `grep -ri odin packages/chronicle/` returns nothing (no runtime path, no settings key, no copied comment).
6. **Goal met** — confirm against the v1 definition of done above: `commit` (simple/atomic auto-decision) and `pr` (4-section reviewer-legible body, GitHub + GitLab) are both fully present and the plugin is independently versioned at `0.1.0`.
7. **Repo docs updated** — `CHANGELOG.md` carries a chronicle `0.1.0` entry; `CLAUDE.md` "What This Is" lists chronicle with a corrected plugin count (no stale "three local plugins"); the Architecture tree has a `packages/chronicle/` block; the Releasing section notes chronicle's independent versioning. Docs are part of the packaging goal, not optional.

### Consistency sweep

- Trigger descriptions in both SKILL.md files are human-invoked-only and carry zh-TW + English phrases.
- The decision-record field → PR-section mapping in `pr/SKILL.md` matches the shape documented in `_context/shared.md`.
- Version parity: the two plugin.json `version` strings are byte-identical.

## Acceptance criteria

- [x] Every script path referenced by either SKILL.md exists on disk.
- [x] `bun test packages/chronicle/skills/**/scripts/` is fully green.
- [x] Both manifests parse and share `version: "0.1.0"`; `chronicle` registered once in each registry, no `version` field there.
- [x] `analyze-branch.ts` with an empty `COCKPIT_HOME` exits 0 and reports `hasCockpit:false`.
- [x] `grep -ri odin packages/chronicle/` returns nothing.
- [x] `CHANGELOG.md` has a chronicle `0.1.0` entry; `CLAUDE.md` lists chronicle (count corrected, tree block present); Releasing section notes independent versioning.
- [x] The v1 definition of done above (commit + pr, both providers, independent version) is fully satisfied; any shortfall is filed against its bucket, not patched here.

## Verification

- [x] `bun test packages/chronicle/skills/**/scripts/` → green.
- [x] `for f in analyze-changes analyze-branch request-creator; do ...` (or manual) confirm each referenced script + the template + both manifests exist.
- [x] `COCKPIT_HOME=$(mktemp -d) bun packages/chronicle/skills/pr/scripts/analyze-branch.ts` exits 0 with `hasCockpit:false`.
- [x] `grep -ri odin packages/chronicle/` is empty.
- [x] Both registries parse and contain exactly one `chronicle` entry each.
- [x] `grep -n chronicle CHANGELOG.md CLAUDE.md` returns the new entries; `grep -n "three local plugins" CLAUDE.md` is empty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto. This gate scores integration-level axes, not a re-score of individual tasks.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration / does it compose | ×4 | a skill references a missing script, or tests fail together | composes but one wiring/consistency gap | every skill→script path resolves, all tests green together, manifests+registries consistent |
| Meets the PLAN goal | ×2 | a v1 goal (commit or pr) absent | both present but one is thin vs the spec | commit auto-decision + 4-section pr (both providers) + independent version all delivered |
| Consistency | ×2 | contradictions across files | minor drift | descriptions, field mappings, versions all aligned across files |
| No regressions / no leak | ×1 | odin leak or monitor/dispatch/relay touched | minor stray edit | zero odin leak, sibling plugins + registries untouched beyond the additive entry |

## Out of scope

- Building the `review` / `merge` skills — Deferred to a future plan; not part of v1's definition of done.
- Live PR/MR creation against a real remote — Deferred. Verified by manual smoke, not this gate.

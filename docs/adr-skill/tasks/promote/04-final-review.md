# PROMOTE-04: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: promote/03
> **Blocks**: none
> **Status**: done
> **Final review**: true

## Goal

Confirm the whole skill composes, regresses nothing, and actually delivers what the plan set out to deliver — cockpit's first durable read path.

## What this task reviews

This is the holistic gate. It does **not** re-score individual pieces; each one already passed its own rubric. It looks at four axes.

### Integration — does it compose?

Walk the flow end to end against the fixtures: collect skeletons, cluster and disposition, confirm, draft, write, archive. Every hand-off has to work with the shape the previous step actually returns, not the shape its spec described.

The two seams most likely to be wrong:

- The trail collector's payload shape versus what the judging agent reads. The collector emits skeletons — `id`, `sessionId`, `kind`, `decision`, `timestamp`, `files`, and nothing else — and the judge has to cluster from exactly those fields. `sessionId` is load-bearing, not incidental: it is how per-candidate dispositions fold back onto per-session archive targets. If the judge reaches for `reason`, the two-pass design is broken and the seam is wrong even though both sides "work".
- The archive plan's shape versus what the writing agent hands the archiver. The plan carries moves and refusals; the writer must pass an already-approved plan through rather than re-deriving one.

A seam that needs a manual patch between steps is an integration failure, not a rough edge.

**Enact the flow by hand — the five roles are not spawnable during this review.** A session resolves `subagent_type` against the version-pinned plugin cache, which is populated from a git clone tracking `main`. The agent and skill files this tree writes live in the working tree, uncommitted, so no `Agent` call can reach them here; committing is the runner's job and releasing is out of scope. So walk the flow by executing the scripts directly and following each agent file's `## Process` and `## Output` yourself, in the order the orchestrator specifies.

That is not a weaker test of what this axis measures. Integration failures live in the seams — a step consuming a field the previous step never emitted — and driving the steps by hand exposes those *more* sharply, because every hand-off passes through your own hands instead of being papered over by an agent that improvises around a missing field. What it does not prove is that the roles resolve and spawn in a live session; that is confirmed once, after release, and is not this review's gate.

### Meets the goal

The plan's claim is that the decision trail stops being write-only. Judge that concretely: run triage against this repository's real trail — 63 log files, roughly 352 entries — and check that it produces a legible set of candidates with reasons, and that the promotion threshold rejects the things it should reject.

The threshold, reproduced so this check does not depend on reading it elsewhere. Require **at least one** of:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the code alone.

**Plus at least one** of:

- The decision remains relevant across sessions or releases.
- The decision affects multiple modules, plugins, or future contributors.
- A reasonable maintainer may challenge or accidentally undo it later.

A run whose stated reasons do not actually map onto the threshold fails this axis regardless of how clean the code is. Judge the reasoning, not the ratio — a real trail that legitimately holds no decision clearing the bar is a correct result, and failing the review for it would reward promoting something marginal to fill a quota. The positive and negative paths are proved against the synthetic fixtures instead, where the expected outcome is known: the single-decision case must promote and the local-detail case must not.

### Consistency

One vocabulary across the whole surface. These must read identically in the scripts, the agent definitions, the skill file, the ADR template, and the repository's own documentation:

- The four status values: `Accepted`, `Proposed`, `Superseded`, `Deprecated`.
- The three dispositions: `promote`, `watch`, `skip`.
- The two archive buckets: `done`, `watch`.
- The five agent role names.

Model tiers in the Codex TOML definitions must match their Claude counterparts, and every refusal rule stated on one side must appear on the other.

### No regressions

Chronicle's existing commit, pull-request, and release flows must be untouched. The extraction is the risk: the pull-request branch analyzer now imports code it used to own, and its branch-scoped, registry-backed, 14-day horizon must behave exactly as it did before.

## Files to create / modify

This task builds no new component. It has exactly one declared output:

- `docs/adr-skill/TRIAGE-MANIFEST-<YYYY-MM-DD>.md` (new) — the dated record of the real-trail run, one row per candidate

Beyond that it may make small corrective edits anywhere under `packages/chronicle/` to fix what the review finds — a mismatched type, a stale vocabulary word, a missing export. Every such edit must land with a test or a stated manual check behind it.

Because those edits are discovered rather than planned, they cannot appear in anyone's declared file list ahead of time. **The manifest is where they are declared.** Give it a `## Corrective edits` section listing every path this review touched that no other task declared, each with one line saying what was wrong and how it is now covered. An undeclared dirty path with no manifest row is a scope violation; one with a row is a recorded correction. Without this the review would be unverifiable by construction — permitted to fix things it is then forbidden to have touched.

## Acceptance criteria

- [x] The full flow runs end to end against the **single-decision fixture, copied to a scratch directory, `git init`-ed there, and its logs backdated with `find <scratch> -name '*.jsonl' -exec touch -t 202601010000 {} +`** — never in place, and never without the backdating. A fresh copy stamps every log with the current time, the archiver's ten-minute guard then refuses the session as live, and the archived end state below becomes unreachable through no fault of the code. Trail resolution is bounded by the git root and records are written under that root's `docs/adr/`, so running against a fixture nested inside this repository would resolve to this repository's own trail and write the test record into this repository's `docs/adr/`. Both gates are accepted, and the run reaches this exact end state inside the scratch copy: one candidate dispositioned `promote`; a new record at `docs/adr/0001-<kebab-title>.md` inside the fixture, carrying `Status: Accepted` and all five sections, with at least one evidence entry naming that fixture's session id; the fixture's session file moved from `.cockpit/logs/` to `.cockpit/archive/done/`; and `.cockpit/logs/` left empty. No hand-editing of any serialized hand-off — the skeleton payload, the body fetch, the archive plan — between steps. Reshaping a payload by hand to make the next step accept it is the failure this criterion exists to catch, so record any such edit as a failure rather than a workaround.
- [x] A triage run against this repository's real trail produces a written manifest — one row per candidate, carrying its disposition, the sessions it draws on, and **which threshold clause it satisfies or fails, by name**. Save it as `docs/adr-skill/TRIAGE-MANIFEST-<YYYY-MM-DD>.md` so a later reviewer judges the same artifact rather than re-forming an opinion. The gate is concrete: a `promote` row names one mandatory clause and one secondary clause and quotes or summarizes the body evidence for each; a `skip` or `watch` row names the clause it fails and why. Nothing about the distribution of outcomes. A real trail holding no decision that clears the bar is a legitimate result, and failing the review for it would reward promoting something marginal to fill a quota. Both paths get exercised against the synthetic fixtures instead, where the expected outcome is known: the single-decision case must promote and the local-detail case must not.
- [x] The four status values, the three disposition names, the two bucket names, and the five role names are identical everywhere they appear.
- [x] The Codex and Claude agent definitions agree on model tier and on every refusal rule.
- [x] The pull-request flow still produces the same branch material it did before the extraction.
- [x] No file under `packages/monitor/` was modified.
- [x] No log content was destroyed. Archiving *moves* files, so a successful run legitimately empties part of the inbox — the check is that every file that left `.cockpit/logs/` now exists byte-identical under `.cockpit/archive/done/` or `.cockpit/archive/watch/`, Make it strictly content-preservation: **every file that vanished from a source bucket has a byte-identical file at its derived destination**, and no file was truncated or overwritten in place. Do not phrase it as "nothing was unlinked" — a move removes the source directory entry by definition, so that check fails precisely when archiving works.
- [x] Every corrective edit made during this review is covered by a passing test or a stated manual check, and every one touching a path no other task declared has a row in the manifest's `## Corrective edits` section.

## Verification

- [x] `bun test packages/chronicle/` reports at least 169 passing and zero failing. 169 was the pre-plan baseline, so the count must have grown, never shrunk.
- [x] `bun test packages/monitor/skills/cockpit/scripts/` reports zero failures — evidence the port left monitor alone.
- [x] `git status --short -- packages/monitor` prints nothing.
- [x] `grep -rnE "^\s*(import|export)[^\"']*from ['\"][^'\"]*monitor" packages/chronicle --include='*.ts'` returns nothing — no cross-plugin import crept in. Match import and export syntax, not the bare word: the shared trail reader is *required* to carry comments naming monitor's files as the spec for what it ported, so a plain `grep 'packages/monitor'` would flag the very annotations another task demands.
- [x] Copy the spread-decision fixture to a scratch directory, `git init` it, backdate its logs with `find <scratch> -name '*.jsonl' -exec touch -t 202601010000 {} +`, run the whole flow there, and confirm one candidate carrying evidence from all four sessions. Every fixture run in this review uses an isolated repository root; a run rooted in this repository proves nothing about the fixture and risks writing into the real trail.
- [x] Run plain `triage` against this repository's real trail and **decline the first confirmation gate**. There is no separate report-only flag and none is needed: everything up to that gate is specified as read-only, so declining leaves the dispositions on screen and the trail untouched. Declining is itself part of the check — if anything was written or moved before you answered, that is a failure of the read-only guarantee, not a quirk of the run. Then read the candidate list against the promotion threshold above by hand and record it in the manifest.
- [x] `md5 .cockpit/logs/*.jsonl` before and after that run produces identical sums.
- [x] Run `git status --short -- packages/chronicle CLAUDE.md docs/adr-skill/TRIAGE-MANIFEST-*.md` and confirm every path it lists is accounted for: it appears in some task's declared file list, it is the manifest itself, or it has a row in the manifest's `## Corrective edits` section. Any path in none of the three is a real scope violation.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Integration < 4 is an automatic veto.

The veto dimension is **Integration**, not Correctness. This table scores the holistic axes; per-piece quality was already scored upstream.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration | ×3 | A hand-off needs a manual patch to work, or a step consumes a field the previous step does not emit. | The flow completes, but a seam relies on an undocumented shape or a coincidence of field naming. | Every hand-off consumes exactly what the previous step returns; the fixture run needs no intervention. |
| Meets the goal | ×2 | Triage does not run against the real trail, or the manifest is missing, or a row names no threshold clause. | Rows name clauses but do not support them: a reason restates the entry's own title instead of quoting or summarizing the body evidence that satisfies the clause it cites. | Every promotion row names **one mandatory clause and one secondary clause** and quotes or summarizes the body evidence for each; every `skip` and `watch` row names **the clause it fails** and why; and the fixture runs show the single-decision case promoting and the local-detail case not. Score the reasoning, never the ratio — a real trail legitimately yielding zero promotions passes here. |
| Consistency | ×2 | Status values, dispositions, buckets, or role names differ between two surfaces. | The vocabulary matches, but Codex and Claude definitions drift on model tier or on a refusal rule. | One vocabulary everywhere, and the two harnesses' definitions agree field for field. |
| No regressions | ×3 | Any failure in the existing chronicle suite, or any modification under the monitor package. | The suite passes, but the pull-request flow's output changed shape or the cockpit suite was not run. | The full chronicle suite grows and stays green, the cockpit suite passes, and the branch material is unchanged. |

## Out of scope

- Adding features the plan deferred — Deferred. Reason: making the pull-request flow cite ADRs and writing marketplace documentation were both held back until a real ADR exists to cite.
- Committing, bumping a version, or tagging — Deferred. Reason: releasing is a separate human-invoked flow, and tasks in this plan share one working tree without committing.
- Writing a real ADR into `docs/adr/` — Deferred. Reason: the first one comes from a live run the human drives, after this gate passes.

# Triage manifest — 2026-08-06

Record of the real-trail triage run required by `tasks/promote/04-final-review.md`.

## Run

- Trail root: `/Users/funnyq/Projects/q-lab/cc-plugins`
- Collector: `bun packages/chronicle/skills/adr/scripts/collect-adr-context.ts`
- Summary: `hasTrail: true`, `sessionCount: 66`, `entryCount: 369`, `adrDir: docs/adr` (`exists: false`, `nextNumber: 1`)
- Clustered by identical `decision`: **367 clusters**. Exactly one cluster spans more
  than one session, and it holds three entries whose `decision` string is empty.
- **Gate 1 was declined.** Nothing was written or moved. `md5 .cockpit/logs/*.jsonl`
  produced identical sums across all 66 files before and after the run, `.cockpit/archive/`
  was never created, and `docs/adr/` still does not exist.

Shortlisting followed the reckoner's two-pass rule: cluster from skeletons, then fetch
bodies only for clusters that plausibly clear both criterion groups. Ten entries were
shortlisted and their bodies read. The 357 unshortlisted clusters are single-session,
single-entry records of local work — a rename, a test helper, a version bump, a
workaround pinned to an upstream issue — and each fails **both** mandatory clauses:
reversal is a local edit, and the rationale is visible in the code it names.

## Threshold clauses, by name

Mandatory — at least one must hold:

- **M1** — reversing the decision would need a migration or coordinated changes.
- **M2** — the rejected alternatives and tradeoffs are not recoverable from the code alone.

Secondary — at least one must hold:

- **S1** — the decision remains relevant across sessions or releases.
- **S2** — the decision affects multiple modules, plugins, or future contributors.
- **S3** — a reasonable maintainer may challenge or accidentally undo it later.

## Candidates

### `promote`

| Entry | Sessions | Decision |
| --- | --- | --- |
| `72562506-d75a-4147-ad08-06d504087e80` | `5c662721-58f3-4623-8885-b90c9675d007` | Plugins in this repo may never import each other |

- **M2** — the body records what the code cannot: the import count from
  `packages/chronicle` to `packages/monitor` is zero *by constraint*, not by accident.
  Plugins install and version independently, so a cache path like
  `.../chronicle/0.9.6/` cannot resolve `../../monitor/...` at
  `.../monitor/3.22.0/`, and the other plugin may not be installed at all. The entry
  names the trap explicitly: "在 repo 裡跑起來會誤導你" — the relative path works in the
  monorepo and only breaks on a user machine.
- **S2** — it binds every future cross-package design. The entry cites this plan's own
  `PLAN.md`, which said "use cockpit's `log-root.ts` walk-up" — a sentence that is
  literally impossible, and the reason `shared/scripts/cockpit-trail.ts` is a port
  carrying spec comments rather than an import.

| Entry | Sessions | Decision |
| --- | --- | --- |
| `5104364a-5a6a-431c-bbd3-bfa344b6f68a` | `82327df5-6355-45c3-8550-3facb7b7aac9` | The `.cockpit` walk-up must stop at the git root |

- **M2** — the body carries a fact no reader can recover from `logRoot()`: `~/.cockpit`
  actually exists on this machine, because `cockpit-home.ts`'s legacy migration only
  fires when the new XDG home is absent, and it is not. Every project lives under
  `~/Projects/`, so an unbounded walk-up would collapse every repository into one trail.
  The entry also records that this came out of a `/relay codex` design review and that
  the original proposal was the unbounded form.
- **S3** — the bound reads as an arbitrary extra condition. A maintainer simplifying the
  loop would remove it, and the failure is silent: trails merge rather than error.

| Entry | Sessions | Decision |
| --- | --- | --- |
| `12da43a3-4b59-4ad5-978d-1bf2fbd735b9` | `2a7606f0-acf8-4c76-8af3-1ac7d54d712c` | Gate `needs_your_call` on an explicit switch, never on inferred presence |

- **M2** — the rejected alternatives are recorded with their measurements and are gone
  from the code: tab-visibility inference was disproved by measurement, and
  focus/blur plus recent input timestamps was rejected as "more code, tunable
  thresholds, and still guessing at a person's attention". The surviving code shows only
  the two-factor result, not the two dead ends.
- **S3** — the body states why the liveness factor cannot be dropped: with the switch on
  and no tab connected, a park hangs forever. That is exactly the simplification a later
  maintainer would attempt.

| Entry | Sessions | Decision |
| --- | --- | --- |
| `f6ea0894-6419-4075-abc3-54989f91275c` | `dba60e1c-d26b-49da-8627-bdb22ada1c7d` | Migrate to GitHub Flow — `main` is the only long-lived branch |

- **M1** — the body is a completed migration with a verified order: five component
  releases landing on merge commit `df7216f`, the plugin cache confirmed at chronicle
  0.9.3 by grepping release paths, `.chronicle/release.json` gaining
  `"workflow": "github-flow"` and losing `branches.develop`, then `develop` deleted
  locally and on the remote. Reversing it means recreating a branch and re-coordinating
  every release config.
- **S1** — it governs every release from that point on, and the entry notes
  `.chronicle/pr.json` was already GitHub Flow while `release.json` had drifted behind.

| Entry | Sessions | Decision |
| --- | --- | --- |
| `8372cd2f-480d-4b5f-8796-b02bc5b31a9f` | `82327df5-6355-45c3-8550-3facb7b7aac9` | Daemon readers treat the registry entry as authoritative, not the request's `project` |

- **M1** — the change is coordinated across three readers: `log-stream.ts` resolves by
  `sessionId` and trusts the entry's absolute `logPath`, while `project-info.ts` and
  `design-system.ts` move to `resolveKnownProject()`. The body records that
  `design-system.ts` was missed by the author and caught in review, which is what makes
  the set, not the single file, the decision.
- **S2** — the body names why exact comparison breaks in *both* directions: a live
  session's link carries the raw cwd while the trail anchors at the repo root, and older
  entries are the reverse. It also states the safety property preserved — confinement
  moved to the entry's own project, and `resolveKnownProject()` never resolves upward.

| Entry | Sessions | Decision |
| --- | --- | --- |
| `9b9fcd4b-02ec-4a1f-8d4f-4e9f23a95a16` | `137d45de-beb9-4d04-8961-5b07629df7c2` | Relay live mode captures results through a file contract, never by reading the pane |

- **M2** — the rejected route was measured and abandoned wholesale, and the measurement
  survives only here: an alt-screen TUI's scrollback is empty, so `recent-unwrapped`
  reads nothing, and the visible read truncates. The same entry records why the prompt
  also travels by file — a multi-line `herd.send` submits early in the TUI input box and
  risks `ARG_MAX`. Neither fact is inferable from `live.ts`.
- **S2** — it fixes the relay↔herdr boundary: `herd.ts` is dynamically imported through
  a resolution chain, and relay falls back to headless with one stderr note rather than
  taking a hard dependency.

### `watch`

| Entry | Sessions | Decision | Clause it fails |
| --- | --- | --- | --- |
| `16bcd405-76e2-4a89-ab3d-a976a155516d` | `896fbaf0-6528-42fe-a4b4-e59334a28b74` | Multi-component release implemented in orchestration prose, not in the pure core | **M1 not yet met** |

The body makes a real either/or — extend `analyze-release.ts` to understand multiple
components, or thread `releases[]` through the agent layer — and chose the second, so
**M2** partly holds. But it also states the mechanism is "N single-component
`--apply`/`--verify` loops plus N `git tag -a` on one merge commit", with no new core
logic. Reversing it is therefore a rewrite of prose, not a migration, and **M1 fails**.
Held for a second data point: if a third component shape forces the core to change
anyway, the decision becomes durable and promotes then.

| Entry | Sessions | Decision | Clause it fails |
| --- | --- | --- | --- |
| `401dd149-8b45-4efb-bbd2-c59f588e0eb7` | `e2e8a980-f8d7-4776-8030-a50ab2dbffb4` | Scribe nudge becomes a three-tier session/project/user switch | **M2 partly fails** |

The durable half is real: project scope is keyed by git root inside the one global
`~/.config/q-lab/cockpit/config.json`, never a repo dotfile, guarding cockpit's
"no per-project metadata file" rule. But the resolution order and the three-state
semantics are readable straight off the config schema and `scribe-nudge.ts`, so **M2**
holds only for the removal of `COCKPIT_NUDGE_OFF`, not for the design as a whole.
Watched rather than promoted so it can merge with the cockpit-config decision if one
appears; on its own it is a settings-layout choice.

### `skip`

| Entry | Sessions | Decision | Clause it fails |
| --- | --- | --- | --- |
| `7529a380-fb3d-4c73-8550-18c93bf1e76c` | `e2e8a980-f8d7-4776-8030-a50ab2dbffb4` | Scribe nudge as a two-layer env + file switch | **S1** |

Superseded within the same session by `401dd149`, which states it "**取代**前一筆" and
removes `COCKPIT_NUDGE_OFF` outright. The decision no longer holds across sessions or
releases, so **S1 fails** and no mandatory clause is reachable. Surfaced here rather than
silently dropped, because the pair is the kind of same-session reversal the skill must
never resolve by simply taking the newest entry.

| Entry | Sessions | Decision | Clause it fails |
| --- | --- | --- | --- |
| `6e0ad679-4153-49d1-934e-6b9da1decd7f` | `main` | Chronicle agents get three reasoning-effort tiers by role, not two by model | **M1 and M2** |

A mechanical convention. **M1 fails**: reversing it is editing an `effort` line in each
of eleven agent files plus the matching `model_reasoning_effort` in the Codex TOMLs — no
migration, no coordination beyond the edit itself. **M2 fails**: the tier is written in
each file's frontmatter and the role's job is visible in the same file, so the mapping is
recoverable by reading the very files it configures. Correct as a `## Conventions` note,
not as a record.

| Entry | Sessions | Decision | Clause it fails |
| --- | --- | --- | --- |
| 357 remaining clusters | 66 sessions | Single-entry local work | **M1 and M2** |

Not shortlisted. Each is one entry in one session naming a rename, a test helper, a
disposable snapshot format, or a workaround pinned to an open upstream issue. Reversal is
a local edit with no migration (**M1 fails**) and the rationale sits in the file the entry
names (**M2 fails**). Promoting any of them would be exactly the "treat every
implementation choice as architecture" non-goal the skill rejects.

## Fixture runs

Both synthetic paths were driven end to end by hand, each in its own `git init`-ed scratch
copy with logs backdated to `202601010000`. No serialized hand-off — skeleton payload,
body fetch, or archive plan — was edited between steps.

| Fixture | Expected | Result |
| --- | --- | --- |
| `single-decision` | promotes | 1 candidate `promote`; `docs/adr/0001-archive-decision-logs-never-delete-them.md` written with `Status: Accepted` and all five sections, evidence naming `session-001` / `dec-single-001`; validator exit `0`; session moved to `.cockpit/archive/done/`; `.cockpit/logs/` empty; md5 `3279dc37…` identical before and after |
| `local-detail` | does not promote | 4 single-entry clusters, all `skip`: a private rename, a test-local helper, a workaround tied to Bun issue 18210, and a disposable snapshot format. All fail **M1** and **M2** |
| `spread-decision` | one candidate, four sessions | 4 sessions / 5 entries collapse into **one** cluster (`Should ADRs ship with a Status field?`) spanning `session-001`–`session-004`; bodies fetched for all five; plan folded 4 moves, 0 refusals; all four archived byte-identically |
| `already-recorded` | index sees the existing record | `exists: true`, `nextNumber: 2`, `ADR-0001` parsed with `Accepted`; validator exit `0` with one `empty-evidence` warning |

## Corrective edits

Paths this review touched that no other task declared.

| Path | What was wrong | How it is covered |
| --- | --- | --- |
| `packages/chronicle/shared/scripts/temp-payload.ts` (new) | The same "mkdir a `/tmp/chronicle/<skill>` directory, write `<prefix>-<unique>.json`, return the path" writer existed three times — `analyze-branch.ts`, `archive-plan.ts`, and inline in `collect-adr-context.ts` — with two different uniqueness schemes. All three now call one helper. | `temp-payload.test.ts`; plus the three call sites exercised by `archive-plan.test.ts`, `collect-adr-context.test.ts`, and the fixture runs above |
| `packages/chronicle/shared/scripts/temp-payload.test.ts` (new) | — | Asserts the output directory, the `<prefix>-<ms>-<pid>.json` name, and object/array round-trips |

Every other path this review edited appears in some task's declared file list. The
integration repairs are recorded there rather than here:

- `agents/{gleaner,reckoner,lorekeeper,codifier,barrowkeeper}.md` and their
  `agents-codex/*.toml` counterparts — four flag or field names that did not exist in the
  scripts they invoke, plus a commit phase that demanded a draft the no-promotion branch
  never produces. Covered by the by-hand flow above, which now runs with no manual patch,
  and by `collect-adr-context.test.ts`'s unknown-flag cases.
- `agents-codex/{reckoner,codifier}.toml` — `model_reasoning_effort` was `"medium"`
  while both Claude counterparts declare `effort: high`. The eleven shipped roles map
  Claude `low → "low"` and Claude `default`/`medium → "medium"`; `high` is an explicit
  request for more than default, so its honest Codex value is `"high"`. Verified against
  the full 16-role table.
- `skills/adr/references/adr-template.md` — the `bad-date` rule row now matches the
  tightened validator.

## Regression evidence

- `bun test packages/chronicle/` — 255 pass, 0 fail (baseline before this review: 252;
  pre-plan baseline: 169).
- `bun test packages/monitor/skills/cockpit/scripts/` — 403 pass, 0 fail.
- `git status --short -- packages/monitor` — empty.
- `grep -rnE "^\s*(import|export)[^\"']*from ['\"][^'\"]*monitor" packages/chronicle --include='*.ts'` — no matches.
- `bun packages/chronicle/skills/pr/scripts/analyze-branch.ts --base main` — exit `0`,
  payload keys unchanged (`base`, `commits`, `decisions`, `diffStat`, `head`,
  `mergeBase`, `provider`, `remoteUrl`, `repo`), 15 commits and 8 harvested decisions,
  filename still `branch-material-<ms>-<pid>.json`.
- Six tests moved rather than deleted when `analyze-branch.ts`'s test-only re-exports of
  `collectDecisions` and `projectMatches` were dropped: the duplicated suites now live
  once in `cockpit-trail.test.ts`, which gained the "every log fails" case the pr copy
  held alone.

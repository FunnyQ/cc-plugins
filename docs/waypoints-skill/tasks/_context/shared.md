# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

This is the `q-lab-marketplace` Claude Code + Codex plugin repo. We are adding a fourth skill,
`waypoints`, to the **dispatch** plugin (`packages/dispatch/`). `waypoints` produces a milestone
**roadmap** and each milestone's flightplan is generated just-in-time by the existing `flightplan`
skill running in a new "waypoint mode". Users: developers planning large from-scratch builds.

The dispatch skill arc: `preflight` → `flightplan` → `autopilot`, and now `waypoints` sits above
`flightplan` as the whole-project milestone layer.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Use `type` over `interface`. No external npm deps.
- **Storage**: filesystem only. Roadmap state lives in `docs/<proj>/WAYPOINTS.md`; leg flightplan trees
  live in `docs/<proj>/legs/NN-slug/`. No DB, no per-project dotfile.
- **Tests**: `bun test`. Extract pure functions and unit-test them, mirroring
  `packages/dispatch/skills/flightplan/scripts/*.test.ts` (each script has a matching `*.test.ts`; a
  `lib/` holds shared pure helpers like `parse-task.ts`).

## Code style

- Match the existing dispatch scripts: Bun APIs (`Bun.file`, `mkdir` from `node:fs/promises`), 2-space
  indent, `type` aliases, small exported pure functions with an impure CLI wrapper at the bottom.
- CLI entry pattern: a `main()` that reads `process.argv`, dispatches on the verb, exits non-zero on
  error. Keep parsing/transition logic in exported pure functions the tests call directly.
- Authoritative source for style (verification only): the sibling scripts under
  `packages/dispatch/skills/flightplan/scripts/`, especially `scaffold.ts`, `next-ready.ts`, `mark-done.ts`.

## File / directory layout

New skill mirrors the flightplan skill shape:

```
packages/dispatch/skills/waypoints/
├── SKILL.md                    # frontmatter: name: waypoints, version, description (AUTO-TRIGGER)
├── references/                 # WAYPOINTS.md template + roadmap interview guide
└── scripts/
    ├── waypoints.ts            # CLI: active | leg-scaffold | advance
    └── waypoints.test.ts       # bun test over the pure helpers
```

No plugin-manifest change is needed to register the skill: Claude Code auto-discovers every
`skills/*/SKILL.md`; Codex uses the `"skills": "./skills/"` glob in `.codex-plugin/plugin.json`.
Marketplace registries (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) are
plugin-level only and are NOT touched.

## `WAYPOINTS.md` format (the roadmap — the single source of truth for status)

A `waypoints` roadmap is one markdown file at `docs/<proj>/WAYPOINTS.md`. Canonical shape:

```markdown
# MyApp — Waypoints

> Rolling-wave roadmap. One leg planned in detail at a time.
> Status: [x] done · [~] active (exactly one) · [ ] pending

## Legs

- [x] 1. Auth foundation — users can sign up / sign in with email
      → legs/01-auth/ · landed 2026-07-01 · outcome: also added rate-limiting
- [~] 2. Session & profile — a logged-in user has a profile page
      → legs/02-profile/
- [ ] 3. Billing — paid plans via Stripe
      → legs/03-billing/
- [ ] 4. Admin dashboard — staff can manage users and plans
      → legs/04-admin/
```

Rules the CLI relies on:

- Each leg is one top-level `- [ ]` / `- [~]` / `- [x]` list item under `## Legs`, numbered `N.`.
- The **NN** (leg dir prefix) is the zero-padded number: leg `2.` → dir `legs/02-<slug>/`.
- **Every leg — pending included — carries a `→ legs/NN-slug/` pointer**, authored when the roadmap is
  first written (naming the milestone's dir is part of naming the milestone). The `<slug>` comes from that
  pointer; the parser requires it on every leg so that when a pending leg is promoted to active, `active`
  can immediately emit its `NN-slug`. A leg with no pointer is a malformed roadmap — fail loudly.
- **At most one** `[~]` active leg — the "which leg are we planning now" signal. Exactly one while the
  roadmap is in progress; **zero** once every leg is `[x]` (the completed terminal state — valid, not
  malformed). More than one `[~]` is always malformed.
- The done-state is the text after the ` — ` **em dash** (U+2014, space-padded) on the item line — the em
  dash is the **sole** title/done-state separator, so ASCII hyphens inside the milestone title are preserved
  verbatim. It is the leg's acceptance summary; flightplan scopes to it.
- A landed leg's continuation line carries `· landed <date> · outcome: <one line>`.

## `waypoints.ts` CLI — the three verbs

One Bun CLI, invoked as `bun packages/dispatch/skills/waypoints/scripts/waypoints.ts <verb> ...`.
All verbs take `<proj>` = the roadmap dir name under `docs/` (so `docs/<proj>/WAYPOINTS.md`).

### `active <proj>`

Read `docs/<proj>/WAYPOINTS.md`, print the active leg + a rolling-wave digest of landed legs. This is
the token-saver: it replaces flightplan running several grep/cat calls. Suggested output (stable,
parseable — flightplan reads it):

```
ACTIVE: 02-profile
DONE-STATE: a logged-in user has a profile page
PRIOR LANDED LEGS:
- 01-auth — users can sign up / sign in with email
  outcome: also added rate-limiting
  goal: <first line of legs/01-auth/PLAN.md Overview, if present>
```

- If there is no `[~]` leg, exit non-zero with a clear message — distinguishing **roadmap complete** (every
  leg is `[x]`) from **nothing active yet** (pending legs exist but none promoted). For the latter, the
  remedy is to **mark one leg `[~]` in `WAYPOINTS.md`** (the skill does this when it authors the roadmap; a
  human can do it by hand) — **not** to run `advance`, which itself requires an already-active leg. Zero
  active is a valid state here, not a parse error.
- The `goal:` line reads the landed leg's `PLAN.md` Overview when it exists; degrade gracefully if not.

### `leg-scaffold <proj> <NN-slug> <buckets>`

Build the nested leg flightplan tree — the reason we can't reuse `scaffold.ts` (its slug regex rejects
a digit-led `01-auth` and its mkdir is non-recursive at the slug level). `<buckets>` is comma-separated.

Creates (mirroring `scaffold.ts`'s output shape, one level deeper):

```
docs/<proj>/legs/<NN-slug>/tasks/_context/
docs/<proj>/legs/<NN-slug>/tasks/<bucket>/     # one per bucket
```

- `docs/<proj>/legs/` is created recursively; the leg dir itself is created **non-recursively** so a
  TOCTOU race (leg created between a check and the mkdir) throws `EEXIST` instead of silently
  overwriting — same guard `scaffold.ts` documents.
- Validate `<NN-slug>` matches `^\d{2}-[a-z][a-z0-9-]*$` (two-digit prefix + kebab slug).
- Validate each bucket is a single kebab token with no internal dashes (`lint-task.ts` / `build-readme.ts`
  parse the H1 `BUCKET` as one uppercase token — dashed buckets scaffold but fail lint).

### `advance <proj>`

Land the active leg and promote the next. Collapses three markdown edits into one command.

**Write interface (canonical — every task, SKILL.md, and flightplan mode must use exactly this; no
bare-write, no stdin):**

- `advance <proj>` **or** `advance <proj> --dry-run` → **preview only, never writes.** Draft the outcome
  line from the active leg's `docs/<proj>/legs/NN-slug/.flightlog/RUNLOG.md` (plus its flightplan-spec
  goal) — a one-line "what actually shipped / how it differed from the plan" — and print it. The presence
  of `--outcome` is the confirmation gate: without it, nothing is written.
- `advance <proj> --outcome "<confirmed line>" [--date YYYY-MM-DD]` → **writes.** The human takes the
  preview, edits it, and passes it back via `--outcome`. `--date` defaults to today (computed in `main()`).

On write it performs three edits atomically:

1. Flip the active leg `[~]` → `[x]`, appending `· landed <date> · outcome: <confirmed line>`.
2. Promote the next `[ ]` → `[~]` (if none remains, land the active one and report the roadmap complete).
3. Serialize back to `WAYPOINTS.md`.

- `<date>` and `<outcome>` are **passed into** the transition helper (`advanceRoadmap(roadmap, outcome,
  date)`) — do not call `Date.now()`/`new Date()` inside a tested helper; keep transitions pure so tests
  are deterministic. `main()` supplies today's date when `--date` is omitted.
- If there is no next `[ ]` leg, land the active one and report the roadmap is complete.

## flightplan waypoint mode (integration)

`flightplan/SKILL.md` gains a "waypoint mode" section. **Entry is deliberately narrow — it must not hijack
normal flightplan use in a repo that happens to contain an unrelated roadmap.** Enter waypoint mode only
when the user's request is about a specific waypointed project, resolved as: (a) the user names it, points
at a `docs/<proj>/` that contains `WAYPOINTS.md`, or references a leg/roadmap; or (b) exactly one
`docs/*/WAYPOINTS.md` exists **and** the request is clearly to plan its next leg. If multiple roadmaps exist
and none is named, **ask which** (don't guess). If the request is an ordinary "spec this out" with no
roadmap intent, stay in normal flightplan mode even when a `WAYPOINTS.md` exists elsewhere. Once a project
`<proj>` is resolved:

1. Run `waypoints.ts active <proj>` to get the active leg's `NN-slug`, done-state, and prior-leg digest.
2. Interview **only** for that leg's done-state, using the digest as rolling-wave context (do not re-plan
   the whole project).
3. Scaffold with `waypoints.ts leg-scaffold <proj> <NN-slug> <buckets>` (not `scaffold.ts`).
4. Write `PLAN.md` + `tasks/` into `docs/<proj>/legs/<NN-slug>/`; lint/readme/review with the existing
   scripts pointed at that path (they already accept arbitrary paths).

`autopilot` is unchanged: `/autopilot docs/<proj>/legs/<NN-slug>`.

## The lint-hook regex widen (integration)

`packages/dispatch/hooks/flightplan-lint.sh` currently gates on (around line 26):

```bash
if ! [[ "$file_path" =~ /docs/[^/]+/tasks/[a-z][a-z0-9]*/[0-9]{2}-.+\.md$ ]]; then
  exit 0
```

`[^/]+` is a single path segment, so a nested leg task file
`docs/<proj>/legs/01-auth/tasks/<bucket>/02-foo.md` does **not** match and is silently skipped. Widen the
pre-`/tasks/` portion so both flat and nested shapes match, e.g. change `/docs/[^/]+/tasks/` to
`/docs/.+/tasks/`. Keep the existing content sniff on the next line (the file must contain
`> **Required reading**:`) as the guard against false positives — that is what prevents the looser path
regex from linting unrelated markdown.

## Commit & branching style

- Branch off: `develop` (this repo uses git-flow; current branch is `develop`).
- Commit format: emoji + conventional (see repo history, e.g. `🐛 fix(chronicle): ...`).
- Committing/releasing is done by the human via `/chronicle:commit` — sub-agents do NOT commit.

## Verification baseline

- `bun test packages/dispatch/skills/waypoints/scripts/` — the CLI tests.
- `bun packages/dispatch/skills/waypoints/scripts/waypoints.ts <verb> ...` — manual smokes in a temp dir.
- Lint a leg tree: `bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/<proj>/legs/<NN-slug>/tasks`.
- Dev server: none (this is a CLI + skill repo).

## Decisions frozen during interview

- **Nested leg layout** — leg trees live under `docs/<proj>/legs/NN-slug/`, not flat siblings. This is why the lint regex widens and why `leg-scaffold` exists (over reusing `scaffold.ts`).
- **Three verbs now** — `active`, `leg-scaffold`, `advance` all built in this pass (advance included even though hand-editing was the fallback, because collapsing the transition into one verb serves the token-saving principle).
- **Outcome from RUNLOG, human-confirmed** — `advance` drafts the outcome line from the leg's `RUNLOG.md`; the human confirms before it is written.
- **Token-saving principle** — wherever a task would run several CLI commands, wrap them into one verb. This is the reason the CLI exists as multi-verb rather than the skill shelling out to many primitives.
- **No auto-walk-roadmap** — human gates each leg; autopilot is never chained across legs automatically.
- **Status lives only in WAYPOINTS.md** — no dotfile, no metadata sidecar.

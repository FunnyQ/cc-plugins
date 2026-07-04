# SCRIPTS-02: waypoints advance verb

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: scripts/01
> **Blocks**: skill/01, integration/01, integration/03
> **Status**: todo

## Goal

Add the `advance` verb to `waypoints.ts` — land the active leg and promote the next — with a deterministic
`draftOutcome` seed, a pure `advanceRoadmap` transition, and the confirmation-gated write interface,
building on the parse/serialize helpers already in the module.

## Files to create / modify

- `packages/dispatch/skills/waypoints/scripts/waypoints.ts` (modify) — add the `advance` verb + `draftOutcome`/`advanceRoadmap`.
- `packages/dispatch/skills/waypoints/scripts/waypoints.test.ts` (modify) — add `advance`-path tests.

## Implementation notes

This task extends the existing `waypoints.ts` module. The core module already exports the roadmap parser,
serializer, and data model — reuse them; do not re-implement. Their signatures (already present):

```ts
export type Roadmap = { title: string; legs: Leg[] };
// Leg has: num, nn, slug, status, title (milestone name, before the em dash),
//          doneState (after the em dash), landedDate?, outcome?
// advance must preserve `title` (and every untouched leg) through serialization.
export function parseRoadmap(md: string): Roadmap
export function serializeRoadmap(roadmap: Roadmap): string
export function assertSingleActive(roadmap: Roadmap): void
```

Add the `advance` verb to the existing `main()` dispatch. Keep new logic in **pure** helpers; only `main()`
reads the filesystem, computes today's date, prints, and writes.

### `draftOutcome` (pure, deterministic seed)

```ts
export function draftOutcome(runlog: string, planOverview: string): string
```

The human refines the result via `--outcome`, but the seed must be deterministic and testable. Fixed
extraction cascade, first match wins:

1. **RUNLOG final verdict** — if `runlog` contains a `## Final review` (or `Final review`) section, take the
   first non-empty, non-heading line under it; strip markdown, collapse whitespace, truncate to 120 chars.
2. **RUNLOG last narrative** — else if `runlog` has any content, take the last non-empty, non-heading line
   (the most recent entry); same clean/truncate.
3. **Plan fallback** — else if `planOverview` is non-empty, use its first sentence prefixed with `planned: `
   (signals it was not confirmed against a real run).
4. **Empty fallback** — else return the literal `landed (no RUNLOG summary available)`.

Examples:

```
draftOutcome("## Final review\nAll tasks passed; added rate-limiting.\n", "...")
  → "All tasks passed; added rate-limiting."
draftOutcome("", "Auth foundation: email sign-up/sign-in.")
  → "planned: Auth foundation: email sign-up/sign-in."
draftOutcome("", "")            → "landed (no RUNLOG summary available)"
```

### `advanceRoadmap` (pure transition)

```ts
export function advanceRoadmap(roadmap: Roadmap, outcome: string, date: string): Roadmap
```

- Active `[~]` → `[x]`, appending `· landed <date> · outcome: <outcome>` to its pointer/continuation line.
- The first `pending` leg → `active`. If no pending leg remains, only land the active one (roadmap complete).
- `date` and `outcome` are **passed in** — never call `Date.now()`/`new Date()` inside this helper; keep it
  pure so tests are deterministic.

### Write interface (canonical — from `../_context/shared.md`)

`main()` implements exactly:

- `advance <proj>` **or** `advance <proj> --dry-run` → reads the active leg's `.flightlog/RUNLOG.md` + its
  flightplan spec, calls `draftOutcome`, and **prints the draft without writing**.
- `advance <proj> --outcome "<text>" [--date YYYY-MM-DD]` → writes: `advanceRoadmap` then `serializeRoadmap`
  back to `WAYPOINTS.md`. The presence of `--outcome` is the confirmation gate; `--date` defaults to today,
  computed in `main()`.

**No-active-leg guard (all modes).** Before drafting or writing, `main()` checks for an active `[~]` leg. If
there is none it prints a clear stderr message and exits non-zero **without writing** — distinguishing
**roadmap complete** (every leg `[x]`; nothing left to land) from **nothing active yet** (pending legs exist
but none promoted; the user must promote one first). This makes a re-run of `advance` on a finished roadmap,
or a run before the roadmap is started, safe and non-destructive. Since `advanceRoadmap` is only reached
with a guaranteed active leg, it does not itself handle the zero-active case.

## Acceptance criteria

- [ ] `waypoints.ts` now also exposes the `advance` verb via the same `main()` dispatch.
- [ ] `draftOutcome` implements the four-branch cascade above with the shown outputs (final-verdict, last-narrative, plan fallback, empty fallback).
- [ ] `advanceRoadmap` flips `[~]`→`[x]` (with `· landed <date> · outcome: <outcome>`) and promotes the next `[ ]`→`[~]`; when no pending leg remains it lands the active one and leaves no `[~]`.
- [ ] `advance` writes only when `--outcome` is passed; bare `advance` and `--dry-run` preview the drafted outcome without writing; `--date` defaults to today in `main()`.
- [ ] With no active `[~]` leg, `advance` (any mode) exits non-zero without writing, distinguishing "roadmap complete" from "nothing active yet".
- [ ] `draftOutcome`/`advanceRoadmap` are pure — no filesystem, `Date.now()`, or `Math.random()` inside them; the date is injected.

## Verification

- [ ] `bun test packages/dispatch/skills/waypoints/scripts/` is green, adding coverage for: `draftOutcome`'s four cascade branches, `advanceRoadmap` transition (with-pending and no-pending), a `serializeRoadmap(advanceRoadmap(...))` round-trip that confirms **milestone titles and untouched legs survive** the write, and the no-active-leg guard (a completed and a not-yet-started roadmap both exit non-zero without writing).
- [ ] Smoke: on a temp `docs/demo/WAYPOINTS.md` (leg 1 `[~]` with a fabricated `.flightlog/RUNLOG.md`), run `advance demo --dry-run` (prints a draft, writes nothing), then `advance demo --outcome "landed X" --date 2026-07-04` and confirm leg 1 is `[x]` with the outcome and leg 2 is `[~]`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md` (dimension set A — code tasks). Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | advance transition or draft cascade wrong | happy path works but no-pending / dry-run / gate edges drift | cascade + transition + write-gate all correct per spec, edges handled |
| Test coverage | ×2 | no advance tests | one branch only | all four draft branches + advance with/without pending + round-trip |
| Interface & readability | ×1 | write logic tangled, filesystem in helpers | works but helpers impure | pure `draftOutcome`/`advanceRoadmap`, thin `main()` reusing the core helpers |
| Assumptions & docs | ×1 | `Date.now()` in a helper, magic thresholds | some assumptions unstated | date injected, truncation/fallbacks documented, deterministic |

## Out of scope

- Reworking parse/serialize/active/leg-scaffold — Deferred/owned by the core CLI task; reuse those helpers as-is.
- Teaching users the advance flow — Deferred to the skill bucket (this task ships the mechanism, not the docs).

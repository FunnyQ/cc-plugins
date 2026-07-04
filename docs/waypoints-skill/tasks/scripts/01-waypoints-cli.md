# SCRIPTS-01: waypoints CLI core (parse · active · leg-scaffold)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: scripts/02, skill/01, integration/01
> **Status**: todo

## Goal

The `waypoints.ts` CLI foundation: the roadmap data model, `parseRoadmap`/`serializeRoadmap`, and the
`active` and `leg-scaffold` verbs — with pure helpers covered by `bun test`. (The `advance` verb is a
separate follow-up task in this bucket.)

## Files to create / modify

- `packages/dispatch/skills/waypoints/scripts/waypoints.ts` (new) — the CLI + exported pure helpers.
- `packages/dispatch/skills/waypoints/scripts/waypoints.test.ts` (new) — `bun test` over the helpers.

## Implementation notes

Keep all parsing/serialization logic in **exported pure functions**; the `main()` at the bottom is the
only impure part (reads `process.argv`, touches the filesystem, prints, sets exit code). This mirrors the
sibling `packages/dispatch/skills/flightplan/scripts/scaffold.ts` / `mark-done.ts` split. Runtime is Bun;
use `node:fs/promises` (`mkdir`, `readFile`, `writeFile`) and `node:path`. No external deps. Use `type`,
not `interface`. Structure `main()` so a fourth verb (`advance`) can be added later without reshaping it.

### Data model

```ts
export type LegStatus = "done" | "active" | "pending";

export type Leg = {
  num: number;        // 1-based, from the "N." in the list item
  nn: string;         // zero-padded, e.g. "02"
  slug: string;       // from the "→ legs/NN-slug/" pointer
  status: LegStatus;
  title: string;      // milestone name — text BEFORE the em dash (e.g. "Auth foundation")
  doneState: string;  // acceptance summary — text AFTER the em dash
  landedDate?: string;
  outcome?: string;
};

export type Roadmap = { title: string; legs: Leg[] };
```

### Parsing & serializing `WAYPOINTS.md`

A leg is a top-level list item under `## Legs`. The exact, concrete `WAYPOINTS.md` example is in
`../_context/shared.md` (Required reading) — parse it per the rules below rather than duplicating it here.

```ts
export function parseRoadmap(md: string): Roadmap
export function serializeRoadmap(roadmap: Roadmap): string   // inverse of parseRoadmap
export function assertSingleActive(roadmap: Roadmap): void   // throws if [~] count > 1 (zero is valid at terminal)
```

- `[x]`→done, `[~]`→active, `[ ]`→pending.
- `num` from the leading `N.`; `nn` = `String(num).padStart(2, "0")`.
- `slug` from the `→ legs/NN-slug/` pointer on the continuation line. **Every leg — pending too — must
  carry this pointer** (see the format rules in `../_context/shared.md`); a leg missing it is a malformed
  roadmap → `parseRoadmap` throws with a clear message. If the pointer's NN disagrees with the derived
  `nn`, prefer the list number (the number is authoritative).
- `title` / `doneState` split on the ` — ` **em dash** (U+2014): `title` is the trimmed text before it (after
  the `N. ` number prefix), `doneState` the trimmed text after. The em dash is the **only** accepted
  separator — split on it, not on ASCII `-`, so a title containing a hyphen (e.g. "Multi-factor auth — …")
  is never mis-cut. A leg item with no em dash is malformed → throw. **Both** fields must survive
  `serializeRoadmap` — reconstruct the item line as `<title> — <doneState>`, so titles are never lost or
  invented when `advance` rewrites the roadmap.
- `landedDate` / `outcome` parsed from `· landed <date>` / `· outcome: <...>` when present.
- `serializeRoadmap(parseRoadmap(md))` must round-trip a well-formed file without semantic loss.

### `active <proj>`

```ts
export function formatActive(roadmap: Roadmap, priorGoals: Record<string, string>): string
```

Pure formatter; `main()` supplies `priorGoals` by reading the Overview first line of each landed leg's
flightplan spec (best-effort; missing file → omit the `goal:` line). Output shape (stable, parseable):

```
ACTIVE: 02-profile
DONE-STATE: a logged-in user has a profile page
PRIOR LANDED LEGS:
- 01-auth — users can sign up / sign in with email
  outcome: also added rate-limiting
  goal: <Overview first line of the landed leg's flightplan spec, if present>
```

- No `[~]` leg → `main()` prints a clear message to stderr and exits non-zero, distinguishing **roadmap
  complete** (all legs `[x]`) from **nothing active yet** (pending legs exist). Zero active is a valid state,
  not a parse/assert error — `assertSingleActive` only rejects *more than one* `[~]`.

### `leg-scaffold <proj> <NN-slug> <buckets>`

```ts
export function validateLegSlug(nnSlug: string): void   // throws on bad shape
export function validateBucket(bucket: string): void    // throws on internal dashes / non-kebab
```

- `NN-slug` must match `^\d{2}-[a-z][a-z0-9-]*$`; each bucket must match `^[a-z][a-z0-9]*$` (single token,
  no internal dashes — the H1 `BUCKET` parser depends on it).
- `main()` creates `docs/<proj>/legs/` recursively, then the leg dir **non-recursively** (TOCTOU guard →
  `EEXIST` on race), then `tasks/_context/` and one dir per bucket. Print the created paths like
  `scaffold.ts` does.

## Acceptance criteria

- [ ] `waypoints.ts` exposes verbs `active` and `leg-scaffold`; an unknown verb exits non-zero with usage.
- [ ] `parseRoadmap` correctly extracts status, num/nn, slug, **title**, doneState, landedDate, outcome from the format in `../_context/shared.md`, and throws on a leg missing its `→ legs/NN-slug/` pointer.
- [ ] `serializeRoadmap(parseRoadmap(md))` round-trips a well-formed roadmap without semantic loss — **milestone titles are preserved**, not erased or invented; `assertSingleActive` throws only when `[~]` count > 1 (zero active is accepted as a valid terminal/complete state).
- [ ] `active` prints the parseable ACTIVE/DONE-STATE/PRIOR-LANDED block; with no `[~]` leg it exits non-zero, distinguishing a completed roadmap (all `[x]`) from nothing-active-yet.
- [ ] `leg-scaffold` creates `docs/<proj>/legs/<NN-slug>/tasks/_context/` + one dir per bucket, rejects a digit-led-only or slash-bearing slug and dashed bucket names, and throws `EEXIST` on an existing leg dir.
- [ ] Parse/serialize/format/validate helpers are pure — no filesystem, `Date.now()`, or `Math.random()` inside them.

## Verification

- [ ] `bun test packages/dispatch/skills/waypoints/scripts/` is green, covering: parse of all three glyphs, missing-pointer throw, em-dash title/done-state split preserving an ASCII hyphen in the title, a round-trip that proves titles survive parse → serialize, `assertSingleActive` (zero active accepted, two throws), `formatActive` shape, and leg-scaffold validation (good + bad slugs/buckets).
- [ ] Smoke: in a temp dir with a hand-written `docs/demo/WAYPOINTS.md`, run `active demo` and `leg-scaffold demo 01-auth work` and eyeball each output (active block + created dirs).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md` (dimension set A — code tasks). Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | verbs misbehave or parse is wrong | happy path parses but edges (NN/pointer mismatch, missing pointer, no-active) drift | parse/serialize/active/leg-scaffold correct, edges + validation handled per spec |
| Test coverage | ×2 | no tests | happy-path parse only | parse all glyphs + missing-pointer + round-trip + leg-scaffold good/bad inputs |
| Interface & readability | ×1 | logic tangled into `main()`, filesystem in helpers | verbs work but helpers impure or types vague | pure parse/serialize/format/validate helpers, clear `type`s, thin impure `main()` |
| Assumptions & docs | ×1 | magic strings, undocumented format assumptions | some assumptions unstated | format assumptions inline, helpers pure and composable |

## Out of scope

- The `advance` verb (`draftOutcome`, `advanceRoadmap`, the write interface) — Deferred to the next task in this bucket, which builds on the parse/serialize helpers here.
- The `SKILL.md` and references that document these verbs — Deferred to the skill bucket.
- flightplan's consumption of `active`/`leg-scaffold` — Deferred to the integration bucket.

# WAYPOINTS.md Template

Use this file shape for `docs/<proj>/WAYPOINTS.md`. The roadmap is the single source of truth for leg status.

## Canonical format

```markdown
# <Project Name> — Waypoints

> Rolling-wave roadmap. One leg planned in detail at a time.
> Status: [x] done · [~] active (exactly one) · [ ] pending

## Legs

- [~] 1. <Milestone title> — <done-state>
      → legs/01-<slug>/
- [ ] 2. <Milestone title> — <done-state>
      → legs/02-<slug>/
- [ ] 3. <Milestone title> — <done-state>
      → legs/03-<slug>/
```

## Rules

- Each leg is one top-level `- [ ]` / `- [~]` / `- [x]` item under `## Legs`: pending (not planned in detail yet), active (the only leg `flightplan` plans next), landed.
- Exactly one leg is `[~]` while the roadmap is in progress; zero only when every leg is `[x]`. The script rejects more than one.
- `N.` is the leg number; its zero-padded form is the directory prefix: leg `2.` → `legs/02-<slug>/`.
- ` — ` (space-padded em dash, U+2014) is the only separator between the milestone title and the done-state, which states what must be true when the leg lands.
- Every leg, pending ones included, carries the `→ legs/NN-slug/` pointer on its continuation line. `advance` appends `· landed <date> · outcome: <one line>` there.
- `advance` rewrites the whole file in this shape, so anything outside the title and `## Legs` is lost.

## Filled example

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

This example has one landed leg, one active leg, and two pending legs. Until that leg lands, `flightplan` should scope only to `02-profile`.

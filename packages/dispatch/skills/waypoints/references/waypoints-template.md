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

## Legend

- `# <Project Name> — Waypoints`: the roadmap title.
- `[ ]`: pending leg, not planned in detail yet.
- `[~]`: active leg, the only leg `flightplan` should plan next.
- `[x]`: landed leg.
- `N.`: human-readable leg number. The zero-padded `NN` comes from this number: leg `2.` uses `02`.
- `<Milestone title>`: short label for the leg.
- ` — `: space-padded em dash, U+2014. This is the only title/done-state separator.
- `<done-state>`: acceptance summary for the leg. It states what must be true when the leg lands.
- `→ legs/NN-slug/`: mandatory pointer for every leg, including pending legs.
- `· landed <date> · outcome: <one line>`: continuation metadata on landed legs.

## Rules

- Each leg is one top-level `- [ ]` / `- [~]` / `- [x]` list item under `## Legs`, numbered `N.`.
- The **NN** leg directory prefix is the zero-padded number: leg `2.` -> `legs/02-<slug>/`.
- Every leg carries a `→ legs/NN-slug/` pointer.
- At most one leg is `[~]` active. Exactly one active leg while a roadmap is in progress; zero active legs only when every leg is `[x]`.
- The done-state is the text after the padded em dash ` — ` on the leg item line.
- A landed leg's continuation line carries `· landed <date> · outcome: <one line>`.

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

This example has one landed leg, one active leg, and two pending legs. `flightplan` should scope only to `02-profile` until that leg lands.

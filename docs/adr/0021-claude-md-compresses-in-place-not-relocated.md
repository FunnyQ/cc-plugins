# ADR-0021: CLAUDE.md compresses in place instead of relocating cockpit's constraints

- Status: Accepted
- Date: 2026-08-05

## Context

Before deleting deep detail from CLAUDE.md, cockpit's own documentation was
checked as a possible destination: `DESIGN.md` (3,077 words, the Night Flight
visual system) and `PRODUCT.md` (brand positioning). Neither document
contains any engineering constraint — meaning facts like "log-root walk-up
must never cross the git root" (a leftover `~/.cockpit` would otherwise
collapse every repo under `$HOME` into one trail), "`document.hidden` stays
false when another app covers the browser, so the presence gate needs both
intent and liveness factors," and "Codex runs hooks under an environment-
frozen app-server daemon" had no second home anywhere in the repo.

## Considered alternatives

- Delete the deep detail from CLAUDE.md and leave a one-line pointer to the
  plugin's own docs. Rejected: this would destroy the knowledge outright,
  since no other document actually carries it.

## Decision

Keep the constraints in CLAUDE.md, rewritten into two sections, "Cockpit
constraints" and "Harness constraints." The 4,483 → 2,336 word reduction came
from deleting facts that were no longer true, deleting Odin-lineage
archaeology, and splitting 200-word sentences — not from deleting any
constraint.

## Consequences

Any future CLAUDE.md slimming pass must first verify, per fact under
consideration, that some other document actually carries it before deleting
it — the mere existence of a plugin's `DESIGN.md`/`PRODUCT.md` does not mean
it is an architecture document. Reversing this decision (relocating instead
of compressing) requires re-verifying, each time, that no other doc covers
the same constraints — an ongoing cost this decision was made specifically to
avoid paying repeatedly.

## Evidence

- **Cockpit's own docs carry zero engineering constraints** — `DESIGN.md`
  (visual system) and `PRODUCT.md` (brand) were checked directly before
  assuming they could absorb relocated detail; neither does. CLAUDE.md was
  compressed from 4,483 to 2,336 words by cutting stale facts, historical
  archaeology, and long sentences, while keeping every hard constraint intact
  in two new sections.
  Session `15bfe5c1-0d59-47b6-9201-02cd37bbc4f8`, entry `74d3447d-994d-4180-be6f-1a46be93d37e`, 2026-08-05.

# ADR-0008: STE-lite writing rules adopted without an approved-word dictionary

- Status: Accepted
- Date: 2026-07-27

## Context

56 instruction files (13 `SKILL.md`, 26 references, 11 agents, 6 commands;
~48k words) were candidates for rewriting in ASD-STE100 style, a controlled-
language standard combining strict writing rules with a fixed approved-word
dictionary (~900 words).

## Considered alternatives

- Full ASD-STE100, including the approved-word dictionary. Rejected: the
  dictionary excludes verbs the product depends on as literal identifiers —
  `spawn`, `distill`, `orchestrate`, `gate`, `scout` — and the flight metaphor
  (flightplan, autopilot, cockpit, waypoints) and Norse agent names
  (Lawspeaker, Runesmith, Oathkeeper, …) are not decoration; `Lawspeaker` is
  the literal string in `subagent_type: chronicle:lawspeaker`. Rewriting to
  the dictionary would break the product, not just its prose.
- Rewrite only `SKILL.md` files. Rejected: insufficient coverage of the
  56-file surface.

## Decision

Adopt STE-lite: keep ASD-STE100's writing rules — one instruction per
sentence, imperative active voice, instructions ≤20 words, condition before
instruction, warning before step, no em-dash chains, noun strings ≤3 —  and
drop the approved-word dictionary entirely. A second reason beyond product
breakage: the dictionary targets non-native human technicians; these files are
read primarily by LLMs, for which a richer vocabulary carries no comprehension
cost, while the writing-rule half reduces both token count and misreading
risk regardless of reader. The rules are written up in
`docs/ste-rewrite/STE-RULES.md`, itself written in STE-lite as a worked
example.

## Consequences

Future instruction-file authors follow `docs/ste-rewrite/STE-RULES.md`'s
writing rules without needing to avoid product identifiers, metaphor
vocabulary, or agent names that a strict dictionary would flag.

## Evidence

- **The approved-word dictionary would exclude the product's own
  identifiers** — `spawn`, `distill`, `orchestrate`, `gate`, `scout` are not
  in ASD-STE100's ~900-word list, and the flight/Norse naming scheme
  (`flightplan`, `Lawspeaker`, …) is a real `subagent_type` string, not
  rhetorical flourish. STE-lite keeps the writing-rule half only, applied
  across 56 files (~48k words), and documents itself in `STE-RULES.md`.
  Session `dba60e1c-d26b-49da-8627-bdb22ada1c7d`, entry `994577ba-661a-4483-b218-8da800bf72f2`, 2026-07-27.

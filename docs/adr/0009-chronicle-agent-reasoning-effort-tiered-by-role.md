# ADR-0009: Chronicle agent reasoning effort is tiered by role, not by model

- Status: Accepted
- Date: 2026-07-27

## Context

Chronicle's 11 agents (both Claude Code and Codex) needed a reasoning-effort
assignment.

## Considered alternatives

- Tier by model: Haiku-backed agents get `low`, Sonnet-backed agents keep the
  default. Rejected as too coarse — it ignores what each agent actually does,
  grouping pure executors and judgment-making roles together whenever they
  happen to share a model.

## Decision

Tier by role instead, in three levels:

- `low` — messenger, seer, watcher, smith, hammerbearer, runesmith: execute an
  already-decided action (run a script, report a fact, commit/tag against an
  already-confirmed plan) with no judgment involved.
- `medium` — oathkeeper, storykeeper: pure coordinators that only sequence
  child-agent spawns; not `low`, because a coordination-order mistake (a
  missed spawn, a wrong order) is expensive enough to not risk it.
- `default` (full effort) — lawspeaker, annalist, skald: perform real
  judgment or synthesis (simple/atomic decision classification, CHANGELOG
  synthesis, PR body writing).

Claude Code side uses `effort` in each agent's `.md` frontmatter
(`packages/chronicle/agents/*.md`); Codex side maps the same tiers onto
`model_reasoning_effort` in each `$CODEX_HOME/agents/chronicle/*.toml`.

## Consequences

The tiering is cross-harness and independent of which model backs an agent,
so it survives future model swaps as long as an agent's role is unchanged.
Any new chronicle agent needs its role classified into one of these three
tiers before shipping, on both harnesses.

## Evidence

- **Role, not model, determines effort tier** — 11 chronicle agents were
  classified by what they actually do (mechanical execution vs. pure
  coordination vs. real judgment/synthesis) rather than which model backs
  them, producing three tiers (`low`/`medium`/full) applied identically via
  `.md` frontmatter `effort` on Claude Code and `model_reasoning_effort` in
  Codex TOML agent configs.
  Session `main`, entry `6e0ad679-4153-49d1-934e-6b9da1decd7f`, 2026-07-27.

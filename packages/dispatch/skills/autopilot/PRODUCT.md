# Hangar

<!-- impeccable:product-schema 1 -->

Hangar is a dense dispatch board built like a ground-control manifest; it reacts against theatrical space dashboards and generic card-based SaaS.

Hangar is the visual world. **flightdeck** is the surface it dresses: the dashboard `dispatch:autopilot` serves while a plan is flying.

## Platform

web

## Users

One engineer watching a run they started, usually at night, beside the terminal that started it. They arrive with three questions about a plan in motion: **what is holding this task up**, **what starts moving when it lands**, and **what has it cost**.

flightdeck ships inside the dispatch plugin, so that engineer is not only its author — it is anyone who installed dispatch and either ran `autopilot` over a task tree or authored their own `graph.json` workflow through `deckplan`. A first-time reader has to be able to answer the three questions from the deck alone.

## Product Purpose

Render a multi-agent plan while it runs: a signalling panel of the task graph over a manifest of the agents working it.

The deck reads three things and joins them. Topology comes from either a flightplan `tasks/` tree or a `graph.json` declared before the run. Progress comes from `.flightlog/run.jsonl`, which the agents themselves append to over the `flightlog` CLI. Spend comes from the agents' own Claude Code transcripts and, when a task drove an external engine, from that engine's rollout.

Success is the reader answering all three questions without opening a transcript.

## Positioning

Progress is **reported by the agents, not inferred by a supervisor.** The orchestrating Workflow script has no filesystem access, so there is no process watching the work and guessing at its state; each agent announces itself and declares its own completion, and the deck reads what they wrote. A supervisor that inferred state would have to guess at an agent that died mid-flight; the deck instead shows the start that was never closed.

The second half is the token join. Spend is attributed per agent and per task by matching an agent's opening prompt to its transcript, and an external engine's spend is kept **beside** its driver's rather than merged into it — a cheap driver plus an expensive delegate stays legible as two figures, not one very expensive agent.

## Operating Context

- Launched as `bun flightdeck.ts --plan <absolute run directory>`. It binds `127.0.0.1` and opens a browser.
- Two run shapes: an autopilot tree under `docs/<slug>/`, and a deckplan-authored graph run under `~/.local/share/q-lab/flightdeck/<slug>/`.
- Read for long stretches, in a dark room, beside the terminal and editor that the run is happening in.
- It is one of three surfaces and owns the narrowest job. The terminal owns the run. `monitor:cockpit` owns live transcripts, the decision trail, and the wait/send bridge. flightdeck owns the picture of the plan.

## Capabilities and Constraints

- The HTTP surface is three GET endpoints — `/api/health`, `/api/tree`, `/api/events` (SSE). There is no write endpoint.
- **Read-only is a product constraint, not a gap.** Nothing on the deck can stop, retry, or edit a task. Control belongs to the terminal and to cockpit. A proposal for a write endpoint has to overturn this line first.
- **Localhost-only is a product constraint.** There is no hosted build and no shared-run view.
- No build step: `dashboard/dist/` is committed as it ships, vendored libraries included.
- Bun-only runtime. No runtime npm dependencies. petite-vue is the only vendored library.
- A run is identified by a one-line `run.id` written beside the graph before it starts. Token attribution matches an agent's **first** message, so a prompt missing the run directory or the run id yields a row with no spend — indistinguishable from an agent that used no tokens.
- A node's completion is a `state` entry in the trail. An agent's own end note is not a completion declaration.
- The daemon record is global: one launch stops whatever deck was already running. This is current behaviour, not a decision anyone has defended.

## Brand Commitments

The dispatch plugin names its skills in aviation: `preflight`, `hop`, `flightplan`, `autopilot`, `waypoints`, `deckplan`, and the `flightlog` trail. `flightdeck` belongs to that set and the name is binding. `Hangar` is the visual world's own name and belongs to DESIGN.md.

The deck is a picture of a plan, never a picture of a railway: refs stay `bucket/NN`, road labels stay bucket names, and the manifest below stays the agent fleet.

## Evidence on Hand

- Three real committed runs, each with a `.flightlog/run.jsonl` and a rendered `RUNLOG.md`: `docs/flightdeck/`, `docs/flightdeck-tokens/`, `docs/flightdeck-workflow-contract/`.
- A synthetic run for the manual browser gate: `docs/flightdeck/FIXTURE-FLIGHT.md` and `scripts/usage-fixture.ts`. It writes Claude assistant lines only and no codex rollout, so an external-engine row is covered by unit tests and has never been eyeballed against the fixture.
- The normative format lives at `references/graph-contract.md`, beside the loader that parses it, because the reader owns the format.
- There is no usage research, no analytics, and no data from anyone else's install. Future work must not invent adoption numbers, user quotes, or benchmarks.

## Product Principles

1. **The deck reports; it never commands.** Anything that changes a run belongs to the terminal or to cockpit.
2. **Absence and zero are different facts.** An unmeasured figure renders as unavailable, never as nothing spent, and a measured zero is never hidden.
3. **Declared before, appended during.** The graph is fixed before the run; the trail is append-only inside it. Nothing in flight rewrites either.
4. **A reading is attributed or it is dropped.** Spend is never spread across a plan to make a total look complete — an unjoinable codex run is discarded rather than charged to whichever task happened to be running.

## Why dark only

Dispatch runs are monitored for long stretches, often beside terminals and editors. A fixed dark ground keeps the board visually continuous with that setting and makes state changes legible without turning the shell into a theme showcase. Hangar is an operating surface, so it has no light-mode branch or theme control.

## Palette

Semantics lead; colour follows. Ground is the work area (`#0E1114`). Surface and raised surface separate operational regions (`#171B20`, `#1E242B`). Rule draws structure without depth effects (`#262C33`). Text, muted text, and faint metadata form the reading hierarchy (`#D2D8DF`, `#7C8794`, `#4C555F`).

Done is green and conclusive (`#5FA249`). Flight is the only warm active signal (`#C3843F`). Ready is a cool teal, quiet but available (`#4E97A1`). Blocked recedes into slate without disappearing (`#4F5B69`). Alert is coral, reserved for failures that need attention (`#FA6B66`). Colour always appears with a label, count, or shape.

These are the shipped values, read from `dashboard/dist/style.css`. The record previously carried an earlier, cooler set — done as `#4FB6C4` cyan against the green the deck actually renders — and the code was confirmed authoritative on 2026-08-29. Read the stylesheet, not this paragraph, when the two disagree again.

## Type

Monospace is the body face because Hangar presents identifiers, counts, state, and machine-produced records. Stable character widths make dense rows easier to compare and align. The system sans face remains available for rare prose, but the shell speaks in the same measured cadence as its data.

## Anti-goals

- No glassmorphism, no backdrop blur, no translucent panels.
- No decorative gradients. The only gradient permitted is a meter fill, and even that should be flat.
- No border radius above 4px, no pill shapes.
- No drop shadows for depth.
- No emoji as status indicators. Colour and shape carry state.
- No third accent colour. If a new state needs marking, reuse an existing colour or use shape.
- No second vendored library. petite-vue is the only one; everything else is hand-rolled or dropped.
- No purple, no violet, no neon. Night Flight owns that register; Hangar must not read as its sibling.
- No full-width hero, no marketing spacing. Density is the point.

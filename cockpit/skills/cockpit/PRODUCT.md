# Product

## Register

product

## Users

Q, piloting one or more Claude Code agents across several projects at once. The cockpit lives on a second screen, glanced at while the agent works: where is each session heading (the goal), what turns has it taken (the decision trail), what is it doing right now (the live transcript). The defining moment is `needs_your_call` — autopilot hands the stick back and Q must choose a heading. He is rarely reading every line; he is monitoring instruments and waiting for the one moment that needs him.

## Product Purpose

Cockpit is the windshield to token-atlas's rear-view mirror. Where token-atlas reflects on what already happened (spend, model mix, rhythm), cockpit looks forward: the destination you set, the course the agent is plotting toward it, and the forks where you take the controls. Success means Q can glance over, read in two seconds whether a session is on course or waiting for him, drop into the live feed when he wants detail, and answer a `needs_your_call` without leaving the seat.

## Brand Personality

Sitting in the pilot's seat of a spacecraft, flying toward a destination through deep space. Composed, in control, instrument-literate. The mood is the quiet of a night flight deck: dark cabin, lit instruments, the destination ahead. Not frantic, not idle, ready. The agent flies; you watch the heading and take the stick when it matters.

Active, not ambient. The interface should feel like a control surface you could act on at any second, not a passive screensaver. But the action lives in the content (the decisions, the feed, the call to act), while the cosmos stays atmosphere, never spectacle.

## Anti-references

Both confirmed by Q as the two things to avoid most:

- **Cheap sci-fi.** The flight-deck aesthetic is embraced (a HUD viewport, screen-styled panels, a forward warp), but executed with restraint. Reject heavy neon glow, blinking-everything, fake telemetry, holographic chrome, LCARS curves, novelty space fonts, and a hyperspace-fast starfield. Premium HUD, not a movie set.
- **Generic dark SaaS.** Pure `#000` (or near-black neutral) plus one corporate blue accent, the Vercel/Linear-clone dark template. Cockpit's dark is a tinted deep-space cosmos, and its accent is not flat blue.

Also retired: the current flat light-neutral build (the thing this redesign replaces) and any cold un-tinted gray.

## Design Principles

1. **Forward, not backward.** Every surface answers "where is this going / what does it need from me," never "what did this cost." Cost and history are token-atlas's job. Cockpit faces the windshield.
2. **Cold is autopilot, warm is your turn.** The cosmos and its cool navigational accent mean the agent is flying itself. The single warm signal color is reserved for the moment Q must act (`needs_your_call`, waiting). Color carries the one distinction that matters.
3. **Instruments over decoration.** The cockpit feel comes from honest instrument readouts — monospace figures, status LEDs, uppercase control-panel legends, tabular timestamps — not from sci-fi styling. If a thing looks like a gauge, it should be measuring something real.
4. **Content first, cosmos second.** The deep-space backdrop and stardust are atmosphere held at low intensity. The transcript and decision log must stay readable for a long session; the space never competes with the words.
5. **Glanceable in two seconds.** On-course vs needs-you must be legible from across the room — through a status LED's color and pulse, not through reading text.

## Accessibility & Inclusion

Dark theme is intrinsic to the product (deep space), so contrast on dark is the priority: target WCAG AA for body text (cool near-white starlight on tinted space surface clears AA comfortably; verify muted/faint tiers). The cool-vs-warm semantic (autopilot vs your-turn) must never rely on hue alone — pair it with the status LED's pulse motion, an explicit label, and position so color-blind users still read state. Keyboard focus uses a 2px aurora outline at 2px offset. Reduced-motion freezes the stardust drift and all status-LED pulses to static states. Stardust stays sparse and low-contrast so it never interferes with text legibility or vestibular comfort.

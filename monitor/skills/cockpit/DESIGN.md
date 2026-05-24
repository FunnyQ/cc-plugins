---
name: Night Flight
description: A deep-space flight deck for watching AI coding sessions — cold cosmos surface, cool aurora navigation accent, one warm signal reserved for "your turn".
colors:
  # Deep-space surface — Night (dark is the only theme; space is dark)
  void: "oklch(14% 0.028 278)"
  space: "oklch(18% 0.03 278)"
  hull: "oklch(22% 0.032 278)"
  hull-2: "oklch(27% 0.034 278)"
  edge: "oklch(36% 0.03 278)"
  edge-soft: "oklch(30% 0.028 278)"
  # Ink — cool starlight, never pure white
  starlight: "oklch(95% 0.008 280)"
  ink-muted: "oklch(74% 0.018 280)"
  ink-faint: "oklch(58% 0.022 280)"
  # Aurora — the cool navigation accent (autopilot / active / focus / links)
  aurora: "oklch(80% 0.13 195)"
  aurora-strong: "oklch(72% 0.15 195)"
  aurora-deep: "oklch(60% 0.13 198)"
  # Signal — the one warm color, reserved for "your turn" (needs_your_call / waiting)
  signal: "oklch(82% 0.14 70)"
  signal-strong: "oklch(75% 0.16 65)"
  # Nebula — distant horizon glow, reserved for the viewport gradient only
  nebula-violet: "oklch(42% 0.13 300)"
  nebula-indigo: "oklch(30% 0.09 285)"
  # Semantic state
  engine: "oklch(80% 0.13 195)"
  idle: "oklch(66% 0.055 200)"
  ended: "oklch(46% 0.02 280)"
  positive: "oklch(78% 0.13 165)"
  danger: "oklch(64% 0.19 25)"
typography:
  destination:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(20px, 2.4vw, 30px)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  readout:
    fontFamily: "SF Mono, ui-monospace, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
  legend:
    fontFamily: "SF Mono, ui-monospace, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.1em"
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
components:
  viewport:
    backgroundColor: "{colors.void}"
    textColor: "{colors.starlight}"
    note: "deep-space hero; faint drifting starfield + a distant nebula glow at the lower edge"
  panel:
    backgroundColor: "{colors.hull}"
    textColor: "{colors.starlight}"
    rounded: "{rounded.md}"
    padding: "0"
  panel-head:
    backgroundColor: "{colors.space}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.legend}"
    padding: "10px 16px"
  drawer-item:
    backgroundColor: "transparent"
    textColor: "{colors.starlight}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  drawer-item-active:
    backgroundColor: "color-mix(in oklch, {colors.aurora} 14%, {colors.hull})"
    textColor: "{colors.starlight}"
    note: "active session: aurora wash + a 1px aurora top/edge tick, never a thick side stripe"
  status-led:
    note: "8px disc with a 3px ambient ring. engine=aurora pulse, idle=idle steady, ended=ended dim, waiting=signal pulse"
  decision-card:
    backgroundColor: "{colors.hull}"
    textColor: "{colors.starlight}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  call-alert:
    backgroundColor: "color-mix(in oklch, {colors.signal} 12%, {colors.hull})"
    textColor: "{colors.starlight}"
    rounded: "{rounded.sm}"
    note: "needs_your_call — the one warm surface. signal-tinted fill + signal badge + signal focus on the respond controls"
  button:
    backgroundColor: "color-mix(in oklch, {colors.aurora} 14%, {colors.hull})"
    textColor: "{colors.starlight}"
    rounded: "{rounded.sm}"
    padding: "0 13px"
    height: "34px"
  button-primary:
    backgroundColor: "{colors.aurora-strong}"
    textColor: "{colors.void}"
    rounded: "{rounded.sm}"
  input:
    backgroundColor: "{colors.space}"
    textColor: "{colors.starlight}"
    rounded: "{rounded.sm}"
    note: "focus: 2px aurora outline; on a call-alert the respond input focuses signal"
  live-entry-assistant:
    backgroundColor: "color-mix(in oklch, {colors.engine} 7%, {colors.space})"
    textColor: "{colors.starlight}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
---

# Design System: Night Flight

## 1. Overview

**Creative North Star: "The Night Flight Deck"**

Cockpit is a spacecraft flight deck on a long night flight. The cabin is dark, the instruments are lit, and the destination is somewhere ahead through the windshield. You are the pilot watching an agent fly the ship toward a goal you set. Most of the time the cosmos drifts past and the instruments read green; you are monitoring, not steering. Then a fork comes, one warm light flicks on, and the controls are yours for a moment.

This is the windshield to token-atlas's rear-view mirror, and the two are deliberate opposites: token-atlas is **warm dawn looking back** at what already happened; cockpit is **cold deep space looking forward** at where you are going. Warm past, cold future. If they ever feel like the same dashboard, one of them is wrong.

The system is **Committed** on a dark, tinted-violet deep-space surface that carries the whole interface, with a single cool **aurora** accent for navigation (active, focus, links, the heading) and a single warm **signal** color held in reserve for the one moment that needs the pilot. Depth comes from tonal layering of space-tinted neutrals (Void → Space → Hull → Hull-2) and from a slow forward **warp** starfield in the HUD viewport, never from glass or shadow theatre.

The cockpit leans into a literal flight-deck aesthetic: the viewport is a **HUD** (corner reticles, thin readouts) over a forward warp, and the two instrument panels read as lit **display screens** (faint scanlines, edge vignette). The line we hold is **restraint, not abstinence**: this is premium HUD, not a movie set. The thing to reject is **cheap sci-fi** (heavy neon glow, blinking everything, fake telemetry, LCARS curves, novelty space fonts, a hyperspace-fast starfield) and **generic dark SaaS** (pure black plus one corporate-blue accent). HUD chrome is hairline-thin aurora at low opacity, every readout shows real data, the warp is a slow cruise, and the scanlines sit barely above the threshold of perception.

**Key Characteristics:**
- Deep-space surface tinted violet (hue ~278), never pure black; built from a four-step tonal ramp.
- One cool aurora accent (teal-cyan, hue ~195) for everything navigational; one warm signal (amber, hue ~70) reserved for `needs_your_call` and waiting.
- "Cold is autopilot, warm is your turn" — color carries the one distinction that matters.
- Instrument feel from monospace readouts, status LEDs, and uppercase legends, not from a sci-fi font.
- A HUD viewport (corner reticles + thin readouts) over a slow forward warp; the two instrument panels read as lit display screens.
- OKLCH everywhere; every neutral tinted cool toward hue 278; never `#000` or `#fff`.

## 2. Colors

A tinted deep-space surface lit by a single cool aurora accent, with one warm signal reserved for the pilot's turn.

### Primary
- **Aurora** (`oklch(80% 0.13 195)`): The cool navigation accent. Active/engine status, links, focus rings, the heading indicator, primary interactive chrome. Teal-cyan, deliberately off the corporate-blue axis. Restraint is the point — it means "the agent is flying."
- **Aurora Strong** (`oklch(72% 0.15 195)`): Primary-button fill (with Void text), pressed/emphasis states, hover-deepened accents.
- **Aurora Deep** (`oklch(60% 0.13 198)`): Borders and washes that need the accent hue at lower lightness on the dark surface.

### The Warm Reserve
- **Signal** (`oklch(82% 0.14 70)`): The only warm color in the system, and it appears in exactly one situation: the pilot must act. `needs_your_call` cards, the waiting status LED, the respond-control focus ring. A warm light in a cold cabin reads instantly as "your turn."
- **Signal Strong** (`oklch(75% 0.16 65)`): Pressed/emphasis on the warm reserve.

### Reserved Atmosphere
The **Nebula** gradient — a distant horizon glow used in exactly one place, the lower edge of the viewport, the way token-atlas reserves its sunrise wave for the hero.
- **Nebula Violet** (`oklch(42% 0.13 300)`) → **Nebula Indigo** (`oklch(30% 0.09 285)`) → fades into Void. A faint sense of a horizon you are flying toward. Never tiled, never repeated on chrome.

### Semantic State
Status reads as instrument LEDs; the cool/warm axis is load-bearing.
- **Engine** (`oklch(80% 0.13 195)`, = Aurora): Active/busy session — engines on, autopilot flying.
- **Idle** (`oklch(66% 0.055 200)`): Connected but quiet; a calm dim cyan-gray.
- **Ended** (`oklch(46% 0.02 280)`): Session over; faint violet-gray, recedes into the hull.
- **Waiting** (`oklch(82% 0.14 70)`, = Signal): Parked on `needs_your_call`; the warm pulse.
- **Positive** (`oklch(78% 0.13 165)`): Resolved calls, diff additions; aurora-green so it stays in the cool family.
- **Danger** (`oklch(64% 0.19 25)`): Errors, diff removals; warm red, distinct from the Signal amber.

### Neutral
Every neutral is tinted cool toward hue 278. The surface is a tonal ramp, not borders.
- **Void** (`oklch(14% 0.028 278)`): Deepest. The viewport's depth and the page base. Space text sits on Void only inside the viewport (with Starlight).
- **Space** (`oklch(18% 0.03 278)`): The main working surface and panel-head fill.
- **Hull** (`oklch(22% 0.032 278)`): Default panel and card fill — the lit instrument housing, one step up from Space.
- **Hull-2** (`oklch(27% 0.034 278)`): Raised / hover / selected wells.
- **Starlight** (`oklch(95% 0.008 280)`): Primary text. Cool near-white; clears AA on Space and Hull.
- **Ink Muted** (`oklch(74% 0.018 280)`): Secondary text, legends, timestamps.
- **Ink Faint** (`oklch(58% 0.022 280)`): Tertiary text, ended sessions, placeholder.
- **Edge** (`oklch(36% 0.03 278)`) / **Edge Soft** (`oklch(30% 0.028 278)`): The rare 1px hairlines — panel separators, control borders, transcript dividers. Never a thick colored stripe.

### Named Rules
**The Cold/Warm Rule.** Cool (aurora + the space neutrals) means autopilot: the agent is flying, you are watching. Warm (signal) means your turn, and it is reserved for `needs_your_call` and waiting only. If a warm color appears anywhere the pilot is not being asked to act, it is wrong.

**The One Accent Rule.** Aurora is the only navigational accent. Links, focus, active state, primary buttons all speak aurora. A second cool accent is rainbow puke; pull from the space neutral ramp instead.

**The Cool Tint Rule.** Never `#000` or `#fff`. Every neutral carries chroma 0.02–0.034 toward hue 278, and text is cool Starlight, never pure white. A neutral gray anywhere is a regression toward generic dark SaaS.

**The Reserved Nebula Rule.** The nebula gradient lives only at the viewport's lower edge. Tiling it, repeating it on cards, or sprinkling it as decoration turns the deck into a sci-fi set.

## 3. Typography

**Body / Headings Font:** system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`).
**Instrument Font:** system mono (`"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace`).

No web fonts. The dashboard ships with no build step and must work offline, so the type system is system sans + system mono only. This is also a feature: a novelty sci-fi display font is exactly the canned-sci-fi cliché the product rejects. The flight-deck character comes from where mono is used, not from a custom face.

**Character:** System sans keeps the destination and prose clean and credible. System mono is the instrument voice — it carries every readout that a real gauge would show: timestamps, session ids, token/line counts, status legends, code, and diffs. Mono plus uppercase legends plus tabular figures reads as a control panel without a single sci-fi flourish.

### Hierarchy
- **Destination** (system sans, 600, `clamp(20px, 2.4vw, 30px)`, line-height 1.15, letter-spacing -0.01em): The session goal in the viewport — the one heading you are flying toward. The largest voice, sitting on Void.
- **Title** (system sans, 650, 14px, line-height 1.3): Panel context and project names.
- **Body** (system sans, 400, 14px, line-height 1.5): Default reading text; transcript prose. Cap measure at 76ch in transcript bubbles.
- **Readout** (system mono, 500, 12px): Instrument values — timestamps, counts, file paths, session ids, code. Tabular numerals.
- **Legend** (system mono, 600, 10px, letter-spacing 0.1em, UPPERCASE): Panel-head labels, status legends, badges. The control-panel stencil voice.

### Named Rules
**The Instrument-Mono Rule.** Every value a gauge would display — time, counts, ids, paths, code — is mono with `tabular-nums`. Prose and headings are sans. A timestamp in a proportional font breaks the instrument read.

**The Stencil-Legend Rule.** Panel heads and status labels are uppercase mono legends with wide tracking (0.1em), the way a physical panel silk-screens its labels. Reserve this voice for chrome legends, never body text.

## 4. Elevation

No shadows, no glass. Depth is **tonal layering** of the space ramp (Void → Space → Hull → Hull-2) plus spacing and 1px hairline edges. The cabin is dark; lift is read as a panel sitting one tonal step brighter than the surface behind it, not as a drop shadow. The only motion-as-depth is the viewport starfield's slow parallax drift, which sits *behind* everything and reads as distance, not as a lifted card.

### Shadow Vocabulary
None. Glassmorphism, drop shadows, bevels, and neon glows are banned. (A status LED's ambient ring is a tight `box-shadow` used as a glow halo on an 8px disc only — it is an instrument light, not surface elevation.)

### Named Rules
**The Tonal-Lift Rule.** To raise a surface, step the ramp (Space → Hull → Hull-2), never add a shadow. A `box-shadow` with a visible blur or offset on a panel is forbidden; the LED halo is the single sanctioned exception.

**The Starfield-Is-Distance Rule.** The viewport starfield drifts slowly behind all content at low contrast to read as forward motion through space. It never overlaps text legibly, never tiles as a pattern on chrome, and freezes entirely under reduced-motion.

## 5. Components

### The Viewport HUD (signature hero — top row)
A heads-up display framing a forward warp into deep space, showing where the active session is heading.
- **Warp:** a canvas starfield (`modules/starfield.js`) where stars emanate from the viewport center and streak outward as they approach, reading as flying forward. Deliberately a slow cruise, WAY slower than a hyperspace jump. Pauses when the tab is hidden; renders one static frame under reduced-motion.
- **Beacon (the goal object):** a small aurora waypoint marker at the viewport center (the warp's vanishing point) — a slowly rotating diamond ring + a pulsing core. It *is* the destination you're flying toward.
- **Leader line:** a solid aurora underline tracing the destination box width, then a dashed, slowly-flowing connector from the underline's bottom-right corner to the beacon, like a HUD callout pointing at the waypoint it tracks. Measured live from the DOM (`modules/lead.js`, ResizeObserver) so it tracks the dynamic text width; pixel-space SVG viewBox, 1px non-scaling stroke.
- **Readouts:** `◢ HEADING [project]` pinned top-left, the session goal as a small subtitle directly beneath it, and a mono telemetry line (session id · flight count) pinned bottom-left. No corner brackets, no status badge — the cabin stays clean.
- **Nebula:** a single soft gradient glow at the lower edge.

### The Manifest (collapsed drawer — second row)
Projects and their sessions as a drawer beneath the viewport, **collapsed by default** to a single bar (the viewport already names the current flight, so the list stays out of the way until opened).
- **Bar:** a `Projects` legend + flight count + a gently pulsing aurora caret as the open affordance. Clicking expands the drawer.
- **Open:** a horizontal strip of flights. **Project:** a flight; **session:** a leg. Each carries a status LED, a goal snippet in body sans, ids/counts in mono readout.
- **Active leg:** aurora wash (`color-mix(aurora 14%, hull)`) + a full 1px aurora hairline ring (inset box-shadow) — never a thick side stripe. The drawer scrolls horizontally if flights overflow.

### Instruments (bottom row — two display screens)
- **Live Transcript** (the comms feed) and **Decision Log** (the flight log), side by side, each a Hull panel styled as a lit screen: a faint scanline overlay + edge vignette (`::after`, `mix-blend-mode: multiply`, low opacity, `pointer-events: none`), with a stencil-legend head carrying a small lit aurora power tick.
- Held barely above perception so the screen effect never fights the text. Panels separated by a 1px Edge hairline, the way two instruments sit in one housing.

### Status LED (signature instrument)
8px disc with a 3px ambient ring (the one sanctioned glow). **Engine/active** → aurora with a 1.3s scale pulse. **Idle** → steady idle cyan-gray. **Ended** → dim ended violet-gray, no ring. **Waiting** → signal amber with a slower 2.2s expanding-glow pulse. State must read from color **and** pulse, never hue alone.

### Decision Card / The Call Alert
- **Plain decision:** Hull card, mono timestamp readout, optional aurora "resolved" tick, file chips in mono.
- **`needs_your_call` (the Call Alert):** the one warm surface in the system. Signal-tinted fill (`color-mix(signal 12%, hull)`), a Signal legend badge, the respond controls (option buttons + free-text) focusing Signal. This is the warm light flicking on in the cold cabin.
- Resolved calls cool back down to a Positive (aurora-green) tick; the warmth retreats once the pilot has acted.

### Buttons / Inputs
- **Default button:** aurora wash on Hull (`color-mix(aurora 14%, hull)`), Starlight text, 34px, 6px radius, 1px Edge border, no shadow. **Hover:** wash deepens toward aurora.
- **Primary button:** Aurora Strong fill with Void text.
- **Respond option (on a Call Alert):** same shape but signal-tinted, signal border, signal focus.
- **Input:** Space fill, Starlight text, 1px Edge border; **focus:** 2px aurora outline at 2px offset (signal on a Call Alert).

### Live Transcript Entries
The transcript renderer is shared with token-atlas's markup (`live-entry` / `live-seg` / `live-code` / `live-diff`); restyle onto the space tokens.
- **Role accent (`--entry-accent`):** user → aurora; assistant → positive (aurora-green); tool/function → signal amber; system → nebula violet. Chip is a mono legend pill; bubble border + wash derive from the accent.
- **Code & diffs:** highlight.js mapped onto the space palette — keywords → nebula violet, strings/additions → positive, numbers/attrs → signal, types/tags → aurora. Diffs inline: additions on a positive wash, removals on a danger wash, hunks/meta in Ink Faint.

## 6. Do's and Don'ts

### Do:
- **Do** keep the surface a tinted deep-space ramp (Void → Space → Hull → Hull-2), every step cool toward hue 278.
- **Do** use aurora as the single navigational accent, and reserve signal warmth strictly for `needs_your_call` and waiting.
- **Do** make state read from color **and** LED pulse, never hue alone.
- **Do** put values a gauge would show (time, counts, ids, paths, code) in mono with `tabular-nums`; keep prose and headings sans.
- **Do** keep the warp a slow cruise behind content, and frozen (one static frame) under reduced-motion.
- **Do** keep HUD chrome and screen scanlines hairline-thin and low-opacity, with real data in every readout.
- **Do** convey depth by stepping the tonal ramp, never by adding shadows.
- **Do** face forward: surfaces answer "where is this going / what does it need from me," not "what did it cost."

### Don't:
- **Don't** drift into cheap sci-fi: no heavy neon glow, blinking-everything, fake telemetry, LCARS curves, novelty space display fonts, or a hyperspace-fast starfield. The HUD is premium and restrained, not a movie set.
- **Don't** drift into generic dark SaaS: no pure-black neutral, no flat corporate-blue accent. The dark is tinted cosmos; the accent is teal-cyan aurora.
- **Don't** let a warm color appear anywhere the pilot is not being asked to act.
- **Don't** use glassmorphism, drop shadows, bevels, or neon glows (the 8px LED halo is the lone exception).
- **Don't** use `#000`, `#fff`, or any untinted gray.
- **Don't** tile or sprinkle the nebula gradient; it lives only at the viewport's lower edge.
- **Don't** use `border-left`/`border-right` over 1px as a colored accent stripe on cards or list items.
- **Don't** use em dashes in UI copy.

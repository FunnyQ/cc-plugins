# Hangar — the flightdeck design system

> dispatch's own visual language. Do not borrow cockpit's Night Flight tokens or layout.
> Every value below is authoritative; write them into `style.css` as custom properties.

## The idea in one line

An aircraft instrument panel: a dark graphite ground, dense monospace readouts, and exactly two
accent colours doing semantic work — amber for what is moving, cyan for what has landed.

## Colour

Dark only. This is an operations surface watched for the length of a run, often beside a terminal.
A light theme would double the token surface and the review burden for a screen nobody reads in
daylight glare. Do not add one.

```css
:root {
  /* ground */
  --ground:    #0E1114;   /* page background — graphite, not black */
  --surface:   #171B20;   /* cards, table rows, panels */
  --surface-2: #1E242B;   /* hover, nested surface, table header */
  --rule:      #262C33;   /* hairline borders and dividers */

  /* type */
  --text:      #D6DCE2;   /* primary */
  --muted:     #7C8794;   /* labels, secondary metadata */
  --faint:     #4C555F;   /* timestamps, disabled */

  /* state — semantic, never decorative */
  --state-flight:  #F0A830;  /* amber  — in flight, the only animated state */
  --state-done:    #4FB6C4;  /* cyan   — done, passed */
  --state-ready:   #6E8CA0;  /* steel  — ready to pick up, present but quiet */
  --state-blocked: #414A55;  /* dim    — blocked, deliberately recessive */
  --state-alert:   #E05B4A;  /* ember  — hard-fail, escalation, parse error */
}
```

Rules:

- A colour must mean a state. Never introduce a colour for decoration or variety.
- Amber is scarce on purpose. If everything is amber, nothing reads as moving.
- Blocked is dimmer than muted text. A blocked task should recede, not compete.
- Ember appears only for a hard-fail, an escalation, or a tree parse error. Not for a low-but-passing
  score.

## Type

No webfonts. The type stack is system-only, so nothing is downloaded at render time.

The SPA's `vendor/` directory holds exactly one file, petite-vue, and nothing may be added beside it —
no font files, no icon set, no chart or diagram library.

```css
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
```

Monospace is the default for the whole page body. Task refs, agent labels, scores, attempt counts,
timestamps, and table data are all monospace — they align into columns, which is the entire point of
an instrument panel. Sans is reserved for section headings and the page title.

```css
--text-xs:  11px;   /* timestamps, unit suffixes */
--text-sm:  12px;   /* table body, badges */
--text-md:  13px;   /* default body */
--text-lg:  16px;   /* card titles */
--text-xl:  22px;   /* section headings — sans */
```

Line height `1.45` for prose, `1.2` for tabular rows. Letter-spacing `0.02em` on all-caps labels,
`0` everywhere else.

## Space, edges, elevation

4px base unit. Use only these steps: `4 · 8 · 12 · 16 · 24 · 32`.

```css
--radius-sm: 2px;   /* badges, meters */
--radius-md: 4px;   /* cards, panels */
```

Nothing is rounder than 4px. Soft, pill-shaped surfaces read as consumer software and fight the
instrument-panel idea.

Elevation is expressed by surface colour and a hairline border, never by shadow:

```css
border: 1px solid var(--rule);
```

Exactly one shadow is permitted, on the sticky section header only, to separate it while scrolling:
`0 1px 0 var(--rule)`.

## Layout

The page is a two-row grid, both rows visible at once. Not tabs.

```
┌──────────────────────────────────────────────────────────┐
│ title · slug · progress ring · counts        [ lanes|dag ]│  header, sticky
├──────────────────────────────────────────────────────────┤
│                                                          │
│  TASK LANES  (or dependency graph)                       │  top row, min 40vh
│  bucket columns, horizontally scrollable                  │
│                                                          │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  AGENT FLEET                                             │  bottom row, fills
│  table, newest first, in-flight pinned to top            │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- Top row and bottom row each scroll independently. The page body never scrolls horizontally; the
  bucket lanes get their own `overflow-x: auto`.
- Below 900px wide the two rows stack into one scrolling column. The fleet table drops the elapsed and
  message columns first.
- Grid: `grid-template-rows: auto minmax(40vh, 1fr) 1fr` on the page shell.

## Motion

One animation only: an in-flight row or node pulses its amber accent.

```css
@keyframes flight-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }
```

2s ease-in-out, infinite, applied to the status dot alone — never to text or a whole row, which makes
labels hard to read.

State transitions get a 150ms colour fade. Nothing slides, nothing scales, nothing bounces.

```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

This block is required, not optional.

## Components

**Status dot** — 6px square (not a circle), `--radius-sm`, filled with the state colour. Squares read
as indicator lamps; circles read as chat presence.

**Score meter** — a horizontal bar. Track `--surface-2`, fill coloured by outcome (cyan passed, ember
hard-failed, amber otherwise). A 1px `--text` tick marks the threshold position. Print the numeric
value beside it in monospace; the bar alone is never the only channel.

**Rubric breakdown** — one thin bar per dimension, width proportional to that dimension's weight, fill
proportional to its score. Dimension name in `--muted`, `--text-xs`.

**Badge** — uppercase, `--text-xs`, `0.02em` tracking, 1px border in the state colour, transparent
background, state colour text. Used for `blocked by ui/01` and for role tags.

## Anti-goals

State these in `PRODUCT.md` too. They are the difference between Hangar and generic dark-mode UI:

- No glassmorphism, no backdrop blur, no translucent panels.
- No decorative gradients. The only gradient permitted is a meter fill, and even that should be flat.
- No border radius above 4px, no pill shapes.
- No drop shadows for depth.
- No emoji as status indicators. Colour and shape carry state.
- No third accent colour. If a new state needs marking, reuse an existing colour or use shape.
- No second vendored library. petite-vue is the only one; everything else is hand-rolled or dropped.
- No purple, no violet, no neon. Night Flight owns that register; Hangar must not read as its sibling.
- No full-width hero, no marketing spacing. Density is the point.

## Accessibility

- Every state must be legible without colour: pair each dot with a text label or badge.
- Contrast: `--text` on `--surface` is 11.6:1, `--muted` on `--surface` is 5.1:1. Both clear AA.
  `--faint` is for non-essential metadata only and must never carry meaning on its own.
- Focusable elements get a 2px `--state-ready` outline with a 2px offset. Do not remove outlines.

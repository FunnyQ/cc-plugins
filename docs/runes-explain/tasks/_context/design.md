---
name: runes explain — Picture-Book Workshop
description: A cold-press watercolour sheet where an ink-and-wash drawing does the explaining and short captions point into it.
colors:
  paper: "#f3eee3"
  paper-slip: "#fbf8f1"
  ink: "#23201c"
  ink-soft: "#5b5348"
  ink-accent: "#a64a29"
  wash-warm: "#d97757"
  wash-cool: "#7da0b8"
  wash-sage: "#9bb08a"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Hiragino Sans, PingFang TC, Helvetica Neue, sans-serif"
    fontSize: "clamp(32px, 4.2cqi, 52px)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  answer:
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.45
  heading:
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.62
  small-caps-label:
    fontSize: "12px"
    letterSpacing: "0.12em"
  masthead:
    fontSize: "13px"
    letterSpacing: "0.1em"
  svg-label:
    fontSize: "16px"
spacing:
  sheet-x: "88px"
  sheet-x-narrow: "22px"
  section-gap: "64px"
  spread-gap: "56px"
components:
  slip:
    backgroundColor: "{colors.paper-slip}"
    padding: "18px 24px"
---

# Design System: runes explain

> Source of truth: `docs/runes-explain/design/mock.html`, approved 2026-10-25. Everything under its comment
> `the skeleton: everything below ships in template.html` is the template's stylesheet, copied as is, with
> the mock-only parts removed (see **Template shell**). The one rule above that comment the template keeps is the
> reset `* { box-sizing: border-box; margin: 0; }`, placed first. Open the mock beside any build of `template.html`.
> One light theme only: there is no dark mode and no `prefers-color-scheme` rule.

## Overview

A picture-book workshop page: cold-press watercolour paper with a visible tooth, an ink-and-wash drawing
pinned on the left while the words read on the right, lettered parts that light up their piece of the drawing,
and paper slips tipped onto the sheet for the analogy and the takeaway. Mode: Read. The reading column stays
calm; the paper, the washes and the slips are the world. Nothing is boxed in cards; nothing glows.

## Colors

Every colour is a custom property on `:root` in `template.html`; the fork never writes a literal colour.

| Token            | Value                    | Role                                                                     |
| ---------------- | ------------------------ | ------------------------------------------------------------------------ |
| `--paper`        | `#f3eee3`                | the sheet                                                                |
| `--paper-slip`   | `#fbf8f1`                | a lighter slip tipped onto the sheet (analogy, takeaway, compare panels) |
| `--ink`          | `#23201c`                | pen line and body text                                                   |
| `--ink-soft`     | `#5b5348`                | captions, masthead, small-caps labels (7:1 on paper)                     |
| `--ink-accent`   | `#a64a29`                | the one red-brown pen: arrows, step numbers, part letters, links         |
| `--wash-warm`    | `#d97757`                | Clawd-orange watercolour: the thing being explained                      |
| `--wash-cool`    | `#7da0b8`                | blue-grey wash: the outside, the other side, the alternative             |
| `--wash-sage`    | `#9bb08a`                | green wash: the good or finished state                                   |
| `--wash-opacity` | `.26`                    | how much pigment a wash lays down                                        |
| `--shadow`       | `rgba(70, 50, 25, .32)`  | slip shadow                                                              |
| `--vignette`     | `rgba(120, 95, 60, .14)` | sheet edge darkening                                                     |

### Named Rules

- **One pen colour.** `--ink-accent` is the only coloured line; washes are fills, never strokes.
- **Washes carry meaning, not decoration.** Warm = the subject; cool = outside/other; sage = done/good.

## Typography

System stacks only (the CSP blocks fonts): `-apple-system, BlinkMacSystemFont, "Hiragino Sans", "PingFang TC",
"Helvetica Neue", sans-serif`; code in `ui-monospace, SFMono-Regular, Menlo, monospace` at `.88em` on a
22 % `--wash-cool` tint, radius 4px.

### Hierarchy

- Title `h1`: `clamp(32px, 4.2cqi, 52px)`, 800, line-height 1.08, tracking -0.02em, max 20ch, `text-wrap: balance`.
- Answer `.answer`: 24px (21px narrow), 500, line-height 1.45, max 46ch.
- Section heading `h2`: 28px (24px narrow), 700, line-height 1.2.
- Body: 18px, line-height 1.62, paragraphs max 64ch.
- Small-caps labels (masthead 13px / slip labels 12px): uppercase, tracking 0.1–0.12em, `--ink-soft`.
- Step numbers: 38px, 800, `--ink-accent`.

## Layout

- `.sheet`: max-width 1280px, centred, padding `64px 88px 72px`; `container-type: inline-size`.
  Below 760px viewport: padding `36px 22px 44px`.
- Top-level blocks of `main` are 20px apart; a `section` is 64px from what precedes it (48px narrow).
- `.spread`: grid `minmax(0, 1.1fr) minmax(0, 1fr)`, gap 56px, `align-items: start`; its `.plate` is
  `position: sticky; top: 24px`. At container width ≤ 760px: one column, gap 20px, plate static.
- Paper: `background-color: var(--paper)` plus two images: a radial vignette
  `radial-gradient(ellipse at 50% 30%, transparent 60%, var(--vignette) 100%)` and the grain tile, an inline
  SVG data URI (`feTurbulence fractalNoise baseFrequency .7 numOctaves 3` → `feDiffuseLighting surfaceScale 1.1,
distant light azimuth 45 elevation 58`, rect opacity `.55`, 260×260), blended `normal, multiply`.
  Copy the exact URL string from the mock.

## Elevation & Depth

### Shadow Vocabulary

- Slip (`.analogy`, `.takeaway`, `.compare > div`): `0 1px 1px var(--shadow), 0 8px 18px -10px var(--shadow)`,
  rotated -0.6deg / 0.5deg / ∓0.5deg so it reads as paper laid by hand.
- Nothing else casts a shadow. No glow, no hard offset.

## Shapes

Slips are square-cornered paper. Parts rows hover with a 6px radius tint. Timeline dots are irregular
blobs (`border-radius: 48% 52% 45% 55%`). Washes in SVG are hand-drawn closed paths, never circles.

## Components

The fork writes only the inside of `<main>`, using these blocks, **in this order**: `answer` first and
exactly once; then `analogy` (optional, at most one); then one or more `section`s; then `takeaway`
(optional, last). Inside a section: `h2`, `p`, `parts`, `steps`, `compare`, `timeline`, in any order.
Class names are exact.

### answer — required, first

```html
<p class="answer">
  The fork already read the whole session, so it picks the topic itself.
</p>
```

### analogy — the everyday comparison

```html
<p class="analogy">
  Photocopying your whole notebook and handing the copy to a friend.
</p>
```

The template prints its label "Think of it like this" through `::before`; the fork writes no label.

### section — a plain section

```html
<section>
  <h2>Why it happens</h2>
  <p>…</p>
</section>
```

### spread — a section with a drawing

```html
<section class="spread">
  <figure class="plate">
    <svg viewBox="0 0 560 520">
      <title>One sentence saying what the drawing shows</title>
      …
    </svg>
    <figcaption>Plate 1. One line.</figcaption>
  </figure>
  <div class="text">
    <h2>…</h2>
    …
  </div>
</section>
```

The plate is always the first child and the text the second. Number plates `Plate 1.`, `Plate 2.` in page order.

### parts — lettered terms linked to the drawing

```html
<dl class="parts">
  <div data-part="a">
    <dt>A</dt>
    <dd><b>Transcript</b>Everything said and done in this session.</dd>
  </div>
</dl>
```

Letters `a`–`f` only (at most six parts). Every SVG element of that part carries `class="… part"` and the same
`data-part`; hovering the row dims every other `.part` in the same `section` to opacity .2 (CSS `:has()`,
no script). Label the part in the drawing with the same capital letter: `A · the session`.

### steps — numbered sequence

```html
<ol class="steps">
  <li>The mod copies the conversation into a fork.</li>
</ol>
```

### compare — before and after

```html
<div class="compare">
  <div>
    <h3>Before</h3>
    You typed the request by hand.
  </div>
  <div>
    <h3>After</h3>
    You press one button.
  </div>
</div>
```

Exactly two children. The template draws the red-brown arrow between them (a CSS mask), turned downward when narrow.

### timeline — a session recap

```html
<ol class="timeline">
  <li><time>09:40</time><b>The idea</b>One or two sentences.</li>
</ol>
```

### takeaway — required last line when present

```html
<p class="takeaway">
  The fork is the one reader that was in the room the whole time.
</p>
```

The template prints "Take this with you" through `::before`.

### SVG vocabulary (inside `.plate svg`)

| Class                                   | Use                                                        | Style                                                                     |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ink`                                   | every outline and pen line                                 | `fill: none; stroke: var(--ink); stroke-width: 2.4`, round caps and joins |
| `ink-accent`                            | arrows and the one emphasised line                         | `stroke: var(--ink-accent); stroke-width: 3.2`                            |
| `dash`                                  | add to `ink` for something absent, outside or hypothetical | `stroke-dasharray: 4 7`                                                   |
| `wash-warm` / `wash-cool` / `wash-sage` | a watercolour blob behind a part                           | fill from the token, `opacity: var(--wash-opacity)`, `filter: url(#wash)` |
| `label`                                 | a part's name                                              | `fill: var(--ink)`, 16px (24px at container ≤ 760px)                      |
| `label-soft`                            | an aside on a line                                         | `fill: var(--ink-soft)`, 14px (21px narrow)                               |
| `part` + `data-part`                    | hover linking                                              | see parts                                                                 |

Rules: every `svg` has a `viewBox` and a `<title>`; width comes from CSS (`width: 100%`), so never set
`width`/`height` attributes; draw outlines as slightly uneven paths (a hand, not a ruler); put the wash path
before the ink it sits behind; keep labels at least 24 viewBox units apart so they survive the narrow size;
no `style` attributes, no literal colours, no `<image>`, no `<foreignObject>`.

## Template shell

`template.html` is this shell plus the mock's skeleton stylesheet with `.sheet`'s tokens moved to `:root`,
the `.sheet` box-shadow removed, the body background set to the same paper so the sheet fills the window,
and the mock-only `.index` / `.specimen` rules dropped:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="{{csp}}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{title}}</title>
    <style>
      /* tokens on :root, then the skeleton rules from the mock */
    </style>
  </head>
  <body>
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
        <filter id="wash" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".035"
            numOctaves="3"
            seed="4"
          />
          <feDisplacementMap in="SourceGraphic" scale="18" />
          <feGaussianBlur stdDeviation=".6" />
        </filter>
      </defs>
    </svg>
    <article class="sheet">
      <header class="masthead">
        <span>{{project}} · explained</span><time>{{generatedAt}}</time>
      </header>
      <h1>{{title}}</h1>
      <main>{{main}}</main>
      <footer class="colophon">
        <span>Written by a fork of this session</span>
      </footer>
    </article>
  </body>
</html>
```

The mock's colophon also shows the check status on the right; the template does not, because the page is
written before the check runs. The status lives in the pane.

Motion: only the parts hover (`.25s`/`.3s cubic-bezier(.16, 1, .3, 1)`), off under
`prefers-reduced-motion: reduce`. Selection colour: 40 % `--wash-warm`.

## Do's and Don'ts

### Do:

- Put the one-sentence answer first, before any picture.
- Give every drawing lettered parts and the matching `parts` list.
- Use a wash to say which part matters, and the accent pen only for arrows.

### Don't:

- Don't add cards, borders around text blocks, kickers above headings, or emoji icons.
- Don't add a dark theme or any `prefers-color-scheme` rule.
- Don't put world material (washes, slips) behind running body text.

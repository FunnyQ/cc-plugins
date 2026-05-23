---
name: Token Atlas
description: A local dawn-lit ledger of Claude Code and Codex usage — sunrise color on a strictly flat warm surface.
colors:
  # Working surface — Dawn (light is the default theme)
  dawn-paper: "oklch(97% 0.008 60)"
  warm-ash: "oklch(94.5% 0.014 55)"
  warm-well: "oklch(92.5% 0.016 55)"
  warm-sink: "oklch(91.5% 0.022 50)"
  # Ink
  dawn-ink: "oklch(22% 0.012 60)"
  ink-muted: "oklch(48% 0.017 50)"
  ink-faint: "oklch(64% 0.014 50)"
  # Edges
  edge: "oklch(86% 0.014 50)"
  edge-soft: "oklch(91% 0.012 55)"
  border: "oklch(88% 0.014 50)"
  # Primary accent (semantic) — coral
  coral-accent: "oklch(64% 0.18 30)"
  coral-strong: "oklch(58% 0.22 28)"
  coral-soft: "oklch(92% 0.045 35)"
  # Sunrise spectrum — reserved for hero + data encoding
  sunrise-violet: "oklch(58% 0.2 305)"
  sunrise-magenta: "oklch(62% 0.22 340)"
  sunrise-coral: "oklch(64% 0.2 25)"
  sunrise-orange: "oklch(72% 0.18 50)"
  sunrise-amber: "oklch(82% 0.16 75)"
  sunrise-sky: "oklch(82% 0.07 220)"
  # Semantic state
  positive: "oklch(64% 0.16 152)"
  warn: "oklch(75% 0.16 75)"
  danger: "oklch(58% 0.21 25)"
  # On-hero text (the only near-white in the system)
  hero-white: "oklch(99% 0.005 60)"
typography:
  display:
    fontFamily: "SF Pro Rounded, SF Pro Display, -apple-system, system-ui, sans-serif"
    fontSize: "clamp(48px, 7vw, 96px)"
    fontWeight: 720
    lineHeight: 1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Fraunces, Georgia, Times New Roman, serif"
    fontSize: "18px"
    fontWeight: 680
    lineHeight: 1.2
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Fraunces, Georgia, Times New Roman, serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  "2xl": "32px"
components:
  button:
    backgroundColor: "color-mix(in oklch, {colors.coral-soft} 26%, {colors.dawn-paper})"
    textColor: "{colors.dawn-ink}"
    rounded: "{rounded.sm}"
    padding: "0 13px"
    height: "36px"
  button-hover:
    backgroundColor: "color-mix(in oklch, {colors.coral-soft} 42%, {colors.warm-ash})"
    textColor: "{colors.dawn-ink}"
    rounded: "{rounded.sm}"
  segmented-active:
    backgroundColor: "{colors.coral-accent}"
    textColor: "{colors.hero-white}"
    rounded: "4px"
    padding: "0 10px"
  panel:
    backgroundColor: "{colors.warm-ash}"
    textColor: "{colors.dawn-ink}"
    rounded: "{rounded.md}"
    padding: "18px 20px"
  card:
    backgroundColor: "{colors.warm-ash}"
    textColor: "{colors.dawn-ink}"
    rounded: "{rounded.md}"
    padding: "22px 24px 20px"
  card-hover:
    backgroundColor: "{colors.warm-sink}"
    textColor: "{colors.dawn-ink}"
    rounded: "{rounded.md}"
  badge-claude:
    backgroundColor: "color-mix(in oklch, {colors.sunrise-coral} 10%, {colors.warm-ash})"
    textColor: "{colors.sunrise-coral}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  badge-codex:
    backgroundColor: "color-mix(in oklch, {colors.sunrise-violet} 10%, {colors.warm-ash})"
    textColor: "{colors.sunrise-violet}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  table-header:
    backgroundColor: "transparent"
    textColor: "color-mix(in oklch, {colors.coral-strong} 32%, {colors.ink-faint})"
    typography: "{typography.label}"
    padding: "10px 10px"
  live-entry-assistant:
    backgroundColor: "color-mix(in oklch, {colors.dawn-paper} 88%, {colors.warm-well})"
    textColor: "{colors.dawn-ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
---

# Design System: Token Atlas

## 1. Overview

**Creative North Star: "The Kept Ledger at Dawn"**

Token Atlas is a private ledger that someone keeps by hand and reviews each morning. The numbers are exact, the columns are honest, the entries are traceable, but the whole thing sits under first light instead of fluorescent tube glare. Sunrise color crowns the page in a single bold horizon band; everything below it settles into a calm, paper-warm working surface where the developer reads spend, model mix, and project rhythm for as long as they need without fatigue. The atmosphere is California-coast dawn (the Big Sur wallpaper lineage), but it lives entirely in color and curve, never in literal sun icons, mountains, or weather metaphors.

The system is **Committed** on color and **strictly flat** on surface. The sunrise spectrum carries 30–60% of the visual weight, but only through two reserved channels: the hero band and data encodings (chart ramps, status accents, transcript role colors). Chrome, cards, dividers, and text stay flat single-color on a warm off-white. There are no shadows, no glass, no bevels, no gradients-on-everything. Depth comes from tonal layering of warm neutrals and from generous spacing, plus one signature touch: a soft cursor-tracked radial **bloom** that warms each panel as you move across it. Both light (Dawn) and dark (Dusk) themes exist; the same sunrise hues simply shift lightness and chroma.

This system explicitly rejects flat admin boilerplate, generic SaaS card grids, neon-on-black observability cliches, the hero-metric template, novelty controls that slow down reading, and consumer-app wellness warmth that erodes developer-tool credibility. The previous Nordic-mythology inflection (runes, world-trees, frost/iron/slate, cold blue) is fully retired.

**Key Characteristics:**
- Bold sunrise horizon band over a calm warm-off-white working surface.
- Strictly flat: zero shadows, zero glass, separation by spacing and tonal layering only.
- Sunrise spectrum reserved for hero + data encoding; UI chrome stays flat single-color.
- Coral is the lone semantic accent (buttons, links, focus, active states).
- OKLCH everywhere; every neutral tinted warm; never `#000` or `#fff`.
- Editorial serif (Fraunces) for headings, system sans for body, SF Pro Rounded for the hero metric.

## 2. Colors

A warm off-white working surface lit by a reserved sunrise spectrum, with coral as the single semantic accent.

### Primary
- **Coral Accent** (`oklch(64% 0.18 30)`): The lone semantic accent. Buttons, links, focus rings, segmented-control active fill, table cost figures, "recent" status dots. Its restraint is the point.
- **Coral Strong** (`oklch(58% 0.22 28)`): Pressed/emphasis variant of the accent; table header text mix, hover-deepened states.
- **Coral Soft** (`oklch(92% 0.045 35)`): Pale wash mixed into button and control fills so interactive chrome reads warm without shouting.

### Secondary
The **Sunrise Spectrum** — a six-stop perceptual ramp, reserved for the hero band and data encoding only. Categorical charts pull a curated subset (coral, amber, gold, violet, magenta) so the donut and the wave feel like one palette.
- **Sunrise Violet** (`oklch(58% 0.2 305)`): Hero start; Codex provider hint; system transcript role; the cool anchor of the ramp.
- **Sunrise Magenta** (`oklch(62% 0.22 340)`): Hero second stop; categorical chart slice.
- **Sunrise Coral** (`oklch(64% 0.2 25)`): Hero mid; user/message transcript role accent; the bloom's warm core.
- **Sunrise Orange** (`oklch(72% 0.18 50)`): Hero stop; categorical slice.
- **Sunrise Amber** (`oklch(82% 0.16 75)`): Hero warm peak; tool/function transcript role accent; the bloom's outer halo.
- **Sunrise Sky** (`oklch(82% 0.07 220)`): Hero end; the single cool resolve so the band lands soft, not garish.

### Tertiary
Semantic state colors, warmed into the sunrise lineage so up/down distinction survives without breaking palette harmony.
- **Positive** (`oklch(64% 0.16 152)`): Assistant transcript role accent, idle status dots, diff additions, growth figures.
- **Warn** (`oklch(75% 0.16 75)`): Waiting status dots, caution thresholds.
- **Danger** (`oklch(58% 0.21 25)`): Diff removals, error states, over-budget figures.

### Neutral
Every neutral is tinted warm (hue ~50–60). The surface is built from a tight tonal ramp, not borders.
- **Dawn Paper** (`oklch(97% 0.008 60)`): The working surface and base background. The page is paper at first light.
- **Warm Ash** (`oklch(94.5% 0.014 55)`): Default card and panel fill — one step up from the surface, separated by tone alone.
- **Warm Well** (`oklch(92.5% 0.016 55)`): Recessed wells, assistant bubble mix.
- **Warm Sink** (`oklch(91.5% 0.022 50)`): Card hover state; the surface a card settles into on hover.
- **Dawn Ink** (`oklch(22% 0.012 60)`): Primary text. Deep warm near-black; clears AAA on the working surface.
- **Ink Muted** (`oklch(48% 0.017 50)`): Secondary text, labels, axis ticks.
- **Ink Faint** (`oklch(64% 0.014 50)`): Tertiary text, default badge text, idle status.
- **Edge** (`oklch(86% 0.014 50)`) / **Edge Soft** (`oklch(91% 0.012 55)`): The rare 1px borders — controls, table rows, transcript dividers. Never as colored stripes.
- **Hero White** (`oklch(99% 0.005 60)`): The only near-white. Used exclusively for text on the hero band.

### Named Rules
**The Reserved Spectrum Rule.** The sunrise spectrum is allowed in exactly two places: the hero band and data encodings (chart ramps, status accents, transcript role colors). Everywhere else, chrome is flat single-color. If a button, divider, or badge is wearing more than one sunrise hue, it is wrong.

**The One Accent Rule.** Coral is the only semantic accent. Buttons, links, focus rings, and active states all speak coral. Reaching for a second accent on UI chrome is rainbow puke; pull from the neutral ramp instead.

**The Warm Tint Rule.** Never `#000` or `#fff`. Every neutral carries chroma 0.008–0.022 toward hue 50–60. A cold gray anywhere is a regression toward the retired Nordic palette.

## 3. Typography

**Display Font:** Fraunces (variable serif, opsz 9–144, wght 300–900, self-hosted) — headings only.
**Body Font:** system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`).
**Hero/Rounded Font:** SF Pro Rounded (falls back to SF Pro Display, then system) — the hero cost metric only.

**Character:** Editorial serif headings give the dashboard an atlas/cartography tone and a hand-kept-ledger seriousness; the system sans body keeps developer-tool credibility and crisp number legibility. The hero metric borrows SF Pro Rounded for dawn-warm curves on the one number that greets you. Fraunces' optical-sizing axis auto-adapts to font size, so small headings (h3) read cleaner than a fixed display cut.

### Hierarchy
- **Display** (SF Pro Rounded, 720 weight, `clamp(48px, 7vw, 96px)`, line-height 1, letter-spacing -0.02em): The hero cost metric — the single number that answers "what did it cost." Tabular numerals.
- **Headline** (Fraunces, 680 weight, 18px / `--fs-2xl`, line-height 1.2): Brand h1 in the hero band; the largest section voice.
- **Title** (Fraunces, 700 weight, 14px / `--fs-lg`, line-height 1.3): Panel headings (`.panel-head h2`). Letter-spacing 0 — tight, not airy.
- **Body** (system sans, 400 weight, 14px / `--fs-lg`, line-height 1.5): Default reading text. Live transcript prose steps up to 16px (`--fs-xl`) for long-session legibility. Cap measure at 76ch in transcript bubbles.
- **Label** (system sans, 700 weight, 10–11px / `--fs-xs`–`--fs-sm`, letter-spacing 0.06em, UPPERCASE): Badges, table headers, status pills, transcript role chips. Tabular numerals on all figures.

### Named Rules
**The Serif-Heads-Only Rule.** Fraunces appears on h1–h4 and nowhere else. Body, controls, tables, and data figures stay on the system sans. A serif number is a regression — numerals belong to the sans (or SF Pro Rounded at hero scale).

**The Tabular Number Rule.** Every figure that can change — cost, tokens, counts, percentages — uses `font-variant-numeric: tabular-nums` so columns stay aligned and numbers don't jitter as they update.

## 4. Elevation

This system uses **no shadows at all**. Surfaces are strictly flat — `--theme-shadow`, `--shadow-soft`, and `--shadow-inset` all resolve to `0 0 0 transparent`, and glass highlights are `transparent` by design. Depth is conveyed two ways: **tonal layering** of warm neutrals (Dawn Paper surface → Warm Ash cards → Warm Well recesses → Warm Sink on hover), and **spacing** (cards are separated by gaps, never borders or drop shadows). The only "lift" in the system is light, not shadow: a cursor-tracked radial **bloom** that raises each panel's warmth as the pointer approaches.

### Shadow Vocabulary
None. There is no shadow vocabulary. Glassmorphism, drop shadows, bevels, and skeuomorphism are banned.

### Named Rules
**The Flat-Surface Rule.** Surfaces never cast shadows and never use glass. If depth is needed, step the tonal ramp (Paper → Ash → Well → Sink) or add spacing. A `box-shadow` with a visible blur or offset is forbidden.

**The Bloom-Is-Light Rule.** The only response to hover/focus on a panel is the radial sunrise bloom (amber core at `oklch(82% 0.16 75 / 0.18)` → coral mid → transparent at 72%), fading in over 240ms. It is light warming paper, not a lifted card. Any new panel-shaped surface must register in both the bloom CSS selector list and the JS `SELECTOR` constant.

## 5. Components

### Buttons
- **Shape:** Gently rounded (6px, `--radius-sm`), 36px min-height, 13px horizontal padding.
- **Default:** Warm coral-soft wash — `color-mix(in oklch, --coral-soft 26%, --dawn-paper)` — 1px `--theme-edge` border, Dawn Ink text, 13px font (`--fs-md`). Flat, no shadow.
- **Hover:** Fill deepens to `color-mix(--coral-soft 42%, --warm-ash)`, border warms toward coral (`color-mix(--coral 18%, --edge)`). Transition 160ms `--ease-out`.
- **Active:** `translateY(1px)` — a 1px physical press, 120ms.
- **Disabled:** Ink Faint text, opacity 0.65, `cursor: not-allowed`.
- **On hero band:** Inverted — translucent dark fill `oklch(22% 0.012 60 / 0.32)` with Hero White text and a faint white border; hover raises both opacities.

### Segmented Controls
- **Track:** 34px tall, 3px inner padding, 6px radius, `color-mix(--coral-soft 22%, --bg-rail)` fill, 1px edge border.
- **Segment:** Transparent, Ink Muted text, 12px / 620 weight, 66px min-width, 4px radius.
- **Active:** Coral fill (`--accent`) with Hero White text. **Inactive hover:** faint coral-soft wash, Ink → text.

### Cards / Containers
- **Corner Style:** 10px (`--radius`).
- **Background:** Warm Ash (`--surface-2`), one tonal step above the Dawn Paper surface. Cards hover to Warm Sink (`--surface-3`).
- **Shadow Strategy:** None. See Elevation — flat, tonal layering only.
- **Border:** None. Cards are separated by spacing, never strokes.
- **Internal Padding:** Panels `18px 20px`; cards `22px 24px 20px`; both `overflow: hidden`, `isolation: isolate`, `container-type: inline-size`.
- **Bloom:** Each carries a cursor-tracked radial sunrise gradient via `::before`/`::after`, opacity 0 → 1 on hover (240ms), 0.85 on focus-visible.

### Inputs / Fields
- **Style:** Inherit the button baseline — 36px min-height, 6px radius, 1px `--theme-edge` border, coral-soft wash fill. Select dropdowns add `0 34px 0 11px` padding for the chevron.
- **Focus:** Global rule — 2px solid coral (`--accent`) outline, 2px offset, 6px radius. The same coral focus ring covers buttons, selects, summaries, and labels.

### Tables
- **Density:** Tight. `--fs-md` (13px) body; compact variant drops to `8px 9px` cell padding.
- **Header:** UPPERCASE, 11px (`--fs-sm`), 700 weight, letter-spacing 0.06em, text `color-mix(--accent-strong 32%, --text-faint)`.
- **Rows:** 1px bottom border `color-mix(--accent 7%, --edge-soft)`; last row's border goes transparent. Hover washes the row `color-mix(--coral-soft 22%, transparent)` (140ms).
- **Figures:** `.num` right-aligned tabular; `.cost` rendered in Coral Strong, 700 weight.

### Modal
- **Backdrop:** `--scrim` — `oklch(18% 0.03 40 / 0.5)` warm dim, `overscroll-behavior: contain`, 24px padding.
- **Panel:** `min(920px, 100dvw - 48px)` wide, `max-height: 100dvh - 48px`, scrolls internally. Inherits flat card treatment — no shadow. Used sparingly (transcript detail); inline/progressive disclosure is preferred elsewhere.

### Live Transcript Entries (Signature Component)
The transcript stream is the system's most distinctive surface. Each entry is a two-column grid (`88px` role chip + content) with a 1px top divider tinted by the entry's accent.
- **Role accent system:** each entry sets `--entry-accent` and the chip + bubble border + bubble wash all derive from it. User/message → Sunrise Coral; assistant → Positive (green); tool/function → Sunrise Amber; system → Sunrise Violet.
- **Role chip:** pill (`--radius-pill`), UPPERCASE, 11px / 740 weight, letter-spacing 0.04em, border `color-mix(--entry-accent 24%, transparent)`, fill `color-mix(--entry-accent 8%, transparent)`.
- **Content bubble:** 6px radius, `max-width: min(76ch, 100%)`, fill `color-mix(--entry-accent 7%, --surface)` (assistant uses a Warm Well mix), 16px (`--fs-xl`) prose at line-height 1.5. Wide content (tables, code) expands to full width.
- **Status dots:** 10px circles with a 3px ambient ring. Busy → coral with a 1.35s scale pulse; idle → positive; recent → coral accent; waiting → warn with an expanding-glow 2.2s pulse.
- **Code & diffs:** highlight.js mapped onto the sunrise spectrum (keywords → violet, strings → positive, numbers/tool-blocks → amber, types → orange, attributes → coral, tags → magenta). Diffs render inline: additions on a positive wash, removals on a danger wash, hunks/meta in Ink Faint.

## 6. Do's and Don'ts

### Do:
- **Do** keep the sunrise spectrum to the hero band and data encodings only (charts, status accents, transcript roles). Everywhere else, one flat color.
- **Do** use coral as the single semantic accent for buttons, links, focus rings, and active states.
- **Do** convey depth through the warm tonal ramp (Dawn Paper → Warm Ash → Warm Well → Warm Sink) and spacing, never shadows.
- **Do** tint every neutral warm (chroma 0.008–0.022, hue ~50–60). Deep warm near-black `oklch(22% 0.012 60)` for ink, warm off-white `oklch(97% 0.008 60)` for surface.
- **Do** keep Fraunces on headings only; body, controls, tables, and numerals stay on the system sans (or SF Pro Rounded at hero scale).
- **Do** use `tabular-nums` on every figure that can change.
- **Do** register any new panel-shaped surface in both the bloom CSS selector list and the JS `SELECTOR` constant.
- **Do** put the working question first: the hero is bold, the answers below it stay calm and out of the way.

### Don't:
- **Don't** apply decorative gradients to everything. The sunrise gradient is reserved for the hero band and sequential chart encodings; cards, buttons, dividers, badges, and text stay flat single-color.
- **Don't** commit rainbow puke: never wear the full sunrise spectrum on UI chrome (buttons, tabs, status pills) where one accent would do.
- **Don't** use glassmorphism, drop shadows, bevels, or skeuomorphism. The direction is bold color on strictly flat surfaces.
- **Don't** use gradient text. The hero number is solid Hero White or deep warm near-black, never `background-clip: text`.
- **Don't** drift into a pastel-everything wellness-app mood. This is a serious developer instrument framed by atmosphere.
- **Don't** reintroduce any Nordic-mythology vestige: no rune-stamped dividers, world-tree hierarchies, saga-chronology copy, frost/iron/slate language, or cold hue-224 blue tokens. That inflection is fully retired.
- **Don't** use literal sun icons, mountain illustrations, beach photography, or weather metaphors in copy. The sunrise lives in color and curve only.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe on cards, list items, or alerts.
- **Don't** reach for a modal as the first thought. Exhaust inline and progressive-disclosure alternatives first.
- **Don't** use em dashes in UI copy.

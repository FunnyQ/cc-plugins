# Product

## Register

product

## Users

Claude Code power users who want a local, private view of usage, cost, model mix, and project activity. They are usually checking spend, reviewing work rhythm, or debugging why usage changed across recent sessions.

## Product Purpose

The dashboard turns local Claude Code data into a scannable operational view. Success means users can open it, understand the current usage window in seconds, compare models and projects without reading raw JSON, and trust that the numbers are local and practical.

## Brand Personality

Warm, composed, watching the sun come up over your data. The interface should feel like the moment you step outside at dawn—bold enough to greet you, restrained enough to stay readable for hours. A serious instrument for a developer, framed by atmosphere instead of decoration.

The product name is Token Atlas. The atmosphere is California-coast dawn, after the macOS Big Sur wallpaper: organic curves of warm sunrise color (violet, magenta, coral, orange, amber, soft sky blue) crowning a calm, paper-warm working surface. The aesthetic suggests cartography of attention — the dashboard is a daily map of where tokens went, opened at first light.

## Anti-references

Avoid flat admin boilerplate, generic SaaS card grids, neon-on-black observability cliches, hero-metric template dashboards, novelty controls that slow down reading the data, and consumer-app warmth that erodes developer-tool credibility.

Hard bans:

- **Decorative gradients applied to everything.** The sunrise gradient is reserved for the hero band and sequential data encodings (charts). Cards, buttons, dividers, badges, and text stay flat single-color.
- **Rainbow puke:** using the full sunrise spectrum on UI chrome (buttons, tabs, status pills) where one accent would do.
- **Glassmorphism, drop shadows, bevels, skeuomorphism.** The new direction is bold color sitting on strictly flat surfaces.
- **Gradient text.** The hero number is large white or deep warm near-black, never gradient-clipped.
- **Pastel-everything mood** that turns the dashboard into a wellness app.
- **Nordic mythology vestiges:** rune-stamped dividers, world-tree hierarchies, saga-chronology copy, frost / iron / slate language, hue-224 cold-blue tokens. The previous inflection is fully retired.

## Sunrise Atlas Inflection

Use Big Sur dawn as atmospheric framing, not literal illustration. The dashboard borrows from horizon perspective, cartography, atmospheric layers, and the daily ritual of greeting the working day.

The visual language should suggest:

- **Horizon over ornament:** a bold sunrise wave crowns the page; everything below settles into a calm working surface
- **Warm clarity:** paper-warm off-white surface, low-chroma warm neutrals, sunrise spectrum as the only saturation
- **Restrained motifs:** organic wave curves used once at hero scale and once inside the trend chart fill — never sprinkled as decoration on cards, dividers, or icons
- **Atlas as daily ritual:** opening the dashboard feels like unfolding a map at dawn — composed, oriented, intentional
- **Local trust as kept ledger:** private data still feels measured and traceable, just under warm light instead of cold metal

No literal sun icons, mountain illustrations, beach photography, or weather metaphors in copy. The sunrise lives in color and curve, not in decoration.

## Color Strategy

Committed: the sunrise spectrum carries 30–60% of the surface through the hero band and chart encodings, while the working surface stays a single warm off-white.

Reserved roles:

- **Hero band:** full sunrise wave — violet → magenta → coral → orange → amber → soft sky blue, organic Big-Sur-style curves, bold saturation
- **Working surface:** warm off-white, around oklch(97% 0.008 60)
- **Cards:** same warm off-white as the surface, separated by spacing alone — no borders, no shadows, no fills
- **Sequential / ordinal charts:** sunrise spectrum as a perceptual ramp encoding model intensity, density, or density-over-time
- **Categorical charts:** a curated subset of the sunrise ramp — coral, amber, gold, violet, magenta — pulled from the hero so the donut and the wave feel like the same palette
- **Primary accent (semantic):** saturated coral or amber for buttons, links, focus rings; muted versions for hover
- **Text:** deep warm near-black, around oklch(22% 0.012 60) on the working surface; pure white text only on the hero band

Never use `#000` or `#fff`. Every neutral is tinted warm.

## Design Principles

1. **Put the working question first:** what changed, where tokens went, and what it cost. The hero is bold; the answers below it are calm.
2. **Use density with rhythm:** cards have generous spacing, charts have room to breathe, tables stay tight.
3. **Make local trust visible** through restrained copy and clear metadata, not privacy theater.
4. **Let color encode model, state, and intensity** through the sunrise spectrum. Never decoration.
5. **Keep the interface calm enough for repeated daily use:** the hero band sets the mood, the rest stays out of the way.
6. **Let the sunrise reference live in atmosphere, color, and curve** — not literal sun icons, mountain illustrations, or weather metaphors in copy.

## Accessibility & Inclusion

Target WCAG AA contrast on the working surface (deep warm near-black on warm off-white clears AAA for body text). On the hero band, white text needs verification on the lightest amber and soft-sky sections; reinforce with weight and size where any region falls short. Keyboard-visible focus states use a saturated coral outline at least 2px wide. Reduced-motion compatibility removes hero wave animation and chart entry transitions. Data encodings never rely on hue alone — every sequential ramp also carries lightness contrast, every categorical color pairs with a label or pattern.

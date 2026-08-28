# Hangar

Hangar is a dense dispatch board built like a ground-control manifest; it reacts against theatrical space dashboards and generic card-based SaaS.

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

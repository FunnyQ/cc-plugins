# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One developer, the only user: a former graphic designer and photographer, now a frontend and Rails developer,
who reads Chinese, English and Japanese. They press the explain button mid-session when an agent's work has
outrun what they can absorb at a glance: a concept, a solution, or a recap of the whole session.

## Product Purpose

runes is a set of switchable UI mods for Claude Code's terminal. Its `explain` rune explains what the user is looking
at, at a high-school level: plain text in a side pane, or a single-file HTML explainer with SVG diagrams when the topic
needs pictures. Success: the user gets the one-sentence answer in the first screen, and the picture makes the rest
obvious.

## Positioning

The explainer is written by a fork of the session's own full transcript, not from a pasted snippet, so it
knows the actual files, decisions and dead ends of that session.

## Operating Context

A desktop browser beside the terminal. The user opens the page right after the press, reads it once top to bottom,
and sometimes revisits it later. Each page wears one of five light themes (`picture-book`, `blueprint`,
`lab-notebook`, `editorial`, `card-table`), picked per page to fit its content; dark mode is deferred.

## Capabilities and Constraints

- One self-contained HTML file per explainer, kept under
  `~/.local/share/q-lab/runes/explain/<project>/<YYYYMMDD>-<session>/`.
- A CSP (`default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com https://font.emtech.cc;
font-src https://fonts.gstatic.com https://font.emtech.cc; img-src data:`) blocks every other fetch. Web fonts
  load from Google Fonts and emfont only; images are `data:` URIs only.
- Scripts are blocked, except a theme's own inline script admitted by its sha256 (`SCRIPT_HASHES` in
  `hooks/explain/html.ts`); only `card-table` has one, a pointer tilt for its option cards.
- A language model fills only `<main>`, from a fixed component vocabulary and colour tokens the skeleton
  defines; the skeleton is fixed.
- A hidden agent screenshots the page at 1280 and 420 wide and fixes overlapping or clipped diagram labels.

## Brand Commitments

runes lives in the terminal beside Clawd, a pixel mascot in Claude's warm orange. The button under Clawd reads
`[Explain plz!]`: the voice is playful and informal, never childish.

## Product Principles

1. Give the answer in one sentence before any detail.
2. Let the picture carry the explanation; keep prose short.
3. Define every term at first use.
4. Never read as a generic documentation site or an AI-generated landing page.

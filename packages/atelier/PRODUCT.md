# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML, CSS, and vanilla JS served by a local Bun script; no build step. Tweakpane v4 and `@tweakpane/plugin-essentials` are vendored as single-file ESM.

## Users

Q: graphic designer, photographer, frontend and Rails developer. Tunes a visual effect or animation in the middle of a coding session with an agent, judging by eye.

## Product Purpose

`atelier:tune` lets the user fine-tune a visual result through controls instead of describing numbers to an agent in chat. The agent writes a small spec; the page renders the controls; the user tunes and presses Apply; the agent receives only the final values and writes them into source. Success: the user lands the feel they want in one sitting, and the agent spends a spec in and a few lines of JSON out.

## Positioning

The controls, shell, and return path are prebuilt, so the agent never writes UI for a tuning run. Two modes: isolated (the effect in a prebuilt stage) and in-situ (the panel injected into the user's running dev-server page).

## Operating Context

- Opened from a coding agent session on `127.0.0.1`; the agent blocks on `tune.ts wait` until Apply.
- Isolated mode: one page, stage fills the space beside the panel, stage ground switchable light / dark / checker.
- In-situ mode: a floating panel inside a shadow root on an arbitrary host page; draggable, collapsible, must not clash with the host.
- Parameter count ranges from 3 to about 25, grouped in folders.
- States: idle, dirty (changed since last Apply), applied, server unreachable, spec error.

## Capabilities and Constraints

- Param types: range, number, color, select, toggle, cubic-bezier, spring (stiffness/damping/mass), duration.
- Animation bar: replay, loop, speed 0.1× / 0.25× / 0.5× / 1×.
- No runtime npm dependencies; no build step.

## Product Principles

1. The stage effect is the hero; the shell never competes with it.
2. It must not read as a generic developer tool or DevTools panel.
3. Controls must be precise to drag: long tracks, exact numeric entry, fine adjustment.
4. Apply state is always unambiguous: the user knows whether the agent has the values.

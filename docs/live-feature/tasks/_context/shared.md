# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

Token-Atlas is a local web dashboard (the `token-atlas` plugin in this marketplace) that visualizes Claude Code / Codex usage from `~/.claude/` and `~/.codex/`. The **LIVE** capability adds two new things, **Claude-only for v1**:

- **Level 1 — "Live now" panel**: a list of currently-active Claude sessions with a live status dot (busy / idle / waiting).
- **Level 2 — streaming modal**: click a session row to open a real-time stream of that session's full transcript.

LIVE is **purely additive**. The existing `/api/stats` snapshot and all current panels are untouched — LIVE is new endpoints + a new panel + a new modal layered on top. Zero re-architecture risk.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Uses `Bun.serve`, `Bun.file`, `bun:sqlite`.
- **Backend**: a single `Bun.serve` HTTP server in `token-atlas/skills/dashboard/scripts/serve-dashboard.ts`, binding `127.0.0.1` only. Data engines are plain `.ts` modules in the same `scripts/` dir (e.g. `api.ts`).
- **Frontend**: petite-vue (NOT full Vue) + Chart.js, both vendored. No build step — `token-atlas/skills/dashboard/dashboard/dist/` is committed and served as-is.
- **Storage**: none of our own — we only read local files under `~/.claude/`.

## Code style

- Use `type`, never `interface`.
- No external npm dependencies. Vendor libs live committed under `dashboard/dist/vendor/`.
- TypeScript: 2-space indent, double-quote strings, semicolons (match the existing files in `scripts/`).
- Model usage keys elsewhere in the codebase are namespaced `provider:model` (e.g. `claude:claude-opus-4-7`) — LIVE rows carry an explicit `provider` field instead.
- Authoritative source (for verification only): the existing `scripts/api.ts` and `scripts/serve-dashboard.ts`.

## File / directory layout

All paths below are relative to repo root `token-atlas/skills/dashboard/`.

- **Backend modules**: `scripts/*.ts`. LIVE adds `scripts/live.ts`. Routing lives in `scripts/serve-dashboard.ts` inside the `Bun.serve({ fetch })` handler.
- **Frontend SPA**: `dashboard/dist/`. Structure:
  - `index.html` — shell; loads `app.js` as a module.
  - `app.js` — bootstraps petite-vue: fetches `partials/dashboard.html`, recursively expands every `[data-partial]` placeholder, then `createApp({ App }).mount("#app")`, then `installBloomTracker()` + `installHeroMotionSettler()`.
  - `modules/dashboard-app.js` — exports `App()`, the single petite-vue root object (all state, getters, methods). New panel/modal state and methods go here, following the existing `selectProject` / `clearSelectedProject` / `startAutoRefresh` patterns.
  - `modules/bloom-tracker.js` — the Sunrise Bloom pointer-trail effect.
  - `partials/dashboard.html` — lists every panel as `<div data-partial="/partials/dashboard/NAME.html">`. Panels render inside `<main v-else-if="stats">`; modals/overlays are placed as siblings near the top (e.g. `project-detail.html`), outside `<main>`.
  - `partials/dashboard/*.html` — one partial per panel/modal. petite-vue directives (`v-if`, `v-for`, `@click`, `{{ }}`) bind against the `App()` scope.
  - `styles/*.css` — one sheet per concern. `style.css` cascades them via `@import url("./styles/NAME.css")`. **A new stylesheet is dead unless its `@import` line is added to `style.css`.**

### Partial loader contract

`app.js` resolves partials by `fetch(path)` then `placeholder.replaceWith(template.content)`, recursing into nested `[data-partial]`. To add a panel: (1) write the partial HTML, (2) add one `<div data-partial="...">` line in `partials/dashboard.html`. No registration elsewhere.

### petite-vue handler pattern

The whole app is one object returned by `App()` in `dashboard-app.js`. State is plain properties on the returned object; derived values are `get` accessors; actions are methods. There is no component system — markup in partials binds to this one scope. Add LIVE state (e.g. `liveSessions`, `liveError`, `streamSession`) and methods (e.g. `startLivePolling`, `openStream`, `closeStream`) as new properties/methods on that returned object.

### Auto-refresh / visibility pattern (mirror this for polling)

`startAutoRefresh()` in `dashboard-app.js` uses `window.setInterval`, guards each tick with `if (document.hidden) return;`, and stores the id in `this.refreshTimer`. Mirror this for the 3s LIVE poll. The constant `AUTO_REFRESH_MS` is imported from `dashboard-utils.js`; add a sibling `LIVE_POLL_MS = 3000` there if you want a named constant.

### Modal pattern (mirror this for the stream modal)

`project-detail.html` is the reference modal: `v-if="selectedProject"`, `class="project-detail-modal"`, `role="dialog"`, `aria-modal="true"`, `@click.self="clearSelectedProject"`, `@keydown.escape="clearSelectedProject"`, an inner `.panel` with `ref` + `tabindex="-1"`, and a Close `<button>`. Open via `selectProject(path)` which calls `lockPageScroll()`, sets the selection, then `$nextTick` focuses the dialog ref. Close via `clearSelectedProject()` which clears selection + `unlockPageScroll()`. `lockPageScroll`/`unlockPageScroll` save/restore `window.scrollY` (`this.modalScrollY`). Modal-shell CSS (scrim, layout) lives in `styles/tables-and-modal.css` under `.project-detail-modal` — reuse that class shape.

### Sunrise Bloom delight (must keep in sync)

Panel-shaped surfaces glow toward the cursor. To opt a new panel in, the class must appear in **both**:
1. the CSS selector list (`styles/panels.css`, the rule that sets up the `::before`/`::after` radial-gradient bloom), and
2. the JS `SELECTOR` const in `modules/bloom-tracker.js` (currently `".panel, .card, .budget-panel, .usage-limits-panel, .data-health-panel"`).

Miss either and the panel won't bloom (or will bloom without the visual).

### prefers-reduced-motion

Hero, bloom, and theme-transition all early-return / disable when `window.matchMedia("(prefers-reduced-motion: reduce)").matches`. Any LIVE animation (status pulse) must respect the same media query — gate the keyframes with `@media (prefers-reduced-motion: no-preference)` or disable the animation under `reduce`.

## Commit & branching style

- Base / PR target branch: `develop` (the repo's main working branch).
- Commit format: emoji + conventional, e.g. `✨ feat: add /api/live endpoint`. Match the existing log (`✨ feat:`, `🔧 release:`).
- Use `/odin-git:simple-commit` for a single logical change, `/odin-git:atomic-commit` when a task produced several. **Always confirm with Q via AskUserQuestion before committing.**
- Use `trash`, never `rm`.

## Verification baseline

Commands every task can rely on (run from repo root):

- **Run the dashboard** (port 5938, auto-opens browser): `bun token-atlas/skills/dashboard/scripts/serve-dashboard.ts`
  - Custom port / no browser: `... serve-dashboard.ts --port 9000 --no-open`
- **Stats JSON (CLI mode)**: `bun token-atlas/skills/dashboard/scripts/api.ts`
- **Install / prereq checks**: `bun token-atlas/skills/dashboard/scripts/install.ts`
- **Type-check a module**: `bun build token-atlas/skills/dashboard/scripts/live.ts --target=bun > /dev/null` (compile-only smoke; no test runner is set up for this plugin).
- Q runs their own dev server during sessions — do **not** start a long-running server for them; use `--no-open` and curl for one-shot verification, or ask Q to look.

## Decisions frozen during interview

- **Claude only for v1** — Codex LIVE is deferred to a v2 backlog. No Codex code in any LIVE task. The `provider` / `statusSource` fields exist in the row shape now only to reserve room.
- **Status is a pass-through string** — read `status` from the session file verbatim; render known values (`busy` / `idle` / `waiting`) specially and fall back to a neutral steady dot for anything else. Never crash on an unknown status.
- **`waiting` is a first-class, distinct state** — shown separately from `idle` with an amber attention treatment. It's the highest-value live signal ("a session is blocked waiting for your input/approval").
- **Do NOT import `parseSessions()` from `api.ts`** — copy the ~15-line session-read logic into `live.ts` to keep LIVE decoupled. Extract a shared helper only if a third consumer appears.
- **Per-session token/cost is out of scope for v1** — keep the first slice lean (status + stream only). Cost pulls in usage parsing + pricing + cache invalidation.
- **Privacy is acceptable as-is** — server binds `127.0.0.1`, it's the user's own local data. The stream modal carries a short, non-alarming notice: "Shows raw local transcript content."
- **Frontend formats relative time client-side** from the absolute `updatedAt`, so "3m ago" keeps ticking between 3s polls. Don't display the server-computed `ageMs` directly.
- **Stale cutoff = 10 minutes** — drop sessions whose `updatedAt` is older than ~10 min from `/api/live`.

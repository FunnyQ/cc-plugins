# PANEL-02: "Live now" panel

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-sources.md`
>
> **Depends on**: panel/01
> **Blocks**: stream/04
> **Status**: todo

## Goal

A "Live now" panel renders the active Claude sessions from `GET /api/live`, each with a status dot (busy = pulse, idle = steady, waiting = amber attention, unknown = neutral), polling every 3s with a client-side ticking "X ago" time.

## Files to create / modify

- `token-atlas/skills/dashboard/dashboard/dist/partials/dashboard/live.html` (new) — the panel markup.
- `token-atlas/skills/dashboard/dashboard/dist/partials/dashboard.html` (modify) — add the `<div data-partial="/partials/dashboard/live.html">` placeholder.
- `token-atlas/skills/dashboard/dashboard/dist/styles/live.css` (new) — panel + status-dot styles.
- `token-atlas/skills/dashboard/dashboard/dist/style.css` (modify) — add `@import url("./styles/live.css");`.
- `token-atlas/skills/dashboard/dashboard/dist/styles/panels.css` (modify) — add `.live-panel` to the bloom selector list.
- `token-atlas/skills/dashboard/dashboard/dist/modules/bloom-tracker.js` (modify) — add `.live-panel` to the `SELECTOR` const.
- `token-atlas/skills/dashboard/dashboard/dist/modules/dashboard-app.js` (modify) — add live state, polling, relative-time helper, status-class helper.

## Implementation notes

This consumes the endpoint that returns `{ sessions: LiveSession[] }` (its task is in **Depends on**). The full row shape is in `data-sources.md`.

### App state + methods (`dashboard-app.js`)

Add to the object returned by `App()`:

- State: `liveSessions: []`, `liveError: null`, `livePollTimer: null`, `nowTick: Date.now()`.
- In `mounted()`, after the existing setup, call `this.startLivePolling()` and start a 1s `nowTick` interval (so relative times re-render between 3s fetches).
- Methods:

```ts
async fetchLive() {
  if (document.hidden) return;
  try {
    const res = await fetch("/api/live");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    this.liveSessions = data.sessions ?? [];
    this.liveError = null;
  } catch (err) {
    this.liveError = err instanceof Error ? err.message : String(err);
  }
}

startLivePolling() {
  this.fetchLive();
  if (this.livePollTimer) window.clearInterval(this.livePollTimer);
  this.livePollTimer = window.setInterval(() => this.fetchLive(), 3000); // LIVE_POLL_MS
}
```

Pause on hidden tab: the `if (document.hidden) return;` guard inside `fetchLive` mirrors `startAutoRefresh`'s pattern, so the interval keeps ticking but does no work while hidden. Also re-fetch immediately on `visibilitychange` → visible so the panel isn't stale when the user returns:

```ts
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) this.fetchLive();
});
```

(Register this once in `mounted()`.)

- Relative time helper (drives the ticking label; reads `nowTick` so petite-vue re-renders each second):

```ts
liveAgo(updatedAt) {
  const ms = this.nowTick - new Date(updatedAt).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
```

Use the client-computed value, **not** the server `ageMs` (which is a stale snapshot from fetch time).

- Status-class helper (so unknown statuses degrade to neutral):

```ts
liveStatusClass(status) {
  const known = { busy: "is-busy", idle: "is-idle", waiting: "is-waiting" };
  return "live-dot " + (known[status] ?? "is-unknown");
}
```

### Panel markup (`live.html`)

A `<section class="panel live-panel">` (the `.panel` base class gives it the standard panel chrome + bloom). Sketch:

```html
<section class="panel live-panel" aria-label="Live sessions" v-if="liveSessions.length || liveError">
  <header class="live-head">
    <h2>Live now</h2>
    <span class="muted">{{ liveSessions.length }} active</span>
  </header>
  <p v-if="liveError" class="live-error">{{ liveError }}</p>
  <ul class="live-list" v-else>
    <li v-for="s in liveSessions" :key="s.id" class="live-row">
      <span :class="liveStatusClass(s.status)" :title="s.status" aria-hidden="true"></span>
      <span class="live-project">{{ s.projectName }}</span>
      <span class="live-status-label">{{ s.status }}</span>
      <span class="live-ago">{{ liveAgo(s.updatedAt) }}</span>
    </li>
  </ul>
</section>
```

Place the panel inside `<main v-else-if="stats">` in `partials/dashboard.html` — add one line: `<div data-partial="/partials/dashboard/live.html"></div>` (near the top of `<main>`, e.g. just after the overview partial, so it's prominent). The click-to-open-stream wiring is a later task; don't add it here.

### Styles (`live.css`)

- `.live-panel` — inherits `.panel`; add any LIVE-specific spacing only.
- `.live-list` — prefer CSS Grid for the rows; align dot / project / status / time.
- `.live-dot` — a small round dot; color by variant using existing theme CSS variables (look up the actual token names in `styles/base.css` — e.g. success/positive for idle, amber/warning for waiting). Variants: `.is-busy`, `.is-idle`, `.is-waiting`, `.is-unknown`.
- `.is-busy` pulses; `.is-waiting` uses an amber attention treatment (steady or a slower amber pulse — make it visually distinct from busy). `.is-idle` / `.is-unknown` steady.
- **Reduced-motion**: gate the pulse keyframes so they only animate under `@media (prefers-reduced-motion: no-preference)`; under `reduce`, the dot is a static color only.

Add the `@import url("./styles/live.css");` line to `style.css` (without it the sheet is dead).

### Bloom sync (both places)

1. In `styles/panels.css`, add `.live-panel` to the selector list that sets up the `::before`/`::after` radial-gradient bloom (find the rule that already lists `.panel, .card, .budget-panel, …`).
2. In `modules/bloom-tracker.js`, add `.live-panel` to the `SELECTOR` const (currently `".panel, .card, .budget-panel, .usage-limits-panel, .data-health-panel"`). Note: `.live-panel` also carries `.panel`, so bloom would partly work via `.panel` already — still add `.live-panel` explicitly for consistency with the documented convention.

## Acceptance criteria

- [ ] The panel renders one row per active session with project name, status text, a status dot, and a relative time.
- [ ] Dot variant matches status: busy pulses, idle steady, waiting amber/attention, unknown neutral steady.
- [ ] Relative time ticks (updates ~every second) without waiting for the next 3s fetch.
- [ ] Panel polls `/api/live` every 3s and stops doing work while the tab is hidden, refetching immediately when it becomes visible again.
- [ ] Pulse animation is suppressed under `prefers-reduced-motion: reduce`.
- [ ] `.live-panel` appears in both `panels.css` bloom selector and `bloom-tracker.js` `SELECTOR`.
- [ ] `styles/live.css` is imported from `style.css`.

## Verification

- [ ] Run `bun token-atlas/skills/dashboard/scripts/serve-dashboard.ts` (or have Q open the dashboard); the "Live now" panel lists real sessions; trigger a busy session and confirm its dot pulses, a waiting session shows amber.
- [ ] Watch one row for ~5s and confirm the "Xs ago" label increments without a network fetch (DevTools Network shows fetches only every 3s).
- [ ] Switch to another browser tab for a few seconds, return, and confirm the panel refreshes immediately and Network shows no fetches while hidden.
- [ ] Toggle OS "reduce motion" and reload → dots are static color, no pulse.

## Out of scope

- Click-to-open transcript stream — Deferred. Reason: the streaming modal is a separate task that depends on both this panel and the SSE endpoint; this task only renders the list + status.
- Per-session token / cost in the row — Deferred. Reason: out of v1 scope (needs usage parsing + pricing).

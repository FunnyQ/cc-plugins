# STREAM-04: Streaming transcript modal

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-sources.md`
>
> **Depends on**: stream/03, panel/02
> **Blocks**:
> **Status**: done

## Goal

Clicking a session row in the "Live now" panel opens a modal that streams that session's transcript live via `EventSource`, appending user / assistant / tool entries with auto-scroll, and closing the stream when the modal closes.

## Files to create / modify

- `token-atlas/skills/dashboard/dashboard/dist/partials/dashboard/live-stream.html` (new) — the modal markup.
- `token-atlas/skills/dashboard/dashboard/dist/partials/dashboard.html` (modify) — add the `<div data-partial="/partials/dashboard/live-stream.html">` placeholder as a sibling overlay (outside `<main>`, next to the existing detail modal).
- `token-atlas/skills/dashboard/dashboard/dist/modules/dashboard-app.js` (modify) — add stream state, `openStream` / `closeStream`, EventSource handling, auto-scroll.
- `token-atlas/skills/dashboard/dashboard/dist/styles/live.css` (modify) — modal-content styles (transcript list, entry rows, privacy notice).
- `token-atlas/skills/dashboard/dashboard/dist/partials/dashboard/live.html` (modify) — make each session row clickable to open the stream.

## Implementation notes

The streaming endpoint is `GET /api/stream?session=<id>` returning SSE (its task is in **Depends on**); it sends `data: <json>` events whose payload is a parsed transcript entry with a `type` field (`user` / `assistant` / tool). The session-list panel and its row markup also already exist (also in **Depends on**) — this task adds click handling to those rows. Modal shell conventions (scrim, scroll-lock, Esc/close, focus) are described in `shared.md`; reuse the `.project-detail-modal` shape from `styles/tables-and-modal.css`.

### App state + methods (`dashboard-app.js`)

Add to the object returned by `App()`:

- State: `streamSessionId: null`, `streamEntries: []`, `streamSource: null` (the `EventSource`), `streamError: null`.
- Open:

```ts
openStream(session) {
  this.closeStream();            // tear down any previous one
  this.streamSessionId = session.id;
  this.streamProjectName = session.projectName;
  this.streamEntries = [];
  this.streamError = null;
  this.lockPageScroll();         // reuse the existing scroll-lock helper
  const es = new EventSource(`/api/stream?session=${encodeURIComponent(session.id)}`);
  es.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      // endpoint may wrap as { kind, entry } or send the raw entry — handle both
      const entry = payload.entry ?? payload;
      this.streamEntries.push(entry);
      this.$nextTick(() => this.scrollStreamToBottom());
    } catch { /* ignore unparseable frame */ }
  };
  es.onerror = () => { this.streamError = "Stream interrupted — retrying…"; };
  this.streamSource = es;
  this.$nextTick(() => this.$refs.liveStreamDialog?.focus());
}
```

- Close (must stop the network stream):

```ts
closeStream() {
  if (this.streamSource) { this.streamSource.close(); this.streamSource = null; }
  if (this.streamSessionId) this.unlockPageScroll();
  this.streamSessionId = null;
}

scrollStreamToBottom() {
  const el = this.$refs.liveStreamBody;
  if (el) el.scrollTop = el.scrollHeight;
}
```

`EventSource` auto-reconnects on transient errors; `onerror` only sets a soft notice. `closeStream()` is the single teardown path (Esc, scrim click, Close button all call it).

### Modal markup (`live-stream.html`)

Mirror `.project-detail-modal`. Place outside `<main>`, sibling to the existing detail modal placeholder.

```html
<div
  v-if="streamSessionId"
  class="project-detail-modal live-stream-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="live-stream-title"
  @click.self="closeStream"
  @keydown.escape="closeStream"
>
  <section class="panel live-stream-panel" ref="liveStreamDialog" tabindex="-1" aria-label="Live transcript stream">
    <header class="live-stream-head">
      <h2 id="live-stream-title">{{ streamProjectName }}</h2>
      <button type="button" class="btn" aria-label="Close stream" @click="closeStream">Close</button>
    </header>
    <p v-if="streamError" class="live-stream-error">{{ streamError }}</p>
    <div class="live-stream-body" ref="liveStreamBody">
      <div v-for="(entry, i) in streamEntries" :key="i" :class="'live-entry is-' + (entry.type || 'unknown')">
        <span class="live-entry-role">{{ entry.type }}</span>
        <pre class="live-entry-content">{{ streamEntryText(entry) }}</pre>
      </div>
    </div>
    <footer class="live-stream-note">Shows raw local transcript content.</footer>
  </section>
</div>
```

Add a small helper `streamEntryText(entry)` to flatten an entry's message/tool payload to a display string (entries vary: `entry.message?.content` may be a string or an array of blocks; tool results carry their own fields). Keep it defensive — fall back to `JSON.stringify(entry)` for shapes you don't special-case. Don't over-engineer rich rendering for v1.

### Make rows clickable (`live.html`)

On the `<li class="live-row">`, add `@click="openStream(s)"`, `role="button"`, `tabindex="0"`, and `@keydown.enter="openStream(s)"` for keyboard access. Add a `cursor: pointer` / hover affordance in `live.css`.

### Styles (`live.css`)

- `.live-stream-panel` — reuse panel chrome; constrain height, let `.live-stream-body` scroll (`overflow-y: auto`).
- `.live-entry` — distinguish roles (`.is-user`, `.is-assistant`, `.is-tool`) using existing theme CSS variables (look up token names in `styles/base.css`).
- `.live-entry-content` — `pre` with `white-space: pre-wrap; word-break: break-word;` so long lines wrap.
- `.live-stream-note` — small, muted, low-emphasis corner notice (non-alarming).

## Acceptance criteria

- [ ] Clicking (or Enter on) a "Live now" row opens the modal for that session.
- [ ] The modal opens an `EventSource` to `/api/stream?session=<id>` and appends each received entry.
- [ ] New entries appear within ~1s of being written and the body auto-scrolls to the latest.
- [ ] Closing via Close button, Esc, or scrim click calls `closeStream()`, which calls `EventSource.close()` and unlocks page scroll.
- [ ] Opening a second session closes the previous stream first (no leaked `EventSource`).
- [ ] The privacy notice "Shows raw local transcript content." is visible in the modal.
- [ ] Modal has `role="dialog"`, `aria-modal="true"`, focuses its dialog on open, and locks page scroll while open.

## Verification

- [ ] With the dashboard open and a live Claude session running, click its row → modal opens showing the backlog; type a prompt in that Claude session and confirm the new turn appears in the modal within ~1s and the view scrolls to it.
- [ ] Close the modal, then in DevTools Network confirm the `/api/stream` EventSource connection is closed (no longer pending).
- [ ] Open session A, then without closing open session B → confirm only one `/api/stream` connection is active (A's is closed).
- [ ] Press Esc and click the scrim → both close the modal and stop the stream.

## Out of scope

- Rich rendering of tool calls / markdown / syntax highlighting — Deferred. Reason: v1 shows raw entry text; pretty rendering is a follow-up.
- Resume from last byte offset on reconnect — Deferred. Reason: the endpoint re-sends backlog on reconnect, acceptable for v1.
- Per-session token / cost display in the modal — Deferred. Reason: out of v1 scope.

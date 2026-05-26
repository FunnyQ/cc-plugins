# UI-01: Send box (UI → agent)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: backend/01, backend/03
> **Status**: in-progress

## Goal

A send box in the cockpit session view that delivers a typed message to the live
session, enabled only when that session has a live channel.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/index.html` (modify) — markup for the send box.
- `packages/monitor/skills/cockpit/dashboard/dist/app.js` (modify) — send handler + state.
- `packages/monitor/skills/cockpit/dashboard/dist/style.css` (modify) — styling, matching the existing design system.
- Possibly a `dashboard/dist/modules/*.js` (modify) — if the session view lives in a module.

## Implementation notes

No build step — edit the committed `dist/` files directly with petite-vue. Match
the existing markup/CSS idioms (look at how the decision-log respond form and
other panels are structured in `index.html` / `modules/` and reuse classes).

### Token

Fetch the daemon token once via `GET /api/token` (the dashboard already does this
for `/api/respond` — reuse the same cached-token approach). Never hardcode it.

### Send

```js
async function sendMessage(sessionId, text) {
  const token = await getToken();           // existing cached-token helper
  const r = await fetch("/api/send-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: sessionId, text, token }),
  });
  return r.json(); // { delivered: boolean }
}
```

- On send: clear the textarea, optimistic-disable while in flight. The user's own message will also appear in the transcript (the `<channel>` injection) — don't double-render it locally unless you want an immediate echo; if you echo, mark it pending until the transcript confirms.
- Enter to send, Shift+Enter for newline (match the respond form's behavior).

### Gating

Read the session's `channel` boolean from `/api/sessions` (the backend exposes it per session — true when a live channel client is connected):

- `provider === "claude" && channel === true` → send box enabled.
- Codex provider → disabled, tooltip "Codex has no channel — observe only".
- Claude but `channel === false` (session not launched with the channel) → disabled, tooltip "Launch this session with the cockpit channel to chat (see README)".

## Acceptance criteria

- [ ] A send box renders in the session view, styled consistently with existing panels.
- [ ] Sending posts `/api/send-message` with the session + token and clears the input on success.
- [ ] Enter sends; Shift+Enter inserts a newline.
- [ ] The box is enabled only for Claude sessions with `channel === true`; disabled with an explanatory tooltip for Codex and for channel-less Claude sessions.
- [ ] No hardcoded token; uses the existing `/api/token` flow.

## Verification

- [ ] Manual: with a live channel session, type a message + Enter → it lands in the session transcript (visible in the cockpit transcript view) and the input clears.
- [ ] Manual: open the dashboard for a Codex session → send box disabled with tooltip.
- [ ] Manual: a Claude session opened without the channel → send box disabled with the "launch with channel" tooltip.

## Out of scope

- Showing the agent's reply — a separate UI task (the reply strip) owns it.
- Any new persistence — the message is delivered via the daemon; the transcript renders it.

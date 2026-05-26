# UI-02: Reply strip (agent → UI)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: backend/02
> **Status**: done

## Goal

A dedicated strip in the cockpit session view that shows messages the agent sends
via the `reply` tool, live — so Q sees the agent address him without scanning the
full transcript or switching to the terminal.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/index.html` (modify) — markup for the reply strip.
- `packages/monitor/skills/cockpit/dashboard/dist/app.js` (modify) — subscribe to the reply SSE.
- `packages/monitor/skills/cockpit/dashboard/dist/style.css` (modify) — styling.

## Implementation notes

No build step — edit `dist/` directly. The reply strip is a small, prominent area
near the send box ("agent → you"), distinct from the dense transcript.

### Subscribe to the reply SSE

```js
async function openReplyStream(sessionId) {
  const token = currentToken;               // from the existing /api/token flow
  const { ticket } = await fetch("/api/reply-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: sessionId, token }),
  }).then((r) => r.json());
  const es = new EventSource(`/api/reply/stream?session=${sessionId}&ticket=${ticket}`);
  es.onmessage = (e) => {
    const { text } = JSON.parse(e.data);    // { text: "..." }
    appendReply(text);
  };
  return es;                                // close it when switching sessions
}
```

- `EventSource` can't set headers, so the UI uses the existing token flow only to POST for a short-lived `/api/reply-ticket`; the EventSource URL carries that ticket, not the daemon token.
- Append each reply with a timestamp; keep a bounded list (e.g. last ~50) so a long session doesn't grow unbounded in the DOM.
- Close the stream when the user navigates away from the session (avoid leaking EventSources, mirror how the transcript/log streams are opened/closed in `app.js`). On stream errors, refresh the daemon token and mint a new ticket before reconnecting.

### Relationship to the transcript

The reply also appears in the transcript (it's a `reply` tool call). This strip is
the *focused* view; do not try to de-dupe against the transcript. (Open question
recorded in the master plan: if the transcript turns out to render replies well,
this strip could instead filter the transcript stream — but default to the
dedicated reply SSE, which is simplest and matches the backend reply-fanout endpoint.)

## Acceptance criteria

- [x] A reply strip renders in the session view, visually distinct from the transcript, styled consistently.
- [x] It subscribes to `/api/reply/stream` for the current session and appends each `{ text }` live.
- [x] The EventSource is closed when switching away from the session (no leak).
- [x] The list is bounded (old entries dropped past a cap).
- [x] Uses the existing token flow; no hardcoded token.

## Verification

- [x] Manual: with a channel session, get the agent to call `reply` (e.g. send it a UI message asking it to reply) → the text appears in the strip within ~1s.
- [x] Manual: `curl -XPOST localhost:5858/api/reply -d '{"session":"<id>","text":"ping","token":"<t>"}'` → "ping" appears in the strip.
- [x] Switch sessions in the UI and back → no duplicate/leaked streams (check the network panel).

Verification note: real Claude channel testing called `mcp__cockpit-channel__reply`
successfully, and a headless Chrome/CDP dashboard run POSTed `reply strip probe
cdp 2` to `/api/reply` and observed it render in `.reply-strip__text`. The store
closes the active EventSource on selection change/beforeunload, keys streams by
provider/session to avoid duplicates, caps replies at 50, and refreshes the
daemon token on stream errors.

## Out of scope

- The send box (UI → agent) — a separate UI task owns it.
- Persisting replies — ephemeral display only; the transcript is the record.

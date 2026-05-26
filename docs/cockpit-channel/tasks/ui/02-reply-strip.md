# UI-02: Reply strip (agent → UI)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: backend/02
> **Status**: in-progress

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
function openReplyStream(sessionId) {
  const token = currentToken;               // from the existing /api/token flow
  const es = new EventSource(`/api/reply/stream?session=${sessionId}&token=${token}`);
  es.onmessage = (e) => {
    const { text } = JSON.parse(e.data);    // { text: "..." }
    appendReply(text);
  };
  return es;                                // close it when switching sessions
}
```

- `EventSource` can't set headers, so the token goes in the query string (the endpoint accepts it there — see api-contract). The daemon is loopback-only.
- Append each reply with a timestamp; keep a bounded list (e.g. last ~50) so a long session doesn't grow unbounded in the DOM.
- Close the stream when the user navigates away from the session (avoid leaking EventSources, mirror how the transcript/log streams are opened/closed in `app.js`).

### Relationship to the transcript

The reply also appears in the transcript (it's a `reply` tool call). This strip is
the *focused* view; do not try to de-dupe against the transcript. (Open question
recorded in the master plan: if the transcript turns out to render replies well,
this strip could instead filter the transcript stream — but default to the
dedicated reply SSE, which is simplest and matches the backend reply-fanout endpoint.)

## Acceptance criteria

- [ ] A reply strip renders in the session view, visually distinct from the transcript, styled consistently.
- [ ] It subscribes to `/api/reply/stream` for the current session and appends each `{ text }` live.
- [ ] The EventSource is closed when switching away from the session (no leak).
- [ ] The list is bounded (old entries dropped past a cap).
- [ ] Uses the existing token flow; no hardcoded token.

## Verification

- [ ] Manual: with a channel session, get the agent to call `reply` (e.g. send it a UI message asking it to reply) → the text appears in the strip within ~1s.
- [ ] Manual: `curl -XPOST localhost:5858/api/reply -d '{"session":"<id>","text":"ping","token":"<t>"}'` → "ping" appears in the strip.
- [ ] Switch sessions in the UI and back → no duplicate/leaked streams (check the network panel).

## Out of scope

- The send box (UI → agent) — a separate UI task owns it.
- Persisting replies — ephemeral display only; the transcript is the record.

# UI-01: Permission modal

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/protocol.md`
>
> **Depends on**: backend/01
> **Blocks**: ui/02
> **Status**: todo

## Goal

A reusable modal in the cockpit dashboard that opens on a permission request,
shows the tool and its input, captures Allow/Deny, posts the verdict, and
**always closes cleanly** — on own-verdict, on a `resolved` event, or on a TTL
fallback (no zombie cards).

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/modules/permission-modal.js` (new)
  — the modal: SSE subscription, render, verdict POST, auto-close lifecycle.
- `packages/monitor/skills/cockpit/dashboard/dist/index.html` (modify) — mount the
  modal markup + import the module.
- `packages/monitor/skills/cockpit/dashboard/dist/style.css` (modify) — modal styles
  (own block; do not restyle existing panels).

## Implementation notes

### Reusable shape

Build the modal as a **self-contained, content-agnostic overlay** (title, body
slot, action buttons, close lifecycle) with the permission-specific content passed
in — so a later effort can reuse it for `needs_your_call` without touching the
existing `needs_your_call` flow. Do not hard-wire it to the `awaitingCall` HUD;
it may *echo* that visual language (the "your turn" glow) but owns its own DOM.

### Data source

Subscribe to `GET /api/permission-stream?session=<selectedSessionId>&token=<t>`
(token comes from the existing `/api/token` the SPA already fetches). Frames:

```jsonc
{ "type": "request",  "request_id": "abcde", "tool_name": "Bash",
  "description": "Run `npm test`", "input_preview": "npm test" }
{ "type": "resolved", "request_id": "abcde", "source": "ui" | "elsewhere" }
```

On a `request` frame, open the modal showing `tool_name` (heading),
`description`, and `input_preview` (monospace block, it's a JSON/command preview).

### Verdict

Allow / Deny buttons POST:
`POST /api/permission-verdict { session, token, request_id, behavior: "allow"|"deny" }`.
Disable the buttons immediately after a click (prevent double-submit); close on
the server's 200 (or on the matching `resolved` frame, whichever lands first).

### Auto-close lifecycle (the core requirement)

Close the modal when **any** of these occur, matched by `request_id`:

1. **Own verdict** — the user clicked Allow/Deny and the POST succeeded.
2. **`resolved` frame** — `source:"ui"` (another tab answered) or
   `source:"elsewhere"` (the channel forwarded a cancel, if such a notification
   exists). Show a brief "已在別處處理" note when `source:"elsewhere"`.
3. **TTL fallback** — if neither arrives within a ceiling (default 90s, make it a
   module constant), dim the modal to a "可能已在別處處理" state and auto-dismiss.
   This guarantees no zombie card even when no `resolved` signal ever comes (the
   undocumented terminal/hook case — see protocol.md).

Why TTL is mandatory: Q runs a `PreToolUse` auto-approve hook, so requests are
frequently resolved outside cockpit; the protocol does not guarantee a cancel
notification, so the UI cannot rely on one.

### Petite-vue wiring

Follow the existing module pattern (`modules/transcript.js`, `decision-log.js`):
export a factory that registers reactive state on the petite-vue app scope; mount
under the existing viewport. Keep the EventSource lifecycle tied to the selected
session (re-subscribe on session switch, close on unmount/hidden as the other
streams do).

## Acceptance criteria

- [ ] A `request` frame opens a modal showing tool name, description, and the
      input preview (monospace).
- [ ] Allow posts `behavior:"allow"`, Deny posts `behavior:"deny"`; buttons disable
      on click; the modal closes on success.
- [ ] The modal auto-closes on a `resolved` frame even if the user never clicked.
- [ ] The modal auto-dismisses via TTL if no verdict and no `resolved` arrive.
- [ ] Switching the selected session re-subscribes the stream; no leaked EventSource.
- [ ] The modal component takes its content via props/state (reusable), not
      hard-coded to permission fields in its shell.

## Verification

- [ ] Run the daemon and, with `curl`, `POST /api/permission-request` for the
      selected session; confirm the modal opens in the browser.
- [ ] Click Allow → confirm `POST /api/permission-verdict` fires (network tab) and
      the modal closes.
- [ ] `POST /api/permission-resolved` for the open request → confirm the modal
      auto-closes with the "已在別處處理" note.
- [ ] Open a request and wait out the TTL → confirm auto-dismiss.

## Out of scope

- Browser notification + tab title flash / badge — deferred to the attention task.
  Reason: the modal must be usable on its own before attention layering.
- Migrating `needs_your_call` to this modal — deferred (build reusable, migrate later).

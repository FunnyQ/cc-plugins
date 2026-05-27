# UI-02: Attention — notification, title flash, badge

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/protocol.md`
>
> **Depends on**: ui/01
> **Blocks**: none
> **Status**: todo

## Goal

Pull the user back to cockpit when a permission request arrives, since the agent
hard-blocks until answered: a browser notification, a flashing tab title, and a
favicon badge — all cleared when the request closes.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/modules/attention.js` (new) —
  notification + title-flash + favicon-badge helpers.
- `packages/monitor/skills/cockpit/dashboard/dist/modules/permission-modal.js`
  (modify) — call attention on open, clear it on every close path.

## Implementation notes

This layers on the modal's open/close lifecycle: attention is *raised* when a
`request` opens the modal and *cleared* on every close path (own-verdict,
`resolved`, TTL). Drive it from the modal module (`permission-modal.js`) so there
is a single close path to hook.

### Browser notification (Notification API)

- On the **first** permission request, call `Notification.requestPermission()`
  (one-time). Cache the result; never re-prompt.
- If granted, on a new request show
  `new Notification("Tool permission needed", { body: \`${tool_name}: ${description}\`, tag: request_id })`.
  Use `tag: request_id` so re-renders coalesce. Clicking it `window.focus()`es.
- If denied/unsupported, **degrade silently** to title flash + badge only. Never
  hard-depend on notifications.

### Tab title flash + favicon badge

- Only when the tab is **hidden** (`document.visibilityState === "hidden"`) or
  otherwise not focused — don't flash a title the user is already looking at.
- Flash: alternate `document.title` between the real title and e.g.
  `"🔔 Permission needed"` on an interval; restore the original title on clear.
- Favicon badge: draw the existing favicon onto a canvas with a small dot/count
  and swap the `<link rel="icon">` href; restore the original on clear. Keep the
  original href so restore is exact.
- Clear all of the above the moment the modal closes (any path) and on
  `visibilitychange` to visible (stop flashing once the user is back).

### Lifecycle

```ts
// attention.js exports
export function raiseAttention(req: { request_id, tool_name, description }): void;
export function clearAttention(request_id: string): void;
```

Idempotent: raising twice for the same `request_id` is a no-op; clearing an
unknown id is a no-op. If multiple requests ever overlap (unlikely — Claude
serializes), the badge reflects the count and clears when the last closes.

## Acceptance criteria

- [ ] First request triggers a one-time `Notification.requestPermission()`; the
      result is cached and never re-prompted.
- [ ] With permission granted, a new request shows a browser notification tagged by
      `request_id`; denied/unsupported degrades to title + badge with no error.
- [ ] Title flashes and a favicon badge shows only while a request is pending and
      the tab is hidden/unfocused; both restore exactly on close or on refocus.
- [ ] Every modal close path (own-verdict, `resolved`, TTL) clears attention.

## Verification

- [ ] Run the daemon, background the cockpit tab, `POST /api/permission-request`,
      and confirm the OS notification + the flashing title + the favicon badge.
- [ ] Answer/await-close and confirm the title and favicon restore to their
      originals and no flashing interval is left running.
- [ ] Deny notification permission in the browser and confirm a request still
      flashes the title/badge without throwing.

## Out of scope

- The modal rendering and verdict round-trip — handled by the modal task.
- Sound/audio cues — not requested; add only if asked later.

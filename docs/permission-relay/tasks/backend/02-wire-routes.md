# BACKEND-02: Wire permission routes into the daemon

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/protocol.md`
>
> **Depends on**: backend/01
> **Blocks**: channel/01, ui/01
> **Status**: done

## Goal

Register the permission broker's endpoints in the daemon's request router so the
channel and the UI can reach them on `127.0.0.1:5858`.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit-server.ts` (modify) — import the
  handlers from `./permission` and add their route lines to `fetch(req)`.

## Implementation notes

The router is a flat list of `if (url.pathname === "/api/...") return handleX(req);`
checks inside `Bun.serve({ ... fetch(req) { ... } })`. Add the new routes next to
the existing `/api/inbox` / `/api/send-message` lines, before the
`return serveStatic(url.pathname);` fallback. Import shape mirrors the existing
`import { handleInbox, handleSendMessage } from "./inbox";`.

```ts
import {
  handlePermissionRequest,
  handlePermissionStream,
  handlePermissionVerdict,
  handlePermissionPull,
  handlePermissionResolved,
} from "./permission";

// inside fetch(req), alongside the other /api routes:
if (url.pathname === "/api/permission-request") return handlePermissionRequest(req);
if (url.pathname === "/api/permission-stream") return handlePermissionStream(req);
if (url.pathname === "/api/permission-verdict") return handlePermissionVerdict(req);
if (url.pathname === "/api/permission-pull") return handlePermissionPull(req);
if (url.pathname === "/api/permission-resolved") return handlePermissionResolved(req);
```

No change to `idleTimeout` (already 255s, which covers the new long-poll). No CORS
or binding changes — the server already binds `127.0.0.1`.

## Acceptance criteria

- [x] All five permission endpoints are routed in `cockpit-server.ts`.
- [x] The routes sit before the static-file fallback so they aren't shadowed.
- [x] No existing route is altered or reordered in a way that changes behavior.

## Verification

- [x] Start the daemon: `bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts`.
- [x] `curl -s "localhost:5858/api/permission-stream?session=<uuid>&token=<bad>"`
      returns a 401 JSON body (proves the route is wired and auth runs), where the
      token is read from `~/.cockpit/daemon.json`.
- [x] `bun test packages/monitor/skills/cockpit/scripts/` stays green.

## Out of scope

- The handler logic itself — implemented and tested separately in `permission.ts`.

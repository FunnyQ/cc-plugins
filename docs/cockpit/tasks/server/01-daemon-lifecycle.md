# SERVER-01: Daemon lifecycle

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: kernel/01
> **Blocks**: server/02, server/04
> **Status**: done

## Goal

A single global Bun daemon that serves the static SPA on `127.0.0.1:5858`, reuses an already-running instance via a PID file, and exposes a route table the later endpoints plug into.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/serve-dashboard.ts` (new) — the daemon.

## Implementation notes

Copy the skeleton from `cc-plugins/token-atlas/skills/dashboard/scripts/serve-dashboard.ts` and adapt. Keep `parsePort`, `killPort`, `mimeFor`, `isInsideDist`, `serveStatic` (see engine-reuse.md for signatures).

### PID-file reuse (`~/.cockpit/daemon.json`)

Before binding:

1. Read `~/.cockpit/daemon.json` (`{ pid, port, token }`) if present.
2. Probe with `process.kill(pid, 0)`:
   - succeeds → a daemon is alive; print its URL and **exit** (reuse, don't double-bind).
   - throws `ESRCH` → stale; continue to bind.
3. After binding, write `~/.cockpit/daemon.json` with this process's `pid`, chosen `port`, and a fresh random hex `token` (`crypto.randomUUID()` or `crypto.randomBytes(16).toString("hex")`). Create `~/.cockpit/` if missing.

```ts
type DaemonInfo = { pid: number; port: number; token: string }
```

### Server

```ts
const port = parsePort() // default 5858
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const url = new URL(req.url)
    // endpoints added by later tasks:
    // if (url.pathname === "/api/projects") return handleProjects()
    // if (url.pathname === "/api/sessions") return handleSessions()
    // if (url.pathname === "/api/log/stream") return handleLogStream(req)
    // if (url.pathname === "/api/transcript/stream") return handleTranscriptStream(req)
    return serveStatic(url.pathname) // serves cockpit/.../dashboard/dist/
  },
})
```

- Static root = the plugin's `dashboard/dist/`; confine with `isInsideDist`.
- Support `--port <n>` and `--no-open` flags (mirror token-atlas). Auto-open the browser unless `--no-open`.
- Bind `127.0.0.1` only.

## Acceptance criteria

- [x] `bun serve-dashboard.ts` binds `127.0.0.1:5858` and serves `dashboard/dist/index.html` at `/`.
- [x] `~/.cockpit/daemon.json` is written with `{pid, port, token}` after a successful bind.
- [x] Starting a second instance while the first is alive **reuses** it (prints URL, exits) rather than erroring on the port.
- [x] Killing the daemon then starting again rebinds (stale PID detected via `process.kill(pid,0)` throwing).
- [x] `--port` and `--no-open` flags work.
- [x] Unknown routes fall through to static serving, confined to `dashboard/dist/`.

## Verification

- [x] `bun .../serve-dashboard.ts --no-open &` then `curl -s -o /dev/null -w "%{http_code}" localhost:5858/` returns `200`; `jq . ~/.cockpit/daemon.json` shows the running pid/port/token. (Q runs/stops the daemon; sub-agent uses a short-lived run + curl.)
- [x] Run a second `bun .../serve-dashboard.ts --no-open` → it reports reuse and exits 0.

## Out of scope

- `/api/*` handlers — Deferred to the later server and bridge tasks (this task only wires the route fall-through + static serving).
- Using the token to authenticate requests — the bridge endpoints consume it; this task only generates + stores it in `daemon.json`.

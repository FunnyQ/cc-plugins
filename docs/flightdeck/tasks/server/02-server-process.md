# SERVER-02: the server process

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/01, ui/01
> **Blocks**: server/03, server/04
> **Status**: todo

## Goal

The long-lived half of the daemon: a Bun server bound to `127.0.0.1:5757` that serves the committed SPA
through the existing static module, records itself so a launcher can find it, and shuts down cleanly.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/daemon-record.ts` (new) — the record's shape, path, and
  read/write/remove helpers.
- `packages/dispatch/skills/autopilot/scripts/daemon-record.test.ts` (new) — round-trip and path tests.
- `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` (new) — the server and its `--serve` entry.
- `packages/dispatch/skills/autopilot/scripts/flightdeck.test.ts` (new) — route wiring tests.

## Implementation notes

### Nothing runs on import

Every side effect lives behind an `import.meta.main` guard at the bottom of the file:

```ts
if (import.meta.main) {
  main().catch((err) => {
    console.error("flightdeck error:", err.message);
    process.exit(1);
  });
}
```

This is not cosmetic. Later work imports this module's exported helpers from a test file, and an
unguarded `main()` would parse the test runner's arguments, touch the record file, bind the port, and
open a browser during `bun test`. It also matches the sibling scripts in this plugin, which all use this
shape.

### The record

The server writes a record so a separate launcher process can discover it. Keep the shape and its I/O in
their own module — the launcher imports the same definitions, and a second copy would drift.

```ts
export type DaemonInfo = {
  pid: number;
  port: number;
  /** Absolute path of the scripts dir this daemon was launched from. */
  root: string;
  /** Absolute path of the plan dir it is serving. */
  plan: string;
};

export function recordPath(): string;                       // XDG-aware
export function readRecord(): Partial<DaemonInfo> | null;   // null when absent or unparseable
export function writeRecord(info: DaemonInfo): void;
export function removeRecord(): void;
```

The record lives at `~/.local/share/q-lab/flightdeck/daemon.json`, honouring `XDG_DATA_HOME` when set.
Create the directory if absent. Write it **only after a successful bind** — a record written first would
advertise a daemon that never came up.

`readRecord` returns null rather than throwing on a corrupt or truncated file. A half-written record from
a killed process must not stop the next launch.

### The `--serve` entry

```
bun flightdeck.ts --serve --plan <absolute path> [--port N]
```

This mode binds and stays in the foreground. It is what a launcher spawns; a person normally does not run
it directly. Validate that `--plan` is absolute and that it holds a `tasks/` child, exiting `2` otherwise.

### Wiring the static module

Static serving already exists as its own module, exporting an async `serveStatic(root, pathname)`. Call
it for every request that is not an API route. Do not reimplement path resolution, containment, or MIME
mapping here — that logic is tested in its own file, and a second copy would drift.

Resolve the dist root once at module scope as `resolve(import.meta.dir, "..", "dashboard", "dist")` — it
is a sibling of the scripts directory, not a child.

### Binding and shutdown

Bind `127.0.0.1` explicitly. Never `0.0.0.0`. If the port is already taken, exit non-zero with a message
naming it rather than retrying — deciding what to do about a busy port is the launcher's job, not this
process's.

Remove the record on `SIGINT` and `SIGTERM` so a clean stop does not leave a stale entry that makes the
next launch try to supersede a dead pid.

## Acceptance criteria

- [ ] Importing the module runs nothing; all side effects sit behind an `import.meta.main` guard.
- [ ] `--serve` requires an absolute `--plan` holding a `tasks/` child, exiting `2` otherwise.
- [ ] The server binds `127.0.0.1` only.
- [ ] A busy port makes the process exit non-zero with a message naming it; it does not retry.
- [ ] The record is written only after a successful bind, at the XDG-aware path.
- [ ] `readRecord` returns null for an absent, corrupt, or truncated record rather than throwing.
- [ ] Non-API requests are delegated to the existing static module; no path or MIME logic is duplicated.
- [ ] `GET /` returns the design system's page; an unknown path returns `404`.
- [ ] The record is removed on `SIGINT` and on `SIGTERM`.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` — all green. The suite must not bind a port,
      which proves the import guard works.
- [ ] Check nothing is already on the port: `lsof -i :5757` returns nothing.
- [ ] Start it in the foreground and confirm it serves:
      `bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --serve --plan "$(git rev-parse --show-toplevel)/docs/waypoints-skill"`
- [ ] `curl -s -o /dev/null -w '%{http_code}' localhost:5757/` → `200`.
- [ ] Confirm the containment check is actually reached. curl collapses dot segments before sending, so
      a bare traversal URL becomes `/etc/passwd` and a 404 would prove nothing. Use `--path-as-is`, and
      check the encoded form too:
      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' --path-as-is 'localhost:5757/../../../etc/passwd'
      curl -s -o /dev/null -w '%{http_code}\n' 'localhost:5757/%2e%2e%2f%2e%2e%2fetc/passwd'
      ```
      Both → `404`.
- [ ] Confirm the record exists and names this process:
      `cat "${XDG_DATA_HOME:-$HOME/.local/share}/q-lab/flightdeck/daemon.json" | jq '.port, .plan'`
- [ ] Start a second instance on the same port and confirm it exits non-zero without retrying.
- [ ] Send `SIGINT` to the first and confirm the record file is gone.
- [ ] Relative plan path exits 2: `bun ... --serve --plan docs/waypoints-skill` → exit code `2`.
- [ ] Absolute path with no `tasks/` child exits 2: `bun ... --serve --plan /tmp` → exit code `2`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Runs on import, binds a public interface, or writes the record before binding | Serves correctly but a corrupt record throws, or a busy port is retried instead of reported | Import-safe, loopback only, record written after bind and removed on both signals, static delegated |
| Test coverage | ×2 | No tests | Record round-trip only | Record round-trip, corrupt-record tolerance, XDG path override, route wiring, and the suite provably binds nothing |
| Interface & readability | ×1 | Record shape and I/O inlined in the server | Extracted but the server still reimplements static logic | Record module standalone and importable by a launcher, static module reused, thin `main()` |
| Assumptions & docs | ×1 | The record path is a bare literal | Named but unexplained | Comments explain why the record is written after bind and why a busy port is reported rather than retried |

## Out of scope

- The launcher: argument parsing for interactive use, the singleton decision, detached spawning, port
  readiness polling, and opening the browser. A separate task in this bucket owns all of that and imports
  this record module.
- Any API route. The tree and event endpoints come later in this bucket.
- Static path resolution, containment, and MIME mapping. Already built as its own module; wire it in, do
  not reimplement it.
- Anything under `dashboard/dist/`. The design-system task owns that directory.

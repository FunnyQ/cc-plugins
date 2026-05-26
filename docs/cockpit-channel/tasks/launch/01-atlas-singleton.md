# LAUNCH-01: usage-dashboard singleton guard

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
>
> **Depends on**: none — foundation task
> **Blocks**: launch/03
> **Status**: done

## Goal

`atlas-server.ts` (usage-dashboard) can be started idempotently — a second start
reuses the running instance instead of killing whatever holds its port — so the
channel can auto-start it without thrash.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts` (modify) — add a PID-file singleton guard.
- `packages/monitor/skills/usage-dashboard/scripts/atlas-lifecycle.ts` (new, optional) — the `decideStartup` logic + tests, if you prefer it testable (recommended; mirror cockpit's `daemon-lifecycle.ts`).
- `packages/monitor/skills/usage-dashboard/scripts/atlas-lifecycle.test.ts` (new, if the above) — tests.

## Implementation notes

Today `atlas-server.ts` has **no** singleton — it kills the process on its port
(port 5938) and binds. That's fine for a manual launch but wrong for auto-start:
every session's channel would kill + restart it. Give it the same lifecycle
cockpit already has.

### Reuse cockpit's pattern

`daemon-lifecycle.ts` exports:

```ts
export type DaemonInfo = { pid: number; port: number; token: string; root: string };
export function decideStartup(
  info: Partial<DaemonInfo> | null, myRoot: string, isAlive: (pid: number) => boolean,
): { action: "reuse" | "supersede" | "start"; info?: DaemonInfo };
```

Port it for atlas:

- PID file at `~/.cockpit/atlas.json` (keep monitor's state together under `~/.cockpit/`). Shape `{ pid, port, root }` — atlas has no token today; only add one if a future endpoint needs it, otherwise omit.
- `root` = atlas's `import.meta.dir` (identifies the install, same supersede rationale as cockpit).
- On startup: `reuse` → print URL + exit(0); `supersede` → SIGTERM/SIGKILL the old pid, then bind; `start` → bind fresh.
- Keep `--port` / `--no-open`. **Replace** the current "kill whatever's on the port" behavior with this guard — do not keep both (a foreign process on 5938 should fail clearly, like cockpit does, not be killed).

Copy `isAlive`, `readDaemonInfo`/`writeDaemonInfo`, `waitForExit`, and the
`startupGuard` shape from `cockpit-server.ts` (lines ~60-134, 244-265) adapted to
the atlas paths. Do not import cockpit internals — atlas is a separate skill;
duplicate the small helpers.

## Acceptance criteria

- [x] Starting `atlas-server.ts` twice from the same install: the second prints the running URL and exits 0 (no double-bind, no kill).
- [x] A stale PID (dead process) → starts fresh.
- [x] A live instance from a different `root` → supersedes (terminates old, binds).
- [x] A foreign (non-atlas) process on port 5938 → exits 1 with a clear message (does not kill it).
- [x] `--port` / `--no-open` still work.
- [x] `~/.cockpit/atlas.json` is written on bind.

## Verification

- [x] If you extracted `atlas-lifecycle.ts`: `bun test packages/monitor/skills/usage-dashboard/scripts/atlas-lifecycle.test.ts` green (mirror `daemon-lifecycle` tests if cockpit has them).
- [x] Manual: `bun .../atlas-server.ts --no-open` then again in another shell → second exits 0 with "already running"; `cat ~/.cockpit/atlas.json` shows pid/port.

## Out of scope

- The channel actually auto-starting atlas — a later launch task owns that; this task only makes atlas idempotently startable.
- Any change to atlas's data/endpoints — only the startup lifecycle changes.

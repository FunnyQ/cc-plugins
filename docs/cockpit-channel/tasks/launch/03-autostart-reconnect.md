# LAUNCH-03: Auto-start daemons + reconnect

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: launch/01, launch/02
> **Status**: done

## Goal

When the channel server spawns, it brings up the cockpit daemon **and** the
usage-dashboard server if they aren't running, and it reconnects (re-ensuring
they're up) if a daemon dies mid-session — so launching a session with the
channel is the single action that lights up the whole monitor surface.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit-channel.ts` (modify) — add the ensure-up + reconnect logic to the channel server's existing lifecycle (built by the prerequisite channel-server task).
- `packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts` (modify) — test the "is it up?" decision logic (pure part).

## Implementation notes

The channel server (the prerequisite launch task) already reads `~/.cockpit/daemon.json`. Extend that lifecycle:

### Ensure-up on spawn

Before the pull loop, ensure both servers:

```ts
function isUp(infoPath: string): boolean {
  // read JSON { pid, port }, return isAlive(pid) — reuse the isAlive(pid) {kill(pid,0)} idiom
}
function ensure(scriptPath: string, infoPath: string) {
  if (isUp(infoPath)) return;
  spawn("bun", [scriptPath, "--no-open"], { detached: true, stdio: "ignore" }).unref();
}
```

- cockpit: `~/.cockpit/daemon.json` ↔ `packages/monitor/skills/cockpit/scripts/cockpit-server.ts`.
- usage-dashboard: `~/.cockpit/atlas.json` ↔ `packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts` (its singleton guard — a prerequisite of this task — makes this idempotent: a double-spawn just reuses).
- Resolve script paths relative to `import.meta.dir` so it works from any cwd. `--no-open` so a barge of sessions doesn't open many browser tabs.
- After spawning cockpit, briefly wait/poll for `daemon.json` to appear (bounded, e.g. up to ~3s) before starting the pull loop, so the first `/api/inbox` has a token to use.

### Reconnect on daemon death

The pull loop's `fetch` to `/api/inbox` will throw/`ECONNREFUSED` if the daemon
dies. On that error: re-run `ensure(cockpit)`, re-read `daemon.json` for a
possibly-new `{ port, token }` (a superseded daemon rotates its token), back off
(~1s), and continue the loop. The loop must never wedge — every error path leads
back to a re-poll.

### Idempotence / races

Multiple sessions spawn multiple channels that may all try to start cockpit at
once. The cockpit singleton guard (`decideStartup`) already handles this (only
one binds; the rest `reuse`), and atlas's singleton guard does the same. So
`ensure` can fire optimistically without locking.

## Acceptance criteria

- [x] Launching a session with the channel while **no** daemon is running brings up both cockpit (5858) and usage-dashboard (5938) automatically.
- [x] With daemons already up, the channel does **not** spawn duplicates (reuse path).
- [x] Killing the cockpit daemon mid-session: the pull loop reconnects (re-ensures + re-reads coords) and resumes without manual intervention; no busy-spin (backoff present).
- [x] A rotated daemon token (after supersede) is picked up on reconnect.
- [x] `--no-open` is passed so auto-start doesn't spam browser tabs.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts` green (the `isUp` / coord-read logic).
- [x] Manual: with nothing running, launch `claude --dangerously-load-development-channels server:cockpit-channel`; confirm `curl -s localhost:5858/api/sessions` and `curl -s localhost:5938/api/stats` both respond.
- [x] Manual: `kill` the cockpit daemon pid mid-session, send a UI message a few seconds later → it still gets delivered (channel respawned/reconnected). Observed pid/token rotation from `68335`/`2c14...` to `69019`/`3541...`; the first post-restart send was stashed during reconnect and then appeared in the transcript, and the next send returned `{"delivered":true}`.

## Out of scope

- usage-dashboard's own singleton mechanics — a prerequisite launch task owns that; this task only *calls* the idempotent start.
- The launcher script / README — a separate launch task owns those.

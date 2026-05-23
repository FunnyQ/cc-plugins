# BRIDGE-02: cockpit wait & send CLIs

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
>
> **Depends on**: bridge/01, kernel/02
> **Status**: done

## Goal

Two more subcommands on the `cockpit` CLI: `cockpit wait <sessionId>` parks the LLM (a background task that blocks until Q answers, then prints the answer); `cockpit send <sessionId> <answer>` is the manual/typed equivalent of a UI button — it posts an answer to a parked session.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/cockpit.ts` (modify) — add `wait` and `send` subcommands.

## Implementation notes

These talk to the broker endpoints (`GET /api/wait`, `POST /api/respond`) over `127.0.0.1:<port>`. Read `port` + `token` from `~/.cockpit/daemon.json`. If the daemon isn't running, error clearly ("cockpit daemon not running — start the dashboard first").

### `cockpit wait <sessionId>`

The LLM runs this **right after** logging a `needs_your_call` decision. In Claude Code it is launched as a **background task**, so the LLM pays nothing while parked and is woken when the task completes.

```
loop:
  GET http://127.0.0.1:<port>/api/wait?session=<id>&token=<t>   (long-poll)
  if response has a real answer  → print it to stdout, exit 0
  if timeout sentinel            → loop again (re-poll)
```

- Print the answer plainly (it becomes the signal the LLM reads on wake).
- Respect a total wall-clock limit (e.g. stop after N hours) to avoid an immortal task; on giving up, print a clear "no answer received" and exit non-zero.

### `cockpit send <sessionId> <answer>`

A thin wrapper over `POST /api/respond` for when Q (or a script) wants to answer from a terminal instead of the UI:

```
POST http://127.0.0.1:<port>/api/respond  { session: <id>, answer: <answer>, token: <t> }
print the {delivered} result
```

- If `delivered: false`, tell the user the answer was logged but the session wasn't parked/listening.

## Acceptance criteria

- [ ] `cockpit wait <id>` blocks, and returns/prints the answer once a `respond` (UI or `cockpit send`) targets that session.
- [ ] `cockpit wait` re-polls across the ~270s long-poll timeout without losing its place; it gives up after the wall-clock limit with a non-zero exit.
- [ ] `cockpit send <id> "answer"` posts to `/api/respond` and reports `delivered: true/false`.
- [ ] Both read `port`+`token` from `~/.cockpit/daemon.json` and error clearly if the daemon is down.

## Verification

- [ ] Daemon running. Shell A: `bun cockpit/skills/cockpit/scripts/cockpit.ts wait <id>` (hangs). Shell B: `bun .../cockpit.ts send <id> "go with B"` → shell A prints `go with B` and exits 0; shell B reports `delivered: true`.
- [ ] With nothing waiting: `bun .../cockpit.ts send <id> "x"` reports `delivered: false`.
- [ ] Stop the daemon, run `cockpit wait <id>` → clear "daemon not running" error.

## Out of scope

- The broker endpoints themselves — built in the broker bridge task; this task only calls them.
- Harness-level IPC to reach a session that has *no* `wait` running — not solvable here; `send` to an unparked session returns `delivered: false` by design (see the data-model caveat).

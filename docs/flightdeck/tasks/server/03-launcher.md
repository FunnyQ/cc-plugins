# SERVER-03: the launcher

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/02
> **Blocks**: server/04, wiring/02
> **Status**: todo

## Goal

The short-lived half of the daemon: a command that decides whether to start, reuse, or supersede a
running server, spawns it detached, confirms it answers, opens the browser, and returns control to its
caller.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/daemon-decision.ts` (new) — the pure singleton decision.
- `packages/dispatch/skills/autopilot/scripts/daemon-decision.test.ts` (new) — unit tests for it.
- `packages/dispatch/skills/autopilot/scripts/launch.ts` (new) — argument parsing and the launch flow.
- `packages/dispatch/skills/autopilot/scripts/launch.test.ts` (new) — argument parsing tests.
- `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` (modify) — route a launch invocation here
  when `--serve` is absent.

## Implementation notes

The server process already exists and can bind, serve, and record itself. This task is everything that
happens *around* it. Import the record module rather than redefining the record's shape or path.

### Why the launcher must not block

The command is run from inside a skill step that has more work to do afterwards, and the server is
resident. Running the server in the caller's foreground would hang that step forever.

So: decide, spawn detached, poll until the port answers, print the URL, open the browser, exit `0`.

```ts
spawn("bun", args, { detached: true, stdio: "ignore" }).unref();
```

That is the pattern already established in this repository. The child is this same file invoked with
`--serve`.

If the child never answers within a short timeout, exit non-zero with a message naming the port. Do not
exit `0` on a server that failed to start — the caller is told the launch is non-blocking, not that it is
unverified.

### Argument parsing

```
bun flightdeck.ts --plan <absolute path to docs/slug> [--port N] [--no-open]
```

`--plan` is required and must be absolute. Reject a relative path with exit `2` rather than resolving it
against the current directory. Workflow agents do not share a working directory, so a relative path here
resolves against whichever agent happened to launch it — the same trap the orchestrator documents for its
log file.

`--port` defaults to `5757` and must be in range. `--no-open` suppresses the browser. The browser opens
by default on every launch, **including when an existing server is reused** — re-running the skill should
always land the user on the page.

Split validation so the interesting half needs no fixtures:

```ts
export type Args = { plan: string; port: number; open: boolean };

/** Pure. Shape only: presence, absoluteness, port range. Touches no filesystem. */
export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; message: string };

/** Impure. Confirms the plan directory exists and holds a `tasks/` child. */
export function validatePlanDir(planDir: string): { ok: true } | { ok: false; message: string };
```

`main()` calls both in that order and exits `2` with the message from whichever fails.

### The singleton decision

Pure and injectable, so it can be exercised without processes or ports.

```ts
export type StartupDecision =
  | { action: "reuse"; info: DaemonInfo }
  | { action: "supersede"; info: DaemonInfo; reason: "moved-install" | "different-plan" | "port-change" }
  | { action: "start" };

export function decideStartup(
  info: Partial<DaemonInfo> | null,
  me: { root: string; plan: string; port: number },
  isAlive: (pid: number) => boolean,
): StartupDecision;
```

Rules, in order:

- no record, or a dead pid → `start`
- alive, different `root` → `supersede`, reason `moved-install`. The running server belongs to a moved or
  updated install and serves file paths that no longer exist.
- alive, same `root`, different `plan` → `supersede`, reason `different-plan`. One server serves one tree.
- alive, same `root` and `plan`, different `port` → `supersede`, reason `port-change`. The requested port
  must win. Without this case a launch with an explicit port override would silently reuse a server on the
  old port while the launcher waits for the new one to answer, and then time out.
- alive, same `root`, `plan`, and `port` → `reuse`

Superseding means: signal the recorded pid to terminate, wait for the port to free, then spawn. Do not
assume the kill succeeded — retry the spawn-and-poll briefly and fail loudly with the port number if the
port never frees, rather than exiting silently.

`root` is this install's scripts directory, `import.meta.dir`. That is what distinguishes a genuine
singleton from a stale server left by a moved or updated plugin cache.

### Opening the browser

Spawn the platform opener detached, exactly as the server spawns its child. Never block on it. A machine
with no opener must not fail the launch — the URL was already printed.

## Acceptance criteria

- [ ] Importing the module runs nothing; side effects sit behind an `import.meta.main` guard.
- [ ] `parseArgs` is pure, touches no filesystem, and rejects a missing `--plan`, a relative `--plan`, and
      an out-of-range `--port`.
- [ ] `validatePlanDir` rejects a missing plan directory and one without a `tasks/` child.
- [ ] `decideStartup` returns each of the five outcomes for the five documented input shapes, including a
      port override on an otherwise-matching server.
- [ ] The launch returns control to its caller and leaves a running detached server.
- [ ] A server that fails to answer within the timeout makes the launcher exit non-zero.
- [ ] Launching twice from the same install for the same plan and port binds once and reuses the second time.
- [ ] Launching for a different plan supersedes and rebinds.
- [ ] Launching the same plan with a different `--port` supersedes and binds the requested port.
- [ ] The browser opens on a reuse as well as on a fresh start, and `--no-open` suppresses it.
- [ ] A missing platform opener does not fail the launch.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` — all green, and the suite binds no port.
- [ ] Check nothing is already on the port: `lsof -i :5757` returns nothing.
- [ ] Confirm the launcher returns quickly and the server survives it:
      `time bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --plan "$(git rev-parse --show-toplevel)/docs/waypoints-skill" --no-open`
      — returns in a few seconds, then `lsof -i :5757` shows a listener.
- [ ] `curl -s -o /dev/null -w '%{http_code}' localhost:5757/` → `200`.
- [ ] Run the same launch again and confirm exactly one listener remains.
- [ ] Launch for a different plan directory and confirm the server rebinds to serve that one:
      `curl -s localhost:5757/api/tree` is not yet available, so confirm via the record's `plan` field.
- [ ] Relaunch the same plan with `--port 5758` and confirm `lsof -i :5758` shows one listener and
      `lsof -i :5757` shows none.
- [ ] Kill the server with `SIGKILL` so the record is left stale, then launch again and confirm it starts
      cleanly rather than trying to reuse a dead pid.
- [ ] Relative plan path exits 2: `bun ... --plan docs/waypoints-skill` → exit code `2`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Blocks its caller, or double-binds the port | Detaches but a supersede reason is unhandled, or a failed start still exits 0 | All five outcomes correct, detaches and verifies, stale pid handled, port override wins |
| Test coverage | ×2 | No tests | `decideStartup` happy path only | Argument parsing without fixtures, all five decisions, stale-pid case, and the suite provably binds nothing |
| Interface & readability | ×1 | Decision, parsing, and spawning tangled together | Separated but `parseArgs` touches the filesystem | Pure `parseArgs` and `decideStartup`, filesystem isolated in `validatePlanDir`, record module imported not redefined |
| Assumptions & docs | ×1 | Timeout and port are bare literals | Named but unexplained | Comments explain why the launch must not block, why a failed start must not exit 0, and why the port override supersedes |

## Out of scope

- Binding, serving, and the record's own shape. The server-process task owns those; import its module.
- Any API route.
- A stop or restart command. The supersede path already covers every caller this plan has.
- Detecting a headless environment. Settled in the interview: the calling skill needs an interactive user
  to reach its confirmation step, so there is no headless case to detect.

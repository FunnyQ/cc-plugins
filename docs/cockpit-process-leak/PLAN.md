# Fix: cockpit process leak + inbox ping-pong CPU spin

Branch: `fix/cockpit-process-leak` (off `develop`)
Plugin: `monitor`

> **Revision note.** This plan was rewritten after two independent adversarial reviews
> (a Claude reviewer and an OpenCode reviewer, each reading the source and empirically
> reproducing the failure). Three claims in the first draft were **wrong** and two proposed
> fixes were **dangerous**; both are corrected below, and §6 records what was cut and why.
> One reviewer found a one-line bug that turns out to be a **co-root-cause** (Cut 2).

## 1. The report — what was observed on a real machine

A user's Mac showed sustained high CPU. `ps` revealed monitor-plugin processes accumulated
across **six** plugin versions, all alive at once:

```
PID     PPID   %CPU   UPTIME    COMMAND
62198   1      96.6   2d23h     bun .../monitor/3.18.4/skills/cockpit/scripts/cockpit-server.ts --no-open
55829   1      22.2   1d01h     bun .../monitor/3.18.5/skills/cockpit/scripts/cockpit-channel.ts
56099   1      22.4   1d01h     bun .../monitor/3.18.5/skills/cockpit/scripts/cockpit-channel.ts
56314   1      21.6   1d01h     bun .../monitor/3.18.5/skills/cockpit/scripts/cockpit-channel.ts
27226   27198  21.9   23h       bun .../monitor/3.18.5/skills/cockpit/scripts/cockpit-channel.ts
94097   94062  0.0    9d01h     bun .../monitor/3.16.1/skills/cockpit/scripts/cockpit-channel.ts
80551   80449  0.0    9d09h     bun .../monitor/3.16.1/skills/cockpit/scripts/cockpit-channel.ts
43395   43294  0.0    24d04h    bun .../monitor/3.12.3/skills/cockpit/scripts/cockpit-channel.ts
66022   65983  0.0    24d03h    bun .../monitor/3.12.3/skills/cockpit/scripts/cockpit-channel.ts
71573   71497  0.0    7d00h     bun .../monitor/3.17.0/skills/cockpit/scripts/cockpit-channel.ts
32152   31885  0.0    3d11h     bun .../monitor/3.18.1/skills/cockpit/scripts/cockpit-channel.ts
82400   82366  0.0    4d11h     bun .../monitor/3.18.1/skills/cockpit/scripts/cockpit-channel.ts
90091   90088  0.0    7d00h     bun .../monitor/3.17.0/skills/usage-dashboard/scripts/atlas-server.ts
```

15 leaked processes; **~180% of CPU** (nearly two cores) burned continuously.

Read the three signatures separately — conflating them leads to fixing the wrong thing:

- **`PPID=1` on `cockpit-channel`** — a bug. The channel is a stdio MCP child of a Claude
  session and must die with it. These outlived their parents by up to 24 days.
- **`PPID=1` on `cockpit-server`** — **by design.** The daemon is deliberately
  `detached: true` + `.unref()`'d (`cockpit-channel.ts:90-93`) because it is a shared singleton
  (port 5858) across sessions. Its problems are different: never superseded on upgrade, and
  pegged by the spin below.
- **Four channels at ~22% + the daemon at 96%** — not idle leakage. Something was spinning.

## 2. Root cause — a causal chain with two independent entry points

```
(1) channel never exits ─────┐
                             ├──► 2+ channels polling ONE session id
(2) session-id resolution ───┘              ↓
    always degrades to a guess     + server evicts a parked poller
                                   + client has no sleep on success
                                              ↓
                                   unbounded full-speed HTTP ping-pong
                                              ↓
                                   daemon = hub, burns Σ(channels)
```

Links (1) and (2) each independently make the collision likely. Both must be fixed.

### 2.1 — `cockpit-channel.ts` has no exit path *(verified empirically)*

`main()` (`cockpit-channel.ts:652-660`) awaits `pullInboxLoop`, which is a bare `while (true)`
(`:592`). The plugin has **no** `process.on("SIGTERM"|"SIGINT"|"exit")`, **no** stdin-EOF
watcher, **no** parent-liveness check.

Critically, the MCP SDK does not save us. `@modelcontextprotocol/sdk`'s
`StdioServerTransport.start()` registers **exactly two** listeners:

```js
this._stdin.on('data', this._ondata);
this._stdin.on('error', this._onerror);
```

There is **no `end` and no `close` listener**; `onclose` is only invoked from `close()`, which
nothing calls on EOF. A reviewer ran the real SDK with `stdin < /dev/null` and a
`while(true)` loop: the process was **still alive** after stdin EOF, with
`transport.onclose` never having fired.

So when Claude Code exits and the stdin pipe closes, nothing tells the channel to stop; the
`while(true)` loop plus its pending fetch/timers hold Bun's event loop open. On Unix the child
is reparented to PID 1 rather than killed — **PPID=1, immortal**.

`${CLAUDE_PLUGIN_ROOT}` is version-scoped, so each release starts spawning channels from a new
path while every previously-orphaned channel keeps running from its old one. Nothing ever reaps
them: **each release adds one more immortal process family.**

> **Consequence for the fix:** `transport.onclose` is a **dead trigger** — wiring it and
> testing only it would ship a broken Cut 1. Use stdin `end`/`close` + signals.

### 2.2 — Session-id resolution silently degrades to a guess *(a one-line bug)*

`cockpit-channel.ts:261-266`:

```ts
function claudeSessionsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_SESSIONS_DIR ||
    join(homedir(), ".claude", "sessions")     // ← homedir is NEVER IMPORTED
  );
}
```

The import block (`:2-18`) has no `import { homedir } from "node:os"` — unlike
`find-session.ts:20`, which does. In production `COCKPIT_CLAUDE_SESSIONS_DIR` is unset, so the
right-hand side always evaluates → **`ReferenceError: homedir is not defined`** → swallowed by
the bare `catch` in `sessionIdFromSessionFile` (`:285-287`, whose comment reads "no file for
this pid, or malformed").

So `sessionIdFromAncestorFiles` **always returns `null`**, and `resolveClaudeSessionId`
(`:295-325`) silently falls through to `findSession` → the **newest-mtime transcript guess**
(`find-session.ts:72-84`): scan `~/.claude/projects/<project>/*.jsonl`, take the newest.

Two channels in the same project can independently guess the **same** transcript — the exact
collision that link (2) needs. And one of them is then polling **the wrong session's inbox**,
which is a correctness bug on its own.

The code's own comment (`:268-272`) states the purpose of the session-file lookup:

> "…unlike the newest-mtime transcript guess, which races sibling sessions in the same project
> (and silently latches the wrong id, leaving the cockpit send box disabled)."

**That defence has never run.** It survived because `cockpit-channel.test.ts` always injects
`sessionFileFinder`, so `claudeSessionsDir()` is never executed under test, and there is no
typecheck script in `package.json` — `tsc --noEmit` would have caught it instantly.

### 2.3 — The ping-pong *(reproduced by both reviewers)*

Server, `inbox.ts:9` and `:68`:

```ts
const pendingInbox = new Map<string, ParkedInbox>();   // keyed by session id ONLY
...
pendingInbox.get(session)?.resolve(null);   // a new poll instantly resolves whoever was parked
```

Client, `cockpit-channel.ts:603-612` — the success path **does not sleep**; only `catch` does.
It relies entirely on the server long-parking the request for 240s (`inbox.ts:28-31`) to pace
the loop. `inbox.ts:68` breaks that implicit contract.

With two channels A and B on one session id:

1. A polls → parks (`pendingInbox[s] = A`).
2. B polls → `:68` instantly resolves A with `{message:null, timeout:true}` — an HTTP **200**,
   i.e. the client's **success** path (`http.ts:5`, `jsonResponse(payload, status = 200)`).
3. A does not sleep → **re-polls immediately** → resolves B.
4. B re-polls immediately → resolves A. → goto 2.

Measured against the real `handleInbox` in `Bun.serve`:

```
SINGLE poller, 2s  →     1 request   (parks; no self-spin)
TWO pollers,   2s  →  7408 requests  (~3704 req/s)
```

The single-poller case is genuinely safe: the client is strictly serial (`await fetchImpl`), and
the resolver's reference-equality delete (`:79-80`) removes the entry before the next poll
arrives. **The no-sleep design is correct only for N=1** — and §2.1/§2.2 guarantee N grows.

### 2.4 — Why the *daemon* burned the most

Not because of disk I/O. `daemonToken()`'s per-request `readFileSync` (`inbox.ts:17-26`, called
at `:60`) measures **11.33 µs/call** — at 3704 req/s that is only **~4% of one core**. It cannot
explain 96%.

The real reason is structural: **the daemon is the hub.** It services every hop from *every*
channel, so its CPU ≈ the **sum** of the channels'. The field data says exactly this:
**4 × 22% = 88% ≈ 96.6%.** No disk-read theory is needed.

> This matters for the fix: caching the token does **not** reduce daemon CPU under ping-pong —
> it removes an 11µs-per-request brake and makes the spin *faster*. Only stopping the loop fixes
> CPU. (See §6.)

### 2.5 — The same bug exists in the permission relay

`pullVerdict` (`cockpit-channel.ts:397-456`) is a second `while(true)` (`:411`) whose
`body.timeout === true` branch is a bare `continue` (`:436`) — **no sleep**. Its server mirror
is `permission.ts:502`: `pendingPulls.get(session)?.resolve(null)` — the same session-keyed
eviction.

Two channels on one session id ping-pong on `/api/permission-pull` identically. It is bounded by
`PULL_BUDGET_MS` (5 min, `:381`) so it is less severe, and an *orphan* cannot trigger it (its
stdin is EOF'd, so it receives no `permission_request` notifications — which incidentally
corroborates the inbox-only diagnosis of the field data).

**Fixing only `pullInboxLoop` would close one hole and leave an identical one 60 lines away.**
(`broker.ts:135` has the same eviction shape; human-paced, so no spin today.)

### 2.6 — Why the stale daemon was never replaced

`ensureServer` (`cockpit-channel.ts:83-95`) gates on liveness only:

```ts
if (isUp(infoPath, alive)) return false;
```

`isUp` (`:75-81`) → `readProcessInfo` (`:54-64`) extracts **only `{pid, port}`** — never `root`.
Yet `daemon.json` **does** record it (`cockpit-server.ts:259-264`, `root: ROOT`, `ROOT =
import.meta.dir` at `:42`), and `startupGuard` (`:128-159`) → `decideStartup`
(`daemon-lifecycle.ts:30-41`) already supersedes a different-root daemon correctly.

That correct, tested logic is simply **unreachable from the channel path**: after an upgrade the
new channel sees the old daemon alive → returns `false` → never launches `cockpit-server.ts` →
`startupGuard` never runs. The stale daemon lives forever, serving assets from the old version's
`dist/`. Worse, an orphaned *old-version* channel will respawn an *old-version* daemon when the
current one dies (`restart-lifecycle.ts:3-9` documents this race) — the leak self-heals in the
wrong direction.

This also explains the field observation: killing the 3.18.4 daemon made `isUp()` finally return
`false`, so the current channel respawned it — correctly, as its own child.

### 2.7 — `atlas-server.ts` (secondary, out of scope)

Foreground-launched from the Bash tool, orphaned the same way. Its root-aware PID-file singleton
(`atlas-lifecycle.ts:19-33`) works, but only when someone re-runs the skill. No polling loop, so
it is an idle leak, not a spinner. Cut 5 deliberately leaves it running because nothing
re-ensures the dashboard after termination; no code change here.

## 3. The fix

### Cut 1 — the channel must die with its parent *(root fix)*

`cockpit-channel.ts`. An `AbortController` aborted by **stdin `end`/`close`** and by
**`SIGTERM`/`SIGINT`**. Then exit the process.

- **Do NOT rely on `transport.onclose`** — proven never to fire on parent death (§2.1).
- Thread the signal into **both** `pullInboxLoop` and `pullVerdict` (`while (!signal.aborted)`)
  and pass it to `fetch` so a parked long-poll unblocks at once.
- **`Bun.sleep()` does not accept an `AbortSignal`.** The backoff sleeps (`:599`, `:619`) must
  become interruption-aware, or a SIGTERM arriving mid-backoff won't be honoured until it
  finishes.

Cut 1 alone kills the observed field failure. Everything else is defence in depth or a
correctness fix.

### Cut 2 — the missing import *(one line; co-root-cause)*

`import { homedir } from "node:os"` in `cockpit-channel.ts`. This makes the authoritative
session-file lookup actually run, so resolution stops silently degrading to the newest-mtime
guess — breaking link (2) of the chain independently of Cut 1 (§2.2).

Recurrence guard: the new test calls `claudeSessionsDir()` with the env override **unset**, so
the branch production actually takes is finally exercised. (Every pre-existing test injects
`sessionFileFinder`, which is why the bug shipped.)

A `tsc --noEmit` typecheck would have caught this instantly and is tempting — but this repo has
**no tsconfig, no CI, and no `typescript`/`@types/bun` dependency**, and `package.json` is seven
lines with zero scripts. Adding typecheck means introducing build infrastructure and choosing
strictness across all five packages. That is an architectural decision, not a bug fix; it is
filed in §7 rather than smuggled into this PR.

### Cut 3 — floor the poll interval *(defence in depth)*

Both `pullInboxLoop` (`:592-621`) and `pullVerdict` (`:411-456`). When the daemon returns the
`{timeout:true}` eviction sentinel under a floor (~1s), sleep the remainder plus jitter.

This removes the implicit "the server will park me for 240s" contract and bounds **any** future
collision — regardless of which poller gets evicted. Jitter de-synchronises colliding pollers.

Real inbox messages bypass the floor and re-park immediately, so rapid sends retain their normal
delivery latency.

### Cut 4 — make `ensureServer` root-aware *(with arbitration)*

`cockpit-channel.ts:83-95`. Compare the daemon's recorded `root` to this install's root.

Two things the first draft got wrong:

- `readProcessInfo` (`:54-64`) must be **extended to parse `root`** — it currently reads only
  `{pid, port}`. Cut 4 is impossible without this.
- **Do not spawn unconditionally on root mismatch.** Two *legitimately live* channels of
  different versions (session A on the old version, session B started after an upgrade) would
  then supersede each other's daemon forever: B kills A's daemon → A's poll errors → A's `catch`
  re-`ensure()`s → A kills B's daemon → … and because `failures = 0` resets on every success
  (`:609`) the backoff never escalates. A sustained kill/respawn war. Today's liveness-only check
  is what accidentally prevents this.

  Use a **deterministic tiebreak that terminates** — newest version wins — or reuse the bounded
  retry arbitration `cockpit.ts` already applies to the same race
  (`restart-lifecycle.ts:3-9`, `cmdRestart`).

### Cut 5 — reap pre-existing orphans *(narrowly)*

`skills/install/scripts/setup.ts`, inside the existing `--session-check` SessionStart hook.

Cuts 1–4 stop *new* leaks. They do nothing for machines already carrying 24-day-old zombies from
six versions back — those users get no relief from upgrading alone. Cut 5 is what makes the fix
land in the field.

Predicate — **all** must hold:

- script path under an **older** version of the running install's exact
  `monitor/<version>/` cache family, **and**
- **`PPID == 1`**, **and**
- same uid.

The `PPID == 1` test is non-negotiable. A foreign version root is **not** evidence of
orphanhood: a user with two terminals (an older session still open, a new one started after an
upgrade) has a *live, correctly-parented* old-version channel, and the first draft's sweep would
have killed it.

Placement: **after** the monotonic version-marker gate in `sessionCheck()`. A session still
running an older plugin version returns early when the shared marker already names a newer one,
so it cannot reap the newer daemon or roll migrated config backward. The sweep also refuses to
scan outside a versioned plugin-cache install, keeping repo-checkout tests away from the real
process table. Never signal PID 1. Swallow all failures — a SessionStart hook must never break a
session.

## 4. Tests

TDD, `bun test`, alongside the existing suites (`cockpit-channel.test.ts`, `inbox.test.ts`,
`daemon-lifecycle.test.ts`).

| Cut | Test |
|---|---|
| 1 | Aborting the signal makes `pullInboxLoop` **and** `pullVerdict` return; stdin-EOF and SIGTERM each exit; a SIGTERM during backoff sleep is honoured promptly |
| 2 | `claudeSessionsDir()` returns a real path (no `ReferenceError`) with `COCKPIT_CLAUDE_SESSIONS_DIR` **unset** — the existing tests miss this because they always inject `sessionFileFinder`; `resolveClaudeSessionId` prefers the session file over the mtime guess |
| 3 | **Ping-pong regression (the important one):** two pollers on one session id produce bounded traffic (≤ N req/s), not an unbounded spin. Assert on request *count*, since the current code yields ~3704 req/s. Same test for `/api/permission-pull` |
| 4 | `ensureServer`: live **same**-root daemon → no spawn; live **different**-root → spawns. Plus a **war test**: two alternating different-root `ensureServer` callers must converge, not oscillate |
| 5 | The sweep selects only (older root in the same cache family **∧** `PPID==1` **∧** same-uid); newer processes and a live older channel with a real parent are **not** killed; an older session cannot roll the shared marker backward; PID 1 is never signalled; a kill failure is swallowed |

The two-poller regression test is the one that reproduces the actual field failure.

## 5. Files touched

- `packages/monitor/skills/cockpit/scripts/cockpit-channel.ts` — cuts 1, 2, 3, 4
- `packages/monitor/skills/install/scripts/reap-stale.ts` — **new**: cut 5's pure selector
  (`selectStaleMonitorPids`) plus the best-effort sweep, following the repo's
  pure-decision-core convention (`statusline-decision.ts`, `daemon-lifecycle.ts`)
- `packages/monitor/skills/install/scripts/setup.ts` — calls the sweep from `sessionCheck()`
- `packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts`,
  `install/scripts/reap-stale.test.ts` — tests
- `packages/monitor/.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` — version bump
- `CHANGELOG.md` — `## [monitor 3.19.0]`

`inbox.ts` is **not touched** — see §6.

Two API notes for the reviewer:

- `pullInboxLoop` / `pullVerdict` / `registerPermissionRelay` gain an optional `floorMs`,
  alongside the `fetchImpl` / `maxFailures` / `budgetMs` injectables they already had. The
  pre-existing relay round-trip test passes `floorMs: 0` because its mock answers the timeout
  sentinel instantly — which in production means an *evicted* poll and is exactly what should be
  padded. The floor is elapsed-time based, so a normal 240s park expiry adds **zero** delay; real
  messages bypass it entirely. Only a suspiciously fast timeout sentinel is slowed.
- `ensureServer` gains a `myRoot` parameter (defaulting to `import.meta.dir`) so the
  newest-version-wins tiebreak is testable.

## 6. Cut from the first draft, and why

**The `superseded` ownership protocol (was Cut 3).** The draft proposed tagging each channel with
an instance id and having the server evict a *different* channel's parked poll with an explicit
`{superseded: true}`, on which the loser would stand down.

It is **last-writer-wins, which inverts the outcome it was designed to produce.** Walk it with a
live channel L and an orphan O: every 240s O's park times out, O re-polls — and O's poll
supersedes **L**, the live one. L stands down (or exits) and **the orphan owns the session**.
`handleSendMessage` (`inbox.ts:110-114`) then resolves the orphan's parked poll, delivering the
user's message into a dead process's broken stdout pipe. The cut meant to be defence-in-depth
*against orphans* would hand the session *to* the orphan.

A correct version needs a liveness/recency tiebreak (process start time, or a monotonic epoch) —
which is real complexity for a case that Cut 1 (no orphans) plus Cut 3's floor (bounded traffic)
already cover. Dropped.

**Caching `daemonToken()` (was part of Cut 3).** Sold as a CPU fix; it is not one — measured at
~4% of a core, and removing it *speeds up* the spin (§2.4). It also has a trap: `inbox.ts` is
imported at `cockpit-server.ts:18` but `writeDaemonInfo` runs at `:259`, so a module-load-time
cache would read the previous daemon's file (or nothing), cache `null`, and **401 every
request**. And `broker.ts:72-73` explicitly documents the opposite rationale ("read fresh per
request so a daemon restart (new token) is picked up without caching staleness").

Dropped from this PR. The genuine cleanup here — `daemonToken()` is duplicated four times
(`inbox.ts:17-26`, `broker.ts:74-83`, `permission.ts:91-100`, and `readDaemonCoords` at
`cockpit-channel.ts:42-52`) — is worth its own refactor PR, not a bug-fix PR.

**`transport.onclose` as a Cut 1 trigger.** Proven never to fire on parent death (§2.1).

**Unconditional spawn on root mismatch (was Cut 4).** Causes a daemon supersede war between two
live channels (§3, Cut 4).

**"Kill any foreign-version process" (was Cut 5).** Would kill live channels of a still-open
older session (§3, Cut 5).

## 7. Follow-ups (not this PR)

- **Typecheck.** `tsc --noEmit` would have caught Cut 2's missing import instantly. The repo has
  no tsconfig, no CI, and no `typescript`/`@types/bun` dep, so wiring it is an infrastructure PR
  of its own (which packages? what strictness?) — not a rider on a bug fix.
- `broker.ts:135` — third copy of the unguarded session-keyed park. A shared helper would prevent
  a fourth.
- `daemonToken()` × 4 — extract to one module.
- `atlas-server.ts` / `cockpit-server.ts` — no signal handling; the daemon never removes
  `daemon.json` on exit, leaving a stale file that only the `isAlive(pid)` check saves you from.

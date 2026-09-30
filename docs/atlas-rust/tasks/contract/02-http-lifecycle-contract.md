# CONTRACT-02: HTTP and lifecycle contract suite

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: contract/01
> **Blocks**: server/02
> **Status**: todo

## Goal

A black-box bun suite pins every route, header, and startup behavior of `atlas serve` (contracts.md §2 and §3), green against the TS server today, so the Rust server is proven by the same tests later.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/contract/serve.ts` (new) — `startAtlas()` helper shared by both test files.
- `packages/monitor/skills/usage-dashboard/contract/http.contract.test.ts` (new) — routes, headers, gzip, ETag/304, static files.
- `packages/monitor/skills/usage-dashboard/contract/lifecycle.contract.test.ts` (new) — `atlas.json`, reuse, supersede, port-in-use.

## Implementation notes

### What already exists (the contract launcher and fixture home)

Use these, never spawn `bun atlas-server.ts` or a binary path directly:

```ts
// contract/launcher.ts
export function atlasCommand(sub: string, args?: string[]): string[]; // COCKPIT_BIN set → [$COCKPIT_BIN, "atlas", sub, ...args]; unset → ["bun", <TS script>, ...args]
export function isRust(): boolean;                                    // true when COCKPIT_BIN is set

// contract/fixtures.ts
export function makeFixtureHome(): Promise<{
  home: string;                        // temp HOME with Claude/Codex/OpenCode fixtures
  env: Record<string, string>;         // HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, COCKPIT_HOME, TZ, TOKEN_ATLAS_NOW_MS, stub URLs
  stub: { url: string; respondWith(path: string, status: number, body: string): void };
  cleanup(): Promise<void>;
}>;
export function freePort(): Promise<number>;
```

Force the OpenRouter 500 with `stub.respondWith(<OpenRouter path>, 500, "{}")`.

### `serve.ts`

```ts
export type AtlasProc = { port: number; proc: Subprocess; stdout(): string; stderr(): string; stop(): Promise<void> };
export async function startAtlas(env: Record<string, string>, port: number, extraArgs?: string[]): Promise<AtlasProc>;
```

Spawns `atlasCommand("serve", ["--port", String(port), "--no-open", ...extraArgs])` with `env` merged over a minimal `PATH`. Resolves once stdout contains `Claude Stats Dashboard → http://localhost:<port>`; rejects after 15 s with the captured stdout/stderr. `stop()` sends SIGTERM and awaits exit. Every test registers `stop()` and `cleanup()` in `afterEach`/`afterAll`, so a failing test leaks no process.

### `http.contract.test.ts`

One fixture home and one server per `describe`, fresh port from `freePort()`.

- **`/api/stats`**: 200, JSON with all 19 top-level keys in contracts.md §6 (assert the key set, not values). With `Accept-Encoding: gzip`: `Content-Encoding: gzip`, `Vary: Accept-Encoding`, body gunzips to JSON (use `fetch(..., { decompress: false })` or `Bun.gunzipSync` on the raw bytes so the assertion sees the wire). Without it: no `Content-Encoding`. Both: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-cache`.
- **ETag**: matches `/^W\/"[^-"]+-\d+:\d+(\.\d+)?"$/` (boot id, then `<count>:<newestMtime>`). Same request twice → same ETag. `If-None-Match: <etag>` → 304, empty body, headers `Cache-Control: no-cache`, same `ETag`, `Vary: Accept-Encoding`. Rewriting a fixture transcript with a newer mtime (`utimes`) → a different ETag. Two separate launches over the same files → different ETags (per-process BOOT_ID).
- **`/api/live`**: 200 `{sessions: [], cockpitUp, cockpitPort}` shape, `Cache-Control: no-store`, never `Content-Encoding`. The live module caches `daemon.json` for 5 s against the pinned clock, so never rewrite it under a running server: run each state in its own fixture home and server process, with `daemon.json` in place before the first request. Alive: `{pid: process.pid, port: 5999, token: "t", root: "/x"}` → `cockpitUp: true, cockpitPort: 5999`. Dead: same with the pid of a spawned-and-reaped `true` → `cockpitUp: false, cockpitPort: null`. Missing: no `daemon.json` → `cockpitUp: false, cockpitPort: null`.
- **`POST /api/pricing/refresh`**:
  - Body `{"models": ["claude:<a model the stub serves>", 42]}` → 200 with exactly the keys `ok, overridePath, openRouterError, resolved, unresolved, writtenCount`; `ok: true`; `openRouterError: null`; the non-string `42` is ignored; `$HOME/.config/cc-dashboard/pricing.json` exists, ends in `\n`, and holds `{"models": {...}}` containing the resolved raw model; `overridePath` starts with `~`.
  - No body → 200 `ok: true` (the TS derives the list from a stats build).
  - OpenRouter stub answering 500 → 200 `ok: true`, `openRouterError: "HTTP 500"` (the TS records it, it does not throw).
  - Pre-existing `pricing.json` containing invalid JSON → 500 `{"error": "Override unreadable: …"}` with `Cache-Control: no-store` (the TS throws `Override unreadable`).
- **Static files** (from the real `dashboard/dist`):
  - `/` → 200 `text/html`, body equals `dist/index.html`.
  - `/vendor/petite-vue.es.js` → JavaScript MIME (assert the exact value the TS sends).
  - `/assets/dashboard-bg-dawn.jpg` and `/fonts/fraunces-variable.woff2` with `Accept-Encoding: gzip` → no `Content-Encoding`, ETag without `-gz`.
  - `/app.js` with gzip accepted → `Content-Encoding: gzip`, ETag ends `-gz"`; without → ETag has no `-gz`.
  - `If-None-Match` equal to a static ETag → 304.
  - `/../package.json`, `/%2e%2e/package.json`, and `/missing.js` → 404, body `Not found`.
  - Every static 200 carries `Cache-Control: no-cache`.

### `lifecycle.contract.test.ts`

- **atlas.json**: after start, `$COCKPIT_HOME/atlas.json` text equals `JSON.stringify({pid, port, root}, null, 2) + "\n"`, where `pid` is the server's pid, `port` the bound port, and `root` ends with `/skills/usage-dashboard/scripts`.
- **Reuse**: a second launch with the same env and a *different* free port prints `Claude Stats Dashboard already running → http://localhost:<first port> (pid <pid>)`, exits 0 within 5 s, and the second port refuses connections.
- **Supersede**: spawn `sleep 60`; write `atlas.json` `{pid: <sleep pid>, port: <free port>, root: "/elsewhere/skills/usage-dashboard/scripts"}`; launch → stdout contains `superseding stale atlas server (pid <sleep pid>`, the sleep process exits, the new server binds, and `atlas.json` now holds the new pid.
- **Port in use**: hold a port with `Bun.listen` (or `Bun.serve`) on `127.0.0.1`; launch on it → exit code 1, stderr contains `atlas: port <n> is in use by another process — stop it or pass --port <n>.`
- **Corrupt atlas.json**: write `{not json` → normal start and a rewritten, valid `atlas.json`.

### Rust-only test

`test.skipIf(!isRust())("live answers during a stats build", …)`: fire `/api/stats` without awaiting, then within 50 ms fetch `/api/live` and assert it resolves in under 1 s while the stats request is still pending. Hold the build with the `TOKEN_ATLAS_TEST_BUILD_BARRIER=<tmp>/barrier` seam (contracts.md §1): fire `/api/stats`, wait for `<tmp>/barrier.entered` to appear, then fetch `/api/live` and assert it answers in under 1 s while the stats request is still pending; finally create `<tmp>/barrier` and assert `/api/stats` completes with 200. No data-volume timing. A one-line comment states why it is skipped for TS: the TS server builds stats synchronously on its single event loop, so `/api/live` blocks behind it.

## Acceptance criteria

- [ ] `http.contract.test.ts` covers `/api/stats` (keys, gzip/plain, ETag shape, 304 headers, ETag change on file touch, BOOT_ID differs across launches), `/api/live` (alive and dead daemon pid), pricing refresh (models body, no body, OpenRouter 500, corrupt override → 500), and static files (index, MIME, no-gzip for jpg/woff2, `-gz` ETag suffix, 304, traversal and missing → 404 `Not found`).
- [ ] `lifecycle.contract.test.ts` covers `atlas.json` exact text, reuse (exit 0, message, no second bind), supersede of a live foreign pid, port-in-use (exit 1, exact stderr), and corrupt `atlas.json`.
- [ ] The Rust-only live-during-build test is present, skipped when `COCKPIT_BIN` is unset, carries its one-line reason, and fails if the stats request finished before `/api/live` was measured.
- [ ] Every process is spawned through `atlasCommand`; no test hard-codes `bun`, a script path, or a binary path.
- [ ] Every test uses `makeFixtureHome()` temp dirs and `freePort()` ports; no test reads or writes the real `HOME`, and none binds 5938.
- [ ] Every non-skipped test passes against the TS server.

## Verification

- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/http.contract.test.ts packages/monitor/skills/usage-dashboard/contract/lifecycle.contract.test.ts` passes (COCKPIT_BIN unset, so against TS), reporting exactly one skipped test.
- [ ] `grep -nE '5938|/Users/|homedir\(\)' packages/monitor/skills/usage-dashboard/contract/http.contract.test.ts packages/monitor/skills/usage-dashboard/contract/lifecycle.contract.test.ts packages/monitor/skills/usage-dashboard/contract/serve.ts` prints nothing.
- [ ] `bunx --bun tsc --noEmit | grep usage-dashboard/contract/` prints nothing.
- [ ] After the run, `pgrep -f 'usage-dashboard/scripts/atlas-server.ts --port'` lists no process left behind by the suite.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Tests fail against TS, or assert behavior the TS does not have (e.g. expect a 500 where TS returns `openRouterError`) | Green against TS but some headers or exact strings from contracts.md §2–§3 are asserted loosely (`toContain` on a whole message, key presence without values) | Every header, status, exact stdout/stderr string, and `atlas.json` byte shape in §2–§3 is asserted exactly and passes against TS |
| Test coverage | ×2 | Only the happy-path routes | Routes covered but failure paths (dead pid, corrupt override, corrupt `atlas.json`, port in use, traversal) missing | Every route, every failure path above, reuse/supersede, and the Rust-only concurrency test that cannot pass vacuously |
| Interface & readability | ×1 | Spawn/teardown copy-pasted per test; leaked processes | Shared helper exists but teardown is not guaranteed on failure | One `startAtlas` helper, teardown in hooks, tests read as a spec of §2–§3 |
| Assumptions & docs | ×1 | Skip or stub choices unexplained | Some choices explained | The Rust-only skip and any stub workaround each carry a one-line reason |

## Out of scope

- Stats payload values — Deferred. Reason: the golden suite compares full payloads; this suite checks shape and transport only.
- Any Rust code or running the suite against Rust — Deferred. Reason: the Rust server does not exist yet; this suite must first be green against TS.
- The `/api/live` session list contents — Deferred. Reason: the live-sessions port owns that; here only the envelope and `cockpitPort` are pinned.

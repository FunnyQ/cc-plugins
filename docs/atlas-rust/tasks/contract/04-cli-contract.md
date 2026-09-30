# CONTRACT-04: CLI subcommand contract suite

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: contract/01
> **Blocks**: server/01, cli/01
> **Status**: todo

## Goal

A black-box bun suite pins the observable behavior of `atlas statusline`, `atlas rollup-update`, `atlas push-usage`, `atlas stats`, and `atlas live` (contracts.md §4), and passes against the TS implementation, so the Rust port has a mechanical gate.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts` (new) — the suite.

## Implementation notes

### Harness you build on (already exists in `packages/monitor/skills/usage-dashboard/contract/`)

```ts
// launcher.ts
export function atlasCommand(sub: "serve" | "stats" | "live" | "rollup-update" | "statusline" | "push-usage", args?: string[]): string[];
// COCKPIT_BIN set → [COCKPIT_BIN, "atlas", sub, ...args]; unset → ["bun", "<scripts>/<ts file for sub>", ...args]
export function isRust(): boolean;

// fixtures.ts
export function makeFixtureHome(): Promise<{
  home: string;                       // temp HOME, populated with Claude/Codex/OpenCode fixtures
  env: Record<string, string>;        // HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, COCKPIT_HOME, TZ, TOKEN_ATLAS_NOW_MS, TOKEN_ATLAS_*_URL → stub
  stub: { url: string; requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>; respondWith(path: string, status: number, body: string): void };
  cleanup(): Promise<void>;
}>;
```

Group the tests under top-level `describe` blocks named exactly `statusline`, `push-usage`, `rollup-update`, `stats`, and `live`, so each port filters its own with `bun test … -t "<regex>"`.

Spawn every command with `Bun.spawn(atlasCommand(...), { env: { ...fixture.env, PATH: process.env.PATH }, stdin, stdout: "pipe", stderr: "pipe" })`. Never pass the real `process.env` wholesale — it carries the real `HOME`. Create one fixture home per `describe` block (or per test where state leaks) and call `cleanup()` in `afterEach`/`afterAll`.

### `atlas statusline`

Pinned TS behavior (`statusline-collector.ts`, `rate-limits-cache.ts`):

- Reads all stdin. If it parses as JSON **and** has a truthy `rate_limits`, writes `$HOME/.cache/token-atlas/rate-limits.json` as `JSON.stringify(record, null, 2)` — 2-space indent, **no trailing newline** — where `record = { capturedAt: <ISO string>, capturedAtEpochMs: <ms>, rate_limits: <input rate_limits verbatim> }`. Key order: `capturedAt`, `capturedAtEpochMs`, `rate_limits`.
- The TS stamps `capturedAt` from `new Date()`, not the `TOKEN_ATLAS_NOW_MS` seam. Assert `rate_limits` deep-equals the input, `capturedAtEpochMs` falls between the test's before/after `Date.now()`, and `capturedAt === new Date(capturedAtEpochMs).toISOString()`. Assert the raw file text equals `JSON.stringify(parsed, null, 2)` to pin indent and the missing newline.
- Stdin without `rate_limits`, or non-JSON stdin → the file does not exist afterwards (fresh home) / keeps its prior bytes (pre-seeded home).
- Inner command: set `TOKEN_ATLAS_STATUSLINE_COMMAND` to a snippet such as `printf 'INNER:'; cat; exit 3`. Assert stdout is `INNER:` followed by the exact stdin bytes, and the process exit code is `3`. The inner command runs through a shell with the same stdin bytes the collector read.
- Rollup nudge: after one run, `$HOME/.cache/token-atlas/.rollup-nudge` exists; poll up to 15 s for the rollup DB at `$XDG_DATA_HOME/q-lab/token-atlas/rollup.db` to appear (the detached `rollup-update`). Record the marker's `mtimeMs`, run the statusline again immediately, and assert the mtime is unchanged (5-minute throttle).
- Push nudge: with `LLM_QUOTA_INGEST_URL` unset or whitespace-only, `.push-nudge` never appears; with it set to `stub.url + "/ingest"`, `.push-nudge` appears after one run.
- Promptness: with the inner command a trivial `printf ok`, the statusline process exits in under 2 s even though the nudged `rollup-update` child may still be running. The bound catches a collector that waits on its nudged children; it cannot prove full detachment, so name that ceiling in a one-line comment.

### `atlas push-usage`

Pinned TS behavior (`push-usage.ts`):

- `LLM_QUOTA_INGEST_URL` unset → exit 0, and `stub.requests` holds no request to the ingest path.
- Set to `stub.url + "/ingest"` with `LLM_QUOTA_INGEST_SECRET=s3cret` → exactly one `POST /ingest`, header `content-type: application/json`, header `x-auth-token: s3cret`, body JSON with exactly the keys `capturedAt`, `claude`, `codex` (in that order); `capturedAt` is a number. With the secret unset, `x-auth-token` is the empty string.
- Stub responds `500`, or the URL points at a closed port → still exit 0 and nothing on stderr that the test asserts beyond exit code.
- The Codex usage fetch inside push-usage hits the stub's Codex usage path through `TOKEN_ATLAS_CODEX_USAGE_URL`; the test does not assert its content.

### `atlas rollup-update`

Pinned TS behavior (`rollup-update.ts` CLI block):

- Prints `JSON.stringify({ ...updateRollup(...), usageHourlyRows }, null, 2)` — keys exactly `filesScanned` (number), `rebuilt` (boolean), `usageHourlyRows` (number), in that order; exit 0.
- `--db <tmp path>` → the DB file is created at that path, and no DB appears at the default `$XDG_DATA_HOME/q-lab/token-atlas/rollup.db`.
- `--rebuild` → exit 0 and `rebuilt: true`; a plain second run reports `rebuilt: false`.
- `filesScanned` equals the number of `.jsonl` files the fixture places under `$HOME/.claude/projects` (count them in the test from disk, do not hardcode).

### `atlas stats`

- Exit 0; stdout parses as JSON; its top-level keys are exactly, in order: `period`, `summary`, `byModel`, `pricingMeta`, `budget`, `usageLimits`, `codexUsageLimits`, `dataHealth`, `daily`, `ledger`, `hourlyUsage`, `activityDays`, `hourlyDistribution`, `weekHourMatrix`, `dailyHourCounts`, `projects`, `sessions`, `insights`, `meta`. Values belong to the golden suite, not here.

### `atlas live`

Pinned TS behavior (`live.ts` `import.meta.main` block): stdout is `JSON.stringify({ sessions, cockpitUp, cockpitPort }, null, 2)` with no trailing newline — an **object**, not a bare array. Assert exit 0, keys exactly `sessions` (array), `cockpitUp` (boolean), `cockpitPort` (number or null), in that order. With no `$COCKPIT_HOME/daemon.json`, `cockpitUp` is `false` and `cockpitPort` is `null`.

### Running against Rust later

Every test must be launcher-driven so the same file runs with `COCKPIT_BIN` set. Do not branch on `isRust()` in this file unless an assertion is genuinely implementation-specific; if one is, use `test.skipIf(...)` with a one-line reason.

## Acceptance criteria

- [ ] `cli.contract.test.ts` covers every bullet above for `statusline`, `push-usage`, `rollup-update`, `stats`, and `live`, each as its own `test(...)`.
- [ ] The rate-limits test pins the exact file text (2-space indent, no trailing newline, key order) and the untouched-file cases.
- [ ] The inner-command test proves stdout forwarding, stdin passthrough, and exit-code forwarding (`3`).
- [ ] The nudge tests prove marker creation, the 5-minute throttle (mtime unchanged on a second run), and that `.push-nudge` appears only with a non-empty `LLM_QUOTA_INGEST_URL`.
- [ ] The push-usage tests prove no request without a URL, the exact headers and body keys with one, and exit 0 on a `500` and on an unreachable URL.
- [ ] Every spawned process runs with the fixture env only; no test reads or writes under the real `HOME`.
- [ ] The whole file passes against the TS implementation (`COCKPIT_BIN` unset).

## Verification

- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts` passes with `COCKPIT_BIN` unset.
- [ ] `bunx --bun tsc --noEmit | grep packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts` prints nothing.
- [ ] `grep -nE 'process\.env(\s*[,}])|\.\.\.process\.env' packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts` prints nothing (the real env is never spread into a child).

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Suite fails against TS, or pins behavior the TS does not have | Passes, but loosens a pinned detail (file text, header, key order, exit code) to "contains" checks | Passes against TS and pins every §4 detail exactly, including the live-output object shape and rate-limits file text |
| Test coverage | ×2 | Only happy paths | Misses the throttle, the unreachable URL, or the untouched-file cases | Every failure path above has its own test; nudge detachment ceiling is named |
| Interface & readability | ×1 | Hardcoded paths, real env leaked into children | Works but repeats spawn/env boilerplate per test | One small local spawn helper, fixture per describe, launcher-driven throughout |
| Assumptions & docs | ×1 | Timing bounds and polling unexplained | Some bounds explained | Each timing bound and each `skipIf` carries a one-line why |

## Out of scope

- Stats and rollup **values** — Deferred. Reason: the golden suite compares them against recorded TS output.
- The HTTP server and `atlas.json` lifecycle — Deferred. Reason: covered by the HTTP contract suite.
- Any Rust code — Deferred. Reason: this suite is the gate the Rust port must pass, written against TS first.

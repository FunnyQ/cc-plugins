# atlas-rust measurements (ship/02)

Measured 2026-10-01 on macOS arm64, release build of `cockpit-rs`, Bun 1.4.0.

## Status

Steps 1–5 ran. The TS was deleted only after both suites were green and the real-home golden check came back equal under the tolerance Q accepted on 2026-10-01 (`|a - b| <= 1e-9 * max(|a|, |b|)`). The RSS MISS below is recorded as a MISS; Q accepted it at 77.8 MB on 2026-10-01.

## Contract suite before deletion

| Run | Result |
|---|---|
| `bun test packages/monitor/skills/usage-dashboard/contract/` (TS) | 106 pass, 5 skip (the `skipIf(!isRust())` tests), 0 fail |
| `COCKPIT_BIN=… bun test packages/monitor/skills/usage-dashboard/contract/` (Rust) | 111 pass, 0 fail |

## Method

- One frozen snapshot of the real home under `/tmp/q-lab/monitor/` (APFS clones of `~/.claude`, `~/.codex/sessions`; `VACUUM INTO` copies of `rollup.db`, `opencode.db`, `state_5.sqlite`, with Codex `rollout_path` rewritten into the snapshot), per the TS-vs-Rust recipe in `tasks/_context/shared.md`.
- One fresh root per process launch: temp `HOME`, `XDG_*`, `COCKPIT_HOME`, a copy of the snapshot `rollup.db`, network cut via the three `TOKEN_ATLAS_*_URL` seams. Free port from the OS; never 5938. The real rollup DB was never opened for writing.
- Driven by a bun script outside the repo that spawns each server directly, so `ps` reads the server's own pid.

## Metrics

| Metric | Target | TS baseline | Rust | Result |
|---|---|---|---|---|
| `atlas serve` RSS (max of 5 × `ps -o rss=`, 1 s apart, after one `/api/stats`, `/api/live` polling) | ≤ 40 MB | 607.1 MB (this home; plan's earlier baseline 197 MB) | 77.8 MB | **MISS** — 37.8 MB over target (−87% vs TS) |
| `/api/stats` cold build (median of 3 launches, same snapshot) | Rust ≤ TS | 6636 ms (6754 / 6616 / 6636) | 6402 ms (6402 / 6402 / 6413) | **PASS** — 234 ms faster |
| `atlas statusline` net overhead (median of 20, `TOKEN_ATLAS_STATUSLINE_COMMAND=true`, nudge markers fresh, minus `sh -c true`) | ≤ 10 ms net | TS total 23.2 ms, net 18.4 ms | total 11.0 ms, baseline 4.8 ms, net 6.2 ms | **PASS** |

## Real-home golden check

Result: **equal** under the accepted tolerance (re-run 2026-10-01, after `baa9bcf` made Rust pass unknown session-file keys through).

- Same frozen snapshot, two fresh roots, one `TOKEN_ATLAS_NOW_MS`, network cut; TS `bun …/scripts/api.ts` vs Rust `cockpit atlas stats`.
- Both outputs path-normalized with `normalizeFixturePaths`, then stripped of `volatile-keys.json` + `pricingMeta.openRouter.error` + `codexUsageLimits`.
- 0 differing paths. 1,199 numbers (cost sums: `byModel.*.costUSD`, `daily.*.costUSD`, `daily.*.usageByModel.*.costUSD`, …) differ in the last float digit only, e.g. `626.3233549` vs `626.3233549000001`; all are within the 1e-9 relative tolerance. They are not bit-equal, so some Rust cost sum still runs in a different operation order than the TS; the fixture golden suite does not catch that.
- The earlier run's 54 missing `sessions.*` fields are gone.

## Contract suite after deletion

`contract/golden/live.json` was recorded from the TS `live.ts` on the `extendLiveFixture` home before deletion; `live.contract.test.ts` now compares Rust `atlas live` against it. Removed with the TS, since they can only run against it: the four `TS seams` tests in `fixtures.test.ts` (they imported `api.ts` for `nowMs` and the URL constants) and `mixed fleet: Rust reuses a running TS server` in `lifecycle.contract.test.ts`.

| Run | Result |
|---|---|
| `bun test packages/monitor/skills/usage-dashboard/contract/` (`COCKPIT_BIN` unset → local release binary) | 106 pass, 0 skip, 0 fail |
| `bun test --parallel packages/monitor/` | 370 pass, 0 fail |

## Kept TS

None. Every candidate's only importers were in the deletion set or its own test:

| Module | Importers found | Outcome |
|---|---|---|
| `shared/scripts/jsonl-lines.ts` | its own test | deleted with test |
| `shared/scripts/static-server.ts` | its own test | deleted with test |
| `shared/scripts/path-inside.ts` | `static-server.ts` (deleted) | deleted |
| `shared/scripts/process-alive.ts` | none | deleted |
| `shared/scripts/opencode.ts` | none (relay's hits are its own `backends/opencode.ts`) | deleted |
| `cockpit/scripts/http.ts` | its own test | deleted with test |
| `cockpit/scripts/cockpit-home.ts` | its own test (`cockpit/bin/cockpit.test.ts` does not import it) | deleted with test |

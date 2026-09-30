# atlas-rust measurements (ship/02, step 1)

Measured 2026-10-01 on macOS arm64, release build of `cockpit-rs`, Bun 1.4.0.

## Status

**The TS has not been deleted.** The real-home golden check found differences (below), and the task makes any difference a blocking finding. Steps 2–5 (deletion, Rust-only launcher, docs) wait for Q's call.

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

Result: **not equal** — 1,253 differing paths after path normalization and stripping `volatile-keys.json` + `pricingMeta.openRouter.error` + `codexUsageLimits`.

1. **1,199 float last-digit differences** in cost fields (`byModel.*.costUSD`, `daily.*.costUSD`, `daily.*.usageByModel.*.costUSD`, …), e.g. `byModel.4.costUSD` TS `626.3233549` vs Rust `626.3233549000001`. All within 1e-9 relative, but not bit-equal, so some cost sum runs in a different operation order than the TS (shared.md requires the same order). The fixture golden suite does not catch it.
2. **54 missing fields in `sessions.*`**: TS `readSessionFiles()` (`session-files.ts`) passes each `~/.claude/sessions/*.json` object through whole; Rust `atlas/session_files.rs` deserializes into a fixed struct and drops unknown keys. Real session files carry `procStart`, `peerProtocol`, `peerFeatures`, `pidDomain`, `messagingSocketPath`, `name`, `nameSource`, `nameSince`, `statusUpdatedAt`, which the Rust payload omits.

## Kept TS

Not determined yet: no deletion ran.

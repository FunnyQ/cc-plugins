# Usage-Dashboard Rust Rewrite (`atlas-rust`)

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-01
> **Max parallel**: 3

Slug: `atlas-rust` (collision check: OK). Run options: **review engine Codex**, **depth Standard** (picked before the tree existed; the tree is 18 tasks in 6 buckets, which sits at the Deep band — Step 7 may re-cut once if the written tree measures large). No impeccable design phase (no UI change).

## Overview

Port the usage-dashboard server and everything it runs — `atlas-server.ts`, the `api.ts` engine, rollup ingest, Codex cache, live sessions, statusline collector, push-usage — into the existing `cockpit` Rust binary as `cockpit atlas <sub>` subcommands. The dashboard keeps its own process on port 5938 and its SPA unchanged. Ship in one monitor major release, then delete the TS.

## Goals

- `cockpit atlas serve` RSS ≤ 40 MB after one `/api/stats` build with the dashboard open (today 197 MB), measured with `ps -o rss=` on macOS arm64.
- `/api/stats` cold build time ≤ the TS version on the same home.
- `cockpit atlas statusline` own overhead ≤ 10 ms per tick, excluding the inner `TOKEN_ATLAS_STATUSLINE_COMMAND`.
- `/api/stats` JSON and `rollup.db` rows produced by Rust equal the TS output on a fixture home (golden diff), proven before the TS is deleted.
- No history loss: `rollup.db` stays schema v3 and is backed up once before Rust first writes it.

## Non-goals

- Changing the SPA (`dashboard/dist/`), any route, or any response shape.
- Changing any on-disk schema: `rollup.db` v3, `codex-sessions.db`, `atlas.json`, `rate-limits.json`, `codex-usage-limits.json`, pricing/budget config.
- Merging the dashboard into the cockpit daemon process.
- A separate crate, binary, shim, or release asset.
- Windows.
- Cutting the release (Q runs `/chronicle:release` for monitor, major bump, after review/01).

## Context

- Measured 2026-10-01: `atlas-server.ts` RSS 197 MB; Rust `cockpit server` 22 MB, `cockpit channel` 9.4 MB.
- TS scope: ~4,900 non-test lines under `usage-dashboard/scripts/` (`api.ts` 3,069) plus shared `static-server.ts`, `jsonl-lines.ts`, `opencode.ts`, `process-alive.ts`, `path-inside.ts`, and cockpit's `http.ts` + `cockpit-home.ts`. ~1,770 lines of bun unit tests; no black-box suite and no HTTP test exists today.
- Precedent: `docs/cockpit-rust/` (26 tasks, contract-first, big-bang). Its PLAN deferred this port as "Later". Its lessons carry over: heavy work on the current_thread runtime must go to `spawn_blocking`; spawned children must be reaped.
- `cockpit-rs` is one binary crate (axum, rusqlite bundled, reqwest **without TLS**, flate2, libc). Reusable modules: `paths.rs` (cockpit home), `daemon_info.rs`, `process_alive.rs`, `server/static_files.rs` (gzip + ETag + 304), `server::json_response`.
- Endpoints: `GET /api/stats` (ETag `W/"<BOOT_ID>-<fingerprint>"`, gzip, single in-flight build), `GET /api/live`, `POST /api/pricing/refresh` (missing from CLAUDE.md today), static dist with `/partials/*` and `/vendor/*`.
- HTTPS hosts: `openrouter.ai`, `chatgpt.com/backend-api/codex/usage`, `auth.openai.com/oauth/token`.
- **Contradiction recorded**: `setup.ts` `migrate()` says it "never touches the statusline" because any collector path kept working across updates. That stops being true once `statusline-collector.ts` is deleted, so session-check now rewrites an *existing* collector command. It still never fresh-wires; opt-in stays manual.
- Coupling to update: statusline regex `/(\S*statusline-collector\.ts)/` in `setup.ts`, `install.ts`, `statusline-decision.ts` (+ tests); `install.ts` `COLLECTOR_COMMAND`; `reap-stale.ts` (atlas excluded by comment + test); SKILL.md launch commands; `opencode` reference; CLAUDE.md + README commands.

## Requirements

### MVP

1. **Contract suite** — `packages/monitor/skills/usage-dashboard/contract/`, bun, one launcher: `COCKPIT_BIN` set → `$COCKPIT_BIN atlas <sub>`; unset → the TS script. Green against TS before each port starts, green against Rust at ship/02.
2. **TS test seams** (contract/01, the only TS behavior change before deletion): env overrides `TOKEN_ATLAS_OPENROUTER_URL`, `TOKEN_ATLAS_CODEX_USAGE_URL`, `TOKEN_ATLAS_CODEX_TOKEN_URL`, `TOKEN_ATLAS_NOW_MS` (clock for period windows); `bun api.ts --source <claude|codex|opencode|pricing>` prints one data source's intermediate result so each engine port proves parity before assembly exists; tests pin `TZ`. Rust honors the same names and flag.
3. **Golden parity** — fixture home with Claude transcripts/stats-cache/history, Codex state_5 + rollouts, OpenCode db. TS and Rust `/api/stats` deep-equal after stripping a fixed volatile-key list; `rollup.db` tables equal row-for-row.
4. **Subcommands** — `cockpit atlas serve [--port N] [--no-open]`, `atlas stats [--source <name>]` (prints stats JSON or one source), `atlas live`, `atlas rollup-update [--rebuild] [--db <path>]`, `atlas statusline`, `atlas push-usage`.
5. **Server parity** — routes, ETag/304/gzip/`Cache-Control`, per-process `BOOT_ID`, single in-flight build, `atlas.json` singleton (reuse same root / supersede different root / `atlas: port <n> is in use by another process` exit 1), static dist from disk. `buildStats` runs on `spawn_blocking` so `/api/live` is never stalled.
6. **Engine parity** — rollup ingest (tail-parse, `seen_requests`, ledger replay rules, per-session tool-call dedup, first-wins Claude usage snapshots as `rollup-update.ts` does today (Codex rollouts are last-wins)), pricing resolution order, Codex usage limits with OAuth refresh, OpenCode db + legacy JSON, budget, data health, insights.
7. **One-time backup** — first Rust open of a `rollup.db` lacking meta key `writer=rust` runs `VACUUM INTO <db>.pre-rust.bak`, then sets the key.
8. **HTTPS** — reqwest gains `rustls` with bundled webpki roots; builds on all 4 targets.
9. **Wiring** — SKILL.md, `install.ts`, `setup.ts` session-check statusline migration + drift regex, `statusline-decision.ts`, `setup-statusline.ts`, `reap-stale.ts`, `opencode` reference all call the shim.
10. **Cleanup** — delete ported TS and its unit tests; delete `cockpit/scripts/http.ts`, `cockpit-home.ts`, and `shared/scripts/*` that lose their last importer; update CLAUDE.md and README.

### Later

- Serving the dashboard from the cockpit daemon — only if a second process proves to matter.

## Tech decisions

- **Stack**: same crate and runtime rules as cockpit-rs (tokio current_thread, axum, rusqlite bundled, serde_json `preserve_order`). New: reqwest `rustls-tls` + webpki roots.
- **Location**: `packages/monitor/cockpit-rs/src/atlas/` — `mod.rs` (subcommand dispatch), `paths.rs`, `dedup.rs`, `jsonl.rs`, `model.rs`, `rollup_db.rs`, `rollup_update.rs`, `pricing.rs`, `codex.rs`, `opencode.rs`, `claude.rs`, `stats.rs`, `server.rs`, `live.rs`, `statusline.rs`, `push_usage.rs`.
- **Engine module API**: frozen in `tasks/_context/engine-api.md` (types mirror TS field-for-field; `IndexMap` where TS order becomes array order; network fns async, parsing sync; clock via `model::now_ms()`).
- **Scaffold once**: engine/01 owns `Cargo.toml`, `main.rs` dispatch, and `atlas/mod.rs`; it creates every module with its public signatures stubbed (`todo!()` bodies). Later tasks fill only their own module.
- **Shared cockpit modules**: `server/static_files.rs` is generalized to take a dist root (engine/01); cockpit's contract suite must stay green.
- **atlas.json**: path and shape unchanged; `root` = `<plugin root>/skills/usage-dashboard/scripts`, the string TS writes, so a mixed TS/Rust fleet supersedes by version.
- **Statusline nudges**: `atlas statusline` spawns `current_exe() atlas rollup-update` / `atlas push-usage` detached, same 5 min / 2 min marker throttle; children are not waited on and are reaped via `setsid` detachment.
- **Tests**: bun contract + golden suite; `cargo test` for internal logic; `cargo fmt --check`, `cargo clippy -D warnings`.
- **Visual design**: none.
- **Conventions**: `_context/shared.md`, copied from cockpit-rust's and adapted. No task commits.

## Architecture

```
SKILL.md / Q ─▶ bin/cockpit atlas serve ─▶ axum 127.0.0.1:5938 ── dashboard/dist (disk)
                                              ├─ /api/stats ─ spawn_blocking(stats::build) ─┐
                                              ├─ /api/live  ─ live.rs (daemon.json, registry.json)
                                              └─ /api/pricing/refresh ─ pricing.rs (rustls)
stats::build ─▶ rollup_update ─▶ rollup.db (v3, authoritative)
            ├─▶ claude.rs  (stats-cache, history, rollup readers, rate-limits.json)
            ├─▶ codex.rs   (state_5 ro, rollouts, codex-sessions.db, usage limits + OAuth)
            └─▶ opencode.rs (opencode.db ro, legacy json)
Claude statusLine ─▶ bin/cockpit atlas statusline ─▶ inner command; detached nudges ─▶ atlas rollup-update / push-usage
```

## Migration phases

1. **contract** — TS seams, fixture home, contract + golden suites green against TS.
2. **engine** — scaffold, then per-source ports in parallel, then assembly.
3. **server / cli** — live sessions, then the HTTP shell; non-server subcommands.
4. **ship** — wiring + statusline migration, delete TS, docs, measurements.
5. **review** — integration gate.

## Bucketing

- **Strategy**: by layer, contract first; engine split by data source.
- **Why**: each data source has its own golden slice and fixtures, so engine tasks run in parallel after the scaffold.

### Buckets

- **`contract/`** — launcher, fixtures, TS seams, black-box + golden suites.
- **`engine/`** — scaffold and data engine.
- **`server/`** — `atlas serve` and `/api/live`.
- **`cli/`** — non-server subcommands.
- **`ship/`** — wiring, deletion, docs, measurement.
- **`review/`** — final review only.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| contract | 01 | launcher-fixtures-ts-seams | todo | > 4.0 | — |
| contract | 02 | http-lifecycle-contract | todo | > 4.0 | contract/01 |
| contract | 03 | golden-stats-rollup | todo | > 4.0 | contract/01 |
| contract | 04 | cli-contract | todo | > 4.0 | contract/01 |
| engine | 01 | scaffold-paths-dedup-model | todo | > 4.0 | — |
| engine | 02 | rollup-db-schema-backup | todo | > 4.0 | engine/01 |
| engine | 03 | rollup-ingest | todo | > 4.0 | engine/02, contract/03 |
| engine | 04 | pricing | todo | > 4.0 | engine/01, contract/03 |
| engine | 05 | codex-sources-limits | todo | > 4.0 | engine/02, contract/03 |
| engine | 06 | opencode-sources | todo | > 4.0 | engine/01, contract/03 |
| engine | 07 | claude-sources | todo | > 4.0 | engine/03, contract/03 |
| engine | 08 | stats-assembly-fingerprint | todo | > 4.0 | engine/03, engine/04, engine/05, engine/06, engine/07 |
| server | 01 | live-sessions | todo | > 4.0 | engine/01, contract/04 |
| server | 02 | atlas-serve-routes-lifecycle | todo | > 4.0 | server/01, engine/08, contract/02 |
| cli | 01 | statusline-rollup-push-stats | todo | > 4.0 | engine/03, engine/05, engine/07, contract/04 |
| ship | 01 | wiring-statusline-migration | todo | > 4.0 | server/02, cli/01 |
| ship | 02 | delete-ts-docs-measure | todo | > 4.0 | ship/01 |
| review | 01 | final review 🏁 | todo | > 4.0 | ship/02 |

Rubric: shared bar in `_context/rubric.md` — Correctness ×3 / Test coverage ×2 / Interface & readability ×1 / Assumptions & docs ×1, pass > 4.0, Correctness < 4 veto. review/01 adds Leanness ×1.

Human checks (tagged `(human)`): golden diff on Q's real home over a copy of `rollup.db` (ship/02); dashboard visual pass against the Rust server (server/02, review/01); live statusline in Claude Code after session-check migration (ship/01); Codex usage limits against real `auth.json` (engine/05).

## Cross-bucket dependencies

```
contract/01 ─┬─ 02 ───────────────────────────────────────────┐
             ├─ 03 ──▶ engine/03,04,05,06,07                    │
             └─ 04 ──▶ server/01, cli/01                        │
engine/01 ─┬─ 02 → 03 ─┬─ 07 ─┐                                  │
           ├─ 04 ──────┼──────┼─▶ engine/08 ─▶ server/02 ◀──────┘ (+server/01)
           ├─ 05 ──────┼──────┤
           ├─ 06 ──────┘      │
           └─▶ server/01      └─▶ cli/01 (+engine/03, 05)
server/02 + cli/01 ─▶ ship/01 → ship/02 → review/01
```

The live module lands before the HTTP shell because `/api/live` in the shell calls it; the shell waits for stats assembly because the HTTP suite asserts a real `/api/stats`.

## Failure modes & rollback

- **Rust ingest corrupts or double-counts `rollup.db`** → `rollup.db.pre-rust.bak` restores it; golden row-diff gates engine/03 before any real-home run.
- **Mixed fleet** (an old TS dashboard or collector still running) writes the same DB → safe only because schema, dedup keys, and `hour_ms` are identical; the golden suite proves that.
- **Statusline ticks between `git pull` and the next SessionStart fail** (collector file gone) → accepted; session-check migration fixes it on the next session start. Recorded as a Known gap.
- **rustls breaks a musl cross-build** → engine/01 builds all four targets in CI dry-run before any network code lands; fallback is shelling out to `curl`.
- **Regression after release** → reinstall monitor 6.x; the release is one commit + one tag.
- **Targets missed** → ship/02 reports measured RSS/latency and the gap; it does not silently pass.

## Open questions

1. Volatile-key list for the golden diff (e.g. `meta.generatedAt`, pricing fetch timestamps) — contract/03 derives it from the TS payload and freezes it in `_context/contracts.md`.
2. Does `TOKEN_ATLAS_NOW_MS` cover every `Date.now()` in `api.ts` (5 call sites) plus `live-sessions.ts` cutoffs? contract/01 audits.

## Assumptions resolved by guessing

- Fixture homes work by setting `HOME` to a temp dir: every TS path except `TOKEN_ATLAS_PROJECTS_DIR`, `TOKEN_ATLAS_ROLLUP_DB`, `COCKPIT_HOME`, `XDG_*`, and the OpenCode DB vars derives from `os.homedir()`, which reads `HOME` on POSIX, as Rust does.

- Subcommand names `cockpit atlas serve|stats|live|rollup-update|statusline|push-usage`.
- Test-seam env var names `TOKEN_ATLAS_OPENROUTER_URL`, `TOKEN_ATLAS_CODEX_USAGE_URL`, `TOKEN_ATLAS_CODEX_TOKEN_URL`, `TOKEN_ATLAS_NOW_MS`.
- `atlas.json.root` keeps the TS string so version supersede works across TS and Rust.
- Moving `buildStats` to `spawn_blocking` is a latency fix, not a shape change, so it is in scope.
- Codex usage-limit fetch and OpenRouter keep their TS timeouts (3 s load, 10 s refresh).

## Known gaps

- Statusline breaks between the marketplace `git pull` and the next SessionStart.
- The `writer=rust` meta key is the only marker of the one-time backup; deleting the `.bak` leaves no second copy.

## References

- `docs/cockpit-rust/PLAN.md`, `docs/cockpit-rust/review-notes.md`
- Measurements in this conversation (2026-10-01).

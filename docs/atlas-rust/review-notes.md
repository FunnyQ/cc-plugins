# atlas-rust final review (review/01, attempt 1)

Reviewed 2026-10-01. Diff scope: `git diff --stat 33ef2e53f519e84080823e1f7362a347bbdd91a5 -- packages/ opencode/ CLAUDE.md README.md` → 104 files changed, 19,660 insertions, 8,049 deletions. Four review lenses wrote findings under `.flightlog/review/attempt-1/`: codex (the cross-vendor lens, which ran and reported 5 findings), reuse (14), leanness (21), and efficiency (10).

## Verdict per review area

### 1. Parity proven: PASS

- `COCKPIT_BIN=…/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/` → 106 pass, 0 fail. That run includes the Rust-only tests for the pre-rust backup and for `/api/live` answering during a stats build.
- The literal golden check `git diff --name-only "$C" -- contract/golden/ ':!…/live.json'` prints `golden/stats.json` and `golden/SHA256SUMS`. Both changed in `baa9bcf`, which extended the fixture's session files with unknown keys and re-recorded the golden. At that commit `launcher.ts` ran the TS whenever `COCKPIT_BIN` was unset, and the TS still existed, so the re-record came from the TS.
  - Proof: I extracted `4ee31a4`, the last commit that still had the TS, with `git archive` into a temp dir and ran `golden.contract.test.ts` there with `COCKPIT_BIN` unset. The TS engine passed 39 of 39 (1 skip) against the same golden files.
  - `git diff --name-only 4ee31a4 HEAD -- contract/golden/` lists only `live.json`, which was recorded from TS `live.ts` before the deletion (measurements.md).
- No golden file was re-recorded in this review.

### 2. One launch path: PASS

`rg -n --glob '!*.test.ts' --glob '!docs/**' 'bun [^ ]*usage-dashboard/scripts/(atlas-server|api|live|rollup-update|statusline-collector|push-usage)\.ts' packages opencode CLAUDE.md README.md` prints nothing. `install.ts:18` resolves the shim, and `COLLECTOR_COMMAND` is `<shim> atlas statusline` (`install.ts:54`).

### 3. Statusline migration: PASS after fixes

- `setup.ts` `migrateStatusline()` only rewrites a monitor-owned TS collector, via `migrateCollectorCommand`. It returns false for an unwired or unparseable `settings.json`, so it never fresh-wires; `setup.test.ts` covers this with "never fresh-wires on a clean install".
- The drift watch classifies the command with `statuslineReferencedCollector()` (`setup.ts:151`) against `SHIM_COLLECTOR_RE`.
- A wrapped user command keeps its `TOKEN_ATLAS_STATUSLINE_COMMAND='…'` prefix byte for byte (`statusline-decision.test.ts`).
- Codex found two defects here, and both are fixed (see Fixes 1 and 2).

### 4. Data safety: PASS after fix

- `rg -n 'schema_version' packages/monitor/cockpit-rs/src/atlas`: the one non-test write is `set_meta(conn, "schema_version", &SCHEMA_VERSION.to_string())` (`rollup_db.rs:227`). The other hits are test fixtures and a `PRAGMA schema_version` probe.
- `usage_hourly` is only upserted additively. Replay and prune touch only `ingested_files`, the ledger tables and `seen_*`.
- The pre-rust backup runs before the migration and never replaces an existing `.pre-rust.bak`. It is now also crash-safe (see Fix 3).

### 5. Contract consistency: PASS

- Every env var in `contracts.md` §1 is read under `src/atlas/` or in `src/paths.rs`, checked by grepping each name. `OPENCODE_DATA_DIR` is read only in `paths.rs`, which is the reused helper.
- Outside test modules, the one `unwrap()`/`expect(` under `src/atlas` is `stats.rs:1303` `expect("a Value always serializes")`, a self-established invariant.
- CLAUDE.md:124 lists `GET /api/stats`, `GET /api/live` and `POST /api/pricing/refresh`. CLAUDE.md:251–259 and README.md:166–169 give the `cockpit atlas` commands. Neither file names a deleted TS file; the `live.ts` at CLAUDE.md:88 is relay's own file.

### 6. Release wiring: PASS

- `git diff --name-only 33ef2e5 -- .chronicle/release.json` prints nothing.
- `Cargo.toml` has `version = "6.0.1"`, the same as both monitor `plugin.json` files.
- `.github/workflows/cockpit-release.yml` builds `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`.
- `reqwest` is built with `default-features = false` and `rustls-tls-webpki-roots`, so there is no OpenSSL.

### 7. Leanness: PASS after cleanups

- The stale `#[allow(dead_code)]` markers are gone from `mod.rs` (5), `pricing.rs`, `rollup_db.rs` and `stats.rs` (3). The one item they hid, `model::add_usage`, is deleted.
- The duplicated helpers are merged (see Fixes 9–15).

## Targets (quoted from measurements.md, plus a re-measure after this review's fixes)

| Metric | Target | measurements.md (Rust) | Result | After review fixes (A/B, same snapshot, same load) |
|---|---|---|---|---|
| `atlas serve` RSS after one `/api/stats` | ≤ 40 MB | 77.8 MB (TS 607.1 MB) | **MISS**. Q accepted 77.8 MB on 2026-10-01. Cause: the build's working set, plus the cached payload's `serde_json::Value` tree kept for the life of the process. | see below |
| `/api/stats` cold build | Rust ≤ TS | 6402 ms vs TS 6636 ms | **PASS** | see below |
| `atlas statusline` net overhead | ≤ 10 ms | 6.2 ms net (TS 18.4 ms) | **PASS** | see below |
| Real-home golden diff | equal within 1e-9 relative | 0 differing paths; 1,199 cost sums differ in the last float digit | **PASS** under the tolerance Q accepted (1e-9) | not re-run. The pricing and cost changes here keep summation order: the golden suite is bit-identical and still passes. |

A/B re-measure: the method is the one in measurements.md, driven from `/tmp/q-lab/monitor/review01.*/ab.ts` over the frozen snapshot `snap.LuAS`. It ran 4 interleaved rounds of the HEAD binary against the fixed working-tree binary. The machine's load average was about 5–8, higher than during ship/02, so compare the two columns with each other rather than with the table above.

| Metric (median of 4) | HEAD (`35b64cf`) | This review | Target |
|---|---|---|---|
| RSS after one `/api/stats` | 80.0 MB | **66.5 MB** | ≤ 40 MB: still a **MISS** (26.5 MB over), within Q's accepted 77.8 MB |
| `/api/stats` cold build | 6494 ms | **6126 ms** | ≤ TS 6636 ms: **PASS** |
| `atlas statusline` total / net of `sh -c true` (3.8 ms) | 11.9 / 8.1 ms | 12.6 / 8.8 ms | ≤ 10 ms net: **PASS**. The difference is run-to-run noise (range 10.3–13.3 on both); this review changed nothing on the statusline hot path apart from one `env_remove`. |

Remaining RSS cause: the peak working set of one build, meaning full `serde_json::Value` parses of every transcript line, the OpenCode message rows collected at once, and the payload tree before it is encoded. The allocator keeps that memory after the build. The next lever is the rejected borrowed-deserialization change below.

## Fixes applied in this review

Each codex finding was a correctness finding, and each one was fixed.

1. **Statusline self-recursion** (codex P2): `'…/cockpit' atlas statusline` with a quoted path did not match `SHIM_COLLECTOR_RE`, so it was treated as a user command and wrapped around the collector. `cockpit atlas statusline` inherits the env var, so the inner collector re-ran itself forever.
   - `SHIM_COLLECTOR_RE` now accepts quotes around the path.
   - The Rust collector now runs its inner command with `env_remove("TOKEN_ATLAS_STATUSLINE_COMMAND")`. This guard holds whatever the regex does.
   - New tests: `statusline-decision.test.ts` "never wraps a quoted shim…" and `cli.contract.test.ts` "inner command does not inherit TOKEN_ATLAS_STATUSLINE_COMMAND".
2. **Legacy migration corrupted valid commands** (codex P2):
   - `/home/q/.bun/bin/bun /…/statusline-collector.ts` used to become `/home/q/.bun/bin/<shim> …`.
   - `bun "/…/statusline-collector.ts"` used to leave a dangling quote.
   - `TS_COLLECTOR_RE` now matches an absolute or quoted `bun` and a quoted script, and still captures the bare path in group 1. Two tests were added.
3. **Partial `.pre-rust.bak` trusted forever** (codex P2): the backup is now written with `VACUUM INTO` to `.pre-rust.bak.tmp-<pid>`, then `hard_link`ed into place (the link fails if the name exists, and a dangling name still errors), and the temp file is removed. A crash can no longer publish a partial backup, and a concurrent opener's backup is never replaced. The test asserts that no temp file is left behind.
4. **Explicit JSON `null` dropped from session files** (codex P3): the optional fields use a `present` deserializer, so `"version": null` passes through as the TS did. The round-trip test now covers nulls.
5. **stats-cache unknown keys dropped** (codex P3): `StatsCache` now carries a `#[serde(flatten)] extra` map, so keys such as `dailyModelTokensVersion` reach `--source claude` as TS `safeReadJSON` returned them. The unit test `load_errors_and_fallbacks` had asserted the drift (`{"version":2}`); it now asserts pass-through.
6. **`/api/stats` cached `Arc<Value>` and re-serialized and re-gzipped on every 200** (efficiency): the slot now caches `StatsBody { json, gzip, models }`, which is encoded once, off the runtime thread, as `Bytes`. The `Value` tree is dropped after encoding.
7. **`POST /api/pricing/refresh` with no model list ran a fresh full build** (efficiency): it now reuses the cached or in-flight build for the current fingerprint and reads its `models`.
8. **Other efficiency fixes:**
   - `prepare_cached` for the per-line and per-file rollup accessors.
   - `open_rollup_db` skips the IMMEDIATE write transaction when the DB is already v3 and written by Rust.
   - The pricing normalized index is built once per table (a `OnceLock`, `#[serde(skip)]`).
   - Ledger and daily rows are priced once and summed from the serialized rows in the same order, so the result is bit-identical.
   - The Claude load uses the ingest's `files_scanned` instead of walking `projects/` a second time; it still walks when the rollup fails to open.
   - The `/api/live` caches hold an `Arc`, so a cache hit no longer deep-copies the transcript index.
9. JS truthiness had 5 atlas copies; they now call the crate's `server::opencode::js_truthy`.
10. `iso_ms` had 5 copies; there is now one, `model::iso_ms`.
11. `Date.parse` had 2 ports that disagreed; there is now one, `model::js_date_parse`. The rollup ingest now also trims and accepts a space separator, as JS does.
12. `RATE_LIMITS_STALE_AFTER_MS`, `FIVE_HOUR_MS` and `SEVEN_DAY_MS` are declared once, in `model.rs`. `ledger_project_name` moved to `model.rs` and is used by OpenCode too.
13. Five copies of existing helpers are deleted in favour of the originals:
    - `live::project_name_for` → `model::project_name`
    - `pricing::tilde` → `model::display_path`
    - `stats::open_code_storage_roots` → the `opencode.rs` original
    - `stats::pricing_override_path` → `pricing::override_path`
    - `atlas::server::parse_port_value` → `server::parse_port`
14. `static_files::accepts_gzip` and `static_files::gzip6` are shared by both servers. `live.rs` uses `paths::registry_path` and `paths::daemon_info_path`. `Ctx` derives `Clone`. Real-clock reads use `jiff::Timestamp::now()`.
15. TS cleanups:
    - The constant `isRust()` and its test are deleted.
    - The two identical `write` branches in `decideStatusLine` are merged.
    - The `LIVE_SHIM` resolve in `install.ts` is one line.
    - The `fixtures.test.ts` describe is renamed from "TS engine" to "atlas engine".

## Findings rejected

- **Efficiency: borrowed-struct deserialization of transcript lines.** This would rewrite the ingest parsers of `rollup_update.rs`, `codex.rs` and `claude.rs`, all of which pass golden. The task forbids rewriting a module whose golden and contract tests pass. This is the largest remaining lever on cold time and RSS; it belongs in a follow-up with its own contract cases.
- **Efficiency: stream OpenCode rows instead of collecting them.** The TS used `.all()`, so a bad row fails the read before any row is ingested. Streaming would ingest a partial prefix, which changes error-path parity.
- **Leanness: hand-rolled `jsonl.rs` → `BufReader::read_until`.** This rewrites a tested module with chunk-boundary tests. The efficiency lens asks for the opposite direction (borrowed slices), so the two are settled by leaving it alone.
- **Leanness: strip `ClaudeSessionFile` to the six fields `live.rs` reads.** The claim was wrong: `stats.rs` serializes the sessions into the payload, and `baa9bcf` added the pass-through for golden parity.
- **Leanness: delete `fixtures.test.ts` spot-checks as covered by golden.** They state the fixture's rules readably (first snapshot billed, `req_A2` billed once) and assert values golden strips as volatile (`meta.generatedAt`, `pricingMeta.openRouter`).
- **Leanness: `node_error` → `codex::io_message`.** Not a subset: `io_message` adds an EISDIR arm, so sharing it would change `sourceHealth` error text for a directory.
- **Leanness: drop the unused `_ctx` parameters.** This is signature churn across 5 source entry points with no failure prevented, and `Ctx` is the uniform seam every source takes.
- **Reuse: live's `opencode_timestamp_ms` → `opencode::open_code_timestamp_ms`.** The latter truncates to `i64`, while live keeps fractional ms for age and sort. That is a behaviour change.
- **Reuse: `local_day_hour` shared with OpenCode.** OpenCode reuses one `TimeZone` across the loop, and the shared helper would call `TimeZone::system()` per row.
- **Reuse: fold atlas's `open_browser` reaping into cockpit's.** That changes cockpit daemon behaviour outside this leg. The atlas copy stays because a long-lived server must reap the zombie opener; cockpit's never had to.
- **Reuse: generic `daemon_info::decide_startup`.** The atlas record carries JS-number pid and port semantics (fractional port echoed, fractional pid dead). Merging would widen a cockpit type for about 15 lines.
- **Reuse: `runAtlas` shared by `cli.contract` and `fixtures.test`.** This is test-harness churn with no defect behind it.
- **Reuse: move `jsonl.rs` to crate level and port cockpit's transcript readers.** Out of this leg's scope, and it rewrites passing cockpit code.

## Incident during this review

While building an A/B baseline binary, I ran `cockpit atlas serve --help` from a temp extraction of HEAD. `atlas serve` has no `--help`, so it started a real server on port 5938 against the real home and opened the browser. It ran from about 04:44 to 04:54, and I stopped it with `kill`. No server was running before it (it printed no reuse or supersede line). Effects:

- `~/.local/share/q-lab/cockpit/atlas.json` now names the stopped pid. That is harmless: the next launch reads the pid as dead and starts fresh.
- It was the first Rust write to the real `rollup.db`. It took `rollup.db.pre-rust.bak` at 04:44, which a read-only check found to be sound:
  - `PRAGMA integrity_check` → `ok`
  - `schema_version` 3, with no `writer` key, so the backup is the TS-written state
  - 5,954 `usage_hourly` rows
- The live DB is now `writer=rust`, `schema_version` 3, with 5,958 rows (normal new ingest), and no history was lost.
- It used the HEAD code that had already passed the real-home golden check.

## Human checks still owed

- [ ] Q opens the Rust-served dashboard on real data and checks every panel, the pricing refresh button, and the live panel's click-through to cockpit.
- [ ] Q confirms the Claude Code statusline renders after the session-check migration rewrote `statusLine.command`.

## Unrelated issue noticed (not fixed)

`packages/monitor/skills/usage-dashboard/contract/Library/Caches/bun/…` is untracked and was already there when this review started. Some contract test spawns `bun` with no `HOME` and its cwd inside `contract/`, so Bun writes its cache relative to that cwd. It should be found and given a temp `HOME`, or the path should be ignored.

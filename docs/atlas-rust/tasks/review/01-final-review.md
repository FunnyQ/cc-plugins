# REVIEW-01: Final review 🏁

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
> - `../_context/rubric.md`
>
> **Depends on**: ship/02
> **Status**: done
> **Final review**: true
> **Models**: judge=opus/high, fix=opus/high

## Goal

Confirm the whole leg composes: `cockpit atlas` replaces the Bun usage-dashboard with no observable change to the SPA, the statusline, or any file on disk; the parity suites prove it; the memory and latency targets are met or their misses are reported with numbers; nothing else in the repo regressed.

## Files to create / modify

- `docs/atlas-rust/review-notes.md` (new) — findings per review area, the diff scope reviewed, the targets quoted from `docs/atlas-rust/measurements.md` with pass/miss, every fix applied here, and every human check still owed.
- Any file in the change set (modify) — only to fix an integration defect found here; each fix is listed in `docs/atlas-rust/review-notes.md`.

## Implementation notes

### Scope

`<baseRef>` is the commit the run started from; autopilot substitutes it. When run by hand, use the parent of the first commit that added `packages/monitor/cockpit-rs/src/atlas/mod.rs`: `git rev-parse "$(git log --format=%H --diff-filter=A -- packages/monitor/cockpit-rs/src/atlas/mod.rs | tail -1)^"`. Every diff below uses that value.

Review the leg's diff, not individual tasks: `git diff --stat <baseRef> -- packages/ opencode/ CLAUDE.md README.md`.

### Review areas, in order

1. **Parity proven.** The atlas contract + golden suite (`packages/monitor/skills/usage-dashboard/contract/`) passes against the Rust binary, including the Rust-only tests (pre-rust backup, `/api/live` answering during a stats build). The golden files under `contract/golden/` are unchanged since they were recorded against TS — the commit that first added the TS recording is `C=$(git log --diff-filter=A --format=%H -- packages/monitor/skills/usage-dashboard/contract/golden/SHA256SUMS | tail -1)`, and `git diff --name-only "$C" -- packages/monitor/skills/usage-dashboard/contract/golden/ ':!packages/monitor/skills/usage-dashboard/contract/golden/live.json'` prints nothing — comparing against that commit, not `<baseRef>`, catches a golden rewritten together with its sums. A re-recorded golden would hide a Rust drift.
2. **One launch path.** The usage-dashboard skill, its OpenCode reference, `install.ts`, `setup.ts`, `statusline-decision.ts`, and `setup-statusline.ts` all use the shim's `atlas <sub>` form. No `bun …usage-dashboard/scripts/(atlas-server|api|live|rollup-update|statusline-collector|push-usage).ts` remains outside `docs/` and test fixtures that deliberately model old command lines (the statusline migration and reaper tests).
3. **Statusline migration.** `setup.ts --session-check` rewrites an existing `bun …statusline-collector.ts` command to `…/skills/cockpit/bin/cockpit atlas statusline`, keeps a wrapped user command reachable through `TOKEN_ATLAS_STATUSLINE_COMMAND`, never fresh-wires an unwired `settings.json`, and the drift watch recognizes the new form. Read the code and its tests.
4. **Data safety.** `rollup.db` is only ever written as schema v3: `rg -n 'schema_version' packages/monitor/cockpit-rs/src/atlas` shows writes only of `SCHEMA_VERSION` (3) and migration steps mirroring the TS. The pre-rust backup runs before the first Rust write and never overwrites an existing `.pre-rust.bak`. `usage_hourly` is never deleted from on replay or transcript deletion.
5. **Contract consistency.** Every env var in `_context/contracts.md` §1 is read somewhere under `packages/monitor/cockpit-rs/src/atlas/` or the reused `paths.rs` helpers (`rg -n '<NAME>'` per name). No `unwrap()`/`expect()` on external data: `rg -n 'unwrap\(\)|expect\(' packages/monitor/cockpit-rs/src/atlas` and judge each hit (tests and self-established invariants are fine). CLAUDE.md and README describe `cockpit atlas` commands, list `POST /api/pricing/refresh`, and no longer name deleted TS files.
6. **Release wiring.** `.chronicle/release.json` needs no change: atlas ships inside the already-versioned `cockpit` binary (`packages/monitor/cockpit-rs/Cargo.toml` is already a monitor version file). Confirm the Cargo.toml version equals both monitor `plugin.json` versions, and that the release workflow builds all four targets with the rustls-enabled reqwest (no OpenSSL).
7. **Leanness.** Rust modules with one caller that only forward, env vars or flags nobody sets, crates added without a `Cargo.toml` justification comment, hand-rolled code a chosen crate already provides (gzip, ETag, JSON ordering, local-time math), duplicated cockpit helpers instead of the reused `paths.rs` / `process_alive.rs` / `static_files.rs`.

### Targets

Quote `docs/atlas-rust/measurements.md` into `docs/atlas-rust/review-notes.md`: `atlas serve` RSS after one `/api/stats` build with the dashboard open (target ≤ 40 MB), Rust vs TS `/api/stats` cold build time on the same home (target Rust ≤ TS), `atlas statusline` own overhead (target ≤ 10 ms), and the real-home golden diff result over a `rollup.db` copy. A miss is acceptable only with its number and cause stated; a missing number is a failure.

### Fixing

Fix integration defects in place. Do not rewrite a module whose golden or contract tests already pass; a behavior change there needs a contract test first. Never re-record golden files here.

## Acceptance criteria

- [x] `docs/atlas-rust/review-notes.md` exists and gives each of the seven review areas above a verdict with evidence (file:line or command output).
- [x] `rg -n --glob '!*.test.ts' --glob '!docs/**' 'bun [^ ]*usage-dashboard/scripts/(atlas-server|api|live|rollup-update|statusline-collector|push-usage)\.ts' packages opencode CLAUDE.md README.md` prints nothing.
- [x] The atlas contract + golden suite passes against the Rust binary with zero failures.
- [x] `docs/atlas-rust/review-notes.md` quotes all three measured targets and the real-home golden result from `docs/atlas-rust/measurements.md` and states pass or miss for each, with the cause of any miss.
- [x] `packages/monitor/cockpit-rs/Cargo.toml` version equals the `version` in `packages/monitor/.claude-plugin/plugin.json` and `packages/monitor/.codex-plugin/plugin.json`, and `.chronicle/release.json` is unchanged: `git diff --name-only <baseRef> -- .chronicle/release.json` prints nothing.
- [x] (human) Q opens the Rust-served dashboard on real data and checks every panel, the pricing refresh button, and the live panel's click-through to cockpit.
- [x] (human) Q confirms the Claude Code statusline renders after the session-check migration rewrote `statusLine.command`.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/`
- [x] `bun test --parallel packages/monitor/ opencode/`
- [x] `bunx --bun tsc --noEmit | grep -E 'packages/monitor/skills/(usage-dashboard|install|cockpit)|opencode/'` prints nothing.
- [x] `git diff --name-only <baseRef> -- packages/monitor/cockpit-rs/src/atlas packages/monitor/skills/usage-dashboard packages/monitor/skills/install CLAUDE.md README.md` lists paths under each of those five areas.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Meets the PLAN goal < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Meets the PLAN goal | ×3 | golden or contract suite fails against Rust, golden files were re-recorded after the TS was deleted, or a target is unmeasured | parity green but a target miss is reported without its cause, or the real-home golden result is missing | parity proven by the untouched golden suite; every target met or its miss reported with number and cause |
| Integration | ×2 | a launch path still runs Bun dashboard code, or the statusline migration breaks an existing wiring | launches work but the migration fresh-wires, drops a wrapped user command, or the drift watch misses the new form | skill, OpenCode reference, install, statusline migration, and shim compose end to end |
| No regressions | ×2 | cockpit contract suite, install tests, or whole-repo monitor/opencode tests fail | tests pass but typecheck reports new errors in touched paths | every suite green; typecheck clean for touched paths |
| Consistency | ×1 | docs, contracts, and code disagree on commands, env vars, or routes | one drift (a missing env var, an undocumented route, a stale file name) | CLAUDE.md, README, contracts, and code agree everywhere |
| Leanness | ×1 | forwarding-only modules, unused config, unjustified crates, or duplicated cockpit helpers throughout | a few pieces with one caller or no justification | no abstraction without a second caller; every crate justified; cockpit helpers reused |

## Out of scope

- Cutting the release — Deferred. Reason: Q runs `/chronicle:release` for monitor with a major bump after this review.
- Re-recording golden files — Deferred. Reason: the golden files are the TS baseline; once the TS is deleted they can no longer be regenerated honestly.
- Merging the dashboard into the cockpit daemon — Deferred. Reason: the plan keeps a separate process on port 5938.

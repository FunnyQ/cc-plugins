# SHIP-02: Delete the TS, update docs, and measure

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: ship/01
> **Blocks**: review/01
> **Status**: blocked

## Goal

The repo stops carrying the Bun usage-dashboard implementation: every atlas process runs from the Rust `cockpit atlas` subcommands, the contract + golden suite runs against Rust only, the docs describe the Rust layout, and the RSS/latency targets are measured and recorded, misses included.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/scripts/*.ts` and `*.test.ts` (delete — every ported module and its unit test; the directory disappears if empty)
- `packages/monitor/skills/shared/scripts/{jsonl-lines,static-server,process-alive,path-inside,opencode}.ts` + their `*.test.ts` (delete — only each file whose last importer is gone; see the rule below)
- `packages/monitor/skills/cockpit/scripts/{http,cockpit-home}.ts` + `cockpit-home.test.ts` (delete — only if no importer remains)
- `packages/monitor/skills/usage-dashboard/contract/launcher.ts` (modify) — Rust-only default, throws when no binary.
- `packages/monitor/skills/usage-dashboard/contract/launcher.test.ts` (modify) — post-deletion mapping.
- `packages/monitor/skills/usage-dashboard/contract/record-golden.ts` (delete)
- `packages/monitor/skills/usage-dashboard/contract/fixtures.test.ts` (modify) — the provider smoke test runs `atlasCommand("stats")` instead of `bun api.ts`; tests that import TS seams (`nowMs`, URL constants) are deleted with the TS.
- `packages/monitor/skills/usage-dashboard/contract/*.contract.test.ts` (modify) — drop `skipIf(!isRust())` guards; remove or rewrite tests that spawn the TS.
- `CLAUDE.md` (modify) — commands, dashboard internals, architecture tree, Bun-prerequisite note.
- `README.md` (modify) — dashboard launch commands (~lines 148–175).
- `docs/atlas-rust/measurements.md` (new) — the measured numbers and the real-home golden result.

## Implementation notes

### Step order (do not reorder)

The TS is the only reference implementation for the measurements and the real-home check, so everything that needs it runs first.

1. **Before deleting anything**:
   - Build the release binary.
   - Run the full atlas suite against both implementations. Both must be green:
     - `bun test packages/monitor/skills/usage-dashboard/contract/`
     - `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/`
   - Take the TS-side measurements and run the real-home golden check (sections below).
   - Q authorized this task's executor to snapshot the real home into a temp root for these two checks, overriding the human-only line in `../_context/shared.md`. Every copy stays local under `/tmp/q-lab/monitor/`; nothing leaves the machine. If a permission prompt for the snapshot is denied, stop and report — do not report a plan defect.
   - If either suite is red, stop and report. Do not delete on a red suite.
2. **Delete** the TS using the importer rule below.
3. **Rewire the contract suite** to Rust-only.
4. **Update the docs.**
5. **Re-run** the Rust suite and the checks in `## Verification`.

### Deletion rule

Delete every file under `packages/monitor/skills/usage-dashboard/scripts/`. All of them are ported: `atlas-server`, `api`, `rollup-db`, `rollup-update`, `live`, `live-sessions`, `codex-cache`, `dedup`, `statusline-collector`, `project-cost`, `push-usage`, `daily-activity`, `session-files`, `rate-limits-cache`, `atlas-lifecycle`, `paths`, plus each one's `.test.ts`.

The shared and cockpit TS helpers go only when nothing outside the deletion set still imports them. Check each candidate:

```sh
rg -n "shared/scripts/<name>|cockpit/scripts/<name>|from \"\./<name>\"" --glob '*.ts' --glob '!packages/monitor/skills/usage-dashboard/scripts/**' packages opencode
```

The candidates are `jsonl-lines`, `static-server`, `process-alive`, `path-inside`, `opencode`, `http`, and `cockpit-home`.

A hit from a surviving file keeps that module. Surviving files include `install/scripts/*`, `cockpit/scripts/diagram-lint.ts`, `cockpit/bin/cockpit.test.ts`, `opencode/*`, and `chronicle`. Record each kept module and its importer under `## Kept TS` in `docs/atlas-rust/measurements.md`.

Two hits are already known when this plan was written:

- `cockpit/scripts/cockpit-home.test.ts` tests the module it sits next to, so it goes with that module.
- `cockpit/bin/cockpit.test.ts` needs checking: if it imports `cockpit-home.ts`, that module stays.

Delete a test file together with the module it tests. Never delete a test whose module stays.

### Contract launcher after deletion

- `COCKPIT_BIN` set → unchanged: `[COCKPIT_BIN, "atlas", sub, ...args]`.
- `COCKPIT_BIN` unset → default to the absolute `<repo>/packages/monitor/cockpit-rs/target/release/cockpit`.
  - If that file is missing, throw at import time with exactly `atlas contract suite: no binary — run cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml or set COCKPIT_BIN`.
  - A silent skip is forbidden: a green suite that tested nothing is the failure this suite exists to prevent.
  - Add a one-line comment in `launcher.ts` saying why there is no TS fallback.
- Remove the TS script mapping (`serve → atlas-server.ts`, and the rest).
- Keep `isRust()` exported and make it always `true`, so no importer breaks.
- `launcher.test.ts`:
  - With `COCKPIT_BIN` set, the mapping stays as above.
  - With it unset, the first element is the absolute default path.
  - The missing-binary error is asserted in a child `bun` process that imports the launcher where the default path is absent; it must exit non-zero with the exact message.
  - No assertion names a `.ts` script.

### Golden files become the permanent fixture

- Delete `contract/record-golden.ts`. It needs the TS engine, which is gone.
- Keep every existing file under `contract/golden/` unchanged and committed. They are the parity reference from now on. The one allowed addition is `contract/golden/live.json`, recorded from the TS `live.ts` during step 1 on a fixture home extended by `extendLiveFixture(home)` from `contract/live-fixture.ts` — the same helper the live test uses, so every status and registry tag stays covered.
- Add one line at the top of `golden.contract.test.ts` saying that regenerating golden files now means writing Rust output over them and reviewing that diff by hand, because no reference implementation remains.
- Turn every `test.skipIf(!isRust())(…)` into a plain `test(…)`. This covers the live-during-stats-build test and the pre-rust backup test.
- Tests that spawn the TS to diff against Rust, such as a differential `atlas live` test, can no longer run. Rewrite the live one to compare Rust `atlas live` against `contract/golden/live.json` (recorded in step 1, with fixture-root normalization); delete any other.

### Docs

Change runtime invocations only. Leave history alone: nothing under `docs/` except `measurements.md`, and nothing in `CHANGELOG.md`.

**`CLAUDE.md`**

- **Commands block**:
  - Replace `bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts` with `packages/monitor/skills/cockpit/bin/cockpit atlas serve   # [--port N] [--no-open]`.
  - Replace `bun …/api.ts` with `… atlas stats`, and `bun …/live.ts` with `… atlas live`.
  - Replace `bun …/rollup-update.ts [--rebuild]` with `… atlas rollup-update [--rebuild]`.
  - Add the atlas contract suite commands, with and without `COCKPIT_BIN`.
  - Replace `bun test packages/monitor/skills/usage-dashboard/scripts/rollup-update.test.ts` with the golden-suite command.
- **"Monitor: dashboard internals"**:
  - Engine files now live in `packages/monitor/cockpit-rs/src/atlas/`. Name the modules: `stats.rs`, `rollup_db.rs`, `rollup_update.rs`, `codex.rs`, `live.rs`, `server.rs`, `statusline.rs`.
  - Add `POST /api/pricing/refresh` to the route list in data-flow step 3, which today names only `/api/stats` and `/api/live`.
  - Keep every rollup rule and both tables unchanged; the behavior did not change.
  - Replace `atlas-server.ts` and `api.ts` names in prose with the Rust modules.
  - The "Bun-only runtime" design decision becomes: the dashboard server is Rust; Bun is still required for the contract suite, `install/`, and `diagram-lint.ts`.
- **Architecture tree**: replace the `usage-dashboard/scripts/` listing with `contract/` (suite + `golden/`), and add `atlas/` under `cockpit-rs/`.
- **Bun prerequisite**: find the sentence saying Bun is still required because of usage-dashboard, and remove usage-dashboard from its reasons.

**`README.md`**: replace the dashboard launch and CLI lines (~148–175) with the shim forms above.

**`usage-dashboard/SKILL.md`**: it already launches through the shim, so do not edit it. Only confirm that `rg` finds no script path in it.

### Measurements (`docs/atlas-rust/measurements.md`)

Measure on macOS arm64 with the release build.

- Use a temp `COCKPIT_HOME`.
- Use a free port.
- Run every measurement under a root built by the real-data recipe in `../_context/shared.md`; one fresh root per implementation.
- Never touch port 5938.
- Never let a measurement write the real rollup DB.

Drive each measurement from a bun script outside the repo, never a shell pipeline. `$!` of a backgrounded pipeline is the subshell's pid, so `ps` would read the wrong process.

| Metric | How | Target | Baseline |
|---|---|---|---|
| `atlas serve` RSS | Start the server, fetch `/api/stats` once (the dashboard's first load), keep one `/api/live` poll going, then take the max of 5 readings of `ps -o rss= -p <pid>`, 1 s apart | ≤ 40 MB | 197 MB (TS, 2026-10-01) |
| `/api/stats` cold build | First request after launch, wall time. Take the median of 3 launches for each implementation on the same home and the same DB copy. TS is measured in step 1. | Rust ≤ TS | measured TS |
| `atlas statusline` overhead | With `TOKEN_ATLAS_STATUSLINE_COMMAND=true`, pipe a fixture statusline JSON to the subcommand 20 times and take the median wall time. Set the nudge markers fresh first so no nudge spawns. Measure `sh -c true` the same way and subtract it; record total, baseline, and net. The target applies to net. | ≤ 10 ms net | TS `bun statusline-collector.ts` median, measured in step 1 |

Record each number, its target, and PASS or MISS. A miss is reported plainly, with the measured gap. It is never rounded into a pass and never omitted.

### Real-home golden check (step 1, before deletion)

1. Build two roots from the same snapshot with the real-data recipe in `../_context/shared.md`, following its TS-vs-Rust comparison steps (frozen snapshot, network cut, one `TOKEN_ATLAS_NOW_MS`, the two extra stripped keys).
2. Run `bun packages/monitor/skills/usage-dashboard/scripts/api.ts` under the first root's env.
3. Run `packages/monitor/cockpit-rs/target/release/cockpit atlas stats` under the second root's env.
4. Normalize each output's root prefix to a placeholder (the `normalizeFixturePaths` helper in `contract/golden.ts` with the root dir).
5. Parse both outputs and delete the paths in `contract/golden/volatile-keys.json`.
6. Deep-compare the two results.
7. Record `equal` or the list of differing paths in `measurements.md`.

A difference is a blocking finding. Report it; do not delete the TS over it.

## Acceptance criteria

- [ ] Before any deletion, the atlas contract suite was green against both TS and Rust, and `docs/atlas-rust/measurements.md` records that run.
- [ ] Every file under `packages/monitor/skills/usage-dashboard/scripts/` is deleted. Every shared or cockpit TS helper with no remaining importer is deleted. Every helper that was kept is listed under `## Kept TS` in `docs/atlas-rust/measurements.md`, with the file that imports it.
- [ ] With `COCKPIT_BIN` unset, the contract launcher runs the locally built binary. It throws the exact missing-binary message when that binary is absent. No test in `contract/` is skipped on `isRust()`.
- [ ] `contract/record-golden.ts` is deleted. Every pre-existing `contract/golden/` file is unchanged; `contract/golden/live.json` is the only new one.
- [ ] `rg -ln 'atlas-server\.ts|scripts/api\.ts|statusline-collector\.ts|rollup-update\.ts' packages/ opencode/ CLAUDE.md README.md | grep -vE 'install/scripts/(statusline-decision|setup|reap-stale)(\.test)?\.ts$'` prints nothing (the allowed legacy references in `../_context/contracts.md` §7).
- [ ] `docs/atlas-rust/measurements.md` records all three metrics with target and PASS/MISS, the TS baselines, and the real-home golden result.
- [ ] `CLAUDE.md` documents `cockpit atlas serve|stats|live|rollup-update`, `POST /api/pricing/refresh`, and the `cockpit-rs/src/atlas/` location.
- [ ] (human) Q reads `docs/atlas-rust/measurements.md` and accepts any MISS it records, or asks for a follow-up.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/` passes with `COCKPIT_BIN` unset. After deletion this runs the Rust binary, with 0 skipped.
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/` passes.
- [ ] `bun test packages/monitor/skills/install/scripts/` passes.
- [ ] `bun test --parallel packages/monitor/` passes.
- [ ] `rg -ln 'atlas-server\.ts|scripts/api\.ts|statusline-collector\.ts|rollup-update\.ts' packages/ opencode/ CLAUDE.md README.md | grep -vE 'install/scripts/(statusline-decision|setup|reap-stale)(\.test)?\.ts$'` prints nothing (the allowed legacy references in `../_context/contracts.md` §7).
- [ ] `rg -ln "statusline-collector\.ts" --glob '!*.test.ts' packages/ opencode/ CLAUDE.md README.md` lists at most `packages/monitor/skills/install/scripts/statusline-decision.ts` and `packages/monitor/skills/install/scripts/setup.ts`.
- [ ] `bunx --bun tsc --noEmit | grep -E "usage-dashboard|shared/scripts|install/scripts|cockpit/scripts"` prints nothing.
- [ ] `test ! -e packages/monitor/skills/usage-dashboard/scripts/api.ts && test -f docs/atlas-rust/measurements.md && grep -cE "PASS|MISS" docs/atlas-rust/measurements.md` prints at least `3`.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | TS deleted on a red suite, a still-imported helper deleted (a typecheck or test breaks), or the launcher silently skips with no binary | Deletion and launcher correct, but a live doc or README reference still names a deleted script, or a Rust-only guard survives | Suite green against Rust with 0 skips; every deletion justified by the importer check; no live reference remains; launcher throws the exact message |
| Test coverage | ×2 | Suite not re-run after deletion | Suite re-run but the launcher's missing-binary path, or the formerly Rust-only tests, are unexercised | Launcher self-test covers both mappings and the missing-binary error; every formerly skipped test now runs; TS-differential tests rewritten against golden or removed with a stated reason |
| Interface & readability | ×1 | Launcher keeps dead TS-mapping code | Dead code gone but `isRust()` removed and importers broken | Launcher is minimal, `isRust()` kept for importers, one why-comment on the missing TS fallback |
| Assumptions & docs | ×1 | Measurements missing or a MISS hidden | Numbers present but method, baseline, or kept-TS list missing | `measurements.md` records method, baselines, PASS/MISS with the gap, the real-home golden result, and each kept TS file with its importer; `CLAUDE.md` matches the Rust layout |

## Out of scope

- Cutting the release, bumping versions, and adding a CHANGELOG entry. Reason: Q runs `/chronicle:release` for monitor, which writes the version bump and changelog.
- Editing past plans under `docs/` or `CHANGELOG.md` history. Reason: they record what was true when they were written.
- Changing the SPA or any Rust behavior to hit a missed target. Reason: this task reports misses. A fix is a separate decision for Q.

# REVIEW-01: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: ship/04
> **Status**: todo
> **Final review**: true
> **Models**: judge=opus/high, fix=opus/high

## Goal

Confirm the whole rewrite composes: every cockpit process now runs from the one Rust binary through the shim, the contract suite proves parity, nothing outside cockpit regressed, and the memory goals are met or honestly reported.

## Files to create / modify

- `docs/cockpit-rust/review-notes.md` (new) — findings, the diff scope reviewed, the measured RSS numbers quoted from `docs/cockpit-rust/rss.md`, and every human check still owed.
- Any file in the change set (modify) — only to fix an integration defect found here; each fix is listed in `docs/cockpit-rust/review-notes.md`.

## Implementation notes

### What to review

`<baseRef>` is the commit the rewrite started from. Autopilot substitutes it with the run's start commit. When run by hand, use the parent of the first commit that added the crate: `git rev-parse "$(git log --format=%H --diff-filter=A -- packages/monitor/cockpit-rs/Cargo.toml | tail -1)^"`. Every diff below uses that same value.

Review the leg's diff, not individual tasks: `git diff --stat <baseRef> -- packages/ opencode/ .github/ .chronicle/ CLAUDE.md .gitignore`.

Check, in this order:

1. **One launch path.** Every harness entry — Claude `plugin.json` mcpServers and hooks, Codex `hooks.json`, `opencode/plugin.ts`, the cockpit skill and its references, both `nudge.md` commands, `monitor-up.ts` — launches `skills/cockpit/bin/cockpit`. No `bun …cockpit-server.ts|cockpit-channel.ts|cockpit.ts|decision-log-start.ts|scribe-nudge.ts|find-session.ts` remains outside `docs/`.
2. **Mixed-fleet safety.** A Claude session still running a monitor 5.x TS channel next to the new Rust daemon: `daemon.json.root` keeps the `<plugin root>/skills/cockpit/scripts` shape, so the TS channel's version rule sees a newer daemon and does not supersede it. Confirm by reading the Rust daemon-info writer and the version-parse code.
3. **Outside consumers.** usage-dashboard (`atlas-server.ts`, `live.ts`) still imports `cockpit-home.ts` and `http.ts`, which still exist; `reap-stale.ts` matches both the old `.ts` and the new `bin/<version>/cockpit (server|channel)` process lines; chronicle's `cockpit-trail.ts` still parses a trail the Rust CLI wrote.
4. **Release wiring.** `.chronicle/release.json` lists `packages/monitor/cockpit-rs/Cargo.toml` (`kind: "toml"`) under monitor; `Cargo.toml` version equals both monitor `plugin.json` versions; the CI workflow's asset names match the shim's download names exactly.
5. **Leanness.** Look for Rust modules with one caller that only forward, config or env vars nobody sets, crates added without a justification comment, and hand-rolled code a chosen crate already provides.

### Fixing

Fix integration defects in place. Do not re-score or rewrite a port that its own contract group already passes; a behavior change there needs a contract test first.

## Acceptance criteria

- [ ] `docs/cockpit-rust/review-notes.md` exists and lists each of the five review areas above with a verdict and evidence (file:line or command output).
- [ ] `rg -n --glob '!*.test.ts' 'bun [^ ]*cockpit/scripts/(cockpit|cockpit-server|cockpit-channel|decision-log-start|scribe-nudge|find-session)\.ts' packages opencode CLAUDE.md` prints nothing. Test fixtures are excluded on purpose: the reaper keeps tests that match old TS process lines.
- [ ] The full contract suite passes against the Rust binary.
- [ ] `packages/monitor/cockpit-rs/Cargo.toml` version equals the `version` in `packages/monitor/.claude-plugin/plugin.json` and `packages/monitor/.codex-plugin/plugin.json`.
- [ ] `docs/cockpit-rust/review-notes.md` quotes both RSS numbers from `docs/cockpit-rust/rss.md` against the targets (channel ≤ 10 MB, server ≤ 30 MB) and states pass or miss for each.
- [ ] (human) Q runs one real Claude Code session with the plugin's shim and `COCKPIT_BIN` pointing at the release build: a dashboard message arrives, a permission prompt is approved from the cockpit, and the dashboard panels render.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit COCKPIT_PLUGIN_ROOT=$PWD/packages/monitor bun test packages/monitor/skills/cockpit/contract/`
- [ ] `bun test packages/monitor/ opencode/`
- [ ] `git diff --name-only <baseRef> -- packages/monitor/cockpit-rs/Cargo.toml packages/monitor/skills/cockpit/bin/cockpit .github/workflows/cockpit-release.yml` lists all three paths.
- [ ] `bunx --bun tsc --noEmit | grep -E 'packages/monitor/skills/(cockpit|install|usage-dashboard)|opencode/'` prints nothing.

## Eval rubric

> Scale 0–5 (see `../_context/rubric.md`); weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | a harness still launches Bun cockpit code, or the contract suite fails against Rust | suite green but an outside consumer (usage-dashboard, reap-stale, chronicle trail reader) breaks or the mixed-fleet root rule drifts | all five review areas verified with evidence |
| Meets the PLAN goal | ×2 | RSS not measured | measured but a miss is unexplained | both targets met, or a miss is reported with the number and the cause |
| No regressions | ×2 | monitor or opencode tests fail | tests pass but typecheck reports new errors in touched paths | tests and typecheck clean for every touched path |
| Consistency | ×1 | Cargo, plugin.json, release.json, CI asset names, and shim disagree | one naming or version drift | every name and version agrees |
| Leanness | ×1 | forwarding-only modules, unused config, unjustified crates throughout | a few pieces with one caller or no justification | no abstraction without a second caller; every crate justified |

## Out of scope

- Cutting the release — Deferred. Reason: Q runs `/chronicle:release` for monitor with a major bump after this review.
- Clean-machine install — Deferred. Reason: the shim test already covers download, checksum, and fail-soft with a local server; a real run needs a pushed tag.

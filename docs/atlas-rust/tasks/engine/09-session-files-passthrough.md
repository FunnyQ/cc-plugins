# ENGINE-09: Pass Claude session files through whole

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: engine/08, server/01
> **Blocks**: ship/02
> **Status**: done

## Goal

`atlas/session_files.rs` keeps every key of each `~/.claude/sessions/*.json` object, as TS `readSessionFiles()` does, so `/api/stats` `sessions.*` and every other consumer carry the same fields as the TS output. The fixture suite catches a dropped key.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/session_files.rs` (modify) — keep the whole JSON object.
- `packages/monitor/cockpit-rs/src/atlas/stats.rs`, `packages/monitor/cockpit-rs/src/atlas/live.rs` (modify only where the type change requires it).
- `packages/monitor/skills/usage-dashboard/contract/fixtures.ts` (modify) — add unknown keys to the fixture session files.
- `packages/monitor/skills/usage-dashboard/contract/golden/**` (regenerate) — re-record from TS with `bun packages/monitor/skills/usage-dashboard/contract/record-golden.ts`, never from Rust.

## Implementation notes

Found by the real-home golden check before TS deletion: real session files carry `procStart`, `peerProtocol`, `peerFeatures`, `pidDomain`, `messagingSocketPath`, `name`, `nameSource`, `nameSince`, and `statusUpdatedAt`, which the Rust payload drops because it deserializes into a fixed struct. 54 paths differed.

- TS (`scripts/session-files.ts`) validates only `sessionId: string`, `cwd: string`, `startedAt: number`, skips a file failing that or failing to parse, and pushes the parsed object unchanged. Match that: keep the typed fields Rust code reads, plus the full object (for example a `#[serde(flatten)] extra: serde_json::Map<String, Value>`, or the raw `Value` alongside), and serialize the full object wherever TS emits it.
- Keep key order as the source file has it where the serializer allows; deep-equality ignores object key order, so this is not a gate.
- Check whether `/api/live` emits session-file objects too. If TS passes them through there, Rust must as well; if TS picks fields, keep Rust's pick.
- In `fixtures.ts`, add at least two unknown keys to each fixture session file — one string, one nested object — then re-record the goldens from TS. Only goldens that contain session-file data may change; if any other golden changes, stop and report it.

## Acceptance criteria

- [x] Under the fixture home, `cockpit atlas stats` deep-equals the re-recorded TS `stats.json`, including the unknown session keys.
- [x] A session file missing `sessionId`, `cwd`, or a numeric `startedAt`, or holding malformed JSON, is skipped, as in TS. A `cargo test` covers each case and the unknown-key passthrough.
- [x] Only golden files containing session-file data changed in the re-record.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `bun test packages/monitor/skills/usage-dashboard/contract/`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | unknown keys still dropped, or goldens recorded from Rust | stats passes through but `/api/live` diverges from TS, or the skip rules drift | both suites green against TS and Rust; every consumer emits what TS emits; skip rules match |
| Test coverage | ×2 | no fixture key the old struct would drop | fixture covers it but no `cargo test` for the skip cases | fixture has string and nested unknown keys; units cover every skip branch |
| Interface & readability | ×1 | `unwrap` on file or JSON data | a second parallel type added where one would do | one type, typed access where Rust reads fields, clippy clean |
| Assumptions & docs | ×1 | silent change to another golden | changed goldens not named in the log note | the log note names every regenerated golden file |

## Out of scope

- Cost-sum float order. Reason: Q accepted a 1e-9 relative tolerance for the real-home check; the fixture goldens already match exactly.
- The serve RSS miss (77.8 MB against 40 MB). Reason: Q accepted it on 2026-10-01.

# SHIP-02: CI release workflow

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: ship/01
> **Blocks**: ship/04
> **Status**: done

## Goal

Pushing a `monitor-v<version>` tag makes GitHub Actions build the `cockpit` binary for all four targets and attach them, with a `SHA256SUMS` file, to that tag's GitHub release. These are the exact assets the shim downloads.

## Files to create / modify

- `.github/workflows/cockpit-release.yml` (new) — the tag-triggered build and upload workflow.
- `packages/monitor/cockpit-rs/scripts/build-release.sh` (new, mode `100755`) — builds one target and writes `cockpit-<triple>` into an output dir. CI calls it, and so do local tests.
- `.chronicle/release.json` (modify) — add the crate manifest to monitor's `versionFiles`.
- `packages/monitor/skills/cockpit/bin/cockpit.test.ts` (modify) — add one case that serves `build-release.sh` output to the shim.

## Implementation notes

### Why the verification is indirect

CI cannot run before a real tag exists, and pushing a tag publishes a release, which is outward-facing and not this task's call. So the workflow is checked statically: `actionlint`, or a YAML parse. The build steps live in `build-release.sh`, which the workflow calls verbatim, so running that script locally exercises the same commands the runner will. Keep all build logic in the script. The YAML should contain only runner setup, a matrix, a call to the script, and the upload.

### `build-release.sh`

```sh
# usage: build-release.sh <target-triple> <out-dir> [--zig]
```

- `#!/bin/sh`, `set -eu`, POSIX only.
- Resolve the crate dir relative to the script (`cd -P "$(dirname "$0")/.."`).
- Build with `cargo build --release --locked --target <triple> --manifest-path <crate>/Cargo.toml`. With `--zig`, build with `cargo zigbuild` instead, using the same flags.
- Copy `target/<triple>/release/cockpit` to `<out-dir>/cockpit-<triple>`.
- Do not write `SHA256SUMS` here. A single step computes it over all four assets, so the file lists every target. For local use, add a second tiny mode instead: `build-release.sh --sums <out-dir>`. It writes `<out-dir>/SHA256SUMS` in `sha256sum` format (`<hex>  <filename>`, two spaces, one line per `cockpit-*`, sorted by filename). Use `shasum -a 256` on macOS and `sha256sum` elsewhere, and normalize to that format.
- The release profile (`opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `strip = "symbols"`, `panic = "abort"`) already lives in `Cargo.toml`. Do not repeat it as flags.

### Workflow `.github/workflows/cockpit-release.yml`

- Trigger: `on: push: tags: ['monitor-v*']`. Also add `workflow_dispatch` with a `tag` input, so a failed run can be re-driven for an existing tag without re-tagging. Resolve `TAG` once in a first job (`github.ref_name` on push, `inputs.tag` on dispatch) and expose it as a job output; every build and release job runs `actions/checkout` with `ref:` set to that output, so a dispatch from any branch builds exactly the tagged source. The static check asserts every `actions/checkout` step in the file carries that `ref`.
- `permissions: contents: write`.
- Job `build`, a matrix of four entries:
  - `macos-14` → `aarch64-apple-darwin` (native)
  - `macos-14` → `x86_64-apple-darwin` (via `rustup target add`; Apple's linker ad-hoc-signs both)
  - `ubuntu-latest` → `x86_64-unknown-linux-musl` (`--zig`)
  - `ubuntu-latest` → `aarch64-unknown-linux-musl` (`--zig`)
- Darwin targets must build on a macOS runner. A darwin binary cross-linked from Linux has no ad-hoc signature, and arm64 macOS kills it (`Killed: 9`).
- Linux setup: install zig (`mlugg/setup-zig` or `goto-bus-stop/setup-zig`, pinned to a release tag) and `cargo install cargo-zigbuild --locked`. Use `rustup target add` for the triple.
- Each matrix job runs `packages/monitor/cockpit-rs/scripts/build-release.sh <triple> dist [--zig]`, then uploads `dist/cockpit-<triple>` with `actions/upload-artifact`.
- Job `release`, `needs: build`, on `ubuntu-latest`:
  - Download all artifacts into one dir.
  - Run `build-release.sh --sums <dir>`.
  - Create the release if it is missing: `gh release view "$TAG" || gh release create "$TAG" --title "$TAG" --notes "cockpit binaries for $TAG" --verify-tag`.
  - Run `gh release upload "$TAG" <dir>/cockpit-* <dir>/SHA256SUMS --clobber`.
  - Set `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Take `TAG` from `github.ref_name`, or from the dispatch input.
- Guard: before building, a step checks that the tag's version (`monitor-v6.0.0` → `6.0.0`) equals both `packages/monitor/.claude-plugin/plugin.json` `version` and the `version` in `packages/monitor/cockpit-rs/Cargo.toml`, and fails the run otherwise. The shim downloads by the `plugin.json` version, so a mismatch would publish assets no shim ever asks for.
- Pin every third-party action to a major tag (`actions/checkout@v4` and so on). `dtolnay/rust-toolchain@stable` is fine for the toolchain.

### `.chronicle/release.json`

In the component whose `"name": "monitor"`, append to `versionFiles`:

```json
{ "path": "packages/monitor/cockpit-rs/Cargo.toml", "kind": "toml" },
{ "path": "packages/monitor/cockpit-rs/Cargo.lock", "pattern": "name = \"cockpit\"\\nversion = \"([^\"]+)\"" }
```

Keep 2-space indentation and the existing two `plugin.json` entries. The lock entry is a name-anchored pattern, never `kind: "toml"`: a lock has one `version = ` line per crate, and only the block under `name = "cockpit"` may move. Without it, a bump leaves the lock's own package version stale and `cargo build --locked` fails. Add a test (in the shim suite or a small bun test beside `build-release.sh`) that copies the crate to a temp dir, rewrites both files the way the two entries would, and runs `cargo build --locked` successfully (skipped when `cargo` is absent). `/chronicle:release` then bumps the crate version together with both `plugin.json` files, which keeps `cockpit --version` equal to the shim's version.

### Added shim test case

Add one `test` to the existing shim suite, `release script assets are shim-compatible`. It is skipped with `test.skipIf(!hasCargo)` when `cargo` is absent, and it:

1. Computes the target with the shim's own `uname` mapping (never `rustc -vV`'s host triple, which is `*-linux-gnu` on Linux). It runs only when that target is a darwin target (the dev machines); on Linux it is skipped with the reason `musl build needs cargo-zigbuild; covered by CI`. Runs `build-release.sh <that target> <tmp>` and then `build-release.sh --sums <tmp>`.
2. Serves `<tmp>` under `/monitor-v<version>/` from the suite's fake server. `<version>` comes from the fake `plugin.json` the case writes.
3. Runs the shim with `--version`.
4. Expects exit 0 and stdout containing the crate version.

This proves the asset name, the sums format, and the shim's verify step agree end to end. The case writes the fake `plugin.json` version equal to the crate's `Cargo.toml` version, which it reads with a regex.

## Acceptance criteria

- [x] `.github/workflows/cockpit-release.yml` triggers on `monitor-v*` tags, builds all four triples, darwin on a macOS runner and linux musl via cargo-zigbuild, and uploads `cockpit-<triple>` plus `SHA256SUMS` with `gh release upload --clobber`.
- [x] The workflow fails before building when the tag version differs from either `plugin.json` or `Cargo.toml`.
- [x] `build-release.sh <host triple> <dir>` produces `<dir>/cockpit-<host triple>`. `--sums <dir>` writes a `sha256sum`-format file that `sha256sum -c` or `shasum -a 256 -c` accepts from inside `<dir>`.
- [x] `.chronicle/release.json` lists `packages/monitor/cockpit-rs/Cargo.toml` with `kind: "toml"` under monitor, and nowhere else.
- [x] The new shim test case passes: the shim downloads, verifies, and execs a binary built by the release script.

## Verification

- [x] `command -v actionlint >/dev/null && actionlint .github/workflows/cockpit-release.yml || bun -e 'const y=require("fs").readFileSync(".github/workflows/cockpit-release.yml","utf8"); Bun.YAML ? Bun.YAML.parse(y) : (()=>{throw new Error("no YAML parser")})(); console.log("yaml ok")'`
- [x] `sh -n packages/monitor/cockpit-rs/scripts/build-release.sh && test -x packages/monitor/cockpit-rs/scripts/build-release.sh`
- [x] `T=$(mktemp -d) && H=$(rustc -vV | sed -n 's/^host: //p') && packages/monitor/cockpit-rs/scripts/build-release.sh "$H" "$T" && packages/monitor/cockpit-rs/scripts/build-release.sh --sums "$T" && (cd "$T" && (shasum -a 256 -c SHA256SUMS 2>/dev/null || sha256sum -c SHA256SUMS))`
- [x] `bun -e 'const c=JSON.parse(require("fs").readFileSync(".chronicle/release.json","utf8")); const m=c.components.find(x=>x.name==="monitor"); if(!m.versionFiles.some(f=>f.path==="packages/monitor/cockpit-rs/Cargo.toml"&&f.kind==="toml")) process.exit(1)'`
- [x] `bun test packages/monitor/skills/cockpit/bin/cockpit.test.ts`

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong asset names, darwin cross-linked from Linux, or sums in a format the shim rejects | Builds are right but the version guard or release-creation step is missing | Four triples on the right runners, version guard, idempotent release create plus `--clobber` upload, sums accepted by the shim |
| Test coverage | ×2 | Workflow never parsed and script never run | Script run by hand only | actionlint or YAML parse, a script build with checksum self-check, and the shim end-to-end case |
| Interface & readability | ×1 | Build logic duplicated between YAML and script | Script works but the YAML carries build flags | YAML is a thin matrix over one script; actions pinned |
| Assumptions & docs | ×1 | No note on why darwin needs macOS runners | Some whys missing | One-line whys for the runner choice, the Cargo.lock exclusion, and the version guard |

## Out of scope

- Pushing a tag or cutting a release. Deferred: the owner runs `/chronicle:release` after the final review, because a release is outward-facing.
- Code signing or notarization. Deferred: the linker's ad-hoc signature is the accepted bar.
- Windows targets. Deferred: out of scope for the whole rewrite.

# SHIP-01: sh shim and download

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01
> **Blocks**: ship/02, ship/03
> **Status**: todo

## Goal

Every harness launches cockpit through one POSIX sh shim, which execs a cached Rust binary or downloads and checksum-verifies the right one from the GitHub release, and fails soft when it cannot.

## Files to create / modify

- `packages/monitor/skills/cockpit/bin/cockpit` (new, git mode `100755`) — the shim, implementing `_context/contracts.md` §7 step for step.
- `packages/monitor/skills/cockpit/bin/cockpit.test.ts` (new) — bun test suite driving the shim against a local fake release server.

## Implementation notes

### Shim behavior (contracts.md §7, restated)

1. `COCKPIT_BIN` set → `exec "$COCKPIT_BIN" "$@"`. Nothing else runs: no plugin-root lookup, no download.
2. `COCKPIT_PLUGIN_ROOT="$(cd -P "$(dirname "$0")/../../.." && pwd)"`; export it. `cd -P` resolves symlinks, so OpenCode's `~/.config/opencode/skills/cockpit/bin/cockpit` (reached through a symlinked skill dir) lands on the real `packages/monitor` dir. When `$0` itself is a symlink to the shim, resolve it first with a `readlink` loop. macOS `readlink` has no `-f`, so the loop is required.
3. Version: the `"version"` value from `$COCKPIT_PLUGIN_ROOT/.claude-plugin/plugin.json`, extracted with `sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1`. Do not use jq, which is not a prerequisite. An empty result → stderr `cockpit: cannot read version from <path>`, exit 1.
4. Target triple from `uname -s` and `uname -m`:
   - `Darwin arm64` → `aarch64-apple-darwin`
   - `Darwin x86_64` → `x86_64-apple-darwin`
   - `Linux x86_64` → `x86_64-unknown-linux-musl`
   - `Linux aarch64` or `Linux arm64` → `aarch64-unknown-linux-musl`
   - anything else → stderr `cockpit: unsupported platform <os>/<arch>`, exit 1.
5. Binary: `BIN_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/q-lab/cockpit/bin/<version>"`, binary `$BIN_DIR/cockpit`. If it exists and is executable → `exec "$BIN_DIR/cockpit" "$@"`.
6. Download function:
   - Base is `${COCKPIT_RELEASE_BASE_URL:-https://github.com/FunnyQ/cc-plugins/releases/download}`.
   - Fetch `$BASE/monitor-v<version>/cockpit-<target>` and `$BASE/monitor-v<version>/SHA256SUMS` with `curl -fsSL` into a `mktemp -d "$BIN_DIR.tmp.XXXXXX"` dir. That dir is a sibling of `BIN_DIR`, so the final `mv` is a same-filesystem rename.
   - `SHA256SUMS` uses `sha256sum` format: `<hex>  cockpit-<target>`. Pick the line for this target and compare hashes. Use `shasum -a 256` when present (macOS), else `sha256sum` (Linux).
   - On a mismatch, print `checksum mismatch` as the reason, remove the temp dir, and install nothing.
   - On success: `chmod +x`, `mkdir -p "$BIN_DIR"`, `mv` the file to `$BIN_DIR/cockpit`, remove the temp dir.
   - Before taking the lock, `mkdir -p "$(dirname "$BIN_DIR")"` — on a clean install `$XDG_DATA_HOME/q-lab/cockpit/bin` does not exist, and both the lock dir and the temp dir live beside `BIN_DIR`. The first-download test starts with that whole parent absent.
   - Lock: `mkdir "$BIN_DIR.lock"` guards the download. If the lock exists and is older than 120 s, remove it and retry once. Detect age with `find "$BIN_DIR.lock" -maxdepth 0 -mmin +2`, which works on both BSD and GNU find. If a fresh lock exists, another process is downloading: poll every 0.5 s for `$BIN_DIR/cockpit` until the caller's budget ends.
   - Always release the lock with `trap … EXIT INT TERM`.
7. The first argument is `hook` and the binary is missing:
   - Run the download function in the background, detached from the harness: `nohup sh "$0" __download >/dev/null 2>&1 &`, or an equivalent subshell.
   - Then `exit 0` with no stdout and no stderr.
   - A hook must never block: SessionStart has a 5 s timeout.
8. Any other first argument and the binary is missing:
   - Run the download in the foreground with a 30 s total budget. Pass `curl --max-time` from the remaining budget, and bound any lock wait by the same budget.
   - On success → `exec`.
   - On failure → exactly one stderr line, `cockpit: binary for <version>/<target> unavailable (<reason>); retry later or set COCKPIT_BIN`, and exit 1.
   - `<reason>` is one of `download failed`, `checksum mismatch`, `timed out waiting for another download`.

- Write only POSIX sh: `#!/bin/sh`, `set -eu`, no bashisms (`[[`, arrays, `local`, `$'…'`).
- If `shellcheck` is on PATH, `shellcheck -s sh` must be clean.
- Commit the file with mode `100755`: `chmod +x` it, then verify with `git ls-files -s` once it is staged by the commit agent. The executor checks the working-tree mode.
- An internal `__download` first argument is allowed for the background path. It is not a public subcommand.

### Test suite (`cockpit.test.ts`)

This suite replaces the clean-machine install check that nobody will run by hand, so it must cover every branch of the shim.

Harness:
- A per-test temp root holding a fake plugin root. Copy the shim to `<tmp>/monitor/skills/cockpit/bin/cockpit` and write `<tmp>/monitor/.claude-plugin/plugin.json` with `{"version":"9.9.9"}`.
- A temp `XDG_DATA_HOME`, and `HOME` pointed at a temp dir so the real `~/.local/share` is never touched.
- A fake "binary": a tiny sh script that prints `FAKE $COCKPIT_PLUGIN_ROOT $*` and exits 0.
- `Bun.serve` on port 0 serves `/monitor-v9.9.9/cockpit-<host triple>` and `/monitor-v9.9.9/SHA256SUMS`, and counts requests.
- Spawn the shim with `COCKPIT_RELEASE_BASE_URL=http://127.0.0.1:<port>`.

Cases, each its own `test`:
1. **COCKPIT_BIN exec**: the shim runs `$COCKPIT_BIN` with the args, and the server receives 0 requests.
2. **Cached binary**: pre-placed `$XDG_DATA_HOME/q-lab/cockpit/bin/9.9.9/cockpit` is exec'd, and the server receives 0 requests.
3. **Download + verify + install**: output starts with `FAKE <resolved plugin root>`; the binary is now in the bin dir and executable; a second run makes 0 new requests.
4. **Checksum mismatch**: the server serves a wrong hash. Expect exit 1, the stderr line containing `checksum mismatch`, and nothing installed.
5. **Hook fail-soft**: `cockpit hook session-start` with no binary. Expect exit 0, empty stdout and stderr, and an elapsed time under 1 s. Then poll up to 5 s until the background download installs the binary.
6. **Foreground failure**: the server returns 404. Expect exit 1 and stderr equal to exactly one line matching `^cockpit: binary for 9\.9\.9/[^ ]+ unavailable \(download failed\); retry later or set COCKPIT_BIN$`.
7. **Unsupported platform**: put a `uname` stub first in PATH that prints `Plan9` or `mips`. Expect exit 1 and stderr `cockpit: unsupported platform Plan9/mips`.
8. **Symlinked invocation**: symlink `<tmp>/link/cockpit` to the skill dir, and separately symlink a whole `skills/cockpit` dir, as OpenCode's install does. `COCKPIT_PLUGIN_ROOT` printed by the fake binary equals the real `<tmp>/monitor` path (`realpathSync`).
9. **Concurrent lock**:
   - Two shims start at once with no binary, and the server delays its response 300 ms.
   - Both exit 0 with the fake output, and the binary asset is fetched exactly once.
   - A stale lock dir with mtime 5 min old is removed and the download proceeds.

The host triple in tests comes from the same `uname` mapping, computed in TS. Skip no case on macOS or Linux.

## Acceptance criteria

- [ ] `packages/monitor/skills/cockpit/bin/cockpit` exists, starts with `#!/bin/sh`, and is executable (`test -x`).
- [ ] The shim implements contracts.md §7 steps 1–8, including the exact stderr strings above.
- [ ] The hook path never writes to stdout or stderr and returns in under 1 s when the binary is missing.
- [ ] A checksum mismatch installs nothing and leaves no temp dir behind in the bin parent dir.
- [ ] Two concurrent first runs download the asset exactly once.
- [ ] Symlinked invocation resolves `COCKPIT_PLUGIN_ROOT` to the real `packages/monitor` dir.
- [ ] No bashisms: `sh -n` passes, and `shellcheck -s sh` is clean when shellcheck is installed.

## Verification

- [ ] `test -x packages/monitor/skills/cockpit/bin/cockpit && head -n 1 packages/monitor/skills/cockpit/bin/cockpit | grep -qx '#!/bin/sh'`
- [ ] `sh -n packages/monitor/skills/cockpit/bin/cockpit`
- [ ] `command -v shellcheck >/dev/null && shellcheck -s sh packages/monitor/skills/cockpit/bin/cockpit || echo "shellcheck not installed — skipped"`
- [ ] `bun test packages/monitor/skills/cockpit/bin/cockpit.test.ts` passes all 9 cases.
- [ ] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/bin/` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong triple mapping, hook path blocks or prints, or an unverified binary gets installed | Happy path downloads; lock, symlink, or budget behavior drifts from §7 | Every §7 step exact, including stderr strings, lock, 30 s budget, and fail-soft hook |
| Test coverage | ×2 | No test, or tests hit the real network | Download happy path only | All 9 cases, including mismatch, concurrency, stale lock, symlink, and unsupported platform |
| Interface & readability | ×1 | Bashisms or unquoted expansions | Works but download logic is duplicated across paths | One download function, quoted everywhere, shellcheck clean |
| Assumptions & docs | ×1 | Magic timeouts unexplained | Some one-line whys missing | Each timeout and trust assumption has a one-line why (the checksum comes from the same release, so it catches corruption, not tampering) |

## Out of scope

- The CI workflow that produces the release assets. Deferred: it builds on this shim's asset naming and lands separately.
- Pointing any plugin manifest, hook, or doc at the shim. Deferred to the wiring change, after every subcommand is ported.
- Signature or notarization checks. Deferred: GitHub TLS plus sha256 is the accepted trust root.

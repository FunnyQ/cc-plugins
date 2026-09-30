# Cockpit Rust RSS

Measured 2026-09-30 on Darwin arm64 (Apple M1 Max) with the release build of `packages/monitor/cockpit-rs` (5.2.4).

The file ship/04 wrote was left untracked in its worktree and never landed. review/01 re-ran the measurement below; the numbers agree with what ship/04 logged (channel 9008 KB, server 11616–11808 KB).

| Process | Target | Measured (max of 5 × 1 s `ps -o rss=`) | Result |
| --- | --- | --- | --- |
| channel (`cockpit channel`, idle, inbox poll parked) | ≤ 10 MB (10240 KB) | 9008 KB (8.8 MiB) | pass |
| server (`cockpit server`, dashboard loaded, one transcript SSE open) | ≤ 30 MB (30720 KB) | 11936 KB (11.7 MiB) | pass |

The Bun versions measured about 55 MB (channel) and 86 MB (server) on the same day.

## Commands

```sh
cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml
d=$(mktemp -d /tmp/q-lab-rss.XXXXXX)   # probe lives outside the repo
COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun "$d/rss-probe.ts"
```

The probe is one Bun script, so `ps` reads each process's own pid and never a shell's. Here is what it does:

1. Builds isolated homes with the contract fixtures (`makeHomes`, `makeProviderFixtures`, `baseEnv`, `fixtureEnv`). `COCKPIT_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are temporary, `COCKPIT_PLUGIN_ROOT=packages/monitor` is set, and the port is free.
2. Seeds a Claude transcript and a live Claude session file for the fixed id `00000000-0000-4000-8000-000000000001`.
3. Starts `cockpit server --no-open --port <p>` through `startDaemon`.
4. Spawns `cockpit channel` through `Bun.spawn` with `CLAUDE_CODE_SESSION_ID` set to that id. It sends MCP `initialize` and `notifications/initialized` on stdin and keeps the pipe open. It then polls `/api/sessions` until that session reports `"channel":true`, with a 10 s timeout that throws.
5. Channel RSS is the max of 5 `ps -o rss= -p <channel pid>` readings taken 1 s apart. The probe then kills the channel.
6. Fetches `/` and every `src`/`href` asset in `index.html` with `accept-encoding: gzip`. It opens `/api/transcript/stream?session=<id>&provider=claude`, reads its first chunk, and keeps it open.
7. Server RSS is the max of 5 readings taken 1 s apart.

## Known gaps

- **Kept TS.** `packages/monitor/skills/cockpit/scripts/` keeps `cockpit-home.ts` and `http.ts`, which usage-dashboard's `atlas-server.ts` and `live.ts` import. It also keeps `diagram-lint.ts`, which `cockpit scribe --diagram` runs through Bun, and those modules' tests. `diagram-theme.test.ts` stays too, because it tests the SPA's `modules/diagram.js`, which `diagram-lint.ts` also loads.
- The measurement covers one idle channel and one open stream. A server holding many transcript streams grows with each open file watcher, and nobody has measured that.

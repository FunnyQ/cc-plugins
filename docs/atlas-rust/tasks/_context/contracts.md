# Compatibility contracts

> Every shape here is observable outside the process that produces it: the SPA, another process, a user's `settings.json`, or a file on disk. Rust must reproduce each one. The TS file named in each section is the authoritative behavior while it exists; when this file is not specific enough, read the TS and port what it does.

## 1. Environment variables and paths

Honor every one, same name, same fallback. `~` is `$HOME` (`os.homedir()` in TS, `std::env::var("HOME")` in Rust) — the contract suite builds fixture homes by setting `HOME`.

| Var | Meaning / fallback | TS source |
|---|---|---|
| `HOME` | Base of every `~` path below. | `paths.ts` |
| `TOKEN_ATLAS_PROJECTS_DIR` | Claude transcripts dir, fallback `~/.claude/projects`. | `paths.ts` |
| `TOKEN_ATLAS_ROLLUP_DB` | Rollup DB path, fallback `$XDG_DATA_HOME/q-lab/token-atlas/rollup.db`. | `rollup-db.ts` |
| `XDG_DATA_HOME` | Fallback `~/.local/share`. Also the base of `codex-sessions.db` (`$XDG_DATA_HOME/q-lab/token-atlas/codex-sessions.db`, same dir as the rollup default — **not** next to a `TOKEN_ATLAS_ROLLUP_DB` override). | `rollup-db.ts`, `codex-cache.ts` |
| `COCKPIT_HOME` | Dir holding `atlas.json`, `daemon.json`, `registry.json`. Fallback `$XDG_DATA_HOME/q-lab/cockpit`, migrating a legacy `~/.cockpit` first. Rust: `paths::cockpit_home()`. | `cockpit-home.ts` |
| `COCKPIT_OPENCODE_DB`, `OPENCODE_DATA_DIR` | OpenCode DB path. Rust: `paths::opencode_db()`. | `shared/scripts/opencode.ts` |
| `TOKEN_ATLAS_STATUSLINE_COMMAND` | Inner statusline command (trimmed), fallback `bunx -y ccstatusline@latest`. | `statusline-collector.ts` |
| `LLM_QUOTA_INGEST_URL`, `LLM_QUOTA_INGEST_SECRET` | push-usage target and `X-Auth-Token` header; unset URL = push-usage does nothing and the collector never nudges it. | `push-usage.ts` |
| `TOKEN_ATLAS_OPENROUTER_URL` | **New test seam.** OpenRouter models URL, fallback `https://openrouter.ai/api/v1/models`. | `api.ts` `OPENROUTER_URL` |
| `TOKEN_ATLAS_CODEX_USAGE_URL` | **New test seam.** Fallback `https://chatgpt.com/backend-api/codex/usage`. | `api.ts` `CODEX_USAGE_URL` |
| `TOKEN_ATLAS_CODEX_TOKEN_URL` | **New test seam.** Fallback `https://auth.openai.com/oauth/token`. | `api.ts` `CODEX_TOKEN_URL` |
| `TOKEN_ATLAS_TEST_BUILD_BARRIER` | **New test seam, Rust only.** When set to a path, the stats build writes `<path>.entered` from inside its blocking task, then waits until `<path>` exists before continuing. Unset = no effect. | none (TS cannot block its event loop usefully) |
| `TOKEN_ATLAS_NOW_MS` | **New test seam.** A positive integer replaces "now" (epoch ms) everywhere the engine and live sessions read the clock; anything else = the real clock. | `api.ts`, `live-sessions.ts`, `live.ts` |

Fixed paths (all under `~`): `.claude/stats-cache.json`, `.claude/history.jsonl`, `.claude/sessions/*.json`, `.codex/state_5.sqlite`, `.codex/sessions/**`, `.codex/auth.json`, `.cache/token-atlas/rate-limits.json`, `.cache/token-atlas/codex-usage-limits.json`, `.cache/token-atlas/.rollup-nudge`, `.cache/token-atlas/.push-nudge`, `.config/cc-dashboard/pricing.json` (user override), `.config/cc-dashboard/budget.json`. OpenCode legacy JSON lives under `<dirname(opencode db)>/storage` and `<dirname(opencode db)>/project`. Bundled pricing defaults: `<plugin root>/skills/usage-dashboard/references/pricing-defaults.json`.

## 2. HTTP surface of `atlas serve`

Bind `127.0.0.1`, default port `5938`. Routing is by pathname only; method matters only for pricing refresh.

| Route | Behavior |
|---|---|
| `/api/stats` (any method) | `fp = statsFingerprint()`; `etag = W/"<BOOT_ID>-<fp>"` where `BOOT_ID` is random per process. Request `If-None-Match` equal to `etag` → `304`, empty body, headers `Cache-Control: no-cache`, `ETag`, `Vary: Accept-Encoding`. Else serve the cached payload for `fp`, building it if the cache is empty or keyed to another `fp`; concurrent requests for the same `fp` share one build; a failed build is never cached. `200` body = stats JSON; gzip level 6 with `Content-Encoding: gzip` when `Accept-Encoding` contains `gzip`; headers `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-cache`, `ETag`, `Vary: Accept-Encoding`. |
| `/api/live` (any method) | `200` `{"sessions": LiveSession[], "cockpitUp": bool, "cockpitPort": number|null}`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, never gzip. `cockpitPort` = `port` from `$COCKPIT_HOME/daemon.json` when its pid is alive, else `null`. |
| `POST /api/pricing/refresh` | Optional JSON body `{"models": string[]}` (non-strings dropped; missing/invalid body → derive the model list from a full stats build). Fetch OpenRouter (10 s timeout), merge into the user override file, clear the pricing cache. `200` `{ok, overridePath, openRouterError, resolved: [{model, key}], unresolved: string[], writtenCount}`, `Cache-Control: no-store`. |
| anything else | Static file from `<plugin root>/skills/usage-dashboard/dashboard/dist`; `/` → `/index.html`; a path escaping the root or missing → `404` body `Not found`. Headers: MIME by extension (unknown → `application/octet-stream`), `Cache-Control: no-cache`, `ETag: W/"<mtimeMs base36>-<size base36>[-gz]"`, `304` on match. Gzip only `.html .js .mjs .css .json .svg` when accepted. |
| any error | `500` `{"error": "<message>"}`, `Cache-Control: no-store`. |

`buildStats` and the fingerprint walk run on `spawn_blocking`; `/api/live` must answer while a stats build is running (TS could not).

## 3. `atlas serve` lifecycle and `atlas.json`

- File: `$COCKPIT_HOME/atlas.json`, written after bind as `JSON.stringify({pid, port, root}, null, 2) + "\n"`; never deleted.
- `root` = `<plugin root>/skills/usage-dashboard/scripts` — the string the TS server writes (`import.meta.dir`), so a TS server and a Rust server from the same install *reuse*, and different installs *supersede*.
- Startup decision: record missing/corrupt/non-number pid or port (any JSON number passes, fractional included)/non-string root, or pid dead (a non-integer pid counts as dead) → start. Alive and `root` equal → print `Claude Stats Dashboard already running → http://localhost:<port> (pid <pid>)`, open the browser, exit 0. Alive and `root` differs → print `superseding stale atlas server (pid <pid>, root <root>) — this install is <myRoot>`, SIGTERM, wait up to 1500 ms (poll 50 ms), SIGKILL if still alive and wait up to 1000 ms, sleep 100 ms, then start.
- Flags: `--port <n>` (1–65535, else default), `--no-open`.
- Bind failure on a used port → stderr `atlas: port <n> is in use by another process — stop it or pass --port <n>.`, exit 1. SKILL.md tells agents to look for this string.
- Success → stdout `Claude Stats Dashboard → http://localhost:<port>`, then open the browser (`open` on macOS, `xdg-open` elsewhere; detached, errors ignored) unless `--no-open`.

## 4. CLI subcommands

| Subcommand | Replaces | Contract |
|---|---|---|
| `cockpit atlas serve [--port N] [--no-open]` | `bun atlas-server.ts` | §2–§3. |
| `cockpit atlas stats` | `bun api.ts` | Prints the stats JSON to stdout, exit 0. |
| `cockpit atlas stats --source <claude\|codex\|opencode\|pricing>` | `bun api.ts --source <name>` (**new test seam**) | Prints one data source's intermediate result as JSON, exit 0. Shapes: `claude` → `{usage, ledger, transcriptFileCount, statsCache, history, usageLimits}` (parseTranscriptUsage + parseStatsCache + parseHistory + readUsageLimits); `codex` → `{usage: <parseCodexUsage()>, usageLimits: <readCodexUsageLimits()>}`; `opencode` → `{usage: <parseOpenCodeUsage()>}`; `pricing` → `<loadPricingWithMeta()>`. Serialization: a `Map` becomes an object (number keys stringified), a `Set` a sorted array, everything else plain `JSON.stringify`. Lets each data source prove parity before the full payload exists. An unknown name, or `--source` with no value, prints `usage: cockpit atlas stats [--source claude\|codex\|opencode\|pricing]` to stderr and exits 2, in both implementations (the TS prints the same line with `bun api.ts` in place of `cockpit atlas stats`; tests assert the exit code and the `--source claude|codex|opencode|pricing` part). |
| `cockpit atlas live` | `bun live.ts` | Prints the `/api/live` object `{sessions, cockpitUp, cockpitPort}` to stdout, 2-space indent, no trailing newline (as `live.ts`'s `import.meta.main` block does), exit 0. |
| `cockpit atlas rollup-update [--rebuild] [--db <path>]` | `bun rollup-update.ts` | Runs `updateRollup`; prints its result JSON; `--db` overrides the DB path. |
| `cockpit atlas statusline` | `bun statusline-collector.ts` | Reads all stdin; when the JSON has `rate_limits`, writes `rate-limits.json` (`buildRateLimitsRecord`); nudges `rollup-update` (marker `.rollup-nudge`, 5 min) and, when `LLM_QUOTA_INGEST_URL` is non-empty, `push-usage` (marker `.push-nudge`, 2 min): skip when the marker's mtime is younger than the throttle, else touch the marker and spawn detached `<current_exe> atlas <sub>` with stdio ignored; any nudge error is swallowed. Then runs `TOKEN_ATLAS_STATUSLINE_COMMAND` through `sh -c` with the same stdin bytes, forwards its stdout, exits with its exit code. |
| `cockpit atlas push-usage` | `bun push-usage.ts` | No-op when the URL is unset. Else POST `{capturedAt, claude: readUsageLimits(), codex: readCodexUsageLimits()}` with `Content-Type: application/json` and `X-Auth-Token: <secret or "">`, 8 s timeout, errors swallowed, exit 0. |

## 5. On-disk files

### `rollup.db` (schema v3, authoritative)

WAL, `busy_timeout = 5000`. `meta(key TEXT PRIMARY KEY, value TEXT)` holds `schema_version` and `ledger_rebuild_pending`. Tables (exact DDL in `rollup-db.ts`):

- `ingested_files(path PK, bytes_parsed, mtime_ms, updated_at)`
- `seen_requests(request_key PK, path)` + `idx_seen_requests_path`
- `usage_hourly(hour_ms, project, model, input_tokens, output_tokens, cache_read, cache_creation, reasoning, message_count, PK(hour_ms, project, model))` — `hour_ms` is the **local** hour start in epoch ms; `0` holds entries with a missing/unparseable timestamp.
- `seen_tool_calls(session_key, tool_key, PK both)`
- `session_ledger(path, session_key, project, project_ts_ms, last_ts_ms, interactions, tool_calls, PK(path, session_key))`
- `session_model_usage(path, session_key, model, input/output/cache_read/cache_creation, PK(path, session_key, model))`

Rules that fail silently if broken:

- `usage_hourly` keeps tokens when a transcript is deleted; `session_ledger` / `session_model_usage` rows prune with the file.
- A replay from byte 0 never touches `usage_hourly` (`seen_requests` blocks re-billing) but deletes and rewrites that file's ledger rows, deduping tokens against a run-scoped set.
- `seen_requests` is never cleared wholesale and never touched by a rewind; its rows for one file are deleted only when that transcript is pruned as deleted (the ingest's per-path clear, subject to its surviving-sibling rule). `seen_tool_calls` is cleared wholesale on rewind and pruned by `session_key NOT IN (SELECT session_key FROM session_ledger)`.
- Tool-call dedup is per session, spanning files.
- Migration v1→v2→v3 writes `<db>.v<old>.bak` via `VACUUM INTO` first; an unknown or newer version is refused with an error. The TS takes that backup before the version check, so a refused v99 DB still gets `<db>.v99.bak`; Rust does the same.
- **New, Rust only**: first open without `meta.writer = 'rust'` → `VACUUM INTO '<db>.pre-rust.bak'` unless that file exists, then insert `writer = 'rust'`. A brand-new DB (no `meta` yet) skips the backup. A failed backup is an error: nothing is written and `writer` stays unset, so the next open retries. The TS ignores unknown meta keys, so a mixed fleet is safe.

### `codex-sessions.db` (disposable cache)

`session_summary(path PK, size, mtime_ms, summary TEXT JSON)`; a row is valid while path + size + mtime match; rows whose file vanished are pruned.

### JSON files

| File | Writer | Format |
|---|---|---|
| `$COCKPIT_HOME/atlas.json` | `atlas serve` | `{pid, port, root}`, 2-space indent + trailing newline |
| `~/.cache/token-atlas/rate-limits.json` | `atlas statusline` | `buildRateLimitsRecord` output — copy the TS writer's `JSON.stringify` form exactly |
| `~/.cache/token-atlas/codex-usage-limits.json` | engine (Codex limits) | copy the TS writer's form exactly |
| `~/.config/cc-dashboard/pricing.json` | pricing refresh | copy the TS writer's form exactly; existing user keys preserved |
| `$COCKPIT_HOME/daemon.json`, `registry.json` | cockpit (read-only here) | `daemon.json` `{pid, port, token, root}`; `registry.json` `{sessions: [...]}` |

## 6. `/api/stats` payload

Top-level keys, in this order: `period`, `summary` (with `providers.{claude,codex,opencode}`), `byModel`, `pricingMeta`, `budget`, `usageLimits`, `codexUsageLimits`, `dataHealth`, `daily`, `ledger`, `hourlyUsage`, `activityDays`, `hourlyDistribution`, `weekHourMatrix`, `dailyHourCounts`, `projects`, `sessions`, `insights`, `meta`. Model keys are namespaced `provider:model` (e.g. `claude:claude-opus-4-7`). Billing dedup key is `requestId:messageId` (`dedup.ts` `dedupKey`). Prices are USD per 1M tokens; resolution order is bundled defaults → OpenRouter live (3 s timeout at load, silent fail) → user override (wins).

**Golden comparison**: the golden suite parses both payloads and compares them deep-equal after deleting the volatile-key list frozen in `packages/monitor/skills/usage-dashboard/contract/golden/volatile-keys.json` (JSON array of dotted paths, `*` matching any one segment). That file is the single definition; add a key only with a one-line reason next to it in the test.

**Golden test names** (filter with `bun test <file> -t "<name>"`; every port's verification uses them): `stats key <topLevelKey>` (one per key above), `source claude`, `source codex`, `source opencode`, `source pricing`, `rollup table <table>` (one per table in §5), `rollup incremental append`, `rollup transcript deleted`, `rollup rebuild`, `rollup migrate v2`, `rollup refuse newer`, `rollup pre-rust backup` (Rust only). All live in `packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts`. Recorded TS outputs live in `contract/golden/` and are regenerated only by `bun packages/monitor/skills/usage-dashboard/contract/record-golden.ts` run against the TS.

## 7. Callers outside the dashboard (updated at wiring time)

- `~/.claude/settings.json` `statusLine.command`: today `bun <marketplace clone>/packages/monitor/skills/usage-dashboard/scripts/statusline-collector.ts`, optionally wrapping the user's own command via `TOKEN_ATLAS_STATUSLINE_COMMAND`. New form: `<marketplace clone>/packages/monitor/skills/cockpit/bin/cockpit atlas statusline`.
- Detection regex `/(\S*statusline-collector\.ts)/` in `install/scripts/setup.ts`, `install.ts`, `statusline-decision.ts`; `install.ts` `COLLECTOR_COMMAND = "bun <path>"`; `setup-statusline.ts` `applyStatusline()`.
- `install/scripts/reap-stale.ts` deliberately excludes the atlas server (comment + `reap-stale.test.ts`).
- `usage-dashboard/SKILL.md` and `references/opencode.md` launch commands.

**Allowed legacy references.** After wiring, the names `atlas-server.ts`, `api.ts`, `statusline-collector.ts`, and `rollup-update.ts` may remain in exactly these files, on purpose: `install/scripts/statusline-decision.ts`, `install/scripts/setup.ts` (old-form statusline detection for the migration) and their tests, and `install/scripts/reap-stale.ts` + `reap-stale.test.ts` (the reaper's atlas exclusion and its fixtures). `CHANGELOG.md` and `docs/` are history and are never searched. Every legacy-reference gate uses one filter for these files:

```sh
rg -ln '<pattern>' <paths> | grep -vE 'install/scripts/(statusline-decision|setup|reap-stale)(\.test)?\.ts$'
```

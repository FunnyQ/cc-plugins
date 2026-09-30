# CONTRACT-01: Launcher, fixture home, and TS test seams

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: none — foundation task
> **Blocks**: contract/02, contract/03, contract/04
> **Status**: todo
> **Models**: dev=opus/high

## Goal

A bun contract harness under `packages/monitor/skills/usage-dashboard/contract/` launches either implementation (TS or Rust) of any `atlas` subcommand against a deterministic fixture HOME, and the TS gains the four env seams plus `--source` so it can be recorded as golden.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/contract/launcher.ts` (new) — `atlasCommand()` + `isRust()`
- `packages/monitor/skills/usage-dashboard/contract/launcher.test.ts` (new) — unit tests of the mapping
- `packages/monitor/skills/usage-dashboard/contract/fixtures.ts` (new) — `makeFixtureHome()`, `freePort()`, HTTPS stub server
- `packages/monitor/skills/usage-dashboard/contract/fixtures.test.ts` (new) — smoke test of the fixture home against the TS
- `packages/monitor/skills/usage-dashboard/scripts/api.ts` (modify) — URL seams, `nowMs()`, `--source` CLI flag
- `packages/monitor/skills/usage-dashboard/scripts/live.ts` (modify) — clock through `nowMs()`
- `packages/monitor/skills/usage-dashboard/scripts/live-sessions.ts` (modify, only if a clock read is found there) — clock through `nowMs()`

## Implementation notes

### Launcher

```ts
export type AtlasSub = "serve" | "stats" | "live" | "rollup-update" | "statusline" | "push-usage";
export function isRust(): boolean;                               // COCKPIT_BIN non-empty
export function atlasCommand(sub: AtlasSub, args: string[] = []): string[];
```

- `COCKPIT_BIN` set → `[COCKPIT_BIN, "atlas", sub, ...args]`.
- Unset → `["bun", <absolute script path>, ...args]`, scripts under `packages/monitor/skills/usage-dashboard/scripts/`: `serve`→`atlas-server.ts`, `stats`→`api.ts`, `live`→`live.ts`, `rollup-update`→`rollup-update.ts`, `statusline`→`statusline-collector.ts`, `push-usage`→`push-usage.ts`.
- Resolve paths from `import.meta.dir`, never from cwd. Cockpit's own launcher (`packages/monitor/skills/cockpit/contract/launcher.ts`) throws when no binary exists; this one must not — an unset `COCKPIT_BIN` means "test the TS".

### Fixture home

```ts
export type StubRequest = { path: string; method: string; headers: Record<string, string>; body: string };
export type StubServer = {
  url: string;
  requests: StubRequest[];
  // Overrides every later response on `path` until called again; lets tests force 500s.
  respondWith(path: string, status: number, body: string): void;
  stop(): void;
};
export async function freePort(): Promise<number>;
export async function makeFixtureHome(): Promise<{
  home: string;
  env: Record<string, string>;
  stub: StubServer;
  cleanup(): Promise<void>;
}>;
```

`env` is the child's **whole** environment — never spread `process.env` into it, or an outer `TOKEN_ATLAS_PROJECTS_DIR`, `TOKEN_ATLAS_ROLLUP_DB`, `COCKPIT_OPENCODE_DB`, or `OPENCODE_DATA_DIR` would point a test at real data. It holds `PATH` copied from the parent plus exactly the fixture values. It sets, all inside one `mkdtemp` dir: `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `COCKPIT_HOME`; `TZ=Asia/Taipei` (non-UTC and no DST, so a UTC-vs-local hour bug shows); `TOKEN_ATLAS_NOW_MS` fixed to a constant a few hours after the newest fixture entry; `TOKEN_ATLAS_OPENROUTER_URL`, `TOKEN_ATLAS_CODEX_USAGE_URL`, `TOKEN_ATLAS_CODEX_TOKEN_URL` pointing at the stub. It must not set `TOKEN_ATLAS_PROJECTS_DIR` or `TOKEN_ATLAS_ROLLUP_DB`, so the HOME-derived defaults are what gets tested.

Any path the stub does not know answers 200 `{}` and is recorded too (push-usage posts to `<stub url>/ingest`). The stub is one `Bun.serve` on a free port with three canned JSON routes — OpenRouter models (a `data` array with the models used below plus one unused model), Codex usage (primary + secondary windows), OAuth token refresh (`access_token`, `refresh_token`, `id_token`) — and records every request in `requests`. Copy the response shapes from how `api.ts` parses them (`fetchOpenRouterPricing`, `fetchCodexUsageWithToken`, `refreshCodexAccessToken`).

Contents of the home — each item exists to exercise one rule:

- **Claude** `.claude/projects/<proj-a>/<session>.jsonl` and `<proj-b>/…`: assistant entries with `message.usage`, `requestId`, `message.id`, `cwd`, `timestamp`, `sessionId`; one request repeated as several usage snapshots (the ingest bills the first occurrence); one request duplicated across two files (billed once); `tool_use` content blocks; a subagent transcript whose `sessionId` is its parent's; one entry with no `timestamp` (lands in `hour_ms = 0`); entries spread over at least 3 days and several hours. Also `.claude/stats-cache.json`, `.claude/history.jsonl`, `.claude/sessions/<pid>.json` (read `parseStatsCache`, `parseHistory`, `session-files.ts` for shapes).
- **Codex** `.codex/state_5.sqlite` with a `threads` table holding every column either query selects: `id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title, model, tokens_used, archived` (api.ts `parseCodexUsage` and live.ts `readCodexThreadRows`). Rollouts under `.codex/sessions/YYYY/MM/DD/*.jsonl` with `token_count` events, referenced from `rollout_path`; one thread with `tokens_used > 0` and no rollout. `.codex/auth.json` with a stale access token and a refresh token. The TS refreshes only after the usage endpoint answers 401 or 403, so the stub's Codex usage route answers 401 to the stale token and 200 to the token its refresh route issues; that is what drives the refresh path. No `.cache/token-atlas/codex-usage-limits.json`.
- **OpenCode**: a SQLite db at the default location `$HOME/.local/share/opencode/opencode.db` (`openCodeDb()` and Rust `paths::opencode_db()` derive it from `HOME`, not `XDG_DATA_HOME`; the fixture env sets neither `COCKPIT_OPENCODE_DB` nor `OPENCODE_DATA_DIR`, so the default path is what gets tested) with the `session`, `message`, and `part` rows `parseOpenCodeUsage` reads (api.ts lines ~2038–2376), plus one legacy `storage/session` + `storage/message` JSON session next to it.
- **Config/cache**: `.config/cc-dashboard/pricing.json` overriding one model's price; `.config/cc-dashboard/budget.json`; `.cache/token-atlas/rate-limits.json` in the shape `buildRateLimitsRecord` writes.
- **Determinism**: set every fixture file's atime/mtime with `utimes` to fixed epoch values, so `statsFingerprint`, `ingested_files.mtime_ms`, and `codex-sessions.db` keys are identical across runs.

### TS seams

- **URLs** (`api.ts` lines 64–67): `CODEX_USAGE_URL`, `CODEX_TOKEN_URL`, `OPENROUTER_URL` read `process.env.TOKEN_ATLAS_CODEX_USAGE_URL`, `TOKEN_ATLAS_CODEX_TOKEN_URL`, `TOKEN_ATLAS_OPENROUTER_URL`, falling back to today's literals when unset or empty.
- **Clock**: add one exported `nowMs(): number` (in `api.ts`, imported by `live.ts`): a positive integer in `TOKEN_ATLAS_NOW_MS` wins, anything else returns `Date.now()`. Route these call sites through it (audited 2026-10-01):
  - `api.ts:630` (`readUsageLimits` staleness), `api.ts:809` and `api.ts:819` (Codex usage cache age / capture time), `api.ts:1259` (`firstSeen` fallback in `parseHistory`), `api.ts:3052` (`meta.generatedAt` → `new Date(nowMs()).toISOString()`).
  - `live.ts:62`, `:102`, `:127`, `:159`, `:180`.
  - `live-sessions.ts` has no clock read today; re-grep and touch it only if one exists.
  - `rollup-update.ts:331` (`opts.nowMs ?? Date.now()`) stays on the real clock: it feeds only `ingested_files.updated_at`, which the golden row diff excludes. Say so in a one-line comment there is **not** required; leave the file untouched.
  - Re-run `grep -nE 'Date\.now\(\)|new Date\(\)' api.ts live.ts live-sessions.ts` after the change; only `nowMs()` itself may remain.
- **`--source`** in `api.ts`'s `import.meta.main` block (line ~3060): `bun api.ts --source <claude|codex|opencode|pricing>` prints one JSON object and exits 0; no flag keeps today's full-payload output. Shapes, exactly as `_context/contracts.md` §4 states:
  - `claude` → `{usage, ledger, transcriptFileCount, statsCache, history, usageLimits}` from `parseTranscriptUsage()` (its five aggregates under `usage`), `parseStatsCache()`, `parseHistory()`, `readUsageLimits()`.
  - `codex` → `{usage: parseCodexUsage(), usageLimits: await readCodexUsageLimits()}`.
  - `opencode` → `{usage: parseOpenCodeUsage()}`.
  - `pricing` → `await loadPricingWithMeta()`.
  - Serialize through one replacer: `Map` → plain object (number keys stringified), `Set` → sorted array, everything else as `JSON.stringify` does. An unknown source name, or `--source` with no value, prints `usage: bun api.ts [--source claude|codex|opencode|pricing]` to stderr and exits 2 (contracts.md §4 freezes this; tests assert exit 2 and the `--source claude|codex|opencode|pricing` part only).
  - Wrap or export the private functions as needed; do not change what they compute.

## Acceptance criteria

- [ ] `atlasCommand` returns `[COCKPIT_BIN, "atlas", sub, ...args]` when `COCKPIT_BIN` is set and `["bun", <abs path>, ...args]` for each of the six subcommands when it is not; `launcher.test.ts` covers all six plus the Rust form.
- [ ] `makeFixtureHome()` builds every item listed under "Contents of the home", and two calls produce homes whose files have identical relative paths, sizes, and mtimes.
- [ ] With the fixture env, `bun packages/monitor/skills/usage-dashboard/scripts/api.ts` prints a payload whose `summary.providers.claude`, `.codex`, and `.opencode` each report non-zero tokens, and the stub recorded at least one OpenRouter request and one Codex token-refresh request.
- [ ] With the fixture env, `bun packages/monitor/skills/usage-dashboard/scripts/api.ts --source codex` prints JSON whose `usage.modelUsage` is non-empty; the other three source names each print valid JSON with the top-level keys listed above.
- [ ] Two runs of `bun api.ts` under the same fixture env print identical JSON (the pinned clock makes `meta.generatedAt` stable).
- [ ] With the three URL vars and `TOKEN_ATLAS_NOW_MS` unset, `api.ts` uses the original literal URLs and the real clock (asserted in `fixtures.test.ts` by importing the constants / `nowMs()`).
- [ ] The only remaining `Date.now()` / `new Date()` reads in `api.ts`, `live.ts`, `live-sessions.ts` are inside `nowMs()`.
- [ ] Existing unit tests under `packages/monitor/skills/usage-dashboard/scripts/` still pass, and the touched TS typechecks clean.

## Verification

- [ ] `bun test packages/monitor/skills/usage-dashboard/scripts/`
- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/launcher.test.ts packages/monitor/skills/usage-dashboard/contract/fixtures.test.ts`
- [ ] `grep -nE 'Date\.now\(\)|new Date\(\)' packages/monitor/skills/usage-dashboard/scripts/api.ts packages/monitor/skills/usage-dashboard/scripts/live.ts packages/monitor/skills/usage-dashboard/scripts/live-sessions.ts` lists only the line inside `nowMs()`.
- [ ] `bunx --bun tsc --noEmit | grep usage-dashboard` prints nothing.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Seams change default behavior, or the fixture home leaves a provider at zero tokens | All providers populated, but a dedup/first-wins/subagent/missing-timestamp case is absent, or output differs between two runs | Every listed fixture case present, output deterministic, defaults unchanged, `--source` shapes match `_context/contracts.md` §4 |
| Test coverage | ×2 | No tests for launcher or fixtures | Happy-path smoke only | Launcher mapping for all six subs + Rust form; fixture determinism; seam defaults; each `--source` name; unknown source exit 2 |
| Interface & readability | ×1 | Launcher depends on cwd; fixture builder is one opaque blob | Works, but fixture cases are not traceable to the rule they exercise | Typed exports as specified; each fixture item named for the rule it exercises |
| Assumptions & docs | ×1 | Clock call sites changed without an audit | Audit done but not recorded | Audit list matches the code; any fixture shape guessed from TS parsing is noted in a one-line comment |

## Out of scope

- The HTTP, lifecycle, golden, and CLI contract test files — Deferred. Reason: each is written against this harness separately.
- Recording golden outputs — Deferred. Reason: the golden suite owns `contract/golden/` and its recorder.
- Any Rust — Deferred. Reason: this task only makes the TS observable.
- Changing `rollup-update.ts` — Deferred. Reason: its clock feeds only `ingested_files.updated_at`, which the row diff ignores.

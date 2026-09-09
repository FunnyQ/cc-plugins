# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What This Is

`q-lab-marketplace` — a plugin marketplace for Claude Code, Codex, and OpenCode. It holds six plugins. Each plugin ships to Claude Code and Codex and versions independently; OpenCode is a third runtime layered on top of the same skills (see `opencode/` below), versioned with none of them.

| Plugin | Purpose | Skills |
| --- | --- | --- |
| **monitor** | Usage analytics + live session cockpit | `usage-dashboard`, `cockpit`, `install` |
| **dispatch** | Interview-driven planning and execution | `preflight`, `hop`, `flightplan`, `autopilot`, `waypoints`, `deckplan` |
| **relay** | Delegate a task to another harness CLI | `relay` |
| **chronicle** | ADR curation, commit, PR/MR, and release automation | `adr`, `commit`, `pr`, `release`, `install` |
| **herdr** | Reference + agent orchestration for the Herdr terminal | `herdr`, `tell`, `herdr-browser`, `herdr-protocol-upgrade` |
| **guard** | Coding rules the harness enforces, as hooks | *(none — hooks only)* |

Read the plugin's own `skills/*/SKILL.md` for its contract. This file documents only what no `SKILL.md` covers: the repo layout, monitor's dashboard internals, and the release rules.

### Plugin summaries

Design facts the `SKILL.md` files do not carry:

- **dispatch** — a ladder, each rung handing off to the next: `preflight` (captures the want as `docs/<slug>/INTENT.md`, refuses to decide *how*) → `hop` (interview, plan, and execute a small scope in this conversation) → `flightplan` (spec + `tasks/` tree on disk; reads an existing `INTENT.md` as its baseline) → `autopilot` (executes that tree, gated on each task's `## Eval rubric`). `waypoints` sits above flightplan and plans each leg just-in-time, after the previous one lands. **`hop` is the skill that was called `preflight` before dispatch 4.0.0** — the name moved up a rung, the behaviour did not change.
- **relay** — a backend-agnostic mode layer over a per-harness strategy layer. The capability matrix makes `image` codex-only.
- **chronicle** — thin `SKILL.md` → agent subtree, so diff and git output never reach the main conversation. **Agent hand-offs are files, never replies**, which is what makes an agent answering in prose cost nothing. `pr` and `adr` nest an orchestrator over cheap children; **`commit` and `release` do not — each runs its own scripts, and `release` spawns one leaf agent for the changelog entry alone.** An errand-runner earns its spawn only when what it swallows is big: a diff, a range of commits. Relaying a few kilobytes of JSON it cost more than it saved, and put a model between the caller and a version number. Splitting it across three cost 70k tokens of cold agent boilerplate against 4–11k of actual diff, and 16 model round trips for work that needs 4. `commit` and `release` put a deterministic script under that topology and re-read their own progress from the log, so an interrupted run resumes. `release` is config-first: the whole-repo versus per-component shape lives in a committed `.chronicle/release.json`.
- **guard** — the only plugin with no skills: it ships hooks and nothing else, so there is nothing to invoke and no way to turn it off short of uninstalling. `comment-guard` reports the comment *blocks* an edit added or grew and asks the model whether each line says why or what; it never judges the answer itself, because a heuristic that guesses meaning would train the model to phrase around it rather than to delete the comment. Three rules set the noise floor, and each was measured over this repo's 2,294 comment blocks before it was picked. **Added is a multiset difference over comment lines only**, not a line diff — moving a comment is not an addition, rewording one is. **A block reports at 3+ lines, counted at its size on disk after the write**, so a one-line addition into a two-line block fires and a lone `//` never does; that alone silences 68% of blocks, which is what keeps the hook tolerable enough to leave on. Blocks come from disk rather than `new_string` because an Edit fragment truncates any block crossing its edges. **The file-header block is exempt** — every block before the first code line, since module prose is the one place a wall of comment is the point. A word-count threshold was measured and rejected: of the 28 files whose comments are all single-line blocks, the wordiest totals 71 words, so no threshold that spares normal code would ever fire where the block rule had not already fired. Each language contributes a `Syntax` of line markers plus **open/close block pairs**, and the scan is stateful over any pair — a `/* */` docblock, an `<!-- -->` HTML comment and a Lua `--[[ ]]` all count their full height. Openers are tested before line markers because several overlap (Lua's `--[[` also starts with `--`). Extensionless build files match on name, so `Rakefile` and `Dockerfile` are covered. **`COMMENT_GUARDED` in `opencode/plugin.ts` is a hand-kept copy of those tables** — the module may import nothing from this repo, so widening it only wastes a spawn while narrowing it past the hook stops guarding a language with no error anywhere. `plugin.test.ts` cross-checks both directions by enumerating `BY_EXT` and `BY_NAME` themselves; **never pin that test to a hand-listed sample**, which is a third copy that drifts the same silent way and misses exactly the entry nobody remembered. The comparison works only because `syntaxFor` is pure lookup — the "should this file be guarded at all" policy (`/docs/`, prose extensions) lives in `isGuardedPath`, which the regex does not encode.
- **monitor** — `usage-dashboard` is the rear-view, `cockpit` the windshield. They run independent servers on separate ports with separate `dist/` SPAs; only the plugin packaging is shared. `install` owns every prerequisite check and config write for the whole plugin.

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # Claude registry (all six plugins; no version field)
├── .agents/plugins/marketplace.json  # Codex registry (all six plugins; no version field)
├── .chronicle/release.json           # release shape: per-component versions + version-file patterns
├── CHANGELOG.md                      # Keep a Changelog format, per-plugin headings
├── packages/
│   ├── monitor/
│   │   ├── .claude-plugin/plugin.json    # manifest + SessionStart hooks + cockpit channel
│   │   ├── .codex-plugin/{plugin,hooks}.json  # mirrors the Claude hooks
│   │   ├── commands/                     # thoughtful.md, nudge.md
│   │   └── skills/
│   │       ├── usage-dashboard/
│   │       │   ├── PRODUCT.md            # design direction — Sunrise Atlas
│   │       │   ├── scripts/
│   │       │   │   ├── api.ts            # data engine → buildStats()
│   │       │   │   ├── rollup-db.ts      # bun:sqlite schema + accessors
│   │       │   │   ├── rollup-update.ts  # incremental transcript ingest
│   │       │   │   ├── codex-cache.ts    # per-rollout summary cache (own DB)
│   │       │   │   ├── live.ts           # active sessions, both providers
│   │       │   │   ├── atlas-server.ts   # Bun HTTP server, port 5938
│   │       │   │   └── statusline-collector.ts
│   │       │   ├── dashboard/dist/       # committed SPA, no build step
│   │       │   └── references/pricing-defaults.json
│   │       ├── cockpit/
│   │       │   ├── SKILL.md              # router only
│   │       │   ├── PRODUCT.md / DESIGN.md  # brand + Night Flight design system
│   │       │   ├── references/           # pilot / scribe / restart / claude-cli / codex
│   │       │   ├── scripts/
│   │       │   │   ├── cockpit-server.ts # Bun daemon, port 5858
│   │       │   │   ├── cockpit.ts        # CLI: log / scribe / prep / wait / send / config / nudge / restart
│   │       │   │   ├── cockpit-channel.ts    # channel MCP server (stdio)
│   │       │   │   ├── codex-control-probe.ts
│   │       │   │   ├── log-root.ts       # per-repo trail anchoring
│   │       │   │   └── config.ts
│   │       │   └── dashboard/dist/
│   │       ├── install/scripts/
│   │       │   ├── setup.ts              # plugin-wide check + wire (--check/--dry-run/--apply/--session-check)
│   │       │   ├── install.ts            # dashboard precheck
│   │       │   ├── setup-statusline.ts
│   │       │   └── statusline-decision.ts    # pure decision, unit-tested
│   │       └── shared/scripts/           # imported by BOTH dashboards — extend, never duplicate
│   │           ├── opencode.ts           # OpenCode DB reader
│   │           ├── path-inside.ts
│   │           └── static-server.ts
│   ├── dispatch/
│   │   ├── hooks/flightplan-lint.sh      # PostToolUse, path + content gated
│   │   └── skills/{preflight,hop,flightplan,autopilot,waypoints,deckplan}/
│   │       # preflight/references/intent-template.md — the INTENT.md contract;
│   │       # preflight borrows flightplan's scaffold.ts for its collision check
│   │       # flightplan/scripts/ also hosts autopilot's shared tools:
│   │       # next-ready / score-task (--log) / flightlog
│   ├── chronicle/
│   │   ├── shared/scripts/               # code imported by more than one skill
│   │   ├── agents/                       # lawspeaker (commit — one agent, no children) / storykeeper+skald+messenger /
│   │   │                                 # lorekeeper+gleaner+reckoner+codifier+barrowkeeper / annalist (release)
│   │   ├── agents-codex/                 # Codex agent definitions (TOML format)
│   │   ├── hooks/check-branch.sh         # PreToolUse, guards commits on main/master
│   │   └── skills/{adr,commit,pr,release,install}/
│   ├── relay/
│   │   ├── commands/                     # backend-fixed aliases: codex / opencode / claude-cli
│   │   └── skills/relay/
│   │       ├── references/backends.md
│   │       └── scripts/
│   │           ├── relay.ts              # entry: relay <backend> <mode> [flags]
│   │           ├── relay-prompt.ts       # pure formatPrompt + file-contract helpers
│   │           ├── live.ts               # herdr live-pane layer (dynamic import)
│   │           ├── context-collector.ts / shared.ts / types.ts
│   │           └── backends/             # gate.ts (pure) + index.ts + codex/opencode/claude
│   ├── herdr/skills/
│   │   ├── herdr/
│   │   │   ├── references/               # config / cli / plugin-development / agent-orchestration
│   │   │   └── scripts/herd.ts           # typed Bun wrapper: spawn/tell/send/keys/wait/read/list/close
│   │   ├── herdr-browser/scripts/browser.ts  # browser pane + CDP driver: open/text/snapshot/watch/endpoint
│   │   ├── tell/                         # hand a job to an agent already open in another project
│   │   └── herdr-protocol-upgrade/       # raises a plugin's minimum-protocol constant
│   └── guard/                            # hooks only — no skills, nothing to invoke
│       ├── .codex-plugin/{plugin,hooks}.json  # mirrors the Claude hook
│       └── hooks/comment-guard.ts        # PostToolUse Edit|Write; exit 2 + stderr
└── opencode/                          # OpenCode runtime layer — repo infra, outside packages/, owns no version
    ├── plugin.ts                          # the OpenCode plugin module (single file, no repo imports)
    ├── plugin.test.ts
    ├── install.ts                         # --check | --dry-run | --apply | --unlink
    ├── install.test.ts
    ├── agents/                            # 10 chronicle agents in OpenCode frontmatter (committed)
    ├── commands/                          # nudge.md + thoughtful.md in OpenCode format (committed)
    └── references/opencode-runtime.md     # the runtime spike log, written by hand before the tree ran
```

Every `packages/<plugin>/` holds both a `.claude-plugin/plugin.json` and a `.codex-plugin/plugin.json`.

## Monitor: dashboard internals

### Data flow

1. `api.ts` reads three providers: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, and `~/.claude/projects/**/*.jsonl`; `~/.codex/state_5.sqlite` and `~/.codex/sessions/`; and `~/.local/share/opencode/opencode.db` through `skills/shared/scripts/opencode.ts`.
2. Pricing resolves in order: bundled defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`.
3. `atlas-server.ts` serves `dashboard/dist/` and exposes `GET /api/stats` and `GET /api/live`. It binds `127.0.0.1`.
4. The frontend fetches `/api/stats` on load and renders with petite-vue and Chart.js.

### Usage rollup DB

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). The rollup DB makes token history outlive that deletion.

**Never read transcript contents on the request path.** `parseTranscriptUsage()` walks `PROJECTS_DIR` for paths only (~110ms of readdir), hands them to `updateRollup()`, and reads everything else back out of the DB. Reading the transcripts there instead cost 13.4s per request on a 2.2GB corpus.

- `rollup-update.ts` tail-parses each transcript from `ingested_files.bytes_parsed` at UTF-8-safe newline boundaries, dedups billing across runs through `seen_requests`, and upserts additively into `usage_hourly(hour_ms, project, model)`. The same pass fills the session ledger — one parse, both outputs.
- The rollup stores **tokens only**. Cost stays a downstream computation, so price corrections apply retroactively. The ledger follows the same rule: `date`, `projectName`, `model` and `tokens` are all derived in `readRollupLedger()`, never stored.
- `hour_ms` is the local hour start. It matches `hourStartMs`, so daily and heatmap reconstruction is byte-identical.
- Triggers: the dashboard load (primary) and a detached, 5-minute-throttled `nudgeRollup()` from `statusline-collector.ts` (secondary). There is no daemon.
- A file shrinking below `bytes_parsed` or `--rebuild` replays transcripts while preserving `usage_hourly` and existing dedup keys. Deleted files are pruned from `ingested_files` and `seen_requests`; their tokens remain. Schema upgrades must migrate in place: v1 → v2 retains legacy keys with an unknown path, v2 → v3 rewinds every cursor to backfill the ledger, and unsupported versions are refused — including a *newer* one, so an older monitor build refuses a v3 file rather than corrupting it. `openRollupDb()` writes `<db>.v<old>.bak` via `VACUUM INTO` before any version-changing migration (a plain copy of a WAL database can read back short). The rollup is authoritative for deleted transcripts, so clearing it permanently loses history. Replays do not correct prior over-counts or changed billing/bucketing; restored transcripts whose keys were already pruned can count again.
- The DB lives at `~/.local/share/q-lab/token-atlas/rollup.db`, outside dotfile sync.

**`usage_hourly` and `session_ledger` have opposite deletion and replay rules.** Get this backwards and the failure is silent arithmetic.

| | `usage_hourly` | `session_ledger` / `session_model_usage` |
| --- | --- | --- |
| Transcript deleted | tokens stay — the whole point | rows pruned with the file |
| Replay from byte 0 | untouched; `seen_requests` blocks re-billing | file's rows deleted, then rewritten |

`interactions` and `tool_calls` have no `seen_requests`-style gate, so accumulating them onto surviving rows would double them on every rebuild — hence the per-file clear, and hence `parseSlice`'s `replay` flag. A replay must then ignore `seen_requests` to re-derive what it just deleted, so it dedups tokens against a run-scoped `ledgerSeen` set instead; that works only because every replay path rewinds *all* files.

Ledger rows are keyed `(path, session_key)` and summed per session on read. A session spans several files — a subagent transcript carries its parent's `sessionId` (1,442 of 2,571 measured) — while a file holds exactly one session key. Per-file rows are what let the ledger prune with the file.

**Tool-call dedup is scoped per session, spanning files.** Both other scopes are wrong and were caught only by diffing against a pre-change payload: per file over-counts (1,202 keys appear in more than one file of one session), and global under-counts, because a resumed or forked session legitimately replays another session's message ids. `seen_tool_calls` is cleared wholesale by `rewindRollup` — the opposite of `seen_requests`, which must never be cleared — and carries no `path` column, since pruning by `session_key NOT IN (SELECT session_key FROM session_ledger)` saves 44MB of column and index.

**Codex rollouts have their own cache, `codex-sessions.db`, deliberately not in `rollup.db`.** The rollup is authoritative data that outlives its source; this is a pure cache, safe to delete. Rollouts are append-only but folded whole (last `token_count` wins), so there is no tail-parse equivalent — it keys the whole summary on path + size + mtime.

### Live sessions panel

`GET /api/live` returns active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy` / `idle` / `waiting`, stale-filtered at 10 minutes) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred` / `recent`). The panel polls every 3 seconds and pauses while the tab is hidden.

Clicking a row calls `openInCockpit(session)`. The port comes from `/api/live`'s `cockpitPort`, read from `~/.local/share/q-lab/cockpit/daemon.json`, falling back to `5858`. Rows stay inert while `cockpitUp` is false. usage-dashboard renders no transcript — cockpit's `transcript-stream.ts` and `modules/transcript.js` are the single source.

### Key design decisions

- **No build step.** `dashboard/dist/` is committed as-is, vendor libs included.
- **Bun-only runtime.** Uses `bun:sqlite`, `Bun.serve`, `Bun.file`.
- **Namespaced model keys** — `provider:model`, e.g. `claude:claude-opus-4-7`.
- **Billing dedup** by `requestId:messageId`. The shared key lives in `dedup.ts`; the rollup ingest reuses it.
- **Theme** — light and dark through `[data-theme]` on `<html>`. Tokens are defined twice in `styles/base.css` (`:root` and `[data-theme="dark"]`). The toggle cross-fades with the View Transitions API.
- **`index.html` links all 12 sheets directly.** A chained `@import` is discovered only after its parent downloads, so an aggregator loaded them serially. Add a new sheet as a `<link>`, in cascade order.
- **Compression is opt-in per caller.** `gzipJsonResponse` (`cockpit/scripts/http.ts`) serves `/api/stats` only; every other endpoint keeps `jsonResponse`. `serveStaticFile` gzips its `COMPRESSIBLE` set and takes the `Request` as an optional third argument, so the two-argument form stays plain.
- **ETags are mtime + size, never a content hash** — hashing re-reads the file the 304 exists to skip. `serveStaticFile` puts the encoding in the key, since the gzip and plain bodies differ. `/api/stats` reuses its cache fingerprint prefixed by a **per-process `BOOT_ID`**: pricing partly comes from a live OpenRouter fetch, which moves no file, so without it a browser would 304 past a restart that repriced. Both need `Cache-Control: no-cache` — `no-store` leaves the client nothing to revalidate with. Cold load 8.6MB → 0.98MB, warm reload → 12.8KB.
- **A `.jpg` in `assets/` must hold real JPEG data.** MIME comes from the extension alone; browsers sniff, which is how two 1.28MB PNGs sat behind `.jpg` names unnoticed. Renaming an asset moves the `url()` reference and the MIME table with it.
- **Sunrise Bloom** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` / `.live-panel` carry a radial-gradient bloom. `installBloomTracker()` lerps `--bloom-x/--bloom-y` toward the cursor each frame. Register a new panel class in **both** the CSS selector list and the JS `SELECTOR` constant.
- **Hero wave** — `.hero-band` masks with a 200%-wide SVG holding two identical wave cycles. `hero-wave-drift` slides `mask-position-x` one wavelength for a seamless loop.

## Cockpit constraints

These rules are not obvious from the code. Break one and the failure is silent.

**Anchor the decision trail per repo, never per cwd.** `log-root.ts` walks up from cwd for an existing `.cockpit/`, bounded by the git root, then falls back to the git root, then to cwd outside a repo. An agent that cd'd into `frontend/` still logs to the root trail. A hand-made `packages/x/.cockpit` keeps its own. **The walk-up must never cross the git root** — `~/.cockpit` is a real leftover of the pre-XDG cockpit home, and an unbounded walk would collapse every repo under `$HOME` into one trail.

**Resolve sessions by raw cwd.** `find-session` looks sessions up by cwd. For a tracked session, the registry entry's absolute `logPath` is authoritative in `log-stream.ts`, `project-info.ts`, and `design-system.ts` — not the request's `project` param.

**Keep cockpit config global.** It lives at `~/.config/q-lab/cockpit/config.json`: the decision-log language and the scribe-nudge preferences. Per-project nudge opinions live keyed by project root inside that one file. Never write a repo dotfile.

**Gate `needs_your_call` on presence.** The TUI is the default asking surface. `cockpit wait` passes `require_watcher=1`, and `/api/wait` refuses with `{not_watching:true, reason}` (CLI exit `4`) unless two factors hold:

1. **Intent** — the user's explicit `answer_here` switch. Global, default off, in the XDG config. Set it from the dashboard toggle, `cockpit config --answer-here on|off`, or `GET/POST /api/answer-here`.
2. **Liveness** — `hasVisibleSubscriber()` in `permission.ts` sees a live permission-stream subscriber for that session.

Place the gate **after** the stash drain and the superseded check, so a fast answer still lands and a moot call still reports `superseded`.

Do not infer intent from visibility. `document.hidden` stays false when another app covers the browser — verified: a minimized window still reports the tab visible. Liveness alone is also not enough: with the switch on and no tab connected, a park hangs forever.

**Leave the permission relay ungated.** Its protocol is notification-based and the terminal prompt stays live beside the cockpit card, so it already defaults to the TUI.

**Route sends by provider.** Claude sends use the cockpit channel MCP server. Codex sends use the managed Codex remote-control app-server socket, with direct app-server as fallback. OpenCode sends use the TUI HTTP bridge (`opencode-send.ts`): the running TUI is discovered from `OPENCODE_TUI_SERVER_URL` or a `ps` scan for `opencode --port <n>` (a `serve` process is excluded from that scan), then delivered through `/tui/append-prompt` followed by `/tui/submit-prompt`. The channel is UI→agent only; the agent's answers ride the transcript.

## Harness constraints

**Chronicle needs nested subagent spawning.** Claude Code 2.1.217 disabled it by default. Without `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (chronicle needs `2`), every nested orchestrator — `pr` and `adr`, but neither `commit` nor `release`, both of which are flat — fails with `Agent exists but is not enabled in this context`. The `chronicle:install` skill owns this: a `SessionStart` hook runs `setup-spawn-depth.ts --session-check`, writes the value into `~/.claude/settings.json` when missing or too low (it only ever raises), and asks the user to restart. The env var is read at session start, so the writing session still runs without it. OpenCode carries the identical requirement under a different name: `subagent_depth` in `~/.config/opencode/opencode.json`, also needing at least `2` — it ships defaulting to `1`, which blocks nesting outright. There is no session hook to write it; `opencode/install.ts --apply` raises it instead, same raise-only rule, same silent-stop failure mode if it's skipped.

**opencode runtime layer.** All OpenCode-facing code lives in `opencode/` at the repo root, deliberately outside `packages/`, so the two-manifests-per-package invariant and the release config stay untouched — `opencode/` versions nothing and ships in no plugin. Install is symlinks, not copies: `opencode/install.ts --apply` links the 20 skills, the plugin module, the 10 chronicle agents, and the 2 monitor commands into `~/.config/opencode/`, with the checkout as the single source of truth — an edit lands live, no reinstall — plus the one `subagent_depth` config edit above.

Hook parity — which Claude hooks port to which OpenCode events:

| Plugin | Hook | Command | Ported to OpenCode? |
|---|---|---|---|
| monitor | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup.ts --session-check` | **No** — dead code outside Claude Code: it returns immediately without `CLAUDE_PLUGIN_DATA`, and its actual work (statusline-path migration, reaping orphaned Claude processes) is Claude-only |
| monitor | `SessionStart` (same matcher) | `skills/cockpit/scripts/decision-log-start.ts` | Yes → `session.created` |
| monitor | `Stop` | `skills/cockpit/scripts/scribe-nudge.ts` | Yes → `session.idle` |
| chronicle | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup-spawn-depth.ts --session-check` | **Moved** — becomes the installer's `subagent_depth` write |
| chronicle | `PreToolUse` (matcher `Bash`) | `hooks/check-branch.sh` | Yes → `tool.execute.before` |
| dispatch | `PostToolUse` (matcher `Edit\|Write`) | `hooks/flightplan-lint.sh` | Yes → `tool.execute.after` |
| guard | `PostToolUse` (matcher `Edit\|Write`) | `hooks/comment-guard.ts` | Yes → `tool.execute.after`, sharing the event with the lint |

OpenCode has no hook-level "ask" — a plugin's `tool.execute.before` handler can only let a call through or throw. The branch guard degrades accordingly: instead of returning an `ask` permission decision, it throws `check-branch.sh`'s own `systemMessage` verbatim, turning what is a prompt on Claude Code into a hard block on OpenCode.

The module itself carries four constraints, each a trap if broken: it is a single file; it imports nothing from anywhere else in this repo, even a helper worth sharing stays module-local; it derives the repo root from `dirname(import.meta.dir)`, never a config file; and it never reads a harness environment variable — Claude's and Codex's own vars must stay meaningless to it.

**Version policy.** `opencode/` is repo infrastructure, not a release component. This work bumps no `plugin.json`, cuts no `<plugin>-vX.Y.Z` tag, and adds no `CHANGELOG.md` entry — it belongs to no plugin, so none of them owns a version bump for it.

**Codex's interactive TUI freezes hook environments; `codex exec` does not.** The TUI hands its session to a long-lived `codex app-server daemon` whose environment is fixed at daemon start, so a delegation env var such as relay's `RELAY_DELEGATED=1` reaches the Codex frontend but never the hook when the daemon predates it. `codex exec` runs the session in-process and does read the var. Verified on 0.151.0: `RELAY_DELEGATED=1 codex exec` suppresses monitor's decision-log hooks (0 `DECISION LOG ACTIVE` hits in the rollout, 1 in the control), while a herdr pane spawned with the same var running interactive `codex` still shows the Stop nudge. Restarting the app-server refreshes the daemon environment; the delegation marker below is the fix that does not require one. The same suppression works cleanly on Claude Code.

To test hook behavior for free, pass a bogus `-m` model — SessionStart and UserPromptSubmit fire and the rollout persists before the 400 lands, so no tokens are spent. Do **not** try to debug this by adding a probe hook to `~/.codex/hooks.json`: codex gates every hook on a `trusted_hash` under `[hooks.state."<file>:<event>:<i>:<j>"]` in `~/.codex/config.toml`, and an entry whose hash does not match is skipped with no warning.

**The delegation marker crosses that daemon boundary.** relay's live codex path drops a file that monitor's decision-log hooks read, because no environment variable can reach them. The writer is `packages/relay/skills/relay/scripts/delegation-marker.ts`, the reader is `packages/monitor/skills/cockpit/scripts/delegation-marker.ts`, and the two plugins version independently — **they share a path and a shape, never code**, so a change to one is a change to both:

```
~/.local/share/q-lab/delegation/<startedAt>-<rand>.json
{ cwd, backend, startedAt, armUntil, expiresAt, sessionIds: [] }
```

Three rules make it safe. Matching is two-phase: a marker matches on `cwd` alone only until `armUntil` (90s, covering relay's spawn plus the 20s TUI settle), and the hook that matches writes its own `session_id` back so every later turn matches exactly — fuzzy once, precise forever, which is what keeps an interactive codex opened in the same repo from being silenced for its whole life. Only **codex live panes** get a marker (`needsDelegationMarker`): Claude and opencode run their hooks inside the process relay spawned, so `RELAY_DELEGATED` already reaches them, and a marker there could silence the parent session sharing the repo. And the reader ignores the marker store entirely unless `PLUGIN_ROOT` is set, which is codex's tell — Claude Code sets only the `CLAUDE_`-prefixed one.

A `pending` live result keeps its marker: the pane is still running and still being nudged, so the marker has to outlive relay and retire on `expiresAt` instead. Every other outcome clears it.

**The autopilot wrappers suppress through the env, not the marker.** `codex-run.ts` and `opencode-run.ts` spawn with `env: { ...process.env, RELAY_DELEGATED: "1" }`. They never went through relay, so before this they set nothing at all. `codex exec` and opencode both read the var, so neither needs the marker.

**The statusline wiring drifts by version.** monitor's `SessionStart` hook repairs under a marker gate on `$CLAUDE_PLUGIN_DATA/.wired-version`. Once per version it re-points a version-drifted statusline path and removes any stale channel entry. The cache path encodes the version (`.../monitor/3.1.0/...`) and old directories linger, so "wired" means the exact current path, not mere existence. The hook never fresh-wires — initial opt-in stays manual.

**Drift inside a version is noticed, never fixed.** The same hook then runs a read-only drift watch on every session, because the marker gate is blind to a hand-edited `settings.json`, a restored backup, or a reinstall under another cache root. It reports a foreign collector path, a stale hand-wired channel, missing `permissions.allow` patterns, and an unparseable `settings.json`, then tells the user to run `/monitor:install`. Two rules make it work: the notice ships as a `systemMessage` inside **one** JSON object on stdout — bare stdout reaches only the model, so nothing else in `--session-check` may print and `migrate()`'s output is captured — and repetition is keyed on which pieces are off, stored in `$CLAUDE_PLUGIN_DATA/.drift-notice`, so one complaint is made once but a drift that returns is reported again.

## Commands

```bash
# Dashboard (port 5938, auto-opens browser)
bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts   # [--port N] [--no-open]

# Data as JSON (CLI mode)
bun packages/monitor/skills/usage-dashboard/scripts/api.ts
bun packages/monitor/skills/usage-dashboard/scripts/live.ts

# Rollup DB (--rebuild rescans while preserving history and dedup keys, and
# rewrites the session ledger, which a replay always re-derives from scratch)
bun packages/monitor/skills/usage-dashboard/scripts/rollup-update.ts  # [--rebuild]

# monitor:install engine — checks both skills, wires the statusline
bun packages/monitor/skills/install/scripts/setup.ts                  # --check | --dry-run | --apply
bun packages/monitor/skills/install/scripts/install.ts                # dashboard precheck only

# Cockpit daemon (port 5858)
bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts

# Restart the daemon onto THIS install's code. Supersedes any concurrent MCP
# respawn, then verifies our root won the port. Run it from the updated cache.
bun packages/monitor/skills/cockpit/scripts/cockpit.ts restart        # [--port N] [--no-open]

# Cockpit config (global, XDG)
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config get-language
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config --log-language zh-TW
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config --answer-here on
bun packages/monitor/skills/cockpit/scripts/cockpit.ts nudge status   # on|off|toggle|clear|status
                                                                     # [--scope session|project|user]

# Cockpit dev: isolate from the cached daemon entirely
COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999

# OpenCode installer — symlinks skills/plugin/agents/commands into ~/.config/opencode/, raises subagent_depth
bun opencode/install.ts                                                # --check | --dry-run | --apply | --unlink

# Tests
bun test packages/monitor/skills/cockpit/scripts/
bun test packages/monitor/skills/install/scripts/
bun test packages/monitor/skills/usage-dashboard/scripts/rollup-update.test.ts
bun test opencode/

# Whole-repo test run — --parallel runs test files across worker processes (Bun 1.4)
bun test --parallel .

# Typecheck. Run it before calling a refactor done — `bun build` bundles
# without typechecking, and `bun test` only reaches the paths a test drives.
bunx --bun tsc --noEmit                              # whole repo
bunx --bun tsc --noEmit | grep <path-you-touched>    # must print nothing
```

**Typecheck against the root `tsconfig.json`, never against a file list.** Naming
files on the command line drops the config, so `strict` runs without
`types: ["bun"]` and every `Bun`, `process`, and `Buffer` reports as an undefined
name. Real errors then hide among a dozen fake ones — this is how a `Target`
literal missing a required field once shipped and failed at runtime on every
command.

The repo-wide run is **not** green: 86 pre-existing errors sit outside herdr, so
a change is clean when `grep <path-you-touched>` prints nothing, not when the
count is zero.

## Code Conventions

- Runtime is Bun with TypeScript. There is no transpile step.
- Use `type` over `interface`.
- Frontend uses petite-vue, not full Vue. Charts use Chart.js.
- Take no external npm dependencies at runtime. Vendor libraries are committed in `dashboard/dist/vendor/`. `devDependencies` may carry types-only packages — `@types/bun` is there so the typecheck above resolves Bun's globals.
- Vendor mermaid as the UMD bundle (`mermaid.min.js`, ~3.3MB, sets `globalThis.mermaid`). The ESM build is code-split and cannot ship as one file. `modules/diagram.js` lazy-loads it on the first diagram render, themes it with concrete hex (mermaid's khroma engine cannot parse `oklch()`), and sanitizes the SVG through DOMPurify's SVG profile.
- Price per 1M tokens in USD.

## Releasing

**Versions live only in each plugin's two `plugin.json` files.** The marketplace registries carry no `version` field — do not add one. The published version is the git tag plus the `plugin.json` values.

Print the current versions rather than trusting a doc:

```bash
git tag --sort=-creatordate | head -5
```

**Every plugin versions independently** under a plugin-scoped tag `<plugin>-vX.Y.Z`, for example `chronicle-v0.1.0`. There is no repo-wide version.

**Bump only the plugin you touched.** Its two files move together:

- `packages/<plugin>/.claude-plugin/plugin.json` → `version`
- `packages/<plugin>/.codex-plugin/plugin.json` → `version`

**This repo runs GitHub Flow.** `main` is the only long-lived branch; there is no `develop`. Both `.chronicle/release.json` and `.chronicle/pr.json` record `"workflow": "github-flow"`, so `/chronicle:release` commits the bump on `main`, cuts every tag on that bump commit, and merges nothing.

**Prefer `/chronicle:release`.** This repo dogfoods its own release skill. Its `.chronicle/release.json` records each plugin as an independently-versioned component with its two `plugin.json` files as version-file patterns. Pick the touched components at the version gate. Coordinated multi-component releases are native: name several components and the finisher cuts N scoped tags on one bump commit.

To cut a release by hand: bump the two `plugin.json` files, add a `CHANGELOG.md` entry headed per plugin (`## [chronicle 0.1.0]`), commit on `main`, cut an annotated `<plugin>-vX.Y.Z` tag on that commit, then push `main` and the tag.

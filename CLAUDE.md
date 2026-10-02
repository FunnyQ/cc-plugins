# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What This Is

`q-lab-marketplace` — a plugin marketplace for Claude Code, Codex, and OpenCode. It holds eight plugins. Each versions independently, and each but `clawd` ships to Claude Code and Codex; OpenCode is a third runtime layered on top of the same skills (see `opencode/` below), versioned with none of them.

| Plugin | Purpose | Skills |
| --- | --- | --- |
| **monitor** | Usage analytics + live session cockpit | `usage-dashboard`, `cockpit`, `install` |
| **dispatch** | Interview-driven planning and execution | `preflight`, `hop`, `flightplan`, `autopilot`, `waypoints`, `deckplan` |
| **relay** | Delegate a task to another harness CLI | `relay` |
| **chronicle** | ADR curation, commit, PR/MR, and release automation | `adr`, `commit`, `pr`, `release`, `install` |
| **herdr** | Reference + agent orchestration for the Herdr terminal | `herdr`, `tell`, `ask`, `herdr-browser`, `herdr-protocol-upgrade` |
| **guard** | Coding rules the harness enforces, as hooks | *(none — hooks only)* |
| **browsers** | Drive Firefox, Zen, Chrome, and Safari from the terminal | `firefox`, `chrome`, `safari` |
| **clawd** | Animated mascot above the prompt, Claude Code only | *(none — a function-hooks mod)* |

Read the plugin's own `skills/*/SKILL.md` for its contract. This file documents only what no `SKILL.md` covers: the repo layout, monitor's dashboard internals, and the release rules.

### Plugin summaries

Design facts the `SKILL.md` files do not carry:

- **dispatch** — `preflight` captures the want as `docs/<slug>/INTENT.md` and refuses to decide *how*; it hands off to `flightplan`, which reads that file as its baseline. Execution is a ladder by scope: `hop` (interview, plan, and execute a small scope in this conversation) → `flightplan` (spec + `tasks/` tree on disk) → `autopilot` (executes that tree, gated on each task's `## Eval rubric`). `waypoints` sits above flightplan and plans each leg just-in-time, after the previous one lands. **`hop` is the skill that was called `preflight` before dispatch 4.0.0** — the name moved up a rung, the behaviour did not change. Under Claude Code, run each non-final autopilot task in its own git worktree managed by `flightplan/scripts/worktree.ts`. Land its work under a mutex. Run every pipeline role with the explicit model and effort map. Apply a task's `> **Models**:` header overrides to dev, verify, judge, and fix.
- **relay** — a backend-agnostic mode layer over a per-harness strategy layer. The capability matrix makes `image` codex-only.
- **chronicle** — thin `SKILL.md` → agent subtree, so diff and git output never reach the main conversation. **Agent hand-offs are files, never replies**, which is what makes an agent answering in prose cost nothing. No skill nests an orchestrator. `adr`'s main agent runs `triage.ts` for clustering, batching, merging, and the archive plan, fans the batch files out to parallel `judge` leaves, then spawns the `codifier` (which writes the drafts straight into the gate-2 payload file) and the `barrowkeeper` (which runs `adr-commit.ts apply`) itself; **`commit`, `pr`, and `release` each run their own scripts too, `pr`'s storykeeper writes the body to a file that `request-creator.ts` reads rather than retyping it, and `release` spawns one leaf agent for the changelog entry alone.** An errand-runner earns its spawn only when what it swallows is big: a diff, a range of commits. Relaying a few kilobytes of JSON it cost more than it saved, and put a model between the caller and a version number. Splitting it across three cost 70k tokens of cold agent boilerplate against 4–11k of actual diff, and 16 model round trips for work that needs 4. `commit` and `release` put a deterministic script under that topology and re-read their own progress from the log, so an interrupted run resumes. `release` is config-first: the whole-repo versus per-component shape lives in a committed `.chronicle/release.json`.
- **guard** — the only plugin with no skills: it ships hooks and nothing else, so there is nothing to invoke and no way to turn it off short of uninstalling. `comment-guard` reports the comment *blocks* an edit added or grew and asks the model whether each line says why or what. No heuristic judges the answer, because one that guesses meaning would train the model to phrase around it rather than to delete the comment. **`jev-screen.ts` may only withdraw a question, never add one.** When `TYPESAFE_API_KEY` is set, both hooks ask TypeSafe's Jev about every added line and drop a block only when each line scores P(why) ≥ 0.8. Any failure keeps the block. Over 708 lines the transcripts reported, it spared 84 of 222 blocks and passed 4 of 36 lines opus labelled what, at p50 220 ms. The comment text and file name leave the machine on every report, in every repo. Three rules set the noise floor, and each was measured over this repo's 2,294 comment blocks before it was picked. **"Added" comes from `tool_response.structuredPatch` when the harness sends hunks** — real line numbers, the only input that survives a Write over an *existing* file (otherwise every untouched block in it reports), an `Edit` with `replace_all` landing in several places, and two comment lines whose text is identical. **The text path is not a fallback for OpenCode alone — Claude Code needs it too.** A Write that *creates* a file sends `structuredPatch: []` with `originalFile: null` (78 of 78 measured), so every new file rides the text difference, which is the right answer there because the whole file is new. That makes the empty patch ambiguous, and `type` is the only thing that separates the two readings: `update` plus `[]` means nothing changed and must report nothing, while `create` plus `[]` means everything is new. Do not collapse them with `Array.isArray`, and do not discriminate on `originalFile` — 2 measured `update` results carry hunks with `originalFile: null`. OpenCode sends no `tool_response` at all, because `opencode/plugin.ts` synthesises the payload from the tool arguments alone. The text path is the older **multiset difference over comment lines**: moving a comment is not an addition, rewording one is, and an added line whose wording repeats an untouched one marks whichever comes first in the file. **A `+` line the same diff also removed is not an addition.** `resolveAdded` subtracts the removed texts from the added ones as a multiset before it does anything else, both sides trimmed. Without it the diff path silently loses the property the text path has always had: re-indenting a block — wrapping it in an `if`, a `try`, a loop — rewrites every line it touches, so the whole block reads as new and every comment inside gets re-asked. That is far more common than literally moving a comment, and it is why the two paths must agree here. **A diff is then trusted only while the file still matches it** — `resolveAdded` re-reads each surviving `+` line off disk and degrades to that diff's own added *text* on any mismatch, because a formatter hook on the same `PostToolUse` event reflows the file in parallel and shifts every line the diff named. **A block reports at 3+ lines, counted at its size on disk after the write**, so a one-line addition into a two-line block fires and a lone `//` never does; that alone silences 68% of blocks, which is what keeps the hook tolerable enough to leave on. **A single blank line bridges a block, two do not** — a paragraph break would otherwise split one authored block into two sub-threshold halves and silence it; the bridged blank pads the reported range but does not count toward the 3, and over this repo bridging newly qualifies 2 of 868 blocks. That exclusion is a **count kept while bridging, never a filter on empty text** — a blank line inside a `/* */` is itself a comment line and has to keep counting, so `CommentBlock.height` carries the answer and `formatReason` totals that rather than `lines.length`. Blocks come from disk rather than `new_string` because an Edit fragment truncates any block crossing its edges. **The file-header block is exempt** — every block before the first code line, since module prose is the one place a wall of comment is the point. A word-count threshold was measured and rejected: of the 28 files whose comments are all single-line blocks, the wordiest totals 71 words, so no threshold that spares normal code would ever fire where the block rule had not already fired. Each language contributes a `Syntax` of line markers plus **open/close block pairs**, and the scan is stateful over any pair — a `/* */` docblock, an `<!-- -->` HTML comment and a Lua `--[[ ]]` all count their full height. Openers are tested before line markers because several overlap (Lua's `--[[` also starts with `--`). Extensionless build files match on name, so `Rakefile` and `Dockerfile` are covered. **`COMMENT_GUARDED` in `opencode/plugin.ts` is a hand-kept copy of those tables** — the module may import nothing from this repo, so widening it only wastes a spawn while narrowing it past the hook stops guarding a language with no error anywhere. `plugin.test.ts` cross-checks both directions by enumerating `BY_EXT` and `BY_NAME` themselves; **never pin that test to a hand-listed sample**, which is a third copy that drifts the same silent way and misses exactly the entry nobody remembered. The comparison works only because `syntaxFor` is pure lookup — the "should this file be guarded at all" policy lives in `isGuardedPath`, which the regex does not encode: a `docs` / `vendor` / `node_modules` **path segment** (not a substring, so a relative `docs/gen.py` is caught and `mydocs/` is not), a `.min.js` / `.min.css` suffix, and the prose extensions. **`plugin.ts` keeps no copy of that policy** — the hook re-checks it on every run, so a second copy could only drift; the regex over-admitting there costs one wasted spawn and nothing else. **`comment-sweep` catches what never goes through Edit or Write** — `sed -i`, a heredoc, a codegen script. `UserPromptSubmit` writes the worktree as a git tree through a throwaway `GIT_INDEX_FILE` (untracked files included, real index untouched), and `Stop` diffs a second tree against it with `-U0` and feeds the hunks to the same `resolveAdded` / `flaggedBlocks`, answering with `decision: block` on stdout because both Claude Code and Codex read that shape. Two rules keep it from nagging: the baseline advances *before* the sweep reports, so the Stop that re-fires after the fix-up judges only the fix-up; and `comment-guard` records every line it already asked into `sweep-state.ts`, which the sweep subtracts — the two hooks run side by side, and without it every Edit-made block would be asked twice. A turn touching more than 20 guarded files reports nothing: that is a checkout, a pull, or a formatter, not authorship. It cannot tell the agent's writes from yours made in an editor during the same turn.
- **browsers** — three skills with one command surface (`open`, `eval`, `click`, `screenshot`, …, one printed line each), each on the browser's own protocol with no driver binary and no npm dependency. It is deliberately not herdr-browser's home: that skill opens its browser as a Herdr tab, so it needs Herdr, and its `herdr:herdr-browser` id is named in the global workflow rule and in `hop` / `flightplan`. `skills/shared/` carries what two skills would otherwise copy — `instances.ts` (the per-instance registry firefox and chrome share) and `webdriver.ts` (the W3C element key and key code points, written as numbers because the formatter rewrites `` escapes into invisible characters). **firefox**: Gecko dropped CDP in Firefox 129, so it talks Marionette directly: length-prefixed JSON over TCP, no geckodriver. Playwright cannot stand in, because it drives its own patched Firefox build and not the installed Firefox or Zen. **Every instance is its own process, profile, and port**, recorded under `/tmp/q-lab/browsers/firefox/instances/`; a fixed port (Marionette's default 2828) let a second launch attach to the first agent's browser. The port is chosen by binding port 0 and releasing it, so a race with another process surfaces as a launch timeout, never as a shared browser. Each command opens and deletes its own Marionette session, because the server serves one connection at a time and leaves a second one without a greeting — measured, the racing command fails after the 10s greeting timeout. The frame reader buffers **bytes** until a whole frame is in, because the length prefix counts bytes and decoding chunk by chunk shifts every cut after a split multibyte character. Element references use the W3C key `element-6066-11e4-a52e-4f735466cecf`. **chrome** speaks CDP over one page WebSocket and launches with `--remote-debugging-port=0`, reading the bound port back from the profile's `DevToolsActivePort` — no choose-then-release race. `Page.navigate` returns before the page loads, so every navigation arms a wait for `Page.loadEventFired` or `Page.navigatedWithinDocument` *before* it sends the command; Marionette and safaridriver wait on their own. `click` and `press` cannot know in advance whether they navigate, so they watch `Page.frameStartedLoading` for 50ms and, if it fires, wait for `Page.frameStoppedLoading` — measured, a 10ms window missed 1 in 5 local-link navigations and 30ms missed none. Without it the next command saw the new document at `readyState` `interactive`, before its images loaded. **safari** drives `/usr/bin/safaridriver` over W3C WebDriver HTTP. Safari has no headless mode and pairs with **one session per machine** — a second `POST /session` answers `already paired with another WebDriver session` — so the skill keeps one record at `/tmp/q-lab/browsers/safari/session.json` and has no `--new` or `--id`. Its live test runs only under `SAFARI_LIVE=1`, because a plain `bun test .` must never open a focus-stealing window with a glass pane over it.
- **clawd** — a Claude Code *mod*: a function-hooks module (`hooks/hooks.json` → `register.tsx`), not a skill or a command hook, so Codex, which has no such API, gets no manifest and no registry entry. `director.ts` is a port of janus-hud's `MascotDirector` and must stay one. The terminal draws a `Raster` of `▀`/`▄` half blocks, or an `Image` where the terminal has kitty Unicode placeholders. herdr's libghostty has none, and there the first denied `blit` switches to the `Raster` for good. The desktop redraws a plain static `Svg` per frame, because an `isInteractive` one sits on an opaque white frame. `frames.ts` is a one-off conversion of janus-hud's `MascotFrames.swift`, with no generator in this repo; `NOTICE` carries hey-clawd's MIT licence. Its tests import `claude-code/testing`, so the root `bunfig.toml` and `tsconfig.json` exclude the package: run `claude plugin test packages/clawd` and `claude plugin validate packages/clawd`.
- **monitor** — `usage-dashboard` is the rear-view, `cockpit` the windshield. They run independent servers on separate ports with separate `dist/` SPAs; only the plugin packaging is shared. `install` owns every prerequisite check and config write for the whole plugin.

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # Claude registry (all eight plugins; no version field)
├── .agents/plugins/marketplace.json  # Codex registry (seven plugins, all but clawd; no version field)
├── .chronicle/release.json           # release shape: per-component versions + version-file patterns
├── CHANGELOG.md                      # Keep a Changelog format, per-plugin headings
├── packages/
│   ├── monitor/
│   │   ├── .claude-plugin/plugin.json    # manifest + SessionStart hooks + cockpit channel
│   │   ├── .codex-plugin/{plugin,hooks}.json  # mirrors the Claude hooks
│   │   ├── cockpit-rs/                  # Rust crate: server, channel, CLI, hook subcommands
│   │   │   └── src/atlas/               # usage-dashboard engine + server: `cockpit atlas <sub>`
│   │   │       # stats.rs / rollup_db.rs / rollup_update.rs / codex.rs / live.rs / server.rs / statusline.rs
│   │   ├── commands/                     # thoughtful.md, nudge.md
│   │   └── skills/
│   │       ├── usage-dashboard/
│   │       │   ├── PRODUCT.md            # design direction — Sunrise Atlas
│   │       │   ├── contract/         # Bun black-box suite for `cockpit atlas`
│   │       │   │   └── golden/           # recorded TS outputs — the permanent parity reference
│   │       │   ├── dashboard/dist/       # committed SPA, no build step
│   │       │   └── references/pricing-defaults.json
│   │       ├── cockpit/
│   │       │   ├── SKILL.md              # router only
│   │       │   ├── PRODUCT.md / DESIGN.md  # brand + Night Flight design system
│   │       │   ├── references/           # pilot / scribe / restart / claude-cli / codex
│   │       │   ├── bin/cockpit          # POSIX sh shim: fetch + verify + exec
│   │       │   ├── contract/            # permanent Bun black-box suite
│   │       │   ├── scripts/             # kept TS + their tests
│   │       │   │   └── diagram-lint.ts  # Mermaid gate spawned by Rust
│   │       │   └── dashboard/dist/
│   │       └── install/scripts/
│   │           ├── setup.ts              # plugin-wide check + wire (--check/--dry-run/--apply/--session-check)
│   │           ├── install.ts            # dashboard precheck
│   │           ├── setup-statusline.ts
│   │           └── statusline-decision.ts    # pure decision, unit-tested
│   ├── dispatch/
│   │   ├── hooks/flightplan-lint.sh      # PostToolUse, path + content gated
│   │   └── skills/{preflight,hop,flightplan,autopilot,waypoints,deckplan}/
│   │       # preflight/references/intent-template.md — the INTENT.md contract;
│   │       # preflight borrows flightplan's scaffold.ts for its collision check
│   │       # flightplan/scripts/ also hosts autopilot's shared tools:
│   │       # next-ready / score-task (--log) / flightlog / worktree
│   ├── chronicle/
│   │   ├── shared/scripts/               # code imported by more than one skill
│   │   ├── agents/                       # lawspeaker (commit) / storykeeper (pr) / annalist (release) /
│   │   │                                 # judge+codifier+barrowkeeper (adr) — none spawns a child
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
│   │   │   ├── references/               # config / cli / socket-api / plugin-development / agent-orchestration
│   │   │   └── scripts/herd.ts           # typed Bun wrapper: spawn/tell/send/ask/collect/keys/wait/read/list/close
│   │   ├── herdr-browser/scripts/browser.ts  # browser pane + CDP driver: open/text/snapshot/watch/endpoint
│   │   ├── tell/                         # hand a job to another project's agent, fire-and-forget
│   │   ├── ask/                          # ask another project's agent and get the answer back
│   │   └── herdr-protocol-upgrade/       # raises a plugin's minimum-protocol constant
│   ├── browsers/skills/
│   │   ├── shared/                       # no SKILL.md: instances.ts (registry) + webdriver.ts (W3C facts)
│   │   ├── firefox/scripts/              # firefox.ts CLI + marionette.ts client; *.live.test.ts skips without a browser
│   │   ├── chrome/scripts/               # chrome.ts CLI + cdp.ts client
│   │   └── safari/scripts/               # safari.ts CLI over safaridriver; live test opt-in via SAFARI_LIVE=1
│   ├── guard/                            # hooks only — no skills, nothing to invoke
│   │   ├── .codex-plugin/{plugin,hooks}.json  # mirrors the Claude hook
│   │   └── hooks/
│   │       ├── comment-guard.ts          # PostToolUse Edit|Write; exit 2 + stderr
│   │       ├── comment-sweep.ts          # UserPromptSubmit snapshot / Stop sweep; decision: block
│   │       ├── jev-screen.ts             # drops blocks Jev scores all-why; both hooks call it
│   │       └── sweep-state.ts            # per-session baseline + already-reported lines
│   └── clawd/                            # Claude Code mod — no .codex-plugin, no skills
│       ├── NOTICE                        # hey-clawd's MIT licence, for frames.ts
│       └── hooks/                        # register.tsx + director.ts + encode.ts + frames.ts; *.test.ts
└── opencode/                          # OpenCode runtime layer — repo infra, outside packages/, owns no version
    ├── plugin.ts                          # the OpenCode plugin module (single file, no repo imports)
    ├── plugin.test.ts
    ├── install.ts                         # --check | --dry-run | --apply | --unlink
    ├── install.test.ts
    ├── agents/                            # 6 chronicle agents in OpenCode frontmatter (committed)
    ├── commands/                          # nudge.md + thoughtful.md in OpenCode format (committed)
    └── references/opencode-runtime.md     # the runtime spike log, written by hand before the tree ran
```

Every `packages/<plugin>/` holds both a `.claude-plugin/plugin.json` and a `.codex-plugin/plugin.json`, except `clawd`, which runs only on Claude Code's function hooks.

## Monitor: dashboard internals

### Data flow

1. The engine lives in `packages/monitor/cockpit-rs/src/atlas/`. `stats.rs` builds the payload from three providers: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, and `~/.claude/projects/**/*.jsonl`; `~/.codex/state_5.sqlite` and `~/.codex/sessions/`; and `~/.local/share/opencode/opencode.db` through `opencode.rs`; `codex.rs` owns the Codex side and `live.rs` the active sessions.
2. Pricing resolves in order: bundled defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`.
3. `server.rs` (`cockpit atlas serve`) serves `dashboard/dist/` and exposes `GET /api/stats`, `GET /api/live`, and `POST /api/pricing/refresh`. It binds `127.0.0.1`.
4. The frontend fetches `/api/stats` on load and renders with petite-vue and Chart.js.

### Usage rollup DB

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). The rollup DB makes token history outlive that deletion.

**Never read transcript contents on the request path.** `read_rollup()` (`claude.rs`) walks `PROJECTS_DIR` for paths only (~110ms of readdir), hands them to `update_rollup()`, and reads everything else back out of the DB. Reading the transcripts there instead cost 13.4s per request on a 2.2GB corpus.

- `rollup_update.rs` (`cockpit atlas rollup-update`) tail-parses each transcript from `ingested_files.bytes_parsed` at UTF-8-safe newline boundaries, dedups billing across runs through `seen_requests`, and upserts additively into `usage_hourly(hour_ms, project, model)`. The same pass fills the session ledger — one parse, both outputs.
- The rollup stores **tokens only**. Cost stays a downstream computation, so price corrections apply retroactively. The ledger follows the same rule: `date`, `projectName`, `model` and `tokens` are all derived in `read_rollup_ledger()`, never stored.
- `hour_ms` is the local hour start. It matches `hourStartMs`, so daily and heatmap reconstruction is byte-identical.
- Triggers: the dashboard load (primary) and a detached, 5-minute-throttled `nudge()` of `cockpit atlas rollup-update` from `statusline.rs` (`cockpit atlas statusline`, secondary). There is no daemon.
- A file shrinking below `bytes_parsed` or `--rebuild` replays transcripts while preserving `usage_hourly` and existing dedup keys. Deleted files are pruned from `ingested_files` and `seen_requests`; their tokens remain. Schema upgrades must migrate in place: v1 → v2 retains legacy keys with an unknown path, v2 → v3 rewinds every cursor to backfill the ledger, and unsupported versions are refused — including a *newer* one, so an older monitor build refuses a v3 file rather than corrupting it. `open_rollup_db()` (`rollup_db.rs`) writes `<db>.v<old>.bak` via `VACUUM INTO` before any version-changing migration (a plain copy of a WAL database can read back short). The rollup is authoritative for deleted transcripts, so clearing it permanently loses history. Replays do not correct prior over-counts or changed billing/bucketing; restored transcripts whose keys were already pruned can count again.
- The DB lives at `~/.local/share/q-lab/token-atlas/rollup.db`, outside dotfile sync.

**`usage_hourly` and `session_ledger` have opposite deletion and replay rules.** Get this backwards and the failure is silent arithmetic.

| | `usage_hourly` | `session_ledger` / `session_model_usage` |
| --- | --- | --- |
| Transcript deleted | tokens stay — the whole point | rows pruned with the file |
| Replay from byte 0 | untouched; `seen_requests` blocks re-billing | file's rows deleted, then rewritten |

`interactions` and `tool_calls` have no `seen_requests`-style gate, so accumulating them onto surviving rows would double them on every rebuild — hence the per-file clear, and hence `parse_slice`'s `replay` flag. A replay must then ignore `seen_requests` to re-derive what it just deleted, so it dedups tokens against a run-scoped `ledgerSeen` set instead; that works only because every replay path rewinds *all* files.

Ledger rows are keyed `(path, session_key)` and summed per session on read. A session spans several files — a subagent transcript carries its parent's `sessionId` (1,442 of 2,571 measured) — while a file holds exactly one session key. Per-file rows are what let the ledger prune with the file.

**Tool-call dedup is scoped per session, spanning files.** Both other scopes are wrong and were caught only by diffing against a pre-change payload: per file over-counts (1,202 keys appear in more than one file of one session), and global under-counts, because a resumed or forked session legitimately replays another session's message ids. `seen_tool_calls` is cleared wholesale by `rewind` — the opposite of `seen_requests`, which must never be cleared — and carries no `path` column, since pruning by `session_key NOT IN (SELECT session_key FROM session_ledger)` saves 44MB of column and index.

**Codex rollouts have their own cache, `codex-sessions.db`, deliberately not in `rollup.db`.** The rollup is authoritative data that outlives its source; this is a pure cache, safe to delete. Rollouts are append-only but folded whole (last `token_count` wins), so there is no tail-parse equivalent — it keys the whole summary on path + size + mtime.

### Live sessions panel

`GET /api/live` returns active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy` / `idle` / `waiting`, stale-filtered at 10 minutes) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred` / `recent`). The panel polls every 3 seconds and pauses while the tab is hidden.

Clicking a row calls `openInCockpit(session)`. The port comes from `/api/live`'s `cockpitPort`, read from `~/.local/share/q-lab/cockpit/daemon.json`, falling back to `5858`. Rows stay inert while `cockpitUp` is false. usage-dashboard renders no transcript — cockpit's Rust transcript routes and `modules/transcript.js` are the single source.

### Key design decisions

- **No build step.** `dashboard/dist/` is committed as-is, vendor libs included.
- **The dashboard server is Rust** (`cockpit atlas serve`). Bun is still required for the contract suite, `install/`, and `diagram-lint.ts`.
- **Namespaced model keys** — `provider:model`, e.g. `claude:claude-opus-4-7`.
- **Billing dedup** by `requestId:messageId`. The shared key lives in `dedup.rs`; the rollup ingest reuses it.
- **Theme** — light and dark through `[data-theme]` on `<html>`. Tokens are defined twice in `styles/base.css` (`:root` and `[data-theme="dark"]`). The toggle cross-fades with the View Transitions API.
- **`index.html` links all 12 sheets directly.** A chained `@import` is discovered only after its parent downloads, so an aggregator loaded them serially. Add a new sheet as a `<link>`, in cascade order.
- **Compression is opt-in per caller.** `server.rs` gzips the `/api/stats` JSON only; every other endpoint answers plain. The static-file path gzips its compressible types.
- **ETags are mtime + size, never a content hash** — hashing re-reads the file the 304 exists to skip. The static-file ETag puts the encoding in the key, since the gzip and plain bodies differ. `/api/stats` reuses its cache fingerprint prefixed by a **per-process `BOOT_ID`**: pricing partly comes from a live OpenRouter fetch, which moves no file, so without it a browser would 304 past a restart that repriced. Both need `Cache-Control: no-cache` — `no-store` leaves the client nothing to revalidate with. Cold load 8.6MB → 0.98MB, warm reload → 12.8KB.
- **A `.jpg` in `assets/` must hold real JPEG data.** MIME comes from the extension alone; browsers sniff, which is how two 1.28MB PNGs sat behind `.jpg` names unnoticed. Renaming an asset moves the `url()` reference and the MIME table with it.
- **Sunrise Bloom** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` / `.live-panel` carry a radial-gradient bloom. `installBloomTracker()` lerps `--bloom-x/--bloom-y` toward the cursor each frame. Register a new panel class in **both** the CSS selector list and the JS `SELECTOR` constant.
- **Hero wave** — `.hero-band` masks with a 200%-wide SVG holding two identical wave cycles. `hero-wave-drift` slides `mask-position-x` one wavelength for a seamless loop.

## Cockpit constraints

These rules are not obvious from the code. Break one and the failure is silent.

**Anchor the decision trail per repo, never per cwd.** `cockpit-rs/src/log_root.rs` walks up from cwd for an existing `.cockpit/`, bounded by the git root, then falls back to the git root, then to cwd outside a repo. An agent that cd'd into `frontend/` still logs to the root trail. A hand-made `packages/x/.cockpit` keeps its own. **The walk-up must never cross the git root** — `~/.cockpit` is a real leftover of the pre-XDG cockpit home, and an unbounded walk would collapse every repo under `$HOME` into one trail.

**Resolve sessions by raw cwd.** `find-session` looks sessions up by cwd. For a tracked session, the registry entry's absolute `logPath` is authoritative in `cockpit-rs/src/server/log_stream.rs`. Resolve project metadata and design requests through `known_project()` in `cockpit-rs/src/server/views.rs`, then read them in `cockpit-rs/src/server/views/design.rs`.

**Keep cockpit config global.** It lives at `~/.config/q-lab/cockpit/config.json`: the decision-log language and the scribe-nudge preferences. Per-project nudge opinions live keyed by project root inside that one file. Never write a repo dotfile.

**Gate `needs_your_call` on presence.** The TUI is the default asking surface. `cockpit wait` passes `require_watcher=1`, and `/api/wait` refuses with `{not_watching:true, reason}` (CLI exit `4`) unless two factors hold:

1. **Intent** — the user's explicit `answer_here` switch. Global, default off, in the XDG config. Set it from the dashboard toggle, `cockpit config --answer-here on|off`, or `GET/POST /api/answer-here`.
2. **Liveness** — `Presence::has_visible_subscriber()` in `cockpit-rs/src/server/presence.rs` sees a live permission-stream subscriber for that session.

Place the gate **after** the stash drain and the superseded check, so a fast answer still lands and a moot call still reports `superseded`.

Do not infer intent from visibility. `document.hidden` stays false when another app covers the browser — verified: a minimized window still reports the tab visible. Liveness alone is also not enough: with the switch on and no tab connected, a park hangs forever.

**Leave the permission relay ungated.** Its protocol is notification-based and the terminal prompt stays live beside the cockpit card, so it already defaults to the TUI.

**Route sends by provider.** Claude sends use the cockpit channel MCP server. Codex sends use the managed Codex remote-control app-server socket, with direct app-server as fallback. OpenCode sends use the opencode 1.x TUI HTTP bridge (`cockpit-rs/src/server/opencode.rs`): the running TUI is discovered from `OPENCODE_TUI_SERVER_URL`, `OPENCODE_SERVER_URL`, or a `ps` scan for `opencode --port <n>` (a `serve` process is excluded from that scan), then delivered through `/tui/append-prompt` followed by `/tui/submit-prompt`. The channel is UI→agent only; the agent's answers ride the transcript.

## Harness constraints

**No chronicle agent spawns a child.** Claude Code 2.1.217 disabled nested subagent spawning by default, and chronicle once carried a `SessionStart` hook that raised `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to `2` for its `pr` and `adr` orchestrators. Both orchestrators were folded away, so the hook and its scripts are gone; keep every chronicle agent a leaf, or the requirement comes back with a silent `Agent exists but is not enabled in this context` failure. OpenCode's equivalent, `subagent_depth` in `~/.config/opencode/opencode.json`, ships defaulting to `1`, which blocks nesting outright; dispatch's `autopilot` still needs it at `2`, so `opencode/install.ts --apply` still raises it — raise-only, no session hook, and a silent stop if it is skipped.

**opencode runtime layer.** All OpenCode-facing code lives in `opencode/` at the repo root, deliberately outside `packages/`, so the two-manifests-per-package invariant and the release config stay untouched — `opencode/` versions nothing and ships in no plugin. Install is symlinks, not copies: `opencode/install.ts --apply` links the 23 skills, the plugin module, the 6 chronicle agents, and the 2 monitor commands into `~/.config/opencode/`, with the checkout as the single source of truth — an edit lands live, no reinstall — plus the one `subagent_depth` config edit above.

Hook parity — which Claude hooks port to which OpenCode events:

| Plugin | Hook | Command | Ported to OpenCode? |
|---|---|---|---|
| monitor | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup.ts --session-check` | **No** — dead code outside Claude Code: it returns immediately without `CLAUDE_PLUGIN_DATA`, and its actual work (statusline-path migration, reaping orphaned Claude processes) is Claude-only |
| monitor | `SessionStart` (same matcher) | `skills/cockpit/bin/cockpit hook session-start` | Yes → `session.created` event, delivered by `experimental.chat.system.transform` |
| monitor | `Stop` | `skills/cockpit/bin/cockpit hook stop` | Yes → `session.idle` event, same delivery |
| chronicle | `PreToolUse` (matcher `Bash`) | `hooks/check-branch.sh` | Yes → `tool.execute.before` on the `bash` tool |
| dispatch | `PostToolUse` (matcher `Edit\|Write`) | `hooks/flightplan-lint.sh` | Yes → `tool.execute.after` |
| guard | `PostToolUse` (matcher `Edit\|Write`) | `hooks/comment-guard.ts` | Yes → `tool.execute.after`, sharing the event with the lint |
| guard | `UserPromptSubmit` + `Stop` | `hooks/comment-sweep.ts snapshot` / `sweep` | **No** — `session.idle` has no way to hand a reason back to the model |

**The module supports opencode 1.x only.** It targets the V1 plugin API: an exported `async (ctx) => hooks` function. OpenCode 2.x replaced that API, so on 2.x the module fails to load and none of its hooks run. The cockpit send and relay's opencode backend are 1.x-only too.

OpenCode has no hook-level "ask" — a plugin's `tool.execute.before` handler can only let a call through or throw. The branch guard degrades accordingly: instead of returning an `ask` permission decision, it throws `check-branch.sh`'s own `systemMessage` verbatim, turning what is a prompt on Claude Code into a hard block on OpenCode.

The module itself carries four constraints, each a trap if broken: it is a single file; it imports nothing from anywhere else in this repo, even a helper worth sharing stays module-local; it derives the repo root from `dirname(import.meta.dir)`, never a config file; and it never reads a harness environment variable — Claude's and Codex's own vars must stay meaningless to it.

**Version policy.** `opencode/` is repo infrastructure, not a release component. This work bumps no `plugin.json`, cuts no `<plugin>-vX.Y.Z` tag, and adds no `CHANGELOG.md` entry — it belongs to no plugin, so none of them owns a version bump for it.

**Codex's interactive TUI freezes hook environments; `codex exec` does not.** The TUI hands its session to a long-lived `codex app-server daemon` whose environment is fixed at daemon start, so a delegation env var such as relay's `RELAY_DELEGATED=1` reaches the Codex frontend but never the hook when the daemon predates it. `codex exec` runs the session in-process and does read the var. Verified on 0.151.0: `RELAY_DELEGATED=1 codex exec` suppresses monitor's decision-log hooks (0 `DECISION LOG ACTIVE` hits in the rollout, 1 in the control), while a herdr pane spawned with the same var running interactive `codex` still shows the Stop nudge. Restarting the app-server refreshes the daemon environment; the delegation marker below is the fix that does not require one. The same suppression works cleanly on Claude Code.

To test hook behavior for free, pass a bogus `-m` model — SessionStart and UserPromptSubmit fire and the rollout persists before the 400 lands, so no tokens are spent. Do **not** try to debug this by adding a probe hook to `~/.codex/hooks.json`: codex gates every hook on a `trusted_hash` under `[hooks.state."<file>:<event>:<i>:<j>"]` in `~/.codex/config.toml`, and an entry whose hash does not match is skipped with no warning.

**The delegation marker crosses that daemon boundary.** relay's live codex path drops a file that monitor's decision-log hooks read, because no environment variable can reach them. The writer is `packages/relay/skills/relay/scripts/delegation-marker.ts`, the reader is `packages/monitor/cockpit-rs/src/hook/delegation_marker.rs`, and the two plugins version independently — **they share a path and a shape, never code**, so a change to one is a change to both:

```
~/.local/share/q-lab/delegation/<startedAt>-<rand>.json
{ cwd, backend, startedAt, armUntil, expiresAt, sessionIds: [] }
```

Three rules make it safe. Matching is two-phase: a marker matches on `cwd` alone only until `armUntil` (90s, covering relay's spawn plus the 20s TUI settle), and the hook that matches writes its own `session_id` back so every later turn matches exactly — fuzzy once, precise forever, which is what keeps an interactive codex opened in the same repo from being silenced for its whole life. Only **codex live panes** get a marker (`needsDelegationMarker`): Claude and opencode run their hooks inside the process relay spawned, so `RELAY_DELEGATED` already reaches them, and a marker there could silence the parent session sharing the repo. And the reader ignores the marker store entirely unless `PLUGIN_ROOT` is set, which is codex's tell — Claude Code sets only the `CLAUDE_`-prefixed one.

A `pending` live result keeps its marker: the pane is still running and still being nudged, so the marker has to outlive relay and retire on `expiresAt` instead. Every other outcome clears it.

**The autopilot wrappers suppress through the env, not the marker.** `codex-run.ts` and `opencode-run.ts` spawn with `env: { ...process.env, RELAY_DELEGATED: "1" }`. They never went through relay, so before this they set nothing at all. `codex exec` and opencode both read the var, so neither needs the marker.

**The statusline collector runs from the marketplace clone.** `install.ts` resolves `~/.claude/plugins/marketplaces/q-lab-marketplace/packages/monitor/...` through `known_marketplaces.json`, because the plugin cache path encodes the version (`.../monitor/3.1.0/...`). monitor's `SessionStart` hook never touches the statusline; once per version (marker `$CLAUDE_PLUGIN_DATA/.wired-version`) it only reaps old daemons and removes a stale channel entry. The hook never fresh-wires — initial opt-in stays manual.

**Drift inside a version is noticed, never fixed.** The same hook then runs a read-only drift watch on every session, because the marker gate is blind to a hand-edited `settings.json`, a restored backup, or a reinstall under another cache root. It reports a foreign collector path, a stale hand-wired channel, missing `permissions.allow` patterns, and an unparseable `settings.json`, then tells the user to run `/monitor:install`. Two rules make it work: the notice ships as a `systemMessage` inside **one** JSON object on stdout — bare stdout reaches only the model, so nothing else in `--session-check` may print and `migrate()`'s output is captured — and repetition is keyed on which pieces are off, stored in `$CLAUDE_PLUGIN_DATA/.drift-notice`, so one complaint is made once but a drift that returns is reported again.

**Cockpit Rust distribution.** Fetch `cockpit-<triple>` and `SHA256SUMS` from the `monitor-v<version>` GitHub release through `skills/cockpit/bin/cockpit`. Cache the verified binary in `$XDG_DATA_HOME/q-lab/cockpit-bin/<version>/`, outside the cockpit home, so the binary migrates a legacy `~/.cockpit` on first run. Set `COCKPIT_BIN` to override the fetch. Hooks fail soft while the binary downloads. Keep `daemon.json.root` at `<plugin root>/skills/cockpit/scripts` so version-aware supersede works across a mixed fleet. Treat `cockpit-rs/Cargo.toml` as a monitor version file. Finish the release workflow before users update, or their first session runs without hooks.

## Commands

```bash
# Dashboard (port 5938, auto-opens browser)
packages/monitor/skills/cockpit/bin/cockpit atlas serve   # [--port N] [--no-open]

# Data as JSON (CLI mode)
packages/monitor/skills/cockpit/bin/cockpit atlas stats
packages/monitor/skills/cockpit/bin/cockpit atlas live

# Rollup DB (--rebuild rescans while preserving history and dedup keys, and
# rewrites the session ledger, which a replay always re-derives from scratch)
packages/monitor/skills/cockpit/bin/cockpit atlas rollup-update   # [--rebuild]

# monitor:install engine — checks both skills, wires the statusline
bun packages/monitor/skills/install/scripts/setup.ts                  # --check | --dry-run | --apply
bun packages/monitor/skills/install/scripts/install.ts                # dashboard precheck only

# Cockpit daemon (port 5858)
packages/monitor/skills/cockpit/bin/cockpit server

# Restart the daemon onto THIS install's code. Supersedes any concurrent MCP
# respawn, then verifies our root won the port. Run it from the updated cache.
packages/monitor/skills/cockpit/bin/cockpit restart        # [--port N] [--no-open]

# Cockpit config (global, XDG)
packages/monitor/skills/cockpit/bin/cockpit config get-language
packages/monitor/skills/cockpit/bin/cockpit config --log-language zh-TW
packages/monitor/skills/cockpit/bin/cockpit config --answer-here on
packages/monitor/skills/cockpit/bin/cockpit nudge status   # on|off|toggle|clear|status
                                                                     # [--scope session|project|user]

# Cockpit dev: isolate from the cached daemon entirely
COCKPIT_HOME=/tmp/cockpit-dev COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit packages/monitor/skills/cockpit/bin/cockpit server --port 5999

# OpenCode installer — symlinks skills/plugin/agents/commands into ~/.config/opencode/, raises subagent_depth
bun opencode/install.ts                                                # --check | --dry-run | --apply | --unlink

# Tests
cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml
bun test packages/monitor/skills/cockpit/contract/
COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/
bun test packages/monitor/skills/cockpit/scripts/
bun test packages/monitor/skills/install/scripts/
bun test packages/monitor/skills/usage-dashboard/contract/   # atlas suite + golden; defaults to target/release/cockpit
COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/
bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts
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

The repo-wide run is **not** green — pre-existing errors remain elsewhere — so
a change is clean when `grep <path-you-touched>` prints nothing, not when the
count is zero.

## Code Conventions

- Runtime is Bun with TypeScript. There is no transpile step.
- Use `type` over `interface`.
- Frontend uses petite-vue, not full Vue. Charts use Chart.js.
- Take no external npm dependencies at runtime. Vendor libraries are committed in `dashboard/dist/vendor/`. `devDependencies` may carry types-only packages — `@types/bun` is there so the typecheck above resolves Bun's globals.
- Vendor mermaid as the UMD bundle (`mermaid.min.js`, ~3.3MB, sets `globalThis.mermaid`). The ESM build is code-split and cannot ship as one file. `modules/diagram.js` lazy-loads it on the first diagram render, themes it with concrete hex (mermaid's khroma engine cannot parse `oklch()`), and sanitizes the SVG through DOMPurify's SVG profile.
- Price per 1M tokens in USD.
- Put scratch that outlives its process under `/tmp/q-lab/<plugin>/<skill>/`, or `/tmp/q-lab/<plugin>/` for a plugin with no skills. The `q-lab` segment keeps a third-party plugin of the same name out of our files. A path an agent writes with the Write tool must end in a `mktemp -d` leaf: Write refuses to overwrite a file it has not read, so a fixed path hands the next run the last run's file. Keep a `mkdtemp` scratch that the same process deletes in `os.tmpdir()`.

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

`clawd` has only the first.

**This repo runs GitHub Flow.** `main` is the only long-lived branch; there is no `develop`. Both `.chronicle/release.json` and `.chronicle/pr.json` record `"workflow": "github-flow"`, so `/chronicle:release` commits the bump on `main`, cuts every tag on that bump commit, and merges nothing.

**Prefer `/chronicle:release`.** This repo dogfoods its own release skill. Its `.chronicle/release.json` records each plugin as an independently-versioned component with its two `plugin.json` files as version-file patterns. Pick the touched components at the version gate. Coordinated multi-component releases are native: name several components and the finisher cuts N scoped tags on one bump commit.

**relay's `config.suggested.json` versions by unix time, not by release.** Set its `version` to `date +%s` only when its `models` or `suggestions` change; `config check` prompts every user whose `version` differs. Merge refreshes an entry only while it still equals its `applied` value, so a withdrawn suggestion does not outlive a merge.

To cut a release by hand: bump the two `plugin.json` files, add a `CHANGELOG.md` entry headed per plugin (`## [chronicle 0.1.0]`), commit on `main`, cut an annotated `<plugin>-vX.Y.Z` tag on that commit, then push `main` and the tag.

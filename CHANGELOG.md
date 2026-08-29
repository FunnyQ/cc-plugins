# Changelog

## [dispatch 3.22.5] - 2026-08-29

_tracks tag `dispatch-v3.22.5`_

### Fixed
- The flightplan graph panel no longer loses hover highlighting during polling refreshes — the hovered dependency route now stays visible and the graph no longer dims unexpectedly while a route is highlighted.

## [dispatch 3.22.4] - 2026-08-29

_tracks tag `dispatch-v3.22.4`_

### Added
- Each berth on the dependency graph now shows its wall-clock elapsed time, updating live once a second while the task runs, so you can see how long a task has been going without leaving the panel.

### Fixed
- The dependency graph no longer draws backwards or zero-length crossovers — a berth now always sits past every task it depends on, so a dependency line reads left-to-right instead of doubling back on itself. The panel runs slightly wider as a result, which is the tradeoff for edges that read correctly.

## [dispatch 3.22.3] - 2026-08-29

_tracks tag `dispatch-v3.22.3`_

### Fixed
- Autopilot's external dev driver no longer runs its own verification pass alongside the independent verifier — it now only lints the task and reports which files changed, so a task's pass/fail verdict comes from one source instead of two agents potentially disagreeing.

## [dispatch 3.22.2] - 2026-08-29

_tracks tag `dispatch-v3.22.2`_

### Added
- Hovering a berth on the dependency graph now also lights a travelling pulse that runs downstream along its route, the way a real interlocking panel shows a live route rather than just the track's lineage.
- Autopilot now folds Codex spend into its usage accounting, so dev steps that delegate to Codex no longer vanish from the plan's cost picture. Codex figures show separately from Claude token counts wherever a surface answers "which side spent what" (the fleet table, lane cards), and combine with them wherever it answers "what did this cost" (the header stat, graph berth plates).

### Fixed
- Flightdeck's headline token metric switched from raw output tokens to fresh (cache-creation) tokens, the only formula that matched a live 11-agent run to the digit on 9 of 11 panel rows; the old metric ran at 0.6-1.1% of the actual billed spend.
- Budget-tier thresholds are recalibrated to the new metric so a plan's colour coding reflects real usage again — the old thresholds, inherited from the output-token era, flagged over 90% of agents as warn-or-worse with no real signal.
- The fleet table's message column now renders full PASS/FAIL verdict text instead of truncating it, with commit SHAs, timestamps, and other bare identifiers tinted for readability.

## [dispatch 3.22.1] - 2026-08-29

_tracks tag `dispatch-v3.22.1`_

### Changed
- A task on the dependency graph now carries its ref and token count *inside* its berth, on one line, instead of hanging them beneath as two floating labels — the state colour and the task's identity no longer have to be paired up by eye before a berth can be read. Berths are taller and sized to the longest ref in the plan, and state is now lit down a berth's leading edge rather than filling it, so the text inside stays legible.
- Cross-bucket dependencies are now drawn as curves rather than 45-degree diagonals. A curve changes road inside the single gap reserved for it, whatever the distance between the two tracks; the diagonal had to spend its own vertical drop in horizontal reach, so on a tall plan most dependencies could not fit and fell back to a straight line.
- Berths sit further apart, which gives each crossover room to read as a curve. A dense plan therefore reaches the graph panel's horizontal scroll sooner than it used to.

### Fixed
- The fleet table's column header no longer leaves a blank band under the title bar in a narrow pane.

## [dispatch 3.22.0] - 2026-08-29

_tracks tag `dispatch-v3.22.0`_

### Added
- Autopilot's flightdeck dashboard now tracks token usage: per-agent counts in the fleet panel, per-task and plan-wide totals on the lane, graph, and header panels, and warn/danger coloring in the fleet once one agent crosses a budget threshold. Task and plan totals stay uncolored — they sum several agents, so per-agent thresholds would light them on any real run.

### Changed
- The dependency graph is now flightdeck's default view, redesigned as a railway-signalling interlocking panel: buckets read as tracks, tasks as berth segments, cross-bucket dependencies as diagonal crossovers, and gates as signal heads, replacing the previous flat node-graph look.
- In the fleet view, each agent's token count now sits under its role chip instead of occupying its own column.

### Fixed
- The graph panel no longer overflows or clips content at wide viewports — it now sizes itself to the pane's actual space instead of a fixed band.
- A lit route on the graph now stays lit end to end instead of breaking at every berth boundary, and a blocked berth is now visually distinct from open track.
- Streamed token usage is no longer double-counted across incremental transcript reads, and aggregate multi-agent token totals no longer get colored as if a single agent had used them.
- `flightplan-lint` now reports a missing task or plan path as its own error instead of folding it into a generic lint failure, with clearer path and working-directory diagnostics.

## [dispatch 3.21.2] - 2026-08-27

_tracks tag `dispatch-v3.21.2`_

### Fixed
- An abandoned `commit` or `scout` agent that died before finishing stayed pinned atop the Agent Fleet panel forever, its timer still running. These two roles share one reference with no attempt count, so the existing stale-row cleanup silently skipped them; a second pass now closes them out based on start order.

## [dispatch 3.21.1] - 2026-08-27

_tracks tag `dispatch-v3.21.1`_

### Changed
- Autopilot's external dev-driver instructions can no longer paste ready-to-run code for a task, wave away a failed acceptance check by adding staging steps around it, or assert a prior attempt was already correct without re-checking it. Retry feedback may now only add requirements — it can no longer drop a verification command or excuse a rejected attempt.

## [chronicle 0.14.3] - 2026-08-27

_tracks tag `chronicle-v0.14.3`_

### Changed
- `chronicle:commit`'s simple-mode path no longer runs a full atomic-split analysis just to throw it away. The watcher now stops right after reading the diff, writing one group covering every path plus a `changeSummary`, so the commit message is written from that summary instead of blind.

## [dispatch 3.21.0] - 2026-08-27

_tracks tag `dispatch-v3.21.0`_

### Fixed
- The flightplan review loop could spin past 19 rounds without converging. Findings already banked as "Known gaps" in `tasks/README.md` were excluded from the review bundle, so the reviewer kept re-reporting them as new P1s every pass; non-convergence detection also compared P1 wording, which never matched across rounds because the plan text changes each pass.

### Added
- A `--prior-findings <file>` flag lets a review pass carry forward the previous round's findings, so a reviewer only re-reports something if the current files still show the defect.
- Review depth tiers (Light/Standard/Deep) now cap at 4/8/12 rounds; any P1 still open when the cap is hit is banked into Known gaps and called out in the closing recap, instead of the loop running unbounded.

## [chronicle 0.14.2] - 2026-08-24

_tracks tag `chronicle-v0.14.2`_

### Fixed
- Codex setup no longer leaves obsolete Chronicle release-role files installed, eliminating malformed-role warnings while preserving unrelated custom roles.

## [dispatch 3.20.2] - 2026-08-24

_tracks tag `dispatch-v3.20.2`_

### Fixed
- The flightplan CLIs that take flag values (`score-task`, `flightlog`, `codex-run`, `opencode-run`) now reject a malformed invocation like `--log --attempt 3` instead of silently treating the next flag as the value.

### Changed
- The lint hook that runs on every Edit/Write now filters non-task-file calls in bash before spawning `jq`, cutting its overhead on those calls.

## [chronicle 0.14.1] - 2026-08-24

_tracks tag `chronicle-v0.14.1`_

### Changed
- The branch-check hook that runs before every Bash call now skips its JSON parsing for commands other than `git commit`, cutting its per-call overhead from about 18ms to about 14ms.
- Release remote checks (tag-on-remote lookups and the behind-remote fetch) are now batched and run concurrently, cutting a 5-component coordinated release's remote-checking time from about 14s to about 3s.

## [herdr 0.5.3] - 2026-08-24

_tracks tag `herdr-v0.5.3`_

### Fixed
- The CDP transport no longer mistakes a protocol error for a result: a failed `eval` used to print an empty line as if it had succeeded, and `screenshot` / `click-ref` blamed the wrong cause when the browser itself reported the failure. These now surface as real errors.
- A socket that dropped mid-command no longer hangs the CLI forever — a pending call now fails instead of waiting on a connection that's already gone.
- Commands now carry a send deadline: 30s normally, 120s for calls whose cost scales with page size (full-page screenshot, whole accessibility tree, large response bodies). A renderer stuck behind a modal dialog now times out instead of hanging. `eval` with an awaited promise is exempt, since its duration is the caller's own expression to decide.

## [monitor 4.0.7] - 2026-08-24

_tracks tag `monitor-v4.0.7`_

### Changed
- `/api/stats` now caches its result and reuses one file walk across the stats build and the rollup update, cutting a warm dashboard load from about 6 seconds to 0.14-0.19 seconds. Two tabs opening at once share the same in-flight rebuild instead of each triggering their own.
- `rollup-update.ts` now reads only the bytes appended to a transcript since the last ingest instead of re-reading the whole file, which matters most for long-running sessions whose transcripts reach tens of MB.
- The Codex live-sessions query gained a time floor that cuts its per-call cost roughly 20x, with no change to which sessions show up in the live panel.
- Consolidated duplicated logic across cockpit and the dashboard onto shared helpers (env-int parsing, path containment, cache paths, error messages, liveness checks), closing a few drift risks where three copies of the same literal could silently disagree — including one where the install drift watch could report "not wired" forever.
- The install script's statusline collector path is now defined in one place, so `--apply` and the drift check can no longer point at different values.
- `scribe-nudge.ts` checks its throttle before doing any work, removing four `git` calls and four file reads from the common no-op path on every turn end.

### Fixed
- Hourly usage payloads no longer carry three always-zero fields (`messages`, `sessions`, `toolCalls`) that the frontend never read and that were always overwritten anyway.

## [relay 0.6.7] - 2026-08-24

_tracks tag `relay-v0.6.7`_

### Fixed
- Image generation now prefers the PNG actually produced by the current run over a path merely mentioned in the tool's output, so a stale or unrelated image can no longer get copied out by mistake. Falls back to the parsed path only when no freshly generated file is found.

### Changed
- Removed a dead decision point (`Backend.strategy()`) that always returned the same value per mode across all three backends; call sites now branch directly on mode.
- The Codex backend now uses standard library calls (`mkdirSync`, `copyFileSync`, `readdirSync({recursive: true})`) instead of subprocess calls and a hand-rolled recursive directory walk.
- A live-pane pre-spawn failure that falls back to the headless path now reuses the already-built prompt instead of re-running git and file reads a second time.

## [herdr 0.5.2] - 2026-08-21

_tracks tag `herdr-v0.5.2`_

### Added
- `screenshot --full` captures the entire page height instead of just the visible viewport, using Chrome DevTools Protocol's `captureBeyondViewport`.

### Changed
- SKILL.md now warns that `--full` can fail silently on pages with scroll-triggered content, returning blank bands or double-composited output, and recommends viewport-by-viewport shots instead. It also notes Chromium's 16384px cap on full-page captures and that an emulated viewport override stays sticky afterward.

## [herdr 0.5.1] - 2026-08-21

_tracks tag `herdr-v0.5.1`_

### Added
- New `references/auth.md` guide for herdr-browser: how login persistence works through terminal-browser's shared Chromium profile, and how to snapshot and restore authenticated state.

### Changed
- SKILL.md now warns that `cookies clear` wipes cookies for every open pane, not just the site you're working on — the browser profile is shared, not per-site.

## [herdr 0.5.0] - 2026-08-21

_tracks tag `herdr-v0.5.0`_

### Added
- `open` now gives a new browser its own Herdr tab instead of splitting the pane you are working in. `--split` becomes an opt-in flag for the old behaviour, and closing the browser removes only a tab the skill created itself.
- New `raw -- <agent-browser command>` escape hatch, forwarding straight to terminal-browser's full surface: network route, HAR, traces, video, Core Web Vitals, and axe-core accessibility checks. Anything this skill does not expose natively is still one command away. PDF is the one exception neither path can reach — Electron's Chromium does not implement `Page.printToPDF`.
- Native `cookies` (get/set/clear) and `headers` commands over CDP, closing a gap `eval` couldn't reach — `document.cookie` never sees an httpOnly cookie and can't write one either. A cookie rejected for the wrong domain now throws instead of silently doing nothing.

### Changed
- `raw` errors no longer echo the whole forwarded command line back, which on a wrong selector was most of the message.
- `--ratio` without `--split` now fails instead of being silently ignored.

## [herdr 0.4.0] - 2026-08-21

_tracks tag `herdr-v0.4.0`_

### Added
- New `--split right|left|down|up` and `--ratio` flags for `open`, plus `--output` for `screenshot`.

### Changed
- Every page operation (`snapshot`, `goto`, `click`, `eval`, `console`, and the rest) now runs over the Chrome DevTools Protocol directly instead of forwarding to a CLI. Output shrinks sharply as a result — a page snapshot now runs 5-18x smaller than the equivalent `agent-browser snapshot` on the same page.
- `console` now reports uncaught exceptions, which it previously could not: a fresh CDP attach replays the page's whole console buffer, including `Runtime.exceptionThrown`.
- `snapshot` now lists elements in document order instead of Chromium's internal serialization order, so a link-dense page no longer buries the first real item under the footer.
- Tab row numbers now come from terminal-browser's own tab strip instead of CDP, which ordered by recency and could make `close 1` close the wrong tab.
- Any command that changes a tab (`open`, `new-tab`, `activate`, `close`) now re-reads the tab strip after acting, instead of printing a snapshot taken before the change — `open` on an already-live browser no longer reports the new page while still showing the old URL in the active row.

### Removed
- **Breaking:** the herdr-browser plugin backend is gone; terminal-browser is now the only backend. It was kept on the belief that it spawned the *system* Chrome and so carried real profiles, extensions, and logged-in sessions — its own source in fact launches Chrome with `--headless=new`, a throwaway per-session `--user-data-dir`, and `--disable-extensions`, borrowing only the Chrome binary, never its state.
- **Breaking:** the `--placement tab|split|overlay|zoomed` flag (added in 0.3.1) is gone with the plugin backend. Use `--split right|left|down|up` and `--ratio` instead.

### Fixed
- A `goto` to an unresolvable host used to report success while loading an error page; it now fails loudly.
- `activate` was a silent no-op, `new-tab` returned a 500 on Electron, and `open --new` could report the wrong browser when two panes held the same URL. All three are fixed.
- Closing the last tab closes its pane, which used to surface as an error; it now reports `closed <view>`.
- Selector and `eval` failures now report one line instead of a full JS stack from the injected wrapper.

## [monitor 4.0.6] - 2026-08-21

_tracks tag `monitor-v4.0.6`_

### Fixed
- Codex's rate-limit windows now slot by their actual duration instead of position, so a dropped 5-hour window no longer causes the weekly window to be mislabeled as "5hr." The usage-limit grid also switches to `auto-fit` columns so a single remaining window no longer gets stranded at 25% width.
- Rate-limit window labels are now derived from each window's real duration rather than a hardcoded slot name, fixing mislabeled windows and giving non-canonical lengths (like 30d, 4hr, 15m) a sensible display name.

## [herdr 0.3.1] - 2026-08-21

_tracks tag `herdr-v0.3.1`_

### Added
- `herd.ts`'s `send()` gained an optional third argument (`{wait, status, timeoutMs}`) that confirms a prompt actually landed, driven by Herdr 0.8.2's `agent prompt --wait`. A prompt that was accepted but never acted on now surfaces as its own stalled state instead of looking identical to an agent that's simply still idle.

### Fixed
- `spawn --task` and `agent start` could both strand a pane the caller had no handle to close: `spawn --task` threw after already creating the pane if a blocked screen was detected on the initial send, and `agent start` rethrew on a not-ready signal even when the agent was actually live. Both paths now always hand the pane's name back to the caller, even when a downstream step errors.

### Changed
- All five `herdr` reference docs and the skill's own guidance are refreshed for Herdr 0.8.2: the updated socket protocol (19 to 20) and its new `pane.input.set` method, new CLI surface (`pane input --right-click`, `api snapshot`, `server reload-agent-manifests`, the renamed `antigravity-cli` agent kind), the full current config surface, and corrected agent-orchestration guidance now that 0.8.2 waits internally after `agent start` instead of needing a manual settle wait.

## [relay 0.6.6] - 2026-08-21

_tracks tag `relay-v0.6.6`_

### Changed
- relay's initial bootstrap send now confirms the prompt actually landed before proceeding, using Herdr's new wait/confirm support — a stalled send is caught immediately at submit time instead of surfacing later through a delayed poll. A failed confirmation is logged and passed over rather than treated as fatal, so the existing nudge/self-heal retry still catches a genuine miss; only a fully blocked send (nothing delivered) stops the bootstrap outright.

## [chronicle 0.14.0] - 2026-08-19

_tracks tag `chronicle-v0.14.0`_

### Added
- `chronicle:release` gained an optional `artifacts` stage that runs between the version bump and the changelog entry. It checks each configured artifact's `--version` output against the target version and rebuilds it when a `build` command is configured, so a committed binary (or similar build output) can no longer drift out of sync with the version you just bumped.
- The version gate now surfaces version-file drift up front: if a unit's bumped manifest has a companion file (like a lockfile) missing from its `versionFiles`, the release reports it at the version gate and offers the edit, instead of leaving it for you to notice later — the kind of gap that once forced a commit amend and a force-pushed tag on a peer repo.

### Changed
- `versionInOutput()` now matches on digit/dot boundaries, so checking for `0.8.0` in an artifact's version output no longer false-matches inside `0.8.01` or `10.8.0`.

## [monitor 4.0.5] - 2026-08-19

_tracks tag `monitor-v4.0.5`_

### Added
- monitor now watches for configuration drift on every session start: another install claiming the statusline, a stale hand-wired cockpit channel entry, missing q-lab permission patterns, or an unparseable `settings.json`. It reports what it finds instead of silently staying broken.

### Changed
- The `SessionStart` hook now runs in two clearly separated phases: a repair phase (still marker-gated, still auto-fixes on a version bump) and a read-only drift watch that always runs afterward. Drift caused by an upgrade is fixed automatically; drift you caused yourself is only reported, never silently changed for you. Repeated notices for the same unresolved drift are throttled so you aren't nagged every session.

## [herdr 0.3.0] - 2026-08-17

_tracks tag `herdr-v0.3.0`_

### Added
- New `herdr:herdr-browser` skill drives Herdr's browser/CDP plugin from inside a live Herdr session — open pages, read text/snapshots, click by reference, watch, and emulate — migrated in from a personal skill so it ships with the plugin instead of living outside it.
- Both plugin manifests and the marketplace registry now advertise the browser/CDP capability, so Claude Code and Codex can discover and load `herdr-browser`.

## [chronicle 0.13.4] - 2026-08-17

_tracks tag `chronicle-v0.13.4`_

### Fixed
- Subagent prompts that referenced skill paths with `$VAR`-style tokens could silently expand to an empty string in a child's shell — a child pasting `$SKILL_DIR` into Bash would run against an unintended path, which had already caused `/chronicle:commit` runs to complete with zero commits staged. All agent and skill docs now hand children literal absolute paths through `{VAR}`-style placeholders instead, so a missed substitution fails loudly with the token name intact rather than silently expanding to nothing.

## [chronicle 0.13.3] - 2026-08-16

_tracks tag `chronicle-v0.13.3`_

### Added
- adr, commit, install, pr, and release gained OpenCode compatibility documentation, so an OpenCode session can resolve chronicle's own scripts and agents.

### Changed
- OpenCode-only instructions for commit, pr, release, and adr moved out of each skill's main SKILL.md into a dedicated `references/opencode.md`, so Claude Code and Codex sessions no longer load OpenCode-specific behavior they never use.
- Normalized OpenCode-only section wording and headings, replacing several copy-pasted phrasings with one canonical line.

## [dispatch 3.20.1] - 2026-08-16

_tracks tag `dispatch-v3.20.1`_

### Added
- autopilot gained OpenCode compatibility documentation, so an OpenCode session can drive the same dev/verify/judge loop.

### Changed
- autopilot's OpenCode-only instructions moved out of SKILL.md into a dedicated `references/opencode.md`.
- Normalized OpenCode-only section wording and headings across the skill's docs.

## [herdr 0.2.5] - 2026-08-16

_tracks tag `herdr-v0.2.5`_

### Added
- herdr and herdr-protocol-upgrade gained OpenCode-facing documentation, clarifying how scripts resolve under OpenCode.

### Changed
- Normalized OpenCode-only section wording and headings across the skill's docs.

## [monitor 4.0.4] - 2026-08-16

_tracks tag `monitor-v4.0.4`_

### Added
- cockpit, install, and usage-dashboard gained OpenCode compatibility documentation, so an OpenCode session can resolve monitor's scripts and agents.
- cockpit gained a `references/opencode.md`, filling the missing third provider reference alongside `claude-cli.md` and `codex.md`.

### Changed
- cockpit's OpenCode-only behavioral sections moved out of SKILL.md into `references/opencode.md`, and the OpenCode notes scattered through `claude-cli.md`, `pilot.md`, `restart.md`, and `scribe.md` were folded into it — cockpit's SKILL.md is a thin router and is now half its former size.
- Normalized OpenCode-only section wording and headings across the skill's docs.

## [relay 0.6.5] - 2026-08-16

_tracks tag `relay-v0.6.5`_

### Changed
- OpenCode's default models moved to the Deepseek v4 family: delegate now defaults to `opencode-go/deepseek-v4-light` and review to `opencode-go/deepseek-v4-pro`; delegate also now passes `--variant max` on both headless and live-pane invocations, running the lighter default model at its maximum reasoning setting to offset the change.
- `relay/backends.md` was shortened, consolidating outdated manual-install instructions now that `opencode/install.ts` is the install method.
- Normalized OpenCode-only section wording and headings across the skill's docs.

## [relay 0.6.4] - 2026-08-14

_tracks tag `relay-v0.6.4`_

### Added
- The opencode backend now supports opencode 1.18.18, both live and headless.

### Fixed
- Headless opencode runs (`opencode run`) no longer silently drop approval-gated operations. `--dangerous` now maps to opencode's `--auto` flag on the headless path too, not just the live TUI, so unattended runs don't auto-reject prompts that need approval.
- A task prompt containing flag-like text (leading `-`/`--`) no longer gets misparsed as a CLI option; the prompt is now appended after a `--` separator so opencode's own parser stops treating it as flags.

### Changed
- Corrected the relay docs' description of opencode's `--auto`: it is not a full permission bypass like Codex's equivalent flag, since explicit deny rules still apply. Also documented that `-m/--model` is optional and that the hidden `--yolo`/`--dangerously-skip-permissions` aliases collapse to the same boolean, and replaced the stale "`--agent` deferred" note with the real reason it stays unwired — the referenced profile would need to exist in every machine's opencode config.

## [dispatch 3.20.0] - 2026-08-14

_tracks tag `dispatch-v3.20.0`_

### Added
- Flightplan now asks for the review engine and review depth up front, in one question alongside the interview's other run options, instead of leaving them buried later in the flow.

### Changed
- Flightplan's approval step (ExitPlanMode) now restates the chosen review options next to the finished task index, so approving the plan also confirms those choices and nothing asks about them again afterward.
- The review loop's stopping rule no longer relies on a fixed round limit. Findings are now labelled by severity, and the loop keeps going as long as a P1 issue is open; the previous round cap becomes a checkpoint that escalates fix tactics instead of cutting the review short.
- The reviewer only declares a plan unable to converge after two consecutive checkpoint passes repeat fixes it already tried, and that verdict is now surfaced in the run's closing recap.

## [chronicle 0.13.2] - 2026-08-12

_tracks tag `chronicle-v0.13.2`_

### Added
- `commit.ts` gained a `propose --file <path>` command: the watcher now writes its proposed commit groups straight to a file the Lawspeaker names, instead of relying on its final chat reply. A watcher that answers in prose no longer strands the commit flow.

### Fixed
- Fixed a macOS-only bug where the outside-repo guard could be fooled by the `/var` ↔ `/private/var` symlink, letting a hand-off file *inside* the repo pass as if it were outside.

### Changed
- The old `shape` subcommand is gone, replaced end to end by the file-backed `propose` hand-off; the Lawspeaker and watcher agents (both Claude and Codex configs) and the commit skill docs now describe this protocol instead.

## [chronicle 0.13.1] - 2026-08-10

_tracks tag `chronicle-v0.13.1`_

### Added
- The ADR validator now catches a body's `ADR-NNNN` citations in ordinary prose, not just its `Supersedes:` / `Superseded by:` lines. Deleting a referenced record now surfaces a warning on every draft still citing it, instead of leaving a dangling pointer with no signal.

### Changed
- ADR drafting now follows a restate-then-cite rule: a citation should point to a source, not carry the fact itself, so a draft's argument still stands even if the cited record is later removed. The template, the codifier's drafting guidance, and ADR-0003 were all updated to this pattern.

## [chronicle 0.13.0] - 2026-08-10

_tracks tag `chronicle-v0.13.0`_

### Added
- The ADR gate page can now run as a background command with `--serve --open`: the browser page posts its answer straight back to a one-shot local loopback server, so submitting no longer needs a manual copy-paste. The command exits on submission (or on usage error, missing browser, or a 30-minute timeout by default), and `SKILL.md` documents the exit codes so the agent resumes correctly. The copy-button fallback still works when `--serve` isn't used or the published page's send button is unreachable.

### Fixed
- A placeholder-substitution bug in the gate page's client script could leak the placeholder name into a submit URL that happened to contain `$&`; substitution now uses a function replacer instead of a plain string replace.

## [chronicle 0.12.1] - 2026-08-09

_tracks tag `chronicle-v0.12.1`_

### Changed
- The commit flow's grouping check now catches a case the ordering rule alone missed: a file and the file that imports from it, both changed together, where neither commit order leaves a codebase that builds in between. Those files are now merged into one commit instead of being split across two, in both the watcher and the Lawspeaker's own review pass.

### Fixed
- `git status` parsing could misread a real filename as two entries, or as part of a rename, whenever that filename happened to contain a newline or the literal text ` -> `. Every path-reading git call now uses the `-z` stream format, which cannot be confused this way, so the commit plan's file coverage check no longer rejects a correct plan.

## [chronicle 0.12.0] - 2026-08-09

_tracks tag `chronicle-v0.12.0`_

### Added
- The commit skill's mechanical steps — deciding simple vs. atomic, staging, committing, and verifying — now run through a single tested script (`commit.ts`) instead of agent prose. An interrupted commit run resumes from wherever it actually left off, read straight from the git log, instead of re-doing or skipping work.
- A commit's emoji is now derived automatically from its type when the plan doesn't supply one, so a missing emoji is no longer possible.
- The Lawspeaker returns as the commit flow's orchestrator: it orders the commits and writes the plan file's prose, while the script still owns shape, staging, and verification.

### Changed
- The watcher agent now hands back commits already in the order they should land, with reasons — including the rule that removing a reference must land before removing what it references.
- The runesmith agent is now a thin errand-runner that only executes the plan; it no longer writes commit prose.

### Fixed
- Non-ASCII filenames could be silently mangled when read from `git status`; the commit script now reads paths with `core.quotePath=false` so they parse correctly.
- A rename staged as a split commit (add and delete separated across commits) is now rejected before it lands, instead of producing a broken commit only caught after the fact.

## [chronicle 0.11.2] - 2026-08-09

_tracks tag `chronicle-v0.11.2`_

### Fixed
- Releasing a Rust crate left `Cargo.lock` behind: the commit bumped `Cargo.toml` alone, so the tag pointed at a tree whose manifest and lockfile disagreed. Both now move together, including in Cargo workspaces where one lockfile tracks several crates. The lock update is anchored to the crate's own package name, so a bump can never rewrite another dependency's version.
- A config written before this fix lists only `Cargo.toml`. Detection runs once, so add the `Cargo.lock` entry to `.chronicle/release.json` by hand — the format is in `references/release-config.md`.

## [chronicle 0.11.1] - 2026-08-09

_tracks tag `chronicle-v0.11.1`_

### Added
- A new `skirnir` agent now runs the release scripts on the main agent's behalf, so their raw output — including the repo's full tag list, git logs, and stack traces — no longer floods the conversation. Skirnir decides nothing; it just runs the script and hands back the distilled result.

### Changed
- The release plan now carries the CHANGELOG path directly instead of the raw release config, an internal cleanup with no visible effect.

## [chronicle 0.11.0] - 2026-08-09

_tracks tag `chronicle-v0.11.0`_

### Changed
- The release skill's five-agent orchestration (seer, oathkeeper, smith, hammerbearer, annalist) is replaced by a script that drives an ordered list of stages — bump, entry, commit, merge, tag, back-merge, push. Each stage decides whether it has already happened by reading the repo, so a run resumes wherever the last one stopped, and re-running a release that already finished now does nothing instead of erroring or duplicating work. Only the annalist remains, since turning commits into user-facing prose is the one judgment a script can't make.
- A release now blocks instead of proceeding when a tag already points at a different commit, or when local `main` is behind its remote — matching the refusal the other release paths already had.
- One release run now loads about a quarter of the instructions it used to, and spawns at most one agent instead of four.

### Fixed
- A release stopped after prepare mode (version bumped, CHANGELOG entry written, nothing committed) had no correct way to finish: the internal "prepared" state could only ever be recorded in a way that either wrote a duplicate CHANGELOG heading on finish, or cut a tag on a commit that didn't actually contain the version it claimed. `/chronicle:release auto` now finishes a stopped prepare run correctly.

## [monitor 4.0.3] - 2026-08-08

_tracks tag `monitor-v4.0.3`_

### Fixed
- `cockpit log --help` used to silently write a blank decision record instead of printing usage: the argument parser's catch-all for unrecognized flags treated `--help` as an ordinary flag and swallowed the next token as its value. Unrecognized flags on `log` and other writing subcommands now fail with an error instead of being written into the trail.
- `--help` / `-h` now short-circuits before any subcommand runs and prints a usage block, so a mistyped invocation is caught before it can touch the decision log.
- `cockpit config --answer-here on|off` kept working after the flag-parsing tightened; `--answer-here` is now a declared flag rather than reaching the command only through the old loose catch-all.

## [chronicle 0.10.6] - 2026-08-08

_tracks tag `chronicle-v0.10.6`_

### Added
- The release skill now recognizes a release already prepared on the feature branch: version bumps and CHANGELOG entries landed, only the tag is missing. It resolves the version gate at the existing bump without asking for a new one, verifies the bump instead of reapplying it, and cuts the tag directly, skipping a duplicate CHANGELOG entry.
- A repo whose version files were bumped with no CHANGELOG entry behind them is now caught and stopped rather than guessed at, so the release doesn't silently pick the wrong half to finish. A repo with no prior tag is never treated this way, since a missing entry there is just the normal first-release state.

### Fixed
- Re-running a release at a version whose tag already exists now fails before the commit and merge happen, instead of after — matching the other release paths, which already refused to touch the repo in that case.
- The Codex side of the release orchestrator now returns the same field names as the Claude side, fixing a mismatch that could point Codex-side callers at the wrong data.

### Changed
- Agent instructions were trimmed of about 260 restated words, so each rule now lives in exactly one place instead of being repeated across prompts.

## [relay 0.6.3] - 2026-08-07

_tracks tag `relay-v0.6.3`_

### Fixed
- The codex backend's `workspace-write` sandbox was blocking relay's routine delegated writes and network fetches. Both the headless delegate and the live-pane invocation now request `-s danger-full-access` instead, so delegated work no longer stalls on sandbox denials. This only lifts the sandbox restriction — approval prompts are unaffected, and the live TUI still surfaces its usual approval prompts in the pane. The opt-in `--dangerous` (YOLO) switch is unchanged, and `codex review` is untouched since it accepts no `-s` flag.

## [chronicle 0.10.5] - 2026-08-07

_tracks tag `chronicle-v0.10.5`_

### Changed
- Depersonalized shipped plugin documentation, replacing the repo owner's name with generic "the user" phrasing in the `adr` skill guide and its codifier agent specs. No behaviour change.

## [monitor 4.0.2] - 2026-08-07

_tracks tag `monitor-v4.0.2`_

### Changed
- Depersonalized a code comment in the cockpit dashboard's permission modal to use generic user phrasing. No behaviour change.

## [chronicle 0.10.4] - 2026-08-07

_tracks tag `chronicle-v0.10.4`_

### Changed
- ADR's two human review gates now render a fixed, purpose-built local page instead of markup the main agent hand-assembled each run. The main agent now supplies only the review data; the page's layout, wording, and consistency checks stay stable across runs instead of drifting between them.
- The gate page is written to a local temp file and opened with the platform's default browser rather than hosted anywhere, since the page is fully self-contained and review data never needs to leave the machine.
- When no browser is available, the gate falls back to the Artifact tool, then to structured markdown in the transcript. This cascade is chosen by whether a browser is present, not by which harness is running — Codex goes through the same script as Claude.
- `cockpit wait` and the `needs_your_call` handoff were dropped from both ADR gates. The wait step only ever succeeded with the answer-here switch on and a subscribed browser tab, and a gate carrying up to twelve full decision records didn't fit a cockpit card anyway.

## [chronicle 0.10.3] - 2026-08-07

_tracks tag `chronicle-v0.10.3`_

### Changed
- ADR promotion now handles a whole batch of decisions in one run instead of one at a time: the codifier drafts every record in a single pass, the lorekeeper runs its phases across the batch, and the barrowkeeper writes the full batch behind the existing two-gate confirmation.
- The `adr` skill's collect phase gained a documented contract, including gate-1 fallback behavior and automatic re-planning when a decision's disposition changes mid-flow.
- The reckoner's shortlist logic now accounts for batch promotion.
- Codex's `adr` agents (codifier, lorekeeper, barrowkeeper) were brought in line with the Claude agent definitions so both harnesses share the same batch contract.

## [dispatch 3.19.0] - 2026-08-06

_tracks tag `dispatch-v3.19.0`_

### Changed

- Autopilot's closing Final review now runs a different set of Claude quality lenses. `simplification` and `altitude` are gone; `reuse` and a new `leanness` lens take their place, alongside the existing cross-vendor engine lens (codex/opencode) and `efficiency`. `altitude` used to flag both over-engineering and under-engineering on the same span of code, so it could ask the fixer to inline an abstraction and extract a helper at once — the fixer reads every findings file with no arbitration rule, so a self-contradicting lens left it guessing. The new split gives each direction its own lens: `reuse` owns "needs more structure" and is the only lens that may ask for more code, while `leanness` is cut-only, tagging findings `delete:` / `stdlib:` / `native:` / `yagni:` / `shrink:` and closing with a `net: -N lines possible.` summary. `leanness` also covers ground neither predecessor did — `reuse` searches for reuse only *inside* the codebase, so nothing used to catch a hand-rolled standard-library function or a dependency doing what the platform already ships. That is what its `stdlib:` and `native:` tags are for. This is visible under `.flightlog/review/attempt-N/<lens>.md` (renamed files) and in `CFG.reviewLensModel`, which now governs three lenses instead of four — one fewer parallel Opus agent per Final review attempt.
- Flightplan now reserves a `review` bucket for the closing Final review task, fixed at `tasks/review/01-<slug>.md`. `lint-task.ts` enforces the location with a new `final-review-location` violation.
- **Upgrade note:** any existing plan tree whose Final review task lives in a feature bucket (for example `ui/05`) now fails the whole-tree lint, and autopilot's Step 1 runs that lint before flying. Move the closing task to `tasks/review/01-<slug>.md` before flying an older plan.

### Added

- The Final review task's rubric can now carry an optional, low-weight Leanness axis matching the new lens. It scores judgement, not a line count.

## [chronicle 0.10.2] - 2026-08-06

_tracks tag `chronicle-v0.10.2`_

### Fixed

- The `chronicle:adr` skill's `lorekeeper` subagent could fail to resolve its own scripts. It relied on a "Base directory" banner shown only at the main agent's load time, which a subagent never sees. `skills/adr/SKILL.md` now hands `lorekeeper` all four script paths explicitly as absolute paths, and every chronicle subagent role spec (`lorekeeper`, `gleaner`, `reckoner`, `watcher`, and the Codex `lorekeeper` config) is now forbidden from searching for a missing script — a missing path now returns a clear refusal instead of guessing.
- Fixed a contradiction in `lorekeeper`'s commit phase: the exception that skips promotion when there is no new ADR or metadata update no longer accidentally waives the requirement for the plan, validator, and archiver paths, which stay mandatory in every case.

## [monitor 4.0.1] - 2026-08-06

_tracks tag `monitor-v4.0.1`_

### Fixed

- Asking Claude to open the usage dashboard now works instead of appearing to hang and fail. The old launch instructions chained the precheck and the server into one command; since the server never exits, the chain blocked until the agent's tool timed out and reported a failure — even though the dashboard was actually running fine. The two steps are now separate: the precheck runs in the foreground so its exit code and failure hints still gate the launch, and only the server itself moves to the background.
- Documented the one launch failure that survives the precheck: another process already holding port 5938, which makes the server print an `EADDRINUSE` line and exit. This is now distinguished from a port already held by a previous dashboard instance, which is reused or superseded normally.

## [chronicle 0.10.1] - 2026-08-06

_tracks tag `chronicle-v0.10.1`_

### Fixed

- Documentation-only fix: the `commit`, `pr`, `release`, and `adr` skills now hold their internal agent topology more reliably. Each skill's guidance previously banned only direct forking, but left a loophole — an orchestrator could still fan out via team-mode (naming a child, spawning it directly, or batching two agents in one message), which could break the required order of steps (for example, an analysis step running before or alongside the decision step it's supposed to inform). All four skills now close that loophole explicitly.
- The `adr` skill's internal orchestrator was missing the "child protocol" instructions its three siblings already had; it now has them, so `chronicle:adr` runs are as consistent as the rest of the suite.

## [chronicle 0.10.0] - 2026-08-06

_tracks tag `chronicle-v0.10.0`_

### Added

- A new `chronicle:adr` skill turns cockpit's decision trail into a triage inbox: it surfaces past decisions worth writing down and helps you promote them into Architecture Decision Records under `docs/adr/`, or mark an existing one superseded. Three modes — `triage`, `promote`, `supersede` — each pause for your confirmation before anything is written or moved.
- ADR promotion never deletes evidence. Triaged sessions move into an archive under `.cockpit/archive/`, and every move is re-validated and re-checked against live sessions immediately before it happens.
- A shared decision-log reader (`cockpit-trail.ts`) now backs both `chronicle:pr` and `chronicle:adr`, so decision context stays consistent across both skills.

## [monitor 4.0.0] - 2026-08-06

_tracks tag `monitor-v4.0.0`_

### Removed

- **Breaking:** `cockpit prune` and its supporting tooling are gone. It expired un-triaged decision logs after 14 days, deleting sessions before anyone had a chance to review them. Log retention now belongs to `chronicle:adr`, which archives rather than discards.

### Changed

- The cockpit dashboard now hides sessions whose decision log has already been triaged and archived by `chronicle:adr`, instead of showing a row that can only ever render an empty trail. A session missing its log for any other reason, or still live, keeps showing normally. Sidebar project counts update to match.
- This behaviour needs a reinstall of the plugin and a `cockpit restart`, since the running daemon serves from the cached plugin code.

## [herdr v0.2.4] - 2026-08-05

_tracks tag `herdr-v0.2.4`_

### Added

- A protocol-upgrade checker now compares the running Herdr API only with the methods and response shapes a plugin actually uses, so compatible protocol updates can be assessed without manually reviewing the full schema.

### Changed

- Herdr guidance and references now cover the 0.8.0 CLI and protocol 19, including stable workspace-qualified IDs, `interactive_ready`, and the conditions for reading alternate-screen history.

### Fixed

- The `herd` wrapper now returns plain-text agent reads correctly, preserves structured errors such as `agent_not_idle`, and drains process output streams concurrently so commands cannot stall.

## [relay v0.6.2] - 2026-08-05

_tracks tag `relay-v0.6.2`_

### Changed

- Relay documentation now makes clear that a marker-terminated result file remains the authoritative completion signal: Herdr pane reads can be unavailable, visible, or truncated and cannot prove a delegate's final answer is complete.
## [dispatch 3.18.8] - 2026-08-03

_tracks tag `dispatch-v3.18.8`_

### Added

- **A verify agent that meets a sibling task's half-written working tree can now defer instead of guessing.** Autopilot runs a wave's tasks in one shared working tree, so a verifier can catch a still-in-progress sibling mid-write. Rather than fail (or worse, improvise around it), the verifier can now DEFER: a wave-scoped tree watch counts live writers, the deferred task waits for the next moment no one else is writing, then re-runs its verification commands once in a strict "requalify" mode whose verdict is final. A defer consumes no attempt and can never waive a genuinely failing (non-zero-exit) command. The audit trail stays strictly binary — a granted postponement shows up only as the requalify row's existence, a new role recognized by the flightlog label parser and the fleet dashboard.

### Changed

- **The ban on destructive git commands (`checkout` / `restore` / `reset` / `clean`) now covers every agent that chooses its own commands, not just the ones that write source.** It was previously baked into three prompts; it's now a single-sourced constant applied to those three plus the verifier, the judge, the review lenses, and the commit instructions — including propagating into the instruction file handed to an external review CLI. This closes a real incident: a verifier met a sibling task's uncommitted work, ran `git reset --hard` on its own initiative, and then reported PASS over two tests that were actually still failing, attributing the failures to the sibling.

### Fixed

- **A fully green Final review round no longer gets parked as an infrastructure failure.** A Haiku verifier ran every check and wrote its PASS flightlog row, but text-emitted its result instead of calling the required StructuredOutput tool, which threw and discarded the otherwise-complete round. Schema-bound prompts now close with an explicit instruction to return by calling the tool, and `resilient()` retries a thrown schema call once on Sonnet. The rubric judge and the commit agents are excluded from that retry, for the same underlying reason — both persist something before they return, so a second run is not free. The judge appends a verdict row keyed by ref+attempt, and only the first row for a key is kept, so a silent retry would leave the audit trail contradicting the decision it records; a commit retried after a partial commit writes a second, incoherent one.

Test coverage grew from 198 to 227 tests across the two batches; both suites are green (227 pass / 0 fail on autopilot scripts, 61 pass / 0 fail on dashboard modules).

## [dispatch 3.18.7] - 2026-08-03

_tracks tag `dispatch-v3.18.7`_

### Fixed

- **The Flightdeck agent fleet no longer leaves dead agents running forever.** When a replacement step for the same task starts, an earlier agent that never logged its end is now marked abandoned instead of staying in-flight at the top of the fleet and keeping the run timer alive. Abandoned rows remain visible as unfinished work without inventing a completion time or verdict.

## [dispatch 3.18.6] - 2026-08-03

_tracks tag `dispatch-v3.18.6`_

### Fixed

- **The dependency graph's reserved lanes (added in 3.18.5) could land in the wrong place.** On a real 30-task plan, 10 of 40 reserved lanes sank below every task in the graph, stretching a band of long horizontal runs underneath the diagram and sending long edges on a needless detour down and back up before heading to their target. The layer-ordering sweep was rebuilding its position index only once per pass, so a reserved row could travel at most one layer per pass — a lane whose edge spanned more layers than there were passes never learned where its edge started and stayed stuck at the bottom. Rebuilding the index after every layer fixes it: on that same plan, stranded lanes went from 10 of 40 to zero, vertical travel dropped by roughly a third, and the graph got shorter. Edges still never cross a node's box. Dashboard-only: the plan format, lint rules, and execution loop are unchanged.

## [dispatch 3.18.5] - 2026-08-03

_tracks tag `dispatch-v3.18.5`_

### Fixed

- **A passing verify step could render red on the flightdeck dashboard.** Verify-row colouring scanned a verifier's whole message for the word "fail," so a message like `"PASS — bun test (7 pass, 0 fail)"` matched on its own passing test summary and showed as a rejection — the reverse could also happen, with a failing message showing green. The dashboard now reads the leading `PASS`/`FAIL` verdict a verifier's message is contracted to start with, falling back to the old prose scan only for off-contract messages.

### Changed

- **The dependency graph on a large flightplan is now readable.** Watching a real 30-task plan render surfaced a tangle of crossing lines; four fixes address it: the graph now draws its transitive reduction (edges implied by other edges are dropped, cutting a measured 53 declared edges to 44 drawn with reachability unchanged), each layer orders its nodes by their neighbours' positions so a node sits near its parents (vertical travel down 28%, straight edges up from 11 to 15), edges that skip a layer get a reserved lane instead of running through an intermediate node's box (12 of 44 edges down to zero), and edges are drawn as rounded paths with each crossing fanned into its own column instead of stacking on one. The graph itself is shorter too, 756px down to 490px.
- **Hovering a task now separates its direct dependencies from the wider lineage.** The direct parent's edge and ring highlight amber, the direct child's highlight violet, and the rest of the ancestry/descendants are quieted — so "what's holding this up" and "what moves when this lands" are answered at a glance instead of by tracing lines.

Both changes are dashboard-only: the plan format, lint rules, and execution loop are unchanged.

## [dispatch 3.18.4] - 2026-08-03

_tracks tag `dispatch-v3.18.4`_

### Fixed

- **A task could fail its own scope check because of a sibling's work.** Autopilot runs all tasks in a parallel wave in one shared working tree, but a verification step like "run `git status --short` and expect only these files" reads the whole tree — so a sibling task's correct, uncommitted edits showed up and made an otherwise-passing task report itself in violation. One live run failed a task three times and parked it despite 7/7 acceptance criteria and 245 passing tests, purely on paths that belonged to the task running alongside it. The `scope-git-status` lint rule now requires every `git status` inside "## Acceptance criteria" or "## Verification" to name a path (e.g. `git status --short -- src/state.rs`); `task-template.md`'s example, which used to teach the unscoped form, is rewritten. Autopilot also lints the whole plan up front in Step 1, and the dev agent is no longer allowed to reword a gate just to make it pass.

  **Upgrade note:** flightplan trees generated before this release will start failing this lint. Fix is per task file — narrow each `git status` with a `--` pathspec naming that task's own files.

- **A single parked task no longer blocks every later commit in the run.** The inter-wave commit gate refused to commit anything once any escalation had occurred, and the only escalation that reached it without stopping the run was a flaky (commit) failure — so one bad commit attempt silently disabled commits for the rest of the run, letting uncommitted changes pile up across every remaining wave. The gate is now scoped: a parked task's declared files are held back and left uncommitted (its task file still commits, since `Status: blocked` is real state), while everything else keeps committing normally.

## [dispatch 3.18.3] - 2026-08-02

_tracks tag `dispatch-v3.18.3`_

### Fixed

- **Autopilot no longer stalls with a misleading message when a parallel wave rolls back a sibling task's file.** A live run had stalled at 7/11: one task's writer ran `git checkout` over a task file that a sibling task had already confirmed done, reverting its `Status: done` line. The wave loop kept trusting its in-memory completed list, so the reverted task could never be re-dispatched, and several waves later it died with a generic "no ready task" message instead of naming the real cause. The shared no-commit rule given to every writer agent now explicitly forbids the working-tree-restore family (`git checkout`, `git restore`, `git reset`, `git clean`) as its own rule, separate from the (still allowed) case of editing a shared source file under a different task. The wave loop also now checks for memory/disk divergence before building the ready set, so a run stops immediately and names the affected task file instead of stalling later with no explanation.
- **A flightplan's "Known gaps" now reach the executor again.** The 3.18.2 token-efficiency trim of `SKILL.md` accidentally dropped two of the seven mentions of `tasks/README.md`, both in the Step 6 review-loop instructions — exactly the step where gaps get produced. With no destination named there, a clean-session run wrote Known gaps into `PLAN.md` instead, which an executor never opens. The build-readme step now names both human-authored sections (`## Where to start` and `## Known gaps`) and says to revisit them after the review loop as well as after the interview.

## [dispatch 3.18.2] - 2026-08-02

_tracks tag `dispatch-v3.18.2`_

### Changed

- **Documentation-only release: no change to how flightplan behaves.** The flightplan skill's execution model and subagent guidance were clarified — repairable errors vs. unrecoverable scaffold failures, when to fork a subagent vs. write inline, and why reviewers start context-less to avoid self-bias.
- **`SKILL.md` was trimmed 25% (3871 → 2892 words)** by removing text duplicated in `references/interview-guide.md` and `references/task-template.md`, and moving the rarely-used waypoint branch into a new `references/waypoint-mode.md`. Every command, flag, path, and constraint carried over unchanged, so flightplan loads fewer tokens per run with an identical planning flow.

## [herdr 0.2.3] - 2026-08-02

_tracks tag `herdr-v0.2.3`_

### Added

- **`herd wait` can now wait for `done`, and take repeated `--status` flags** to wait on more than one target state at once (e.g. done or blocked). It throws on an empty status list instead of silently falling back, so a misconfigured call fails loudly rather than hanging forever. The default stays `idle` on purpose: widening it to include `blocked` was considered and rejected, since `blocked` means the agent is parked on a human approval — a wait that quietly returned there would hand a stuck pane to a caller with nobody watching.

### Changed

- **The `parseArgs` helper now supports repeatable flags** rather than keeping only the last value for a flag passed more than once, which the new multi-status `wait` depends on.

### Docs

- **A new `references/socket-api.md` documents herdr's underlying Unix-socket protocol.** Measurement showed the CLI is a thin, faithful pass-through over the socket (identical JSON payloads and error envelope), so migrating the wrapper to talk to the socket directly was evaluated and declined — the one capability the CLI still can't reach is `events.subscribe`. SKILL.md and `plugin-development.md` now point to the new reference.

## [relay 0.6.1] - 2026-08-02

_tracks tag `relay-v0.6.1`_

### Fixed

- **`references/live.md` no longer contradicts itself about how to wait on a live pane.** One passage told readers to block with `herd wait`, another told them to prefer `collect`; the guidance is now consistent, and the real reason to prefer `collect` is spelled out — it verifies the result-file marker, which a plain status wait can't stand in for.

## [dispatch 3.18.1] - 2026-08-02

_tracks tag `dispatch-v3.18.1`_

### Changed

- **Autopilot's `SKILL.md` was streamlined.** The intro is now one sentence, the "when to use vs doing it by hand" section is gone, Steps 1-4 are condensed, and detailed technical reasoning moved into `references/orchestrator.md`. The bundled-scripts list now covers only the three user-facing tools (`next-ready.ts`, `lint-task.ts`, `flightlog.ts report`), and verbose escalation/infrastructure-failure explanations were removed.

## [dispatch 3.18.0] - 2026-08-01

_tracks tag `dispatch-v3.18.0`_

### Added

- **The closing cross-vendor review lens can now run in a visible herdr live pane**, the same way the dev delegate already could (`CFG.liveReviewEngine`). It's gated only on `CFG.relayPath`, not on the dev-side live settings, because the review lens runs an external vendor on every flight — even an all-Claude one. It passes `--dangerous` since a live pane has no sandbox flag: without it, an unwatched approval prompt would stall the lens through the whole wait-and-collect cycle and then report a false unreachable result. Read-only mode still enforces prompts as before. Verified end-to-end on a live smoke flight.
- **Flightdeck's dependency graph now lays out left-to-right at full readable size** instead of scaling every label down to fit a fixed box — a wide task tree scrolls instead. Type size is fixed at 14px and every other dimension (box, gaps, padding, arrowheads) scales from it. Edges now show arrowheads, and node labels use near-black ink on the light state fills for contrast.
- **Hovering a node in flightdeck's dependency graph highlights its whole lineage** — everything it depends on and everything that depends on it — while dimming the rest of the tree.
- **Flightdeck's Agent fleet panel can collapse to its heading**, and the header now shows total flight time, from the earliest agent start to now while a run is in progress, or frozen at the last finish once it's done.
- **A new `dashboard/dist/playground.html`** lets you tune flightdeck's graph colours and box geometry against the real renderer and copy the resulting values back into the source.
- **Fleet rows for a failed verify or judge step now render in the alert colour** instead of looking like a clean finish, so a scan of the fleet panel surfaces failures at a glance.

### Fixed

- **No dev step was ever explicitly told not to commit its own work.** A shared no-commit rule is now included in the Claude dev prompt, the external driver's prompt, the instruction it writes for its own CLI, and the final-review fixer — since only the dedicated commit agents should be committing, and an external engine writes outside the harness where no hook can catch it.
- **A new lint rule catches a task whose scope-check can never pass under autopilot** — one that gates on `git status --short` expecting a single changed path, when the runner itself edits the task file as part of running it. This trap bit a real flight, where a delegate "fixed" its own failing gate by reverting the very status change that was supposed to mark it done. The task template now documents the trap and the working form.
- **Flightdeck's fleet column header no longer overlaps the panel title on scroll.** The header offset was a hardcoded pixel value that no longer matched once the fleet panel gained a collapse toggle; both offsets now come from a single shared value.

### Changed

- **The state palette was retuned for contrast**, and the "done" state colour was desaturated — it's used for lane fills, fleet role badges, and verdict text throughout flightdeck, not just node fills, so the change is visible across the dashboard.

## [dispatch 3.17.0] - 2026-08-01

_tracks tag `dispatch-v3.17.0`_

### Added

- **A tree that owns a test suite can no longer ship a Final review task that runs no test at all.** A new lint rule checks the Final review task's `## Verification` section against every test command declared elsewhere in the tree, and a companion advisory report prints each task's test paths on every tree lint.
- **Two opt-in stopping behaviours for autopilot, both off by default.** `CFG.lastShotEngine` lets a failing Claude-Opus retry ladder end with one genuine cross-vendor attempt instead of giving up. `CFG.budgetFloor` lets a run with a declared token budget stop cleanly between waves once it's within a set floor of running out, rather than starting a wave it can't finish.

### Changed

- **The scout now only transcribes, it no longer interprets.** It echoes `next-ready.ts --summary` output verbatim; all parsing and shape validation moved into the orchestrator itself, ahead of the checks that decide whether a run is actually finished. A new guard also makes sure a genuinely empty tree can never be mistaken for a completed one.
- **A failed inter-wave commit now surfaces as a real escalation instead of failing silently.** The commit step runs as its own tracked call with a clear success/failure result and a matching audit-log entry.
- **A retried task now sees the full history of prior attempts**, not just the most recent rejection — so if a fix is rejected twice, the third attempt sees what both earlier attempts were told, instead of repeating a mistake it was already warned about.

### Fixed

- **A subagent that never returns its structured result no longer swallows an otherwise-finished wave.** Autopilot previously read this failure mode inconsistently across its scout and commit steps; it's now handled the same way everywhere and always reported instead of silently dropped.

## [dispatch 3.16.0] - 2026-08-01

_tracks tag `dispatch-v3.16.0`_

### Added

- **`next-ready.ts --summary` returns a whole-tree snapshot** — `{ready, counts, unfinished, invalid, errors}` — so autopilot's wave loop can tell a genuinely finished tree from a stalled one instead of guessing from partial reads.
- **A new `invalid` task state is surfaced end-to-end.** A task marked `Status: done` while an Acceptance-criteria or Verification box is still unticked is now flagged as malformed, reported by `lint-task.ts`, blocked from unlocking dependents by `next-ready.ts`, and shown with its own count in the flightdeck dashboard.

### Changed

- **Malformed "done" tasks now fail loudly instead of passing quietly.** Previously an agent could write a decorated Status line that silently failed to register as done while every gate checkbox still ticked green, and autopilot would report clean completion with a task subtree actually stranded. An existing task tree carrying this pattern will now fail lint and readiness checks the next time it's touched.
- **`mark-done.ts` is now one atomic status transition:** it validates the task header first and writes nothing at all on failure, instead of leaving the file half-updated. The duplicated status-line regex is gone — `matchStatusLine()`/`parseStatusValue()` in `lib/parse-task.ts` are now the single source of truth.
- **`flightplan-lint.sh` now recognizes the annotated Required-reading header** flightplan scaffolds actually use, instead of silently skipping every current task file.
- **Infrastructure failures now survive the pipeline instead of vanishing.** Task thunks are wrapped before running in parallel and reconciled by index; a verifier or judge that returns no structured result now parks and escalates immediately, distinct from an ordinary quality failure (`passed: false`), which still retries as before.

### Fixed

- **Autopilot no longer false-stalls on a resumed run**, because wave-loop termination is now read directly off the on-disk task-count snapshot rather than inferred.

## [monitor 3.22.0] - 2026-08-01

_tracks tag `monitor-v3.22.0`_

### Added

- **Cockpit now detects and reports split scribe decision logs**, so a decision trail that got divided across multiple log files is surfaced instead of silently appearing incomplete.

## [relay 0.6.0] - 2026-08-01

_tracks tag `relay-v0.6.0`_

### Added

- **New `relay collect` command reattaches to a pending live delegate run.** If a delegate is still working when you'd otherwise time out or walk away, you can now come back and keep waiting on it instead of the attempt being counted as failed.

## [chronicle 0.9.6] - 2026-07-28

_tracks tag `chronicle-v0.9.6`_

### Added

- **`analyze-changes.ts` gains a `verify` subcommand.** It checks a completed commit plan against what actually landed in git, catching both a planned file that never made it into any commit (`missing`) and a changed file the plan never accounted for (`leftover`). Exits non-zero on either mismatch.

### Fixed

- **`/chronicle:commit` no longer silently drops files staged with `git add -N` (intent-to-add).** Such a file previously reached the commit flow as nothing at all — it landed in no commit while the flow still reported success, leaving a feature commit that couldn't build. The watcher agent now recognizes `status: "added"` with `staged: false` as covering both untracked and intent-to-add files, so it's grouped and committed like any other new file.
- **A false "success" report is no longer possible.** The runesmith now records a base commit sha before its first commit and runs the new verify check after its last, and the lawspeaker refuses to report success unless that check comes back clean — so a plan that silently fails to land is caught instead of reported as done.

## [monitor 3.21.0] - 2026-07-28

_tracks tag `monitor-v3.21.0`_

### Added

- **New "Ask me here" switch for cockpit's decision gate.** A toggle pill in the dashboard's Decision Log column header, plus `cockpit config --answer-here on|off` / `get-answer-here`, lets you choose whether an agent should pause and wait for you on the dashboard. It's off by default.

### Changed

- **`needs_your_call` now only parks an agent on the cockpit dashboard when someone is actually there to answer.** Previously, `cockpit wait` blocked the agent for up to 240 seconds per question regardless of whether the dashboard was open. Now it only waits there if "Ask me here" is on *and* a cockpit tab has that session selected; otherwise the agent asks in your terminal instead and the answer still gets recorded into the decision trail. The decision card is logged either way, so the trail stays complete.

### Fixed

- **The permission approval modal is no longer dead on deep-linked cockpit tabs.** Opening cockpit via a deep link — exactly how usage-dashboard's "Live now" rows open it — left the permission stream unsubscribed, so a permission request could never surface a card to approve.

## [chronicle 0.9.5] - 2026-07-28

_tracks tag `chronicle-v0.9.5`_

### Fixed

- **A newly-created file staged with `git add -N` (intent-to-add) is no longer dropped from commit analysis.** Chronicle's change analyzer skipped these files entirely, so a commit could get planned around a brand-new module that was never actually staged. The analyzer now reports the file's worktree-side addition, and still avoids double-reporting an unmerged (`AA`) conflict.

## [monitor 3.20.0] - 2026-07-28

_tracks tag `monitor-v3.20.0`_

### Changed

- **Cockpit's per-project decision trail is now anchored to the repo, not the working directory.** In a monorepo, an agent whose working directory drifted into a subpackage used to start a second, separate trail there — splitting one repo's history across several `.cockpit/` folders that showed up as unrelated "projects" in the dashboard sidebar. Storage now walks up from the current directory to find an existing `.cockpit/`, bounded by the git root, and falls back to the git root itself (or the working directory outside a repo). A deliberately hand-made `.cockpit/` in a subpackage still keeps its own trail as an escape hatch. Existing split trails are not merged automatically — this only changes where new activity is recorded.

## [chronicle 0.9.4] - 2026-07-28

_tracks tag `chronicle-v0.9.4`_

### Changed

- **Chronicle's agents now carry a reasoning-effort tier tuned to their job.** The purely mechanical executors (messenger, seer, watcher, smith, hammerbearer, runesmith) run at low effort; the orchestrators that just sequence child spawns (oathkeeper, storykeeper) run at medium; the agents making real judgment calls (lawspeaker, annalist, skald) keep the default. No behavior change for users — this only affects how much the agents "think" per step.

## [chronicle 0.9.3] - 2026-07-28

_tracks tag `chronicle-v0.9.3`_

### Added

- **The release skill now detects a repo's branching workflow — git-flow or GitHub Flow.** The analyzer reads branch structure and hands the result to the release agents (Seer, Oathkeeper, Hammerbearer), so a coordinated release finishes correctly under either workflow instead of assuming git-flow.
- **The branch-guard hook no longer blocks a GitHub Flow release commit.** `check-branch.sh` now recognizes a release commit made under GitHub Flow and lets it through without the git-flow confirmation prompt, while still guarding plain commits to `main`/`master`.

### Changed

- **Release skill docs now explain git-flow vs. GitHub Flow** — branch naming and merge-strategy differences are spelled out so a reader picks the right release path for their repo.
- **All 11 agent definitions, 4 skills, and 5 references were rewritten to a plain, one-instruction-per-sentence style.** Sentences over 20 words dropped from 355 to 108 repo-wide; wording only, no trigger phrases or frontmatter changed. Four adversarial codex review rounds caught eight real defects the mechanical checks alone couldn't see — broken inline code spans, lost scope qualifiers, and a few spots where splitting a sentence had quietly turned a preference into a prohibition.

### Fixed

- **A truncated sentence in the release orchestrator's instructions is now complete.** `agents/seer.md` used to cut off mid-clause ("...already exists, and it."); it now correctly describes that `config` is the parsed `.chronicle/release.json`, `null` when the file doesn't exist.

## [dispatch 3.15.4] - 2026-07-28

_tracks tag `dispatch-v3.15.4`_

### Changed

- **All four skills (`preflight`, `flightplan`, `waypoints`, `autopilot`) and their nine reference docs were rewritten to a plain, one-instruction-per-sentence style.** The 5,600-word autopilot orchestrator spec saw the biggest gain — long sentences (20+ words) fell from 26 to 9. Wording only; no trigger phrases or frontmatter changed.

## [herdr 0.2.2] - 2026-07-28

_tracks tag `herdr-v0.2.2`_

### Changed

- **The herdr skill and all four reference docs (config, CLI, plugin development, agent orchestration) were rewritten to a plain, one-instruction-per-sentence style.** Wording only; no trigger phrases or frontmatter changed.

## [monitor 3.19.7] - 2026-07-28

_tracks tag `monitor-v3.19.7`_

### Changed

- **Cockpit's six reference docs, the `install` and `usage-dashboard` skills, and all three commands (`/monitor:nudge`, `/monitor:prune-logs`, `/thoughtful`) were rewritten to a plain, one-instruction-per-sentence style.** Wording only; no trigger phrases or frontmatter changed.

### Fixed

- **The scribe reference no longer points auto-logging at a step that doesn't exist.** `references/scribe.md` told the scribe agent to check "the sweep in Step 4", but that file only has three steps and the sweep is actually in Step 2 — a dangling reference that shipped in every version from 3.18.10 through 3.19.6.

## [relay 0.5.9] - 2026-07-28

_tracks tag `relay-v0.5.9`_

### Changed

- **The relay command docs (`/relay:claude-cli`, `/relay:codex`, `/relay:opencode`) now state the delegation protocol more explicitly**, reducing ambiguity about how a delegated run reports back.
- **The relay skill, both reference docs (`backends.md`, `live.md`), and all three command docs were rewritten to a plain, one-instruction-per-sentence style.** Wording only; no trigger phrases or frontmatter changed.

## [herdr 0.2.1] - 2026-07-24

_tracks tag `herdr-v0.2.1`_

### Fixed

- **`herd read` no longer crashes on a settled or idle pane.** Reading a pane whose agent had already gone quiet could throw `null is not an object (…).read'`, since a settled pane's agent read returns a null envelope. `read()` now falls back to a plain pane-buffer read (resolving the pane id via the pane list) so the buffer still surfaces instead of erroring out.

## [relay 0.5.8] - 2026-07-24

_tracks tag `relay-v0.5.8`_

### Changed

- **A killed live run can now be reattached and recovered.** relay prints the `result.md` path and the `herd read <agent>` recovery command to stderr *before* the long poll begins, instead of only after it completes. If the foreground process gets cut off mid-run (e.g. by an exec time cap) rather than exiting cleanly, those recovery handles are already on screen — and, thanks to the herdr 0.2.1 fix above, `herd read` against the now-settled pane actually works.

## [herdr 0.2.0] - 2026-07-22

_tracks tag `herdr-v0.2.0`_

### Fixed

- **Spawn works again against herdr 0.7.5.** That release split spawning into a pane/tab creation step followed by a separate `agent start`, but the newly created pane isn't always ready to host an agent the instant it appears — spawn could fail outright with `agent_pane_busy`. Spawn now retries until the pane is ready. This also silently broke relay's live-pane mode, which was quietly falling back to headless execution instead of opening a visible pane — that path is fixed too.

### Added

- **Agent panes and tabs opened by `spawn` no longer show the shell startup banner by default** (a caller can still opt back in). Agent panes aren't meant for a human to read, and the banner was cluttering `herd read` output.

## [herdr 0.1.8] - 2026-07-22

_tracks tag `herdr-v0.1.8`_

### Changed

- **The `herd.ts` wrapper now tracks herdr 0.7.5's CLI surface.** `send()` uses `agent prompt` for prompt injection instead of a manual send-plus-Enter, and `spawn()` explicitly sequences `pane split` then `agent start --pane` for correct pane lifecycle. Reference docs and tests were updated to match.

## [chronicle 0.9.2] - 2026-07-22

_tracks tag `chronicle-v0.9.2`_

### Fixed

- **Chronicle's commit, PR, and release flows could fail outright with "Agent exists but is not enabled in this context" — no commit, nothing staged, nothing released.** Claude Code 2.1.217 changed nested sub-agent spawning to be disabled by default, and Chronicle's whole topology is orchestrator-shaped (main agent → orchestrator → children), so every flow tripped the new limit. Chronicle now owns this prerequisite itself: a new `SessionStart` hook writes `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` into `~/.claude/settings.json` whenever it's missing or too low, and only ever raises the value — never lowers it, since the setting is shared globally and shrinking it could break other plugins. **The fix needs a restart to take effect:** the env var is read once at session start, so the very session whose hook performs the write is still running without it — running a Chronicle command again in that same session will still fail and can look unfixed.

### Added

- **The install skill can now repair the spawn-depth setting by hand, not just via the automatic hook.** `check` / `dry-run` / `apply` modes let you inspect or apply the fix yourself instead of waiting on the next session start.

## [chronicle 0.9.1] - 2026-07-22

_tracks tag `chronicle-v0.9.1`_

### Fixed

- **Chronicle's commit, PR, and release flows declared their orchestrators' spawn permission using a scoped form** — `tools: ["Agent(chronicle:watcher)", …]`. All three roles (Lawspeaker, Storykeeper, Oathkeeper) now declare unscoped `tools: ["Agent", "Read"]` instead. _Correction (chronicle 0.9.2): this entry originally claimed the scoped form left the orchestrators read-only and unable to spawn at all. A later live probe on Claude Code 2.1.217 showed that's wrong — the scoped form does grant the Agent tool; it just doesn't restrict which agent types can be spawned. The orchestrators' actual breakage was the harness's new nested-subagent-spawn-depth default, fixed in chronicle 0.9.2, not this frontmatter. Switching to the unscoped form is still the right shape — the scoped form reads as a guarantee it doesn't provide — it just wasn't a fix for the read-only symptom originally described here._

### Changed

- **Orchestrator spawn scope is now governed by each agent's `## Child protocol` prose** ("spawn exactly one X, then one Y; never spawn helpers, replacements, or both children together") rather than by frontmatter. This is not a loosening — the scoped frontmatter form never enforced anything; it only appeared to.

## [chronicle 0.9.0] - 2026-07-20

_tracks tag `chronicle-v0.9.0`_

### Added

- **Commit analysis now applies a diff budget on large changesets.** When a change set produces a very large diff, the commit skill's analysis engine now caps how much diff it feeds into downstream decision-making instead of passing the whole thing through unbounded, avoiding slow or degraded analysis on big commits.

### Changed

- **More reliable agent orchestration across commit, pr, and release.** All six chronicle agent roles (Claude and Codex definitions alike) now consistently handle the asynchronous nature of agent spawning — a spawn returns a launch receipt rather than an immediate result, and the agent resumes only once notified — reducing the chance of a hang or a silent no-op being mistaken for success.
- **Skill guides now include ground-truth verification steps.** The commit, pr, and release skill docs spell out how to independently confirm a run actually did what it claims, making it easier to catch a bad result before trusting it.

## [monitor 3.19.6] - 2026-07-19

_tracks tag `monitor-v3.19.6`_

### Fixed

- **`/thoughtful` auto-logging could write decision-trail entries to the wrong session.** The background fork running `/cockpit scribe` used to resolve the live session itself, but a background fork can get its own transcript (and on Codex its own newer thread), so entries sometimes landed on that child session instead of the one you were actually working in. The parent session id is now resolved before the fork spawns and passed to every scribe call explicitly; a fork that's missing this id now fails loudly instead of silently logging to the wrong place. Manual `/cockpit scribe` invocations are unaffected.

## [relay 0.5.7] - 2026-07-19

_tracks tag `relay-v0.5.7`_

### Fixed

- **`/relay` live mode no longer refuses to run when relaying from a sibling repo or a different project.** Cross-project callers used to fall back to a strict cwd match that couldn't succeed, losing the visible live tab. Relay now also accepts an inherited Herdr workspace/tab/pane identity when it uniquely matches one active agent of the expected type, even if the cwd differs — while still falling back to the cwd check (and refusing) on any id mismatch or ambiguous match, preserving the original stale-id protection.

## [monitor 3.19.5] - 2026-07-17

_tracks tag `monitor-v3.19.5`_

### Fixed

- **Codex Stop hooks no longer fail when the cockpit scribe emits a reminder.** Monitor now uses Codex's supported `systemMessage` output under `PLUGIN_ROOT` while preserving Claude Code's `additionalContext` schema.

## [relay 0.5.6] - 2026-07-17

_tracks tag `relay-v0.5.6`_

### Fixed

- **`/relay` no longer fails to spawn a live Herdr pane when invoked from a nested working directory.** Herdr reports the *pane's* cwd (where it was opened), while relay runs from wherever the agent actually is — often a subdirectory or sub-agent cwd underneath it. Caller resolution previously required an exact cwd match and rejected these valid nested cases, including ones with a perfectly good inherited pane ID; it now matches "pane cwd is an ancestor of (or equal to) the caller cwd," picking the deepest containing pane, while still hard-failing on genuine equal-depth ambiguity.

## [monitor 3.19.4] - 2026-07-17

_tracks tag `monitor-v3.19.4`_

### Changed

- **Session-start guidance and scribe nudges now also run under Codex**, via a bundled Codex-specific hooks manifest, matching the behaviour Claude Code sessions already had. The Stop-hook nudge is now guarded against firing recursively when a Stop hook re-triggers itself.

## [herdr 0.1.7] - 2026-07-16

_tracks tag `herdr-v0.1.7`_

### Added

- **Herdr popup terminals are now fully documented for custom keybindings and plugins.** The reference covers `popup` commands and placement, cell or percentage sizing, half-terminal defaults, and session-modal input behavior.

### Changed

- **Herdr guidance now reflects the 0.7.4 CLI and configuration surface.** Updated references cover new terminal, metadata, detection, integration, UI, and remote-keybinding options, and clarify that popups are not Herdr panes and cannot be targeted through pane or agent APIs.

## [herdr 0.1.6] - 2026-07-16

_tracks tag `herdr-v0.1.6`_

### Fixed

- **Relay can now identify the active Herdr caller even when inherited pane or workspace values are stale.** Herdr exposes the foreground agent directory so live delegation follows the current caller instead of an outdated pane.

## [relay 0.5.5] - 2026-07-16

_tracks tag `relay-v0.5.5`_

### Fixed

- **Live Relay sessions now open in the active caller's Herdr workspace.** Relay validates inherited pane IDs against current Herdr state, recovers from stale values when there is one clear match, and safely avoids spawning when the caller is ambiguous.

## [chronicle 0.8.2] - 2026-07-14

_tracks tag `chronicle-v0.8.2`_

### Changed

- **Skill manifests restructured for more precise triggering** — `commit`, `pr`, `release`, and `install` now split `description` (one-line what) from `when_to_use` (decision boundaries), dropping redundant trigger phrases in favor of semantic matching. Re-confirmed human-invoked-only guards on `commit`/`pr`/`release`; `install` is now labelled `[codex only]`.

## [dispatch 3.15.3] - 2026-07-14

_tracks tag `dispatch-v3.15.3`_

### Changed

- **Skill manifests restructured for more precise triggering** — `preflight`, `flightplan`, `waypoints`, and `autopilot` now split `description` from `when_to_use`, spelling out how the four skills hand off to each other (preflight → flightplan → autopilot, with waypoints above flightplan) instead of relying on trigger-phrase lists.

## [herdr 0.1.5] - 2026-07-14

_tracks tag `herdr-v0.1.5`_

### Changed

- **Skill manifest restructured for more precise triggering** — `description` now states what herdr help covers; `when_to_use` separately states config/CLI/plugin-dev help vs. in-pane agent orchestration (gated on `HERDR_ENV=1`).

## [monitor 3.19.3] - 2026-07-14

_tracks tag `monitor-v3.19.3`_

### Changed

- **`cockpit`, `install`, and `usage-dashboard` skill manifests restructured for more precise triggering** — each now splits `description` from `when_to_use`, dropping redundant trigger-phrase lists in favor of semantic matching; existing behavioral guards (opt-in only for `cockpit`, command-triggered only for `install`) are unchanged but restated more clearly.

## [relay 0.5.4] - 2026-07-14

_tracks tag `relay-v0.5.4`_

### Changed

- **Skill manifest restructured for more precise triggering, and the capability matrix fixed** — `when_to_use` now correctly states `image` is codex-only and inverts a previously-backwards negative-trigger boundary (asking another harness to do work now fires the skill; a passing mention like "codex said…" doesn't); `argument-hint` updated to match.

## [chronicle 0.8.1] - 2026-07-14

_tracks tag `chronicle-v0.8.1`_

### Changed

- **`/commit` and `/release` now show argument hints in slash-command autocomplete** — `commit [simple]` and `release [auto|auto push] [version|component...]` — so you can see the expected shape before typing. No behavior change.

## [dispatch 3.15.2] - 2026-07-14

_tracks tag `dispatch-v3.15.2`_

### Changed

- **`/preflight`, `/flightplan`, `/waypoints`, and `/autopilot` now show argument hints in slash-command autocomplete** — `preflight [topic]`, `flightplan [topic]`, `waypoints [project]`, `autopilot <slug|path>` — so you can see the expected shape before typing. No behavior change.

## [monitor 3.19.2] - 2026-07-14

_tracks tag `monitor-v3.19.2`_

### Changed

- **`/cockpit` now shows an argument hint in slash-command autocomplete** — `cockpit [scribe|restart]` — so you can see the expected shape before typing. No behavior change.

## [relay 0.5.3] - 2026-07-14

_tracks tag `relay-v0.5.3`_

### Changed

- **`/relay` now shows an argument hint in slash-command autocomplete** — `relay <codex|opencode|claude> <delegate|review|image> [task]` — so you can see the expected shape before typing. No behavior change.

## [monitor 3.19.1] - 2026-07-14

_tracks tag `monitor-v3.19.1`_

### Added

- `/cockpit restart` is now documented as a first-class skill mode (the CLI command already worked — agents just weren't taught it). The new procedure covers running it in the foreground, `--port`/`--no-open` flags, how to read exit codes, and a caveat: restarting refreshes the daemon only, not an already-running session's cockpit channel process.

### Removed

- Dropped two stale cockpit docs — an unbuilt backlog wishlist and a README that had drifted out of sync with the root README. Cockpit setup docs now live in one place: the root README plus the skill's `SKILL.md`.

## [chronicle 0.8.0] - 2026-07-14

_chronicle is independently versioned; this entry tracks the `chronicle-v0.8.0` tag._

### Added

- **Chronicle now opens correct PRs when you're working from a fork.** It detects fork remotes, qualifies the head ref as `owner:branch`, resolves the real push-remote URL, and can target an explicit repo — so cross-fork PRs no longer land on the wrong branch or repo.
- **PR and release workflows register their own Codex agent roles.** Both flows now work even when the Codex runtime only exposes generic nested agents.
- **Chronicle remembers each repository's PR workflow choices.** Once you've picked a workflow, the choice is persisted (as a locale-neutral config commit) and honored by branch guards on future runs.

### Changed

- **PR base branch selection is now correct by default.** The base is resolved from the branch's real fork point, `hotfix/` and `release/` branches are routed to `main`, and an explicit base is now required rather than silently falling back — the `--base auto` behavior moved into the analyzer.
- **The skald's Mermaid diagrams are now constrained to syntax GitHub can actually render.** An earlier regex-based lint attempt was withdrawn after turning out to be unsound.

### Fixed

- **Reading cockpit's decision log no longer discards sibling entries when one log file is unreadable.**

## [monitor 3.19.0] - 2026-07-14

_monitor is independently versioned; this entry tracks the `monitor-v3.19.0` tag._

### Added

- **A stale monitor process reaper now runs on session start**, cleaning up leftover monitor processes without ever touching the usage dashboard.

### Fixed

- **Fixed a cockpit channel process leak and an inbox ping-pong CPU spin.**
- **Real messages no longer wait behind the poll floor**, so they're delivered promptly.
- **Stale sessions no longer roll configuration back**, preventing lost settings changes.

## [relay 0.5.2] - 2026-07-14

_relay is independently versioned; this entry tracks the `relay-v0.5.2` tag._

### Changed

- **Clarified relay's `--scope` behavior for code review tasks**: docs now correctly note that Claude's `/code-review` drops `--scope` rather than enforcing it, and that `--scope` is only advisory on opencode.
- **Unified how relay handles review tasks internally across backends**, for more consistent behavior going forward.

## [monitor 3.18.10] - 2026-07-13

_monitor is independently versioned; this entry tracks the `monitor-v3.18.10` tag._

### Fixed

- **Long session titles no longer stretch the Cockpit flight container.** Title labels are capped at 288px, still shrink responsively, and retain their existing single-line ellipsis behavior.

## [monitor 3.18.9] - 2026-07-13

_monitor is independently versioned; this entry tracks the `monitor-v3.18.9` tag._

### Fixed

- **Cockpit session titles now persist after sessions end.** Existing registry entries receive one provider-specific historical lookup when empty, misses are remembered to prevent repeated transcript scans, and a later live title can still refresh the stored value.

## [monitor 3.18.8] - 2026-07-12

_monitor is independently versioned; this entry tracks the `monitor-v3.18.8` tag._

### Added

- **Cockpit’s session rail now shows provider-native session titles.** Claude, Codex, and OpenCode sessions are easier to identify at a glance, while long titles stay on one line with an ellipsis and remain available in full on hover.

## [chronicle 0.7.1] - 2026-07-12

_chronicle is independently versioned; this entry tracks the `chronicle-v0.7.1` tag._

### Fixed

- **Codex commit workflows now work when the runtime exposes only generic nested agents.** Chronicle preserves the Lawspeaker, Watcher, and Runesmith boundary by loading each role from its stable installed TOML instead of requiring a named-role selector.

## [monitor 3.18.7] - 2026-07-12

_monitor is independently versioned; this entry tracks the `monitor-v3.18.7` tag._

### Changed

- **The cockpit flight panel now uses a wider responsive footprint.** More dashboard space is available for flight details without changing the surrounding workflow.

## [chronicle 0.7.0] - 2026-07-11

_chronicle is independently versioned; this entry tracks the `chronicle-v0.7.0` tag._

### Added

- **Chronicle commit workflows can now use native Codex named agents.** The Lawspeaker, Watcher, and Runesmith roles have dedicated Codex model mappings and an idempotent install skill that preserves existing configuration while registering the trio at stable paths.

### Changed

- **`/chronicle:commit` now routes Codex through the same delegated topology as Claude.** Missing roles produce a clear install instruction instead of silently falling back while claiming named-agent execution.

## [monitor 3.18.6] - 2026-07-11

_monitor is independently versioned; this entry tracks the `monitor-v3.18.6` tag._

### Fixed

- **Decision-log reminders now stay out of automated work.** Relay workers, SDK/headless sessions, and subagents skip both SessionStart guidance and Stop nudges, while interactive main sessions keep the reminder.

## [relay 0.5.1] - 2026-07-11

_relay is independently versioned; this entry tracks the `relay-v0.5.1` tag._

### Fixed

- **Relay now marks both headless and live delegated processes explicitly.** Claude workers can suppress interactive-only hooks without losing inherited environment such as `PATH` or `HOME`.

## [chronicle 0.6.0] - 2026-07-09

_chronicle is independently versioned; this entry tracks the `chronicle-v0.6.0` tag._

### Added

- **`/chronicle:commit` gained a `simple` mode.** Say "simple", "one commit", "single commit", or "快速 commit" and it forces a single commit for the whole change set, skipping the usual automatic simple-vs-atomic decision tree.

## [monitor 3.18.5] - 2026-07-09

_monitor is independently versioned; this entry tracks the `monitor-v3.18.5` tag._

Internal tooling hardening only — no user-facing behaviour change. The cockpit diagram lint now validates Mermaid source through a real parser (via happy-dom) instead of an approximation, and the install skill's setup gained a matching happy-dom precheck.

## [monitor 3.18.4] - 2026-07-08

_monitor is independently versioned; this entry tracks the `monitor-v3.18.4` tag._

### ✨ Added

- **New `cockpit prune [--days N] [--dry-run]` CLI command** cleans up decision-log clutter: cockpit's registry already reaps stale entries every 14 days, but the on-disk `.cockpit/logs/*.jsonl` files were never removed, so orphaned logs piled up without bound. Prune now trashes log files whose last signal (registry heartbeat or file mtime, whichever is newer) is older than the cutoff, and drops matching or dangling registry entries — always via `trash`, never a hard delete.
- **New `/monitor:prune-logs` slash command** fronts the CLI with a safe confirmation flow: it always previews the plan with `--dry-run` first and only deletes after you confirm.

## [chronicle 0.5.3] - 2026-07-08

_chronicle is independently versioned; this entry tracks the `chronicle-v0.5.3` tag._

### 🐛 Fixed

- **`/chronicle:release`'s changelog step now correctly diffs from the previous release** instead of silently falling back to the entire repo history — `lastTag` is now threaded all the way through the release skill's internal handoff.
- **Release-fact gathering no longer breaks on paths containing spaces or shell metacharacters**, and a git failure while counting commits is now surfaced as a real error instead of being reported as "no changes."
- **Version bumps in minified JSON files no longer touch the wrong `"version"` field** when a nested `"version"` key appears before the top-level one.
- **Tag-template matching now respects the configured pattern precisely**, so version-first or non-terminal `{version}` tag templates (not just simple trailing-version ones) resolve to the correct previous tag.
- Internal cleanup: an unused raw shell helper was removed, and the release fact-gathering step now returns only its computed results instead of an extra raw tag list.

## [chronicle 0.5.2] - 2026-07-07

_chronicle is independently versioned; this entry tracks the `chronicle-v0.5.2` tag._

### 🔧 Changed

- **Internal sub-agent names were renamed to Norse mythology (e.g. `manager` → `lawspeaker`, `writer` → `runesmith`), aligning with the odin plugin family's naming.** Purely internal — no user-facing behaviour changed.

## [chronicle 0.5.1] - 2026-07-07

_chronicle is independently versioned; this entry tracks the `chronicle-v0.5.1` tag._

### ✨ Added

- **`/chronicle:release` can now cut coordinated multi-component releases natively.** A single invocation drives several components through one shared version gate and produces one bump commit plus one `develop → main` merge carrying all of the scoped tags together — replacing the previously hand-driven, one-component-at-a-time coordination. The pure version-analysis core is untouched, so its existing test coverage still holds.
- **New branch-guard hook (`check-branch.sh`)** asks for confirmation before a `git commit` lands directly on the git-flow production branch, helping catch an accidental commit to `main`/`master`. It fails open when `jq` isn't installed and respects a configured `gitflow.branch.master`, falling back to `main`/`master` otherwise.

## [monitor 3.18.3] - 2026-07-07

_monitor is independently versioned; this entry tracks the `monitor-v3.18.3` tag._

### 🔧 Fixed

- **Cockpit's Mermaid diagram linter now catches unterminated parallelogram/trapezoid shapes** — labels like an unquoted slash command (`[/release]`) no longer slip past the diagram-lint check silently; the case is now flagged with test coverage and a note in the diagram reference guide.

## [chronicle 0.5.0] - 2026-07-07

_chronicle is independently versioned; this entry tracks the `chronicle-v0.5.0` tag._

### ✨ Added

- **New `/chronicle:release` skill** — cuts a release end-to-end: bumps version files, writes the CHANGELOG entry, and (in auto mode) commits, merges, tags, and pushes. Auto-detects whether the repo is versioned whole-repo or per-component and remembers the shape in a committed `.chronicle/release.json` after a one-time interview, so every later run just reads it instead of re-guessing.
- **Three modes from the invocation**: `/chronicle:release` (prepare — bump + changelog + verify, then stop for review); `auto` (also commits, merges `develop → main`, tags, and merges back — local only); `auto push` (the above plus pushing branches and the tag). A version or component token can follow any mode to skip that part of the gate.
- **Capture-group version-file patterns** (Rails-friendly) let a release unit's version live in files beyond `plugin.json`, e.g. a Ruby `VERSION = "x.y.z"` constant, via a configurable regex with a capture group.
- **Nested no-Bash orchestrator** mirroring the existing commit/pr skills: a `releaser` custom agent spawns `surveyor` (read-only release-fact gathering), `bumper` (persists config + applies + verifies version bumps), `chronicler` (writes the Keep-a-Changelog entry from `git log`), and `finisher` (commit/merge/tag/push in auto mode) — keeping git and script output out of the main conversation.

## [monitor 3.18.2] - 2026-07-07

_monitor is independently versioned; this entry tracks the `monitor-v3.18.2` tag._

### ✨ Added

- **Cockpit prep mode** for orchestration setup.

### 🔧 Changed

- **Cockpit dashboard body font-size bumped from 14px to 16px** for better readability.

### 📖 Docs

- **Cockpit reference restructure** — usage-dashboard docs consolidated into a README, Mermaid diagram guidance extracted into its own cockpit reference, the `claude.md` reference renamed to `claude-cli.md` (avoids a macOS case-collision with `CLAUDE.md`), and the codex reference now points at the selected mode reference (`pilot.md` / `scribe.md`) instead of the shared `SKILL.md`.

## [herdr 0.1.4] - 2026-07-07

_herdr is independently versioned; this entry tracks the `herdr-v0.1.4` tag._

### 🔧 Changed

- **New agent tabs now open in the caller's workspace, not the focused one.** `herd.ts`'s new-tab spawn (`startInNewTab`) defaults `tab create --workspace` to the caller's `HERDR_WORKSPACE_ID` when no explicit `workspace` is given. Previously a tab spawned while you were viewing a *different* herdr workspace landed in that workspace; now it stays pinned to where the delegating agent lives (fixes relay live-pane delegations opening in the wrong workspace). An explicit `opts.workspace` still wins.

## [dispatch 3.15.1] - 2026-07-07

_dispatch is independently versioned; this entry tracks the `dispatch-v3.15.1` tag._

### 🔧 Changed

- **autopilot live dev driver waits longer before giving up.** The live delegate now passes `--wait-timeout 900000` (15 min, up from relay's 10-min default). Since relay's poll loop returns the instant the result lands, the bigger budget costs nothing for normal-speed tasks and only extends patience for genuinely-long ones — so a `pending` outcome now reliably means a pathological/runaway task (correctly retried/escalated) rather than a slow-but-fine one being killed prematurely.

## [relay 0.5.0] - 2026-07-07

_relay is independently versioned; this entry tracks the `relay-v0.5.0` tag._

### ✨ Added

- **`--keep-pane` flag** — keep a successful live pane open for follow-up conversation. Without it, relay now closes the pane after collecting a verified result.

### 🔧 Changed

- **Live pane closes by default after a verified result.** Previously a successful live run always left the pane open; now relay closes it once the agent has settled and the result-file marker verifies the answer (best-effort — a close failure never downgrades a verified success). Failures and pending timeouts still leave the pane open for postmortem.
- **Status-aware timeout.** At the poll timeout, relay now checks the agent's herdr status: a still-`working`/`blocked`/unknown pane returns `pending` as before, but a pane that has already settled (`idle`/`done`) without a verified result returns a failure instead of misreporting "still running".

### 📖 Docs

- **Live-vs-headless guidance** added to `references/live.md` + `SKILL.md`: editing capability is identical, so `--headless` needs a genuine reason (nested delegation / no live seam / no pane surface); and relay is a single blocking call, so don't poll its output while it runs.

## [dispatch 3.15.0] - 2026-07-07

_dispatch is independently versioned; this entry tracks the `dispatch-v3.15.0` tag._

### ✨ Added

- **autopilot live dev engine (opt-in).** When the external dev engine (codex/opencode) is selected and the session runs inside herdr (`HERDR_ENV=1` + a resolvable `relay.ts`), autopilot can run the dev step in a visible herdr live pane via relay instead of the headless `<engine>-run.ts` wrapper. Gated by `CFG.liveDevEngine` + absolute `CFG.relayPath`, surfaced as a scout-time question; **headless stays the default** and the fallback path is byte-identical. The review lens always stays headless.

### 🔧 Changed

- **Pending semantics for the live dev driver.** A relay pending report is treated as a failed gate attempt (logged with the agent name and a pane-left-open-for-postmortem note); the task's `## Verification` remains the real correctness gate. Relay's default 10-minute poll budget is kept as-is — decomposed flightplan tasks are small by design, so needing longer signals decompose-further or escalate-to-Opus.

## [herdr 0.1.3] - 2026-07-07

_herdr is independently versioned; this entry tracks the `herdr-v0.1.3` tag._

### 📖 Docs

- **`herd.ts` docblock verb count fixed** — corrected to say seven verbs, not five.
- **herdr 0.7.1 verification headers** added to `cli.md`, `config.md`, and `plugin-development.md` references.
- **Agent-orchestration spawn recipe fixed** and `SKILL.md` trigger docs trimmed.

## [relay 0.4.0] - 2026-07-07

_relay is independently versioned; this entry tracks the `relay-v0.4.0` tag._

### ✨ Added

- **`relay config set-model <backend> <mode> <model>`** — a new subcommand that validates the backend against the registry and the mode against `delegate|review|image`, then merge-writes the default model into `~/.config/q-lab/cc-plugins/relay/config.json` (preserving existing keys). Replaces error-prone agent hand-edits of the config JSON with deterministic script work.

### 📖 Docs

- **Live-pane mode docs extracted** from `SKILL.md` into a dedicated `references/live.md`.
- **Renamed `/relay:claude` command to `/relay:claude-cli`** to avoid an APFS case-insensitive filename collision with `CLAUDE.md`.

## [dispatch 3.14.0] - 2026-07-07

_dispatch is independently versioned; this entry tracks the `dispatch-v3.14.0` tag._

### ✨ Added

- **`score-task --json`** — the flightplan scoring gate now supports a `--json` flag (`toJsonResult()` helper) that emits a machine-readable verdict, so callers no longer need to parse human-facing text.
- **`next-ready` returns task file paths.** `ReadyRef` gains a `path` field (sourced from a new `pathByRef` map), so callers get a ready task's file location directly instead of re-deriving it.

### 🔧 Changed

- **autopilot orchestrator drops inline scoring.** The orchestrator's `scoreInline()` helper is gone; gate decisions now call `score-task.ts --json` directly. `JUDGE_SCHEMA` was reshaped to carry scores plus a nested `verdict` object instead of the full rubric, and `READY_SCHEMA` now requires the `path` field sourced from `next-ready`.
- **flightplan and waypoints docs** updated to document the new `--json` flag and `path` field, with outdated inline-scoring prose removed.

## [chronicle 0.4.0] - 2026-07-07

_chronicle is independently versioned; this entry tracks the `chronicle-v0.4.0` tag._

### ✨ Added

- **Bounded diffs in the commit analyzer.** `analyze-changes.ts` now caps unified diffs at 400 lines (`capDiff()`, with a truncation footer noting total +/- counts) and skips inlining untracked files over 256 KiB, so a single huge file or diff can no longer blow up the commit-analysis payload. Also adds a `summary` field to the analysis result.
- **Branch analyzer error handling.** `analyze-branch.ts`'s `main()` now captures the actual error (`fallbackPayloadForError()`) instead of swallowing it silently, so a failed analysis reports why in its fallback payload and JSON output instead of just going blank.

### 📖 Docs

- **`DESIGN.md`** documents the current agent-spawn topology (Manager as a custom agent with the `Agent` tool; analyst/writer as Haiku leaves) and the rationale behind it. Agent prompts and the commit `SKILL.md` were trimmed to match.

## [monitor 3.18.1] - 2026-07-06

_monitor is independently versioned; this entry tracks the `monitor-v3.18.1` tag._

### 🐛 Fixed

- **Pricing refresh no longer 500s.** `POST /api/pricing/refresh` (the dashboard's "refresh pricing" button) threw `ReferenceError: dirname is not defined` on every call — `refreshPricingOverride` in `usage-dashboard/scripts/api.ts` used `dirname()` to create the override directory, but only `join` was imported from `node:path`. Added `dirname` to the import. The bug only surfaced on the code path that creates `~/.config/cc-dashboard/` when it doesn't yet exist, which is why it looked intermittent. Note: Fable 5 and Opus 4.8 aren't in the static `pricing-defaults.json` — they resolve via the OpenRouter live fetch and land in the user override once a refresh succeeds.

## [monitor 3.18.0] - 2026-07-05

_monitor is independently versioned; this entry tracks the `monitor-v3.18.0` tag._

### ✨ Added

- **Write-time lint for `--diagram` Mermaid source.** `cockpit log` / `cockpit scribe` now lint the diagram before anything is written (new `scripts/diagram-lint.ts`): unknown diagram-type first line, unbalanced brackets, unknown `:::` classes, and unquoted `()` inside `[...]` labels each exit non-zero with a fix hint. This closes a real feedback gap — Mermaid's parser is DOM-bound, so a broken diagram used to fail silently at render time where the authoring agent could never see it; now the author fixes it on the spot. Deliberately conservative: sequence async arrows (`-)`), cylinder shapes (`[(db)]`), quoted labels, frontmatter, and mindmap cloud/bang shapes all pass. The type whitelist is the vendored mermaid v11 bundle's complete keyword set, drift-guarded by a test that checks every entry against the bundle.
- **Download a decision-card diagram as SVG.** The diagram lightbox gained an "SVG ⤓" button: it exports the exact sanitized SVG on display (no re-render), bakes the Night Flight card surface colour onto the root so the dark ink stays readable outside the dashboard (GitHub READMEs, PR bodies), and names the file from the card headline (`cockpit-<title>.svg`).
- **Diagram authoring guidance in the cockpit references** (inspired by reviewing the archify skill): a shape→Mermaid-type selection table (state machine → `stateDiagram-v2`, call chain → `sequenceDiagram`, decision tree → `flowchart TD`, before/after → two `subgraph`s) and layout discipline for glance-sized decision-card diagrams — one main path, sparse event-like edge labels, detail in `--facet`/`--text` rather than extra arrows, ~12-edge budget.

## [dispatch 3.13.0] - 2026-07-04

_dispatch is independently versioned; this entry tracks the `dispatch-v3.13.0` tag._

### ✨ Added

- **waypoints** — a fourth dispatch skill: a rolling-wave milestone-roadmap tier above flightplan. Writes
  `docs/<proj>/WAYPOINTS.md` (milestones + `[x]`/`[~]`/`[ ]` status), a `waypoints.ts` CLI
  (`active` / `leg-scaffold` / `advance`), and a flightplan "waypoint mode" that plans one leg at a time
  into `docs/<proj>/legs/NN-slug/`. Tracks the scoped tag `dispatch-v3.13.0`.

### 🔧 Changed

- **flightplan** (0.6.0) — gains waypoint mode; `flightplan-lint.sh` now lints nested leg task files.

## [dispatch 3.12.2] - 2026-07-04

_dispatch is independently versioned; this entry tracks the `dispatch-v3.12.2` tag._

### ✨ Added

- **autopilot — choose the model for the final-review `/simplify` lenses.** New `CFG.reviewLensModel` option (`'opus'` default, or `'fable'` for Claude Fable 5), surfaced as a Step-2 pick alongside the dev engine and cross-vendor reviewer. It routes through the orchestrator's `MODEL.reviewLens`, so it affects **only** the four final-review quality lenses (reuse / simplification / efficiency / altitude); the fixer and rubric judge stay Opus, keeping the dev≠judge gate stable. Named for its true blast radius (`reviewLensModel`, not `finalReviewModel`).

## [chronicle 0.3.2] - 2026-07-04

_chronicle is independently versioned; this entry tracks the `chronicle-v0.3.2` tag._

### 🐛 Fixed

- **`chronicle:commit` no longer crashes on commit-less repositories.** `analyze-changes.ts` ran `git log --oneline -10` inside a `Promise.all`; in a freshly `git init`'d repo with no commits, git exits non-zero ("your current branch does not have any commits yet") and Bun's `$` shell rejects, so the whole analysis aborted with exit 128 — blocking the first commit on any new project. The `git log` call now `.catch(() => "")`s, so a missing history resolves to an empty `recentCommits` array and the changeset analysis proceeds normally.

## [monitor 3.17.0] - 2026-07-04

_monitor is independently versioned; this entry tracks the `monitor-v3.17.0` tag._

### ✨ Added

- **Optional remote usage export — push your Claude + Codex quota snapshot to an external dashboard.** The statusline collector gained a tertiary trigger, `nudgePush()`, that spawns a detached, 2-min-throttled `push-usage.ts` worker to POST the latest usage-window snapshot (`{ capturedAt, claude, codex }`) to a remote relay such as an n8n webhook — so an external display (e.g. a TRMNL e-ink dashboard) can show current quota/usage without running the dashboard. It exports **only** usage-window data — never transcripts, message content, or project/session lists. Fully opt-in: nothing runs unless `LLM_QUOTA_INGEST_URL` is set, so existing users see zero behavior change. `LLM_QUOTA_INGEST_SECRET`, if set, is sent as the `X-Auth-Token` header. Like the rollup nudge, the push is detached + throttled so statusline rendering never waits on (or fails because of) the network call or the Codex usage API. `readUsageLimits()` / `readCodexUsageLimits()` are now exported from `api.ts` so the worker reuses the existing cache logic instead of duplicating it.

## [herdr 0.1.2] - 2026-07-02

_herdr is independently versioned; this entry tracks the `herdr-v0.1.2` tag._

### ✨ Added

- **New-tab spawns are now labelled.** `spawn({ newTab: true })` labels the tab it creates (via `tab create --label`) so you can tell at a glance what each tab is for. Defaults to the generated agent name (e.g. `relay-codex-delegate-8b6f` — encodes role + a unique suffix); override with `tabLabel` / `herd spawn --tab-label "PR #42 review"`. relay live runs get labelled tabs for free (no relay change needed).

## [herdr 0.1.1] - 2026-07-02

_herdr is independently versioned; this entry tracks the `herdr-v0.1.1` tag._

### ✨ Added

- **`spawn({ newTab: true })` / `herd spawn --new-tab` — start an agent in its own tab, not a split.** herdr has no "start an agent in a fresh empty tab" primitive, so the wrapper does the dance: capture the focused tab → `tab create --no-focus` → `agent start --tab <new>` → close the leftover shell root pane → restore focus (`agent start --tab` steals focus despite `--no-focus`). The caller's pane keeps its full size.
- **`keys` verb — send bare key chords with no text.** `herd.keys(target, "enter")` submits whatever already sits in the input box; `herd.keys(target, "ctrl+a", "ctrl+k")` clears a line. Wraps `pane send-keys` (re-resolving name → pane id first), filling the gap left by `send`, which always types text before the Enter.

### 🐛 Fixed

- **`herd.send` no longer races the TUI: a settle pause before pressing Enter.** Submitting immediately after writing the prompt text could get the Enter swallowed by a TUI still processing the pasted input (seen live with codex: the bootstrap sat in the input box, never submitted, and the agent idled forever). `send` now waits 400 ms between the text write and the `pane send-keys … enter` — tune or disable via `HERD_SUBMIT_SETTLE_MS`. Applies to `spawn --task` too (it submits through the same path).

## [relay 0.3.0] - 2026-07-02

_relay is independently versioned; this entry tracks the `relay-v0.3.0` tag._

### ✨ Added

- **Live-pane execution inside herdr — delegates and reviews you can watch and take over.** When relay runs inside herdr (`HERDR_ENV=1`), `delegate` and `review` now spawn the backend's **interactive TUI** (`codex` / `claude` / `opencode`) in a visible sibling pane instead of a blocking headless spawn, driven through the herdr plugin's `herd.ts` wrapper. The full prompt rides a `live-prompt.md` file (a one-line bootstrap is all the pane receives — multi-line TUI sends submit prematurely), and the answer comes back via a result-file contract: the delegate writes its complete final markdown to `result.md` ending with an exact end-marker line, and relay polls for agent-**settled** (`idle` *or* `done` — codex parks at `done` after answering) + marker, and self-heals a lost bootstrap delivery (pane never leaves idle, no result file → re-send the whole bootstrap line, at most twice; covers both a swallowed Enter and text the TUI dropped while starting up). stdout stays the clean answer; live metadata (agent name, keep/close hint) rides stderr. In live mode, review always uses the prompt strategy — a git-ref scope becomes a produce-the-diff-yourself instruction (`git diff <ref>...` / `git show <sha>`). `image` stays headless/native.
- **`--headless` and `--wait-timeout <ms>` flags.** `--headless` forces the classic flow even inside herdr (essential for nested delegation — a live-delegated agent inherits `HERDR_ENV=1`); `--wait-timeout` bounds the live poll (default 10 min). A run that outlives the timeout is **not a failure**: relay exits 0 with a `pending` report of copy-pasteable follow-ups (`herd wait/read/close` + `cat result.md`) and never kills or closes the pane. Pane lifecycle after success is the calling agent's call (AskUserQuestion close-or-keep, per SKILL.md).
- **No hard herdr dependency.** `herd.ts` is resolved at runtime (`HERD_SCRIPT_PATH` override → repo-sibling checkout → both harnesses' plugin caches, newest version first) and dynamically imported only when the live path is taken; anything unresolvable degrades to one stderr note + the unchanged headless flow, so relay stays portable to machines without the herdr plugin. Headless fallback is double-run-safe: a spawn that throws after partially creating its pane is detected via an agent-list diff (new `relay-<backend>-<mode>-*` name), and relay then reports the error instead of re-running the task headless (found by a codex live review of this very change).
- **Live runs open their own tab, not a split.** The live pane now spawns via `herd.spawn({ newTab: true })`, so your working pane keeps its full size instead of being halved by a `--split down`. (`split: "down"` is still passed as a graceful fallback for an older `herd.ts` that predates `newTab`.)
- **`--dangerous` is now a uniform YOLO switch across all three live backends.** codex → `--dangerously-bypass-approvals-and-sandbox`, claude → `--dangerously-skip-permissions`, and **opencode → `--auto`** (its "auto-approve permissions not explicitly denied" flag, accepted by the interactive TUI) — previously opencode had no unattended-live story and stalled on permission prompts. Without `--dangerous`, no bypass flag is passed and approval prompts surface in the pane for a human to answer; with it, an unwatched pane runs to completion.

### 🔧 Changed

- `executeRelay` is now async (the headless runner stays sync internally); backends gained a pure optional `invokeLive` seam describing their TUI launch (model/dangerous flag mapping).
- **Input-state-aware bootstrap nudge.** When the pane never leaves idle and no result file appears, relay no longer blindly re-sends the whole bootstrap (which could submit the read-this-file instruction *twice*). It now reads the pane's visible input box first: full line present but unsubmitted → press **Enter only**; line lost entirely → **re-send**; partial paste → **clear the line (`ctrl+a ctrl+k`) then re-send**. Uses herdr 0.1.1's new `keys` verb.

## [herdr 0.1.0] - 2026-07-02

_herdr is independently versioned; this entry tracks the `herdr-v0.1.0` tag._

### ✨ Added

- **New `herdr` plugin — reference + in-session agent orchestration for the [Herdr](https://herdr.dev) terminal workspace manager.** Migrated the standalone `/herdr` reference skill (config, CLI, plugin development, live pane/agent recipes) into its own marketplace package rather than folding it into `relay` — the reference is *knowledge*, distinct from relay's *executor* role. Ships to both the Claude and Codex marketplaces at `0.1.0`.
- **`herd` wrapper (`scripts/herd.ts`) — a typed Bun layer over the raw `herdr` CLI.** Collapses herdr's multi-step recipes into five verbs — `spawn` / `send` / `wait` / `read` / `list` / `close` — for driving agents in sibling panes when running inside herdr (`HERDR_ENV=1`). Handles the CLI's sharp edges, all verified live against herdr 0.7.1: addresses agents by a collision-resistant generated **name** (pane ids renumber and aren't durable), `send` writes literal text **and presses Enter** to submit (raw `agent send` doesn't), `read` defaults to `--source visible` because agent TUIs render into the alternate screen and leave scrollback empty, and the runner honors `HERDR_BIN_PATH`. Exposed as a `createHerd(run)` factory so `relay` can consume the same layer for a future live-pane strategy. Backed by 15 unit tests (mocked runner) plus a codex-reviewed argument parser.

## [monitor 3.16.2] - 2026-07-02

_monitor is independently versioned; this entry tracks the `monitor-v3.16.2` tag._

### 🔧 Changed

- **Cockpit's DESIGN button now shows the selected project's design doc, not cockpit's own.** The dashboard's `/api/design-system` endpoint reads the selected project's `DESIGN.md` (or `design.md`) instead of a fixed path to cockpit's checked-in file, and the DESIGN toggle hides entirely when the selected project has no design doc (no fallback to cockpit's own). The endpoint is confined to registry-known projects and realpath-confined to the project root — mirroring the existing `project-info.ts` hardening — so a crafted deep link can't make the daemon read arbitrary `DESIGN.md` files. The frontend availability probe also captures-and-compares the selected project after its await, so a slow probe for a since-changed selection can't clobber current UI state.

## [monitor 3.16.1] - 2026-07-01

_monitor is independently versioned; this entry tracks the `monitor-v3.16.1` tag._

### 🐛 Fixed

- **`parseCodexUsage()` now includes Codex threads with no rollout_path in cost summaries.** Threads with token usage but no on-disk rollout_path were silently omitted from the per-model cost summary and per-project totals (though they still appeared in the hourly chart and recent-activity ledger). The four aggregate maps now include these threads, matching the existing accumulation pattern.

### 🔧 Changed

- **Extracted shared utility modules to eliminate duplicated logic.** `paths.ts`, `session-files.ts`, `shared/scripts/path-inside.ts`, and `shared/scripts/static-server.ts` consolidate path constants, session-file reading (with validation), path-containment checks, the static file server + MIME table, JSON response helpers, OpenCode timestamp normalization, and the daily-activity/daily-hour-count merge loops that were spread across `api.ts`/`live.ts`/`atlas-server.ts`/`cockpit/scripts/cockpit-server.ts`. `OPENCODE_DIR`/`OPENCODE_DB` resolution now respects the `COCKPIT_OPENCODE_DB` env override (previously ignored). Added a 5s TTL cache to two file reads on the 3-second `/api/live` poll path (`cockpitSessionKeys`/`cockpitDaemonPort`).

## [monitor 3.16.0] - 2026-06-28

_monitor is independently versioned; this entry tracks the `monitor-v3.16.0` tag._

### ✨ Added

- **`/monitor:nudge` — a multi-scope kill switch for the scribe auto-log reminders.** The 💭 "spawn a fork to run /cockpit scribe" nudge that the `Stop` hook re-surfaces at the end of each turn can now be silenced (or re-enabled) at three scopes — `session` (TTL-pruned file, one week idle), `project` (keyed by git root), and `user` (global default) — via `cockpit nudge [on|off|toggle|clear|status] [--scope session|project|user]`. The most-specific *defined* scope wins (`session → project → user → default: on`), so a broad `off` can be re-enabled at a narrower scope — e.g. mute everywhere with `nudge off --scope user`, then hear them in just one session with `nudge on`. Project and user opinions persist in the one global cockpit config (the project opinion is keyed by its git root, never a repo dotfile); `status` prints the effective result plus the per-scope breakdown. The `Stop` hook consults this toggle before nudging, so an all-unset setup stays enabled (unchanged behaviour).

## [monitor 3.15.2] - 2026-06-21

_monitor is independently versioned; this entry tracks the `monitor-v3.15.2` tag._

### ✨ Added

- **"Fetch latest pricing" button in the dashboard's Pricing confidence panel.** A square refresh button (bottom-right of the panel) pulls live per-model pricing from OpenRouter and writes it into your override file (`~/.config/cc-dashboard/pricing.json`), then reloads the stats so the panel updates in place. Entries are keyed by the raw model name — no harness prefix — so a model used across Claude/Codex/OpenCode collapses to one price, and your hand-set override entries are preserved. A status note ("Saved to … — N models priced") auto-dismisses after 5 seconds.

### 🔧 Changed

- **Model→price matching is now harness-agnostic and tolerant of id formatting.** A new normalization step lets used models resolve to live OpenRouter prices that previously fell through to the conservative fallback: it bridges provider prefixes (`anthropic/`, `minimax/`…), version dot-vs-dash (`claude-opus-4-5` ↔ `claude-opus-4.5`), trailing `-YYYYMMDD` snapshot dates, and `:free`/`:thinking` routing tags. Exact matches still win first, so curated defaults and overrides are never repriced; normalization only rescues models that would otherwise have no price. On a real account this took the "fallback in use" count to zero with no mismatches.

### 🐛 Fixed

- **Removed a stale `claude-opus-4-5` default price (15/75 per 1M).** It now resolves to the correct live OpenRouter price (5/25) via the normalization above, instead of a wrong hard-coded value.

## [monitor 3.15.1] - 2026-06-21

_monitor is independently versioned; this entry tracks the `monitor-v3.15.1` tag._

### 🐛 Fixed

- **The cockpit "thoughtful" scribe nudge no longer fires in headless `claude -p` runs.** The `Stop` hook that re-surfaces the auto-logging reminder fires in print/SDK mode too — so relay's `delegate`/`review` backends (and any SDK app) had a `/cockpit scribe` nudge injected into every turn, where there is no interactive cockpit and no human to ever act on it. `scribe-nudge.ts` now bails at the top of `main()` when `CLAUDE_CODE_ENTRYPOINT` starts with `sdk` (headless runs report `sdk-cli`; SDK apps `sdk-*`; the interactive TUI reports `cli`), verified against a live Stop hook probe. Interactive cockpit sessions are unaffected.

## [chronicle 0.3.1] - 2026-06-19

_chronicle is independently versioned; this entry tracks the `chronicle-v0.3.1` tag._

### 🐛 Fixed

- **`chronicle:commit` no longer launches its writer before the analyst returns.** The Commit Manager was emitting the `chronicle:analyst` and `chronicle:writer` spawns in the *same* turn, so the writer ran in parallel and received an empty plan — the manager builds the `CommitPlan` from the analyst's facts, a hard data dependency. `manager.md` described a sequential flow but never forbade same-turn batching, so the model followed the harness's default "batch independent tool calls" guidance. It now states the two `Agent()` calls are strictly sequential and must never be batched in one turn (the batch-parallel guidance doesn't apply to dependent calls), with a reminder at the writer step to spawn only after the analyst returns.

## [chronicle 0.3.0] - 2026-06-18

_chronicle is independently versioned; this entry tracks the `chronicle-v0.3.0` tag._

### 🔧 Changed

- **Both the commit and PR flows were rebuilt onto a nested-manager topology.** They previously ran as context-inheriting `fork`s, but a fork is a leaf the harness forbids from spawning subagents — so `chronicle:commit` silently never delegated to its Haiku analyst/writer (it ran git inline), and `chronicle:pr`'s fork could open a PR on its own. Both are now driven by nested custom orchestrators that hold `Agent` + `Read` but **no `Bash`/`gh`**, so they *must* delegate: `chronicle:commit` → `chronicle:manager` → `chronicle:analyst` + `chronicle:writer`; `chronicle:pr` → `chronicle:editor` → `chronicle:drafter` (bun-only, no `gh` — structurally can't create) + `chronicle:publisher` (the only agent that opens the request, auto-creating as a draft by default). Orchestrators run on Sonnet (Haiku mishandles the synchronous spawn loop); the leaf workers stay on Haiku.

### ✨ Added

- **PR/MR bodies can lead with a synthesized overview diagram.** When the change has a shape, the drafter opens "What changed" with one cohesive Mermaid diagram of the whole PR, distilled from the cockpit decisions + diff. It uses inline `classDef` for colour, since GitHub/GitLab render with their own default Mermaid (no cockpit theme).

### 🐛 Fixed

- **`chronicle:pr` now actually reads the cockpit decision trail.** Branch-scoping compared decision timestamps as raw strings, but cockpit logs UTC (`…Z`) while git `%cI` emits a local offset (`…+08:00`) — so for any non-UTC user every in-branch decision was silently dropped (`hasCockpit:true` but `decisions:0`, with a context-inheriting fork masking the dead path). Timestamps are now compared as parsed instants; a mixed-timezone regression test guards it.

## [monitor 3.15.0] - 2026-06-18

_monitor is independently versioned; this entry tracks the `monitor-v3.15.0` tag._

### ✨ Added

- **Cockpit diagrams now colour nodes by meaning.** A Night Flight `themeCSS` palette gives Mermaid six semantic node classes — `:::ok` / `:::bad` / `:::fix` / `:::info` / `:::warn` / `:::start` — so a decision diagram's success path, failure path, and the fix read at a glance instead of rendering in one flat accent. Scribe/pilot guidance now tags nodes with these classes; the palette is additive, so untagged diagrams still render.

### 🔧 Changed

- **`/monitor:install --apply` now pre-approves the marketplace's own scripts.** It adds `Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts)` to `permissions.allow` so plugin scripts run without a permission prompt. This is required for deeply-nested sub-agents (e.g. chronicle's drafter under its editor): a nested agent can't surface a permission prompt to be answered, so an un-allowlisted `bun` call is otherwise silently denied. (Wired into `--apply` only, not the SessionStart migrate path, which never fresh-wires.)

## [monitor 3.14.3] - 2026-06-18

_monitor is independently versioned; this entry tracks the `monitor-v3.14.3` tag._

### 🐛 Fixed

- **Scribe entries now actually follow the configured decision-log language.** The language requirement lived only in scribe.md's "Step 5 — Language", which sat _after_ the write step (Step 4) — so a fork wrote every entry in its inherited (often English) context first and met the rule too late. Language resolution now happens up front in Step 1 and is enforced at the point of writing in Step 4, with explicit wording that it overrides the conversation/prompt language; Step 5 becomes a final sanity-check. The `SessionStart` auto-logging guidance also now reminds that the fork writes in the configured language, which may differ from the chat.

## [monitor 3.14.2] - 2026-06-18

_monitor is independently versioned; this entry tracks the `monitor-v3.14.2` tag._

### 🐛 Fixed

- **The cockpit registry no longer grows without bound.** `registry.json` only ever upserted sessions by id and never dropped ended ones, so it accumulated an entry per session forever — bloating the file, keeping long-dead projects in the dashboard's project list, and making every `/api/sessions` poll `stat()` every historical session's log. Writes now route through a single path that reaps any entry whose last activity signal (heartbeat or log mtime) is older than 14 days — which doubles as the dashboard's "recent projects" look-back window. (`scribe-nudge.json` already self-pruned at 24h and is unchanged.)

## [monitor 3.14.1] - 2026-06-18

_monitor is independently versioned; this entry tracks the `monitor-v3.14.1` tag._

### 🔧 Changed

- **The thoughtful-logging nudge is now terse and diagram-first.** The `Stop`-hook reminder no longer repeats the full fork how-to every turn (that boilerplate is taught once at `SessionStart`); it is now a one-line poke in two tiers by change size — light vs structural — each carrying only the essential `subagent_type:"fork"` token so it stays actionable even after the session is compacted. Both tiers, and the `scribe` reference itself, now lead **diagram-first**: prefer attaching a Mermaid `--diagram` whenever the insight has a shape (flow / sequence / state / fan-out), falling back to prose only for genuinely flat facts.

## [monitor 3.14.0] - 2026-06-18

_monitor is independently versioned; this entry tracks the `monitor-v3.14.0` tag._

### ✨ Added

- **Thoughtful auto-logging now gets nudged at the right moment.** A new `Stop` hook (`scribe-nudge.ts`) re-surfaces the decision-log reminder at the end of each turn — the natural "a chunk of work just finished" boundary — via the hook's `additionalContext`, which fixes the old `SessionStart`-only guidance that got buried as the session grew. It stays high-signal rather than naggy: it nudges only when code actually changed since the last nudge (a git signature over HEAD + numstat + porcelain), throttles repeats, and fires once per distinct code-state. When the change looks structural (many files / many lines, untracked files included), the reminder also encourages attaching a Mermaid `--diagram`.

### 🔧 Changed

- **The global cockpit home moved to a standard XDG path.** `~/.cockpit` (holding `daemon.json` / `registry.json` / `atlas.json`) is now resolved under `~/.local/share/q-lab/cockpit` via `XDG_DATA_HOME`, matching the rollup DB's location. A single shared `cockpitHome()` helper replaces the dozen inlined definitions and performs a one-time, race-safe migration of any legacy `~/.cockpit` on first resolve. `COCKPIT_HOME` still works as an explicit override, and project-local `.cockpit/` decision logs are unchanged.

## [chronicle 0.2.1] - 2026-06-18

_chronicle is independently versioned; this entry tracks the `chronicle-v0.2.1` tag._

### 🔧 Changed

- **Follows the cockpit home move to XDG.** The PR skill's decision-trail reader now resolves the cockpit registry under `~/.local/share/q-lab/cockpit` (via `XDG_DATA_HOME`) instead of `~/.cockpit`, mirroring monitor 3.14.0 so PR enrichment keeps finding the trail. `COCKPIT_HOME` still overrides.

## [monitor 3.13.0] - 2026-06-18

_monitor is independently versioned; this entry tracks the `monitor-v3.13.0` tag._

### ✨ Added

- **Usage history now outlives Claude Code's cleanup.** A new persistent SQLite rollup DB (`rollup-db.ts` + `rollup-update.ts`, stored under `~/.local/share`) tail-ingests `~/.claude` transcripts into billing-deduped hourly buckets, so the dashboard's token/cost history survives `cleanupPeriodDays` deleting the underlying transcripts. `api.ts` now sources its aggregate maps from the rollup (with a live-walk fallback), and the statusline collector fires a throttled, fail-silent background nudge to keep it fresh. The `/api/stats` output shape and live-pricing cost are unchanged.

## [chronicle 0.2.0] - 2026-06-18

_chronicle is independently versioned; this entry tracks the `chronicle-v0.2.0` tag._

### ✨ Improved

- **The commit skill is now driven by one Commit Manager.** The old two-phase flow (an analyze fork, then a write fork, both on your model) is replaced by a single context-inheriting Commit Manager fork that owns the whole run: it spawns a fresh Haiku `chronicle:analyst` to gather changeset facts, decides simple vs atomic itself, then spawns a fresh Haiku `chronicle:writer` to stage and commit. The grunt work drops to Haiku while the Manager keeps the conversation's "why" — which it distills into each commit's `whyBrief` and passes down, since the fresh children don't inherit the conversation. This threads three Claude Code constraints (a fork can't spawn another fork; fresh agents honor a per-call model override; children don't inherit context), and keeps all diff/git output inside the Manager subtree so the main conversation only sees the final `git log`.

## [chronicle 0.1.2] - 2026-06-17

_chronicle is independently versioned; this entry tracks the `chronicle-v0.1.2` tag._

### 🐛 Fixed

- **Commit messages stay terse now that a fork writes them.** The context-inheriting write fork holds far more "why" than belongs in a commit, which bloated bodies into essays and turned the 繁中 summary into a line-by-line re-translation. The template now carries a length guardrail — body capped at ~3–4 one-line bullets, summary at 1–3 summarizing sentences — echoed in the Phase B spawn note.

## [monitor 3.12.3] - 2026-06-17

_monitor is independently versioned; this entry tracks the `monitor-v3.12.3` tag._

### ✨ Improved

- **Sharper thoughtful-mode auto-logging guidance.** The `SessionStart` thoughtful hook is reframed as a clearer "DECISION LOG ACTIVE" nudge: the four worth-recording triggers are listed inline, the bar is kept high (missing some is fine) so it doesn't fire forks on trivial turns, and the spawn prompt uses the full "distill the work we just completed" phrasing with an explicit `"fork"` reminder. The scribe reference now also asks whether an insight is structural enough to draw, so the fork reaches for a `--diagram` when the "what" is a shape rather than a sentence.

## [chronicle 0.1.1] - 2026-06-17

_chronicle is independently versioned; this entry tracks the `chronicle-v0.1.1` tag._

### 🐛 Fixed

- **Chronicle's commit and PR skills now spawn context-inheriting forks.** Both skills described their analyze/write phases as a generic "sub-agent", which would start fresh, context-less agents — so commit bodies degraded to diff-plus-template and a PR's **Why** section lost the in-session rationale. The phases are now explicit `subagent_type: "fork"` (Codex `fork_context: true`) spawns that inherit the conversation "why" while keeping diff/git output out of the main context, with a warning against omitting the fork type.

## [monitor 3.12.2] - 2026-06-17

_monitor is independently versioned; this entry tracks the `monitor-v3.12.2` tag._

### ✨ Added

- **Enlarge a cockpit diagram.** Click (or press Enter/Space on) a rendered decision-card diagram to blow it up in a lightbox at near-full-viewport, with a hover ⤢ hint — dense instrument panels are finally readable. Close with the backdrop, the ✕, or Esc. The lightbox reuses the already-sanitized SVG (no re-render) and sits below the permission modal so a needs-your-call prompt still wins.

### 🐛 Fixed

- **The "off the cockpit" invite no longer lingers once a session gets logged.** When a session started untracked and a later scribe entry arrived, the invite card stayed pinned below the real decision cards. Its `display:grid` was outranking the `[hidden]` attribute; the invite now hides correctly as soon as a decision lands.
- **Thoughtful auto-logging and statusline repair now cover resumed, cleared, and compacted sessions.** Both `SessionStart` hooks were firing on a cold launch only; they now also run on `resume`, `clear`, and `compact`, so continuing or compacting a session no longer drops the auto-log nudge or the version-drift statusline fix.

## [chronicle 0.1.0] - 2026-06-17

_chronicle is independently versioned; this entry tracks the `chronicle-v0.1.0` tag._

### ✨ Added

- **Chronicle joins the marketplace as an independently-versioned plugin.** The new `commit` skill unifies simple and atomic commit flows into one decision tree, while the `pr` skill authors PR/MR descriptions enriched by the cockpit decision trail when available. Chronicle ships to both Claude Code and Codex marketplaces at version `0.1.0`.

## [3.12.1] - 2026-06-17

### ✨ Added

- **Restart the cockpit daemon without restarting your Claude session.** A new `cockpit restart [--port N] [--no-open]` command bounces the dashboard daemon onto the current plugin code — useful for picking up a plugin update or a working-tree edit mid-session. It kills the running daemon, rebinds on the same port, and confirms it won the race past the channel MCP's auto-respawn before returning.

## [3.12.0] - 2026-06-17

### ✨ Added

- **Cockpit decision entries can now include diagrams.** Run `cockpit log --diagram` or `cockpit scribe --diagram` to attach a Mermaid diagram to any decision card. The diagram renders inline as a Night Flight-themed SVG (lazy-loaded; falls back to showing the source text if Mermaid can't render it) and is sanitized through DOMPurify's SVG profile.

### 🐛 Fixed

- **Cockpit auto-logging fork now inherits conversation context.** The thoughtful/scribe guidance was corrected to spawn the auto-log fork with `subagent_type: "fork"` (Codex: `fork_context: true`). Previously, omitting it spawned a context-less fresh agent that had no knowledge of the ongoing session.

## [3.11.0] - 2026-06-16

### ✨ Added

- **Cockpit auto-logging is on by default on Claude Code.** A new `SessionStart` hook turns on thoughtful logging for every Claude session, so the cockpit decision trail fills in as you work — no setup, no per-session toggle. (Codex sessions stay manual: run `/thoughtful` when you want logging.)
- **A new `/thoughtful` command** replaces the old skill, giving you a single, explicit way to opt a session into auto-logging.
- **Global, XDG-aware cockpit config.** Your preferred log language now lives in one place — `~/.config/q-lab/cockpit/config.json` — and is shared across all projects. Set it with `cockpit config --log-language <lang>` and read it back with `cockpit config get-language`.

### 🔄 Changed

- **Cockpit is now one skill instead of three.** The old `cockpit`, `cockpit-scribe`, and `thoughtful` skills are collapsed into a single `cockpit` router skill (`SKILL.md` dispatching to `pilot.md` and `scribe.md`), making the cockpit simpler to reason about and maintain.
- **The needs_your_call / wait / send bridge is preserved** — the UI-to-agent handoff you rely on works exactly as before.

### 🔥 Removed

- **Goal tracking is gone.** Both the per-session goal and the per-project goal have been retired — cockpit now focuses purely on the live decision trail. `project-meta.md` and the `cockpit start` command were removed along with them.
- **Per-project cockpit config** is replaced by the single global `log_language` setting (see above); all other knobs were dropped.

## [3.10.3] - 2026-06-16

### ✨ Added

- **OpenCode sessions now appear in the live dashboard.** The usage dashboard's "Live now" panel discovers recent OpenCode sessions from the local SQLite store, so active OpenCode work shows up alongside Claude and Codex sessions in real time.
- **Cockpit can view OpenCode transcripts.** OpenCode sessions are now fully supported in cockpit — click any live OpenCode session row to open its transcript, powered by the existing DB-backed transcript viewer.
- **Cockpit can send messages to OpenCode.** The cockpit send box is now enabled for reachable OpenCode sessions. A new bridge layer discovers a running `opencode serve` instance (or starts one) and delivers messages via the official `/session/:id/prompt_async` API. Authenticated servers (with `OPENCODE_SERVER_PASSWORD`) and TUI-mode control (via `/tui/append-prompt` + `/tui/submit-prompt`) are both supported.

### 🐛 Fixed

- **OpenCode transcript shows file reads correctly.** `Read` tool parts are now converted into transcript tool-result entries with proper file labels and syntax highlighting inferred from the file path — no more raw JSON blobs in the transcript.
- **Empty OpenCode messages are filtered out.** Assistant rows with no parts or usable fallback content are silently dropped, keeping the cockpit backlog clean.
- **OpenCode deep links work in cockpit.** Cockpit now accepts OpenCode session IDs in `?session=…&provider=opencode` deep links (e.g. from the dashboard "Live now" panel) and validates the provider query param before selecting a session.
- **OpenCode transcript no longer shows internal step metadata.** Step lifecycle events (start/end markers) are hidden from cockpit transcripts; patch parts are rendered as compact changed-file summaries instead of raw diff blobs.
- **OpenCode bridge auth is stable.** A 401 from the bridge now triggers a token refresh and retry. Basic auth headers are forwarded when `OPENCODE_SERVER_PASSWORD` is set. TUI bridge requests are covered by tests.
- **OpenCode sends route to the TUI correctly.** Messages are delivered through the `/tui/append-prompt` + `/tui/submit-prompt` path. Fixed-port TUI processes are discovered while ignoring headless `serve`/`web` backends that aren't visible control targets.
- **OpenCode bridge uses the official prompt API shape.** Delivery was switched from a custom payload to `/session/:id/prompt_async` with `parts`-structured text, matching the documented OpenCode server and SDK interface. Servers are probed via `/global/health`; sessions via `/session/:id`.

## [3.10.2] - 2026-06-16

### ✨ Added

- **Flightplan's plan review is now engine-selectable.** Step 6's review→fix→re-review loop defaults to **Codex** (unchanged) but can now run on **OpenCode** or **Opus**. `review-plan.ts` gained `--engine codex|opencode` (+ `--model` for OpenCode) and a `--print` mode that emits the exact instructions+bundle so all engines share one source of review criteria. The **Opus** engine spawns a **fresh, independent reviewer subagent** for each pass — never the main agent that wrote the plan — preserving the reviewer ≠ author anti-bias split. A missing CLI skips the gate gracefully (exit 0 + warning), same as before.

## [3.10.1] - 2026-06-15

### ✨ Added

- **Autopilot can fly with OpenCode** as its dev engine and/or its cross-vendor review lens, alongside the existing Claude and Codex options. Dev engine (`CFG.devEngine`) and cross-vendor reviewer (`CFG.reviewEngine`) are now **two independent axes** — you can have OpenCode write and Codex review, or any mix. A new `opencode-run.ts` wrapper (the OpenCode counterpart of `codex-run.ts`) drives the `opencode` CLI: `delegate` writes code, `review` runs prompt-enforced read-only (OpenCode has no sandbox read-only, so the wrapper prepends a hard "analyze only" guard). Pick the OpenCode model per role via `CFG.opencodeDevModel` / `CFG.opencodeReviewModel` (default `opencode-go/kimi-k2.7-code` for dev, `opencode-go/qwen3.7-max` for review).

### ♻️ Changed

- **Autopilot's external-engine plumbing generalized** behind an `ENGINES` map, so codex and opencode share one parametrized dev-driver and review-lens path; adding a future engine is a single entry. (Internal to the orchestrator; no change to the Claude default flight.)

### 🐛 Fixed

- **`codex-run.ts` docstring** corrected to match the code — it described the long-removed `-a never` flag and a `git diff --stat` summary, but the wrapper drops `-a never` (codex ≥ 0.139) and prints `git status --short` (so newly-created files show up).

## [relay 0.2.0] - 2026-06-15

_relay is independently versioned; this entry tracks the `relay-v0.2.0` tag._

### 🔄 Changed

- **Consolidated relay's slash commands around the `relay:relay` skill**: removed the standalone `/relay` command — the generic entry is now the `relay:relay` skill, and the three backend aliases (`/relay:codex`, `/relay:opencode`, `/relay:claude`) forward to it via `/relay:relay <backend> …`. One source of truth for the routing logic and fewer command files to keep in sync.

### 🐛 Fixed

- **Relay script path now resolves for installed users**: `SKILL.md` previously hard-coded `bun packages/relay/skills/relay/scripts/relay.ts`, which only exists inside the source repo and broke for anyone running relay as an installed plugin. It now resolves `relay.ts` from the skill's load-time "Base directory for this skill" banner (the repo's `$SKILL_DIR` convention) with a file guard, and documents why `${CLAUDE_PLUGIN_ROOT}` isn't relied on (not reliably set in agent Bash, empty under Codex).

### 📖 Documentation

- **`/relay` → `/relay:relay` throughout**: SKILL.md and the backends reference now consistently use the actual slash entry after the command consolidation.

## [3.10.0] - 2026-06-15

### ✨ Added

- **Relay plugin** — cross-harness task delegation via `/relay <codex|opencode|claude> <delegate|review|image>`. A backend-agnostic mode layer with per-harness backends (claude, codex, opencode), capability-gated dispatch, and a functional superset of odin-codex. Alias shorthand commands (`/relay claude`, `/relay codex`, `/relay opencode`) let you target a specific harness directly without specifying a mode. Relay is independently versioned at 0.1.0 and ships as part of this marketplace release.
- **Custom-file review routing in relay**: reviews can now be directed at specific files rather than always defaulting to the current diff, enabling targeted code review across harnesses.

### 🐛 Fixed

- **Relay backend output parsing** (caught by end-to-end smoke tests): opencode backend switched to `--format json` + `parseJsonl` (was raw-trim on default format); codex backend dropped the `-a` flag removed in codex ≥ 0.139; claude delegate now extracts `.result` from the JSON events array instead of dumping the raw stream.
- **Codex review deduplication**: deduplicate codex review output and improve format selection so repeated findings no longer stack up across review passes.

### 📖 Documentation

- **Autopilot CFG absolute-path requirement**: clarified that `CFG.scratch` and `CFG.log` paths must be absolute (relative paths split the flightlog across different agent `cwd` contexts, breaking the audit trail).

## [3.9.1] - 2026-06-11

### ✨ Added

- **Flightplan artifacts are written in English, with a localized review summary**: PLAN.md, `_context/`, and task files are now an explicit English-by-default execution blueprint (a sub-agent picks them up cold, so English keeps them portable) — the interview can still be held in any language, and writing-topic plans whose deliverable is another language may use it for content samples. At handoff (Step 7), the agent hands back a quick summary in the user's reply language (zh-TW for a zh-TW user) — goal, buckets/task counts, execution order, Known gaps — so you can sanity-check the plan's shape without opening every file.

## [3.9.0] - 2026-06-10

### ✨ Added

- **Autopilot now asks which dev engine to fly with**: before calling Workflow, autopilot prompts you to pick **Claude** (default — Sonnet→Opus) or **Codex** (the OpenAI codex CLI writes each task, Claude judges) instead of silently defaulting to Claude. Picking Codex makes the `codex --version` check load-bearing for every task, with an offer to fall back to Claude if codex is unreachable.
- **`codex-run.ts` wrapper** (in `flightplan/scripts/`): a thin wrapper over the `codex` CLI used by both the codex dev engine and the closing codex review lens. `delegate` runs `codex exec -s workspace-write` and appends a `git status --short`; `review` runs `codex exec -s read-only`. It captures codex's clean last message, prints it, and deletes its own scratch — so the driver reads one deterministic stdout and there is **no temp transcript left to mine**.
- **Flightplan Codex review now iterates to convergence**: Step 6 is a review → fix → re-review loop instead of a single pass. The first pass catches the loud problems; the revised plan then exposes deeper issues, and Codex (non-deterministic) surfaces different findings each run. Floor of 2 cycles, keep going while passes yield material findings, stop when a pass comes back clean, ceiling ~4–5 (remaining items banked as Known gaps).

### 🐛 Fixed

- **Codex dev step no longer fully depends on the odin-codex plugin**: the dev engine and review lens now shell out to the `codex` CLI directly via `codex-run.ts` rather than the `/codex delegate` and `/codex review` skills — only the `codex` binary is required (already version-checked in scouting).
- **No more lingering codex scratch files**: the Haiku driver used to search codex's `/tmp/odin/codex-skill/` output to reconstruct what changed. The wrapper prints the result and cleans up after itself, so there is nothing to search.
- **Correct codex flags + clean exits** (caught by a real end-to-end smoke test): dropped the invalid `-a never` flag (`codex exec` is already non-interactive in current codex), fixed a scratch-dir leak on the error path (cleanup now always runs), and switched the changed-files summary from `git diff --stat` to `git status --short` so newly-created files show up.

## [3.8.0] - 2026-06-10

### ✨ Added

- **Autopilot codex dev engine (`CFG.devEngine`)**: a new opt-in option to delegate each task's dev step to the OpenAI codex CLI. Default stays `'claude'` (Sonnet→Opus). Set `CFG.devEngine: 'codex'` and the dev step becomes a cheap Haiku driver that runs `/codex delegate` (`codex exec -s workspace-write`) so codex writes the implementation, while the verify→judge→score pipeline stays Claude — turning the dev≠judge split into a cross-vendor one. The last attempt before the cap still falls back to Claude-Opus, and if codex is unreachable the driver reports failure rather than fabricating code.

## [3.7.4] - 2026-06-10

### 🐛 Fixed

- **Autopilot inter-wave commits now actually run**: the wave loop called the `odin-git:atomic-commit` skill, but a Workflow agent has no `Agent` tool — the skill's `vör`/`bragi` sub-agents couldn't spawn, and its analysis script (in a different plugin's cache) was unresolvable. The atomic-commit contract — grouping principles + the full commit-message template (emoji/type subject, English body, zh-TW summary) — is now inlined into the orchestrator as a `COMMIT_INSTRUCTIONS` prompt, so each wave commits over plain git.
- **flightplan lint false positive**: the sibling-task-reference check no longer misflags deeper file paths like `src/images/02` or `foo-bar/01` as task references (added a path-aware lookbehind).

### 💄 Polish

- **flightplan self-containment guidance**: lint violations now spell out how to fix them (it's a dependency → `Depends on`; the executor needs it → inline or move to `_context/`), and the task template gains a sharp ❌/✅ on naming the *thing* (the API client, the schema) instead of a sibling task id like `frontend/01`.

## [3.7.3] - 2026-06-09

### ✨ Added

- **OpenCode integration in usage dashboard**: ingest OpenCode sessions and messages from JSON storage (`~/.local/share/opencode/`) and SQLite (`opencode.db`); add OpenCode to the provider filter (All / Claude / Codex / OpenCode); parse token usage and cost data; extend project detail modal and CSV export with OpenCode fields; add color palette and styling for the OpenCode provider.
- **flightplan `review-plan` script**: collects all plan files (PLAN.md, `_context/*.md`, `tasks/**/*.md`) and pipes them to `codex review` for content-quality assessment. Exports `collectPlanFiles()` and `buildReviewPrompt()` as pure functions. SKILL.md updated to document Step 6: mandatory Codex review gate after lint passes.

### 🐛 Fixed

- **OpenCode zero-cost fallback**: preserve absent recorded costs so the pricing fallback can run; use recorded costs only when greater than zero; cover mixed recorded-and-computed cost aggregation.

## [3.7.2] - 2026-06-03

### ✨ Added

- **Autopilot commits as it flies**: autopilot now runs as a true wave loop and makes an atomic commit between waves, plus a closing commit after the final review. Instead of one giant end-of-run diff, a flight leaves a clean, reviewable per-wave history — and the final-review lenses diff against the captured base ref, so they see every committed task change rather than an empty working tree.

### 💄 Polish

- **Cockpit decision cards refresh**: refined decision-card styling and source-badge presentation in the cockpit decision trail, so kind and origin read more clearly at a glance.

### 📖 Docs

- **Dispatch README + flow diagram updated**: the README and the dispatch-flow SVG now document autopilot's wave loop and its inter-wave / post-loop atomic commits.

## [3.7.1] - 2026-06-02

### 💄 Polish

- **Thoughtful logging now uses all four lenses**: in practice `/thoughtful` and `cockpit-scribe` were biasing toward `decision` entries, so `rationale`, `learning`, and `caveat` rarely showed up in the decision trail. The scribe now sweeps all four lenses before writing, treats `learning`/`caveat` as first-class (not consolation prizes for when there's no decision), and dedups across lenses instead of collapsing to a single entry — so the trail reflects the full reasoning, not just the choices made.

## [3.7.0] - 2026-06-02

### ✨ Added

- **Cockpit "thoughtful" auto-logging mode**: a new opt-in mode that keeps the cockpit decision trail flowing without manual logging. Turn it on with `/thoughtful` and the main agent will, at natural decision points, fork a lightweight background `cockpit-scribe` pass that captures what was decided and why — keeping you in the loop with minimal ceremony and zero blocking of the work in progress.
- **`cockpit-scribe` skill**: the background scribe that powers thoughtful mode. It gathers `diff` and diff-vs-branch context, dedupes against recent entries before writing, and records high-signal, typed decision entries asynchronously so the main agent never stalls.
- **`cockpit scribe` CLI + typed decision records**: a new `cockpit scribe` subcommand logs decision records with a `kind` (decision / rationale / learning / caveat) and `source: scribe`, auto-registers the session on first write, supports a `--recent` flag for dedup lookups, and adds a concurrency-safe persistence guard. The `DecisionRecord` schema stays backward compatible — `kind` and `source` are optional.

### 💄 Polish

- **Decision-card kind badges + scribe source indicator**: cockpit decision cards now show per-kind accent badges (decision / rationale / learning / caveat) and a distinct visual marker for auto-logged (scribe) entries, so you can tell at a glance what each entry is and where it came from. The empty-state CTA now points to `/thoughtful` for the automated logging mode.

## [3.6.5] - 2026-06-02

### 💄 Polish

- **Token Atlas model colors**: Claude Haiku, Sonnet, and Opus now use distinct, stable colors across charts, legends, toggles, and ledger markers, making model mix easier to scan at a glance.

## [3.6.4] - 2026-06-02

### ✨ Added

- **autopilot — closing multi-lens Final review**: the Final-review round now fans out 5 parallel reviewers — `codex /codex review` for cross-vendor bug review plus the four `/simplify` lenses (reuse / simplification / efficiency / altitude) — each writing independent findings to `.flightlog/review/`, after which an Opus fixer applies them. The round re-loops until clean, bounded by a default of 2 attempts.
- **flightplan — `mark-done.ts`**: a deterministic done-transition that sets a task's `Status: done` and ticks every checkbox in its `## Acceptance criteria` and `## Verification` sections when the task passes. autopilot now uses it instead of editing status by hand.
- **flightplan — `next-ready.ts --json` mode**: the scout can now emit structured JSON (`[{ref,finalReview}]`, or `[]` when nothing is ready) so a per-wave run can't misread empty output as "everything ready", and it surfaces the `finalReview` flag per task.

## [3.6.3] - 2026-06-02

### Fixed

- **autopilot**: the orchestrator now bakes its config (slug, paths, scriptsDir, plan goal) into a CFG literal block instead of relying on the Workflow `args` global, which didn't reach the script — previously the scout ran `bun undefined/next-ready.ts` and the run silently completed with no work done. Scout failures now escalate instead of breaking silently.

## [3.6.2] - 2026-06-02

### Fixed

- **autopilot**: corrected the flightplan scripts path in SKILL.md — it used `${CLAUDE_PLUGIN_ROOT}/../flightplan/scripts/` (which resolved outside the installed plugin) instead of `${CLAUDE_PLUGIN_ROOT}/skills/flightplan/scripts/`, so the scout step (next-ready.ts) and flightlog report failed to locate the scripts.

## [3.6.1] - 2026-06-02

### 📝 Documentation

- **Dispatch plugin is now fully English**: the rubric system (dimensions, pass-line phrasing, table headers), reference templates, SKILL docs, test fixtures, and the dispatch-flow diagram were translated from Chinese. No behavior change, all tests green.

## [3.6.0] - 2026-06-02

### ✨ Added

- **Dispatch `autopilot` skill — fly a flightplan task tree end to end**: autopilot takes a blueprint written by flightplan (`PLAN.md` + a `tasks/` tree) and executes it with a multi-agent Workflow. A wave-loop scout finds every ready task, runs them in parallel, and drives each one through a dev → verify → judge → score quality gate that retries until the task's own acceptance criteria and rubric pass — grounding correctness on real verification evidence rather than vibe. Blocked tasks park and continue once you unblock them, and the closing **final-review** task gates the whole tree before ship.
- **Flightlog audit layer**: every autopilot verdict is now recorded to a self-gitignored audit trail under `docs/<slug>/.flightlog/` (created automatically, never committed). `flightlog.ts` provides `log` (agent narratives) and `report` (a `RUNLOG.md` summary), and `score-task --log` persists rubric verdicts deterministically into the trail.
- **Final-review closing gate for flightplan**: each plan must end with one task marked `Final review: true` whose transitive `Depends on` reaches every other task, so the whole tree is gated before a final review can begin. lint-task enforces this at the tree level (single-task plans are exempt; cherry-picked files skip the check).

### 📝 Documentation

- **Dispatch registered and documented in the README**: the README now covers the full dispatch pipeline (preflight → flightplan → autopilot → final review → ship) with a three-skill overview and installation instructions for both Claude Code and Codex. The `dispatch-flow.svg` pipeline diagram moved into a shared `assets/` directory.

## [3.5.3] - 2026-05-29

### 📝 Documentation

- **Install command examples use explicit Bash expansion**: the install skill's documentation now uses `${CLAUDE_PLUGIN_ROOT}` instead of `$CLAUDE_PLUGIN_ROOT` across all code examples, for clearer and more defensive variable expansion.

## [3.5.2] - 2026-05-28

### ✨ Added

- **Token Atlas window navigation**: the usage dashboard now supports movable rolling usage windows. A floating side control panel and a bottom range pill let you pan the visible period forward and backward. Keyboard navigation (arrow keys) is supported with synchronized droplet motion on the timeline.

### 🐛 Fixed

- **Atlas window navigation hardened**: window offsets are reset when switching providers, range bounds are now provider-aware for sparse daily data, provider ledger bounds are cached for reliable keyboard navigation, global event listeners are cleaned up on unmount, and duplicate range pill hover styles are removed.

### 💄 Polish

- **Atlas navigator glass preserved on disabled state**: floating navigator buttons retain their glass styling when disabled (at the boundary of available data).
- **Atlas navigator buttons positioned farther out**: floating side controls are tucked further outside the chart area to reduce overlap with content.

## [3.5.1] - 2026-05-27

### ✨ Added

- **Token Atlas "Last 24 hours" range**: the usage dashboard now offers a rolling 24-hour view alongside the existing ranges. Its overview cards, model mix, heatmap, and the previous-period comparison are all aggregated over the same rolling window.
- **Hourly trend chart for the 24h range**: when "Last 24 hours" is active, the trend chart breaks down into 24 hourly buckets (with hourly chart title and aria labels), so you can see usage shape across the day instead of a single daily total.
- **Cockpit "jump to latest" controls**: live transcript and decision-log panes now show a floating jump-to-bottom control when new content arrives while you're scrolled away, with a CRT-style reveal animation. One shared pinned threshold keeps both columns consistent.

### 🐛 Fixed

- **Atlas 24h totals now agree across the page**: overview tokens, cost, model totals, and the trend chart are all built from the same hourly usage buckets, so the summary cards and the chart no longer disagree. Session, message, and tool-call counts stay deduped from the rolling ledger window.
- **Codex hourly usage matches thread totals**: Codex token-count events are now stored as cumulative snapshots and hourly buckets are derived from adjacent deltas, so the hourly trend sums to the same token semantics as the thread totals.
- **No more double-minus deltas**: summary delta percentages are formatted from absolute values with the sign driven only by direction, fixing the doubled negative sign on declines.
- **Atlas auto-refresh stays recoverable**: stats and live fetches now have timeouts, overlapping live polls no longer stack up, and stats refresh immediately when the tab returns to the foreground — so a stalled fetch no longer wedges the dashboard.
- **Cockpit active-project / active-session counts**: the manifest readout now counts only projects and sessions that are actually active, so ended sessions no longer inflate the displayed flight count.

### 💄 Polish

- **Cockpit mobile layout**: on narrow screens the decision log sits above the live transcript, stays compact by default so the latest card is visible, and expands to half the viewport after you scroll or touch it.
- **Cockpit dashboard refinements**: stabilized Atlas selected-project cards (non-layout corner indicator + inset rings), aligned instrument header heights, enlarged and clarified project-rail carets, made the whole projects bar a toggle target, simplified session rows, and moved the send box under the Live Transcript column.

### 📝 Documentation

- **Cockpit backlog & enhancement roadmap** added (`packages/monitor/skills/cockpit/BACKLOG.md`): `@`-file mentions in the send box, a skill-list panel, spawning new sessions from cockpit, and a note on slash-command constraints — captured from Permission Relay testing.

## [3.5.0] - 2026-05-27

### ✨ Added

- **Permission Relay — answer permission prompts from the cockpit**: when a running Claude Code session hits a tool-permission prompt (e.g. "Allow this Bash command?"), the cockpit dashboard now surfaces it as a modal with **Allow / Deny** buttons, so you can decide right there in the windshield without switching back to the terminal. The verdict is relayed back to the running session through the cockpit channel.
  - A new **permission broker** in the cockpit daemon fans inbound permission requests out to the UI and rounds the verdict back to the waiting session.
  - The cockpit channel carries the permission prompts inbound and the Allow/Deny verdicts outbound.
  - The permission modal **auto-dismisses on a TTL** so a stale prompt doesn't linger after the session has moved on.
- **Attention cues for permission prompts**: a new attention module raises a **browser notification**, **flashes the tab title**, and **badges the favicon** when a permission prompt is waiting, so you notice it even when the cockpit tab is in the background.

### 🐛 Fixed

- **Ghost permission modals and a wedged relay**: rapid or superseded permission prompts could leave a "ghost" modal hanging and deadlock the relay. The channel now aborts the prior in-flight pull when a new request arrives and enforces a bounded pull budget; the daemon supersedes the old pending request and resolves it from transcript progress, waking the parked pull with `{abandoned: true}`; and a proactive expiry timer sweeps orphaned watchers.

### 📝 Documentation

- **Permission Relay feature spec + task system** added under `docs/permission-relay/` (PLAN, layered backend/channel/UI tasks, shared context, and the wire protocol), with live findings recorded and tasks marked done.
- **`<plugin-root>` resolution clarified**: it must be derived from the skill's load-time base-directory banner, not the `${CLAUDE_PLUGIN_ROOT}` env var (which is never available in shell commands).

## [3.4.5] - 2026-05-27

### ♻️ Internal

- **The cockpit channel no longer force-starts the usage dashboard**: the channel MCP server now ensures only the cockpit daemon (its real dependency — it owns `/api/inbox`), not the 5938 usage dashboard. The dashboard is independent of the channel and is started on demand by its own skill, so a channel-flagged session no longer spins up a dashboard server the user may not want.

### 💄 Polish

- **Re-running a server now always opens the browser**: both the cockpit daemon and the usage dashboard open the browser on reuse (an already-running instance), not just on a fresh start — so re-invoking the skill reliably lands you on the page even when the daemon was started headless (e.g. by the channel MCP). Honors `--no-open`.

### 📝 Documentation

- **Skills reframed as "ensure + open"** and a dev note added for running an isolated daemon (`--port` + `COCKPIT_HOME`) when a live channel session is respawning the cached daemon.

## [3.4.3] - 2026-05-27

### 🐛 Bug Fixes

- **Cockpit dashboard crashes when stepping between sessions**: the channel send form used `<template v-else>` / `<template v-if>` siblings, which made petite-vue throw `insertBefore: s is null` (and a downstream TDZ on `s`) while re-rendering, blanking the cockpit. The conditionals are now flattened to sibling elements each carrying an independent `v-if` (`!channelNeedsRelaunch`), so the send form and relaunch hint render without the template-block crash.

## [3.4.2] - 2026-05-27

### 🐛 Bug Fixes

- **Cockpit send box stays disabled even when launched with the channel flag**: the channel server was resolving its own session id by guessing the newest-mtime transcript in the project — a guess latched once at MCP startup that races sibling sessions in the same project, so it would silently poll the wrong session's inbox and the real session never lit up (`channel: false`). It now resolves the id authoritatively by walking ancestor pids to `~/.claude/sessions/<pid>.json` (keyed by the Claude CLI pid that spawned the channel), falling back to the mtime guess only when no session file matches.

## [3.4.1] - 2026-05-27

### ♻️ Internal

- **The cockpit-channel is now packaged in the plugin manifest**: instead of a hand-written `~/.claude.json` entry, the cockpit-channel MCP server is declared directly in `.claude-plugin/plugin.json` (`mcpServers` + `channels`), so it ships with the plugin and registers automatically. `monitor-up.ts` now references the packaged channel via `plugin:monitor@q-lab-marketplace` rather than `server:cockpit-channel`.
- **`monitor:install` no longer fresh-wires the channel**: the install/setup flow only cleans up stale hand-wired channel entries left by older versions, never registering the channel itself (the manifest handles that now). The `--apply-channel` flag was removed; `--apply` now covers statusline wiring plus stale-channel cleanup.

### 📝 Documentation

- **Updated install skill docs and tests** to reflect the manifest-packaged channel and the cleanup-only install flow.

## [3.4.0] - 2026-05-27

### ✨ New Features

- **Send cockpit messages to Codex sessions, not just Claude**: the cockpit send box now works for Codex too — messages start a real Codex turn through the managed remote-control socket (falling back to direct app-server mode when needed), so Codex is no longer observe-only. The box is gated on a real resume-readiness probe, so it only lights up when the session can actually receive a message.
- **Relaunch hint for sessions missing a live channel**: when a Claude session lacks a cockpit channel attachment, the dashboard now shows a copyable relaunch command (with the right channel flags) in place of the send form — one click to copy, with a brief "Copied" confirmation — so you can reconnect a stranded session.
- **Self-healing install paths**: `monitor:install` now treats a config as "wired" only when it points at the *exact* current plugin version path, so version drift (old cache dirs like `monitor/3.1.0/…` lingering after an update) is detected and re-pointed. A `SessionStart` hook runs a marker-gated `--session-check` once per version to silently re-point drift, or nudge a fresh install to run `/monitor:install` — it never fresh-wires, so initial opt-in stays manual. Adds `setup.ts --migrate` to re-point drift on demand.

### 🐛 Bug Fixes

- **Codex turns no longer get cut off**: cockpit now waits for turn completion before closing the app-server transport, routes active threads through turn/steer with the expected turn id, and acknowledges sends after submit instead of blocking on completion — so messages aren't dropped, resubmitted, or left hanging.

### ♻️ Internal

- **Install logic consolidated into a dedicated `install` skill**: `install.ts`, `setup-statusline.ts`, and `statusline-decision.ts` moved out of usage-dashboard into a new `install` skill with a unified `setup.ts` entry point that checks both skills and wires both configs (cockpit-channel MCP + statusline collector). Tests consolidated to remove duplication.
- **Codex control probe** added for the remote-control send path, kept separate from the runtime send.

### 📝 Documentation

- **Updated cockpit docs** to reflect that `send` now supports both Claude (via the channel MCP) and Codex (via managed remote-control), with setup notes and readiness gating. Removed completed spike/task-planning docs for the cockpit-channel and Codex-control work.

## [3.3.0] - 2026-05-26

### ✨ New Features

- **Talk to a running session straight from the cockpit dashboard**: the Decision Log column now ends in a send box, so you can drop a note or steer the agent without leaving the cockpit. The agent's replies show up inline in the live transcript — one place to watch and one place to type.

### 🐛 Bug Fixes

- **The cockpit send box no longer flickers**: channel presence is now held across the gaps between inbox polls (a short TTL window) instead of dropping to "no channel" for a beat, so the send box stays put rather than blinking in and out while a session is connected.

### ♻️ Internal

- **The live transcript is now the single source for agent→UI output**: the separate channel reply tool and its SSE fan-out / ticket-auth subsystem were retired. Agents write to the session log directly and the dashboard reads the transcript, removing a whole duplicate path and the reply strip that went with it.

### 📝 Documentation

- **Clearer `needs_your_call` guidance**: the cockpit skill now states that autonomous decision-making is the default and `needs_your_call` is reserved for genuine forks only you can settle — with a caution against turning every decision into a question (which buries the reasoning trail).

## [3.2.0] - 2026-05-26

### ✨ New Features

- **Cockpit reads each session's live status at a glance**: sessions now surface a fine-grained live state (working, waiting on you, idle, …) rendered as LED variants, a status pill, and a breathing activity bar — so a quick look tells you what every session is actually doing, not just "busy / idle".
- **The "⊕ N agents" badge now counts live sub-agent delegations — for both Claude and Codex**: cockpit detects in-flight Agent/Task delegations and shows how many are running. Claude is read from the sub-agent sidechain transcript; Codex from its spawn-edge table, cross-checked against each child's completion so finished delegations drop off.
- **Answer a `needs_your_call` straight from chat**: if you reply in the agent UI/chat while a session is parked on a `needs_your_call`, that message is now recorded as the answer through the cockpit bridge and the card is closed — no need to repeat it in the dashboard.

### 🐛 Bug Fixes

- **Codex sub-agent threads no longer masquerade as separate sessions**: spawned child threads are excluded from the live rail and the session picker, so a delegation counts only under its parent's badge instead of cluttering the list.

### ♻️ Internal

- **Shared Codex DB helpers**: access to Codex's `state_5.sqlite` (spawn-edge filtering and friends) was extracted into one module reused by live-sessions, find-session, and the delegation counter.

## [3.1.0] - 2026-05-25

### ✨ New Features

- **Decision cards now carry self-labeled reasoning "facets"**: A new repeatable `--facet "LABEL: text"` flag on `cockpit log` lets you attach distinct reasoning dimensions to a decision (e.g. `REJECTED`, `CONSTRAINT`, `ASSUMPTION`, `RISK`, `PRIOR-ART`). Each facet renders in the dashboard as a labeled instrument chip with a type glyph, so the *why* behind a call is captured alongside the call itself.

### 💄 Polish

- **The decision log is now a "flight path"**: Decisions are laid out along a vertical aurora route, each with its own waypoint node — cool for autopilot, warm-pulse for `needs_your_call`, green for resolved — making the shape of a session readable at a glance.
- **Plain autopilot decisions get a "lit readout" card**: Routine autopilot entries now render on a calm light-purple surface, visually distinct from the warmer `needs_your_call` cards.

## [3.0.1] - 2026-05-25

### 🐛 Bug Fixes

- **Cockpit `needs_your_call` answers no longer cross-talk between cards**: Each wait is now bound to its specific call, so answering one decision card can never wake a wait parked on a different (stale) card. Only the latest open call is ever active — answering an older, superseded call no longer reopens it.
- **Stale cockpit daemon paths resolved after a plugin move or update**: The daemon now records where it was launched from and only reuses an existing daemon when the paths match; a moved or updated install supersedes the old one instead of serving stale files (404 static, 200 API).
- **`cockpit log` verifies entries persisted**: A read-back guard catches silent drops so logged decisions are durable.

### ♻️ Internal

- **usage-dashboard internals refactored into testable pure modules**: The filesystem/network-bound scripts now delegate their logic (billing dedup, per-project cost, daily activity merge, live-session enrichment, statusline decisions) to pure modules. Behavior is unchanged, verified end-to-end.
- **usage-dashboard now has a test suite (0 → 56 tests)**: Covers the newly extracted modules plus `api.ts` helpers (cost, token/key/date math), bringing the full monitor suite to 167 passing.

## [3.0.0] - 2026-05-24

### ⚠️ Breaking

- **Token Atlas and Cockpit are now one plugin: `monitor`**: The two separate plugins have merged into a single `monitor` plugin that ships both as skills (`usage-dashboard` + `cockpit`). **You must reinstall** — remove the old `token-atlas` and `cockpit` plugins, then install `monitor@q-lab-marketplace` (Claude Code) / `monitor@q-lab-marketplace` (Codex). One install, one version line, one marketplace card.
- **Skill rename**: `dashboard` → `usage-dashboard`. Invocation namespaces are now `monitor:usage-dashboard` and `monitor:cockpit`; the in-skill trigger phrases (e.g. `/token-atlas`, `/cockpit`) still work.

### ♻️ Internal

- **Both skills now ship to Codex**: previously only Cockpit was on the Codex marketplace; `monitor` exposes both skills (`skills: "./skills/"` auto-discovers them). The `usage-dashboard` skill's run paths were made runtime-neutral (`<plugin-root>`) so they resolve under Codex as well as Claude Code.
- **Packaging-only merge**: the two web servers stay independent (usage-dashboard on 5938, cockpit daemon on 5858) — no runtime/daemon merge in this release.

## [2.6.1] - 2026-05-24

### 💄 Polish

- **The "Live now" cockpit-down notice points at the command**: When Cockpit's daemon isn't running, Token Atlas now tells you to run `/cockpit` to start it, instead of a raw port hint.

## [2.6.0] - 2026-05-24

### ✨ New Features

- **Cockpit is the single live transcript view**: Token Atlas's "Live now" rows now open the running session straight in Cockpit (deep-linked by URL) instead of rendering a transcript in-app, and Cockpit can open any running session — tracked or not. One transcript renderer, no drift between the two dashboards.
- **Live sessions across every project in the Cockpit manifest**: The manifest mirrors what's actually running (from `~/.claude/sessions` and the Codex state DB), so genuinely-live sessions show up even from projects you never ran `/cockpit` in; sessions without a goal trail appear as "untracked".
- **Session prev/next navigator**: The Cockpit manifest bar's ‹ › are now real controls that step the selection through active sessions (wrapping, cross-project), with keyboard ←/→ support and a "2 / 3" position readout.
- **Know which sessions are worth opening in Cockpit**: Token Atlas tags live sessions that already have a Cockpit decision trail with a "cockpit" badge, and flags when the Cockpit daemon isn't running so clicking a row never opens a dead tab.
- **A `/cockpit` invite for untracked sessions**: Opening a session Cockpit isn't tracking now shows a gentle Decision Log card inviting you to run `/cockpit` and start a trail, instead of a blank "No decisions logged yet."
- **Scroll-to-top history in the Cockpit transcript**: The live transcript reverse-paginates older entries as you scroll up, keeping the viewport anchored where you were reading.
- **Subagent notifications read as their own role**: Agent and task completion messages render with a distinct subagent role and accent instead of looking like one of your own messages.

### 🐛 Bug Fixes

- **Live rows open Cockpit's real port**: Token Atlas opens transcripts on the port Cockpit actually bound (read from `daemon.json`) rather than a hardcoded 5858, so a Cockpit started on a custom `--port` no longer opens a dead tab.
- **Wide code no longer overflows the transcript**: Long single-line JSON and code blocks scroll within their column instead of spilling past it and being clipped.
- **Diff lines wrap again**: Long diff lines soft-wrap in the Cockpit transcript instead of widening the column and clipping the +/- gutter.

### 💄 Polish

- **Cockpit dashboard aligned to the Night Flight design system**: the untracked-session invite drops the reserved nebula color for a tonal card with an aurora accent, the navigator arrows use an on-scale radius and the standard ease-out curve, and em dashes were removed from UI copy.

### ♻️ Internal

- **Distinct dashboard server filenames**: Cockpit's and Token Atlas's servers were renamed to `cockpit-server.ts` and `atlas-server.ts`, so a `pkill -f "serve-dashboard.ts"` can no longer take down both daemons at once.

### 📝 Documentation

- **`/cockpit-start` is now `/cockpit`**: the cockpit skill's invocation was shortened.
- **Marketplace docs cover both plugins**: CLAUDE.md now describes Token Atlas and Cockpit as siblings, documents the dynamic Cockpit port, and corrects the release process to the three version files that must be bumped together.

## [2.5.1] - 2026-05-24

### 🐛 Bug Fixes

- **No more missed Cockpit call answers on cold start**: The broker now stashes a `needs_your_call` answer that arrives before the agent has parked its wait, so responses sent during the startup race are delivered instead of lost. Stashed answers are single-use and time-bounded so they can't leak into an unrelated later call.
- **Hero stays raised while you're being asked**: The cockpit hero viewport no longer collapses while a session is awaiting your input — it holds open on an open `needs_your_call`, stays raised for a 60-second grace period after you answer, and skips viewport moves during backlog replay so it only reacts to live activity.

### ⚡ Performance

- **Faster Cockpit dashboard loads**: Registry log files are now read with a bounded 64KB head instead of being slurped whole, and each project's goal metadata is read once per build (cached across sessions and projects) instead of repeatedly — cutting redundant file I/O on busy projects.

### ♻️ Internal

- **Shared HTTP response helpers**: Duplicate `jsonResponse()` / `jsonError()` helpers across the broker, project-info, dashboard server, and SSE tailer were consolidated into a single `http.ts` module.

### 📝 Documentation

- **Lighter Cockpit terminology**: Dropped the "windshield" metaphor from the cockpit skill docs in favor of plainer "heading" / "cockpit" wording.

## [2.5.0] - 2026-05-24

### ✨ New Features

- **Resilient Cockpit live streams**: The log and transcript SSE streams now share a watch-first, poll-backed tailer that waits for a not-yet-created file instead of dead-ending on a 404, falls back to polling when `fs.watch` never fires, and re-binds watchers after atomic file replacement (inode change) — no more blank or stale live panels.
- **Authoritative Cockpit session resolution**: Session lookup now trusts the live `CLAUDE_CODE_SESSION_ID` first and only falls back to the most-recently-modified transcript when it's absent, so decisions are no longer misfiled to a stale or concurrent session. `cockpit log` auto-resolves the current session when `--session` is omitted.

### 🐛 Bug Fixes

- **No duplicate call responses**: A `needs_your_call` card is marked resolved immediately after a successful dashboard response, and the Send control stays disabled to guard against duplicate click or Enter submits.

## [2.4.4] - 2026-05-24

### ✨ New Features

- **Safer Cockpit call responses**: `needs_your_call` options now select first instead of sending immediately, so the final answer is only delivered when Send is pressed.
- **Additional instructions field**: Replaced the custom-answer input with a one-line auto-growing textarea, allowing `Shift+Enter` line breaks and optional comments to be sent alongside a selected option.

> Token Atlas runtime is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.4.

## [2.4.3] - 2026-05-24

### 📝 Documentation

- **Marketplace README refresh**: Clarified the positioning of Token Atlas as the usage-history view and Cockpit as the active-session control surface, and tightened install notes for the current Claude Code and Codex marketplace entries.
- **Demo dashboard previews**: Replaced README screenshots with demo/fake-data previews for both plugins, so the above-the-fold screenshots show key features without exposing local usage traces.
- **Sharper preview assets**: Switched dashboard previews to PNG assets to keep UI text, labels, and fine lines crisp in README rendering.

> Runtime behavior is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.3.

## [2.4.2] - 2026-05-24

### 📝 Documentation

- **Cockpit needs-your-call guidance**: Clarified that when a Cockpit session is already running, any workflow that needs to ask the user should route that question through `needs_your_call` and wait for the cockpit answer.
- **Shared user-facing wording**: Generalized Cockpit and Token Atlas product/skill wording from project-specific operator language to neutral `user` / `users` wording, while preserving author metadata, marketplace ids, install commands, and task-history docs.

> Token Atlas runtime is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.2.

## [2.4.1] - 2026-05-24

### ✨ New Features

- **Cockpit Design System panel**: Added a dedicated dashboard panel for the Cockpit design system so `DESIGN.md` renders as its own focused reference surface instead of being buried in Project Info.
- **Faster-feeling hero animation**: Increased the hero starfield density, added more visible star variants and gradient trails, lengthened the tails, and kept the moving beacon following the warped vanishing point for a stronger cockpit-in-motion feel.
- **Automatic hero quieting**: The Cockpit hero now auto-collapses after 60 seconds and pauses the starfield animation, while still allowing manual reopening.

### 💄 Improvements

- **Cleaner dashboard chrome**: Removed the Project Info panel and flight-row toggle now that the Design System panel owns the design reference workflow.
- **Quieter default panels**: `CLAUDE.md` and `AGENTS.md` Project Info sections now start collapsed by default when that legacy data path is used.

### 🐛 Bug Fixes

- **Clearer Design panel route failures**: The dashboard now distinguishes an unavailable design-system route from a missing design file, making stale daemon restarts easier to diagnose.

> Token Atlas is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.1.

## [2.4.0] - 2026-05-24

### ✨ New Features

- **New plugin: cockpit**: A new marketplace plugin that gives each project a live mission-control view of your coding agents. Capture a per-project goal and a running decision log behind a `/cockpit-start` human gate, then watch live transcripts, decisions, and "needs your call" prompts as your agents work — with respond-from-the-dashboard buttons that send your answer straight back to the waiting session.
- **Claude Code and Codex sessions side by side**: Cockpit discovers and streams both Claude Code and Codex sessions, with provider badges and per-provider transcript streaming so you can supervise mixed-agent work from one dashboard.
- **Per-project decision-log language**: `cockpit start` accepts a `--log-language` flag (asked for at start) so each project's decision trail can be recorded in your preferred language; the setting persists across re-runs.
- **Project Info modal**: View a project's goal, metadata, `CLAUDE.md`, `AGENTS.md`, and `DESIGN.md` design tokens in a modal triggered from the project rail, with path-confined reads of the assistant instruction files.

### 🎨 Design

- **"Night Flight" deep-space flight deck**: Cockpit ships a distinctive deep-space dashboard — a HUD viewport with a forward warp starfield, rotating destination beacon, leader callouts, collapsible projects manifest, and screen-styled instrument panels for the live transcript and decision log. Deep-space OKLCH palette with a cool aurora navigation accent and a warm signal reserve held back for "needs your call" dock alerts.

### 🐛 Bug Fixes

- **Non-destructive start**: Re-running `cockpit start` on an existing session now refreshes only the leading goal record and preserves the full decision/response trail instead of wiping it.
- **Robust wait/send bridge**: The wait/send commands now surface daemon errors (bad token, invalid session) instead of misreporting, fail fast on repeated stale-daemon connection failures, keep long-polls and SSE streams alive under the daemon idle timeout, and no longer kill a foreign process holding the port.
- **Stable decision-log dedupe**: Decision-log cards are deduped by durable record id (content-based fallback for legacy logs) so EventSource reconnects no longer re-render the backlog as duplicates, and relative timestamps refresh periodically instead of freezing.
- **Hardened security**: `CLAUDE.md` reads are confined to the exact project-root path, rejecting symlinks that resolve elsewhere inside the project.

### 📝 Documentation

- **Provider-neutral cockpit skill**: Refactored the cockpit skill into a shared, provider-neutral core with deltas-only `claude.md` / `codex.md` references (plugin-root resolution, find-session command, wait policy), documented the dashboard daemon lifecycle and a session-id discovery helper, and added Codex marketplace + install documentation.

> Token Atlas is unchanged in this release; the version bump unifies all marketplace plugins at 2.4.0.

## [2.3.4] - 2026-05-23

### 💄 Improvements

- **Larger live transcript text**: Bumped the streamed conversation prose to a larger font size for more comfortable reading of live transcripts.

### 📝 Documentation

- **Token Atlas design system reference**: Documented the Sunrise Atlas design language as a `DESIGN.md` color/typography spec and a machine-readable `DESIGN.json` token set (tonal ramps and color metadata) for the dashboard skill.

## [2.3.3] - 2026-05-23

### 🐛 Bug Fixes

- **Live transcript layout for wide content**: Wide blocks like tables and code blocks in the live transcript now scroll horizontally within their chat bubble instead of bursting out of the panel, and tool-segment entries line up cleanly with regular assistant and user messages.

## [2.3.2] - 2026-05-22

### 🐛 Bug Fixes

- **Live diff wrapping**: Long lines in live file diffs now soft-wrap inside the diff block instead of clipping or overflowing the panel, so wide edits stay fully readable.

## [2.3.1] - 2026-05-22

### 🐛 Bug Fixes

- **Version sync**: Bumped the plugin manifest (`plugin.json`) to match the marketplace version, which was missed in the 2.3.0 release so the marketplace and the installed plugin reported different versions.

### 📝 Documentation

- Updated the README and project guide to reflect Codex live sessions, GFM Markdown rendering, syntax highlighting, and inline file diffs, and documented that both version files must be bumped together on release.

## [2.3.0] - 2026-05-22

### ✨ New Features

- **Codex live sessions**: The Live now panel now surfaces your active Codex threads alongside Claude sessions, with click-to-open transcripts that stream Codex messages, tool calls, and results in the same modal.
- **Live file diffs**: File edits now appear inline in the live transcript as collapsible, color-coded diff views — Codex `apply_patch` edits and Claude Edit / MultiEdit / Write calls render with a unified, aligned format that highlights added, removed, and context lines for quick scanning.
- **Richer transcript rendering**: Live Markdown is now rendered with a proper Markdown engine and sanitized for safety, adding GFM tables, more heading levels, and safer external links. Code blocks in transcripts and tool output now get syntax highlighting based on the detected language.

### 🔧 Improvements

- **Consistent tool-block styling**: Claude and Codex tool calls and results now share the same visual treatment, so the live transcript reads consistently regardless of which assistant produced it.
- **Cleaner transcript layout**: Messages now read as conversation bubbles with larger, more readable text, while tool and result blocks stay visually distinct and collapse by default to cut noise. File-change blocks default to expanded for visibility.
- **Cleaner notification cards**: Claude task notifications and Codex subagent notifications now render as compact result cards instead of raw XML or JSON, hiding internal ids and metadata.

### 🐛 Bug Fixes

- **No more duplicate Codex messages**: Fixed Codex assistant and tool messages showing up twice in the live transcript by using a single display source.
- **Stable diff layout**: Fixed live diffs overflowing the modal or stretching too wide, and tightened spacing so blank diff rows no longer look oversized — long lines now scroll inside the diff block.
- **More robust live parsing**: Hardened transcript parsing so escaped entities stay literal, vanished session files are skipped gracefully, and active Codex sessions sort ahead of idle ones.

## [2.2.0] - 2026-05-22

### ✨ New Features

- **Live now panel**: A new dashboard panel surfaces your currently active Claude sessions with live status dots, project names, and relative timestamps, refreshing automatically as sessions come and go.
- **Live transcript modal**: Click any live session to open a streaming transcript that follows along in real time — backed by a server-sent-events stream that tails the session as it's written.
- **Reverse-scroll history**: Scroll to the top of a live transcript to load earlier messages on demand, paging backward through the session without loading the whole file at once.
- **Rich transcript rendering**: Transcript entries render as Markdown prose with collapsible code blocks for tool calls, results, and JSON, plus clear role labels and styled thinking blocks for terminal-style readability.

### 🔧 Improvements

- **Faster live polling**: Transcript indexing now uses a short-lived cache and incremental file reads instead of rescanning the full session tree on every poll, with hidden-tab updates skipped to save work.
- **Smarter auto-scroll**: The transcript modal only auto-scrolls when you're pinned to the bottom, so reading earlier messages no longer yanks you back down.
- **Quieter reconnects**: Brief stream disconnections stay silent — errors only surface after 15 seconds — and retry state clears cleanly when the stream recovers.
- **Better accessibility & layout**: Live transcript styling adds focus-visible outlines for keyboard navigation, active-state feedback, and an improved responsive grid.

### 🐛 Bug Fixes

- **Transcript deduplication & pairing**: Fixed dropped text and tool-use blocks that shared an identity key, paired tool results back into their originating tool calls for clean terminal-style output, and capped blockquote nesting to prevent overflow on deeply nested quotes.

## [2.1.1] - 2026-05-21

### ✨ New Features

- **Hero wave settles into calm**: The animated hero wave now gently eases to a gentle stop after 60 seconds of inactivity, using a smooth quintic decay so the dashboard relaxes into a restful state instead of looping forever. Fully respects `prefers-reduced-motion`.

## [2.1.0] - 2026-05-21

### ✨ New Features

- **Live usage-limits panel**: New dashboard panel that surfaces your real-time quota windows so you can see how close you are to hitting limits at a glance.
- **Claude rate limits from the statusline**: Token Atlas now reads your Claude Code rate limits via a lightweight statusline collector and shows your 5-hour and weekly usage windows live.
- **Codex live usage limits**: The same panel now pulls live rate limits for Codex too, displaying Claude and Codex windows side by side with provider-specific states and empty states.
- **One-step statusline setup**: A new setup flow can auto-wire the statusline collector into your Claude Code settings (with backup and your approval), and re-discovers the installed plugin path after cache updates — no manual config editing.

### 🔧 Improvements

- **Redesigned usage-limits panel**: Circular gauges replace horizontal bars, and Claude and Codex now sit in separate, clearly badged sub-panels for easier reading.
- **Smarter limit visuals**: Meters use severity-encoded fills (amber to magenta), a time-elapsed marker that reveals when you're burning faster than the window pace, and a projected-at-reset indicator with safe/warn/over levels.
- **Better dashboard pacing**: The Monthly budget panel now sits directly above the Usage shifts panel, keeping spend-pacing and anomaly questions next to each other.
- **Accessibility**: Usage meters now expose ARIA progressbar attributes for screen readers.

## [2.0.4] - 2026-05-18

### 🔧 Improvements

- **Dashboard HTML maintainability**: Split the generated dashboard shell into focused partial files and added a lightweight loader so the shipped interface stays easier to maintain without changing runtime behavior.

### 📖 Documentation

- **README feature overview**: Simplified the feature list into clearer grouped sections and removed visual direction copy so marketplace readers can scan the plugin capabilities faster.

## [2.0.3] - 2026-05-18

### 🔧 Improvements

- **Dashboard preview in README**: Added the Token Atlas dashboard screenshot so marketplace visitors can see the current Sunrise Atlas experience before installing.
- **Install guidance polish**: Clarified the automatic precheck behavior and fixed marketplace/CLI install syntax so setup instructions match the current plugin workflow.
- **Dashboard asset organization**: Split the shipped dashboard runtime and styles into focused modules, making future updates easier to maintain without changing the user-facing dashboard behavior.

## [2.0.2] - 2026-05-17

### 🔧 Improvements

- **Auto-precheck before launch**: `SKILL.md` now chains the install precheck in front of `serve-dashboard.ts`, so the dashboard only starts once the environment is verified. Failed checks surface verbatim with their hints — no silent auto-fixes.
- **Required vs optional install checks**: `install.ts` now distinguishes required failures (`✗`, exit 1) from optional ones (`○`, exit 0 with a notice). Missing `history.jsonl` — common for fresh Claude Code installs without chat history — no longer blocks the dashboard; the project ranking section just stays empty.

### 🐛 Bug Fixes

- **Plugin manifest version drift**: `token-atlas/.claude-plugin/plugin.json` was stuck at `1.0.0` while the marketplace tracked `2.0.x`. Both files now agree on the released version.

## [2.0.1] - 2026-05-17

### 📖 Documentation

- **README refresh for Sunrise Atlas**: Updated feature list to reflect the v2.0.0 dashboard — daily burn hero, monthly budget tracker, project drilldown modal, session ledger, anomaly panel, token composition & cache efficiency, data health diagnostics, light/dark themes, pointer-tracking bloom, animated hero wave, current-view export, and persisted preferences. Added a one-line note that the visual direction is "Sunrise Atlas — Big Sur dawn palette over a calm working surface".
- **CLAUDE.md updates for contributors**: Documented the theme system (`[data-theme]` tokens + View Transitions cross-fade), the Sunrise Bloom delight (cursor-tracking radial glow on panels/cards — with a reminder to register new panel-shaped classes in both the CSS selector list and the JS `SELECTOR` constant), and the hero wave mask animation. Added CHANGELOG.md to the project tree and switched the PRODUCT.md description from "Nordic-inflected" to "Sunrise Atlas".

## [2.0.0] - 2026-05-17

### ✨ New Features

- **Sunrise Atlas redesign**: Complete visual overhaul of the Token Atlas dashboard with a warm dawn-to-dusk palette inspired by Big Sur. Cost is now the hero metric, set against a layered animated wave band.
- **Light & dark themes**: Theme toggle that respects `prefers-color-scheme` on first load, persists your choice, and cross-fades smoothly between Dawn (light) and Dusk (dark) modes.
- **Daily burn metric**: Primary cost card now shows your average daily spend with a sparkline trend and comparison delta against the previous period.
- **Monthly budget tracker**: Configure a monthly budget and see month-to-date spend, remaining budget, and projected burn rate alongside a sunrise-spectrum progress meter.
- **Project drilldown**: Selectable project cards open a viewport-safe modal with a provider-aware model breakdown for each project.
- **Session ledger**: Unified, sortable, filterable table of recent Claude sessions and Codex threads in one place.
- **Usage anomaly panel**: Detects elevated usage days from your active baseline and surfaces which models drove the spike.
- **Token composition & cache efficiency**: New dashboard sections that break down where your tokens go and how much your prompt cache is saving you.
- **Export current view**: One-click JSON or CSV exports scoped to the active provider and date range, grouped under a single export dropdown.
- **Data health diagnostics**: Compact footer panel showing the status of each local data source (Claude, Codex, pricing) — non-fatal failures no longer block the dashboard.
- **Persisted preferences**: Your filter, range, and view choices now stick across reloads.
- **Variance comparison**: Selected ranges show deltas against the prior equivalent period, with pricing-confidence metadata so you know how solid an estimate is.
- **Loading overlay**: Animated full-screen sunrise overlay during initial data fetch, with staggered "Reading local traces" title and layered breathing waves.
- **Pointer-tracking glow**: Subtle cursor-following radial glow on interactive surfaces — fully respects `prefers-reduced-motion`.

### 🔧 Improvements

- **Typography overhaul**: Self-hosted Fraunces variable font for editorial display headings, SF Pro Rounded for hero metric values, system stack for body — full offline support.
- **Refined visual tokens**: Normalized heading sizes, panel spacing, radii, and motion tokens across the dashboard.
- **Big Sur sunrise wallpaper**: New translucent dawn and dusk background veils replace the previous Nordic-themed asset.
- **Chart palette refresh**: Claude pulls warm dawn hues (coral/amber/gold), Codex pulls cool dusk hues (violet/magenta/indigo/sky).
- **Hero wave motion**: Three-layer animated waves with organic, out-of-phase drift and skew — restrained 5–8px amplitudes.
- **Cost-first hierarchy**: Dashboard reordered so cost reads first — hero → KPI strip → budget → trend → per-model table → usage shifts → activity → ledger → data health.
- **Qwen pricing defaults**: Added qwen pricing defaults and external pricing alias resolution.

### 🐛 Bug Fixes

- **Dark mode badges**: Fixed status badges and modals showing cold-blue residue in dark mode — they now read as warm-tinted patches.

### 📖 Documentation

- **Brand pivot to Sunrise Atlas**: Rewrote PRODUCT.md brand personality from Nordic mythology to "warm, composed, watching the sun come up over your data"; added SHAPE.md design brief covering layout, states, and interaction model.

## [1.1.0] - 2026-05-13

### 🔧 Improvements

- **Dashboard sync**: Updated Token Atlas dashboard runtime and data engine to stay in sync with the latest odin-dashboard improvements — includes refined API logic and frontend presentation tweaks

## [1.0.1] - 2026-05-05

### Added

- Installation instructions for Claude plugins (CLI and TUI methods)
- Prerequisite check command for dashboard setup
- Documentation for stats-cache.json seeding via /stats command

## [1.0.0] - 2026-05-05

### Added

- Initialize Claude Code plugin marketplace with plugin registry
- Add token-atlas plugin: local web dashboard for Claude Code & Codex usage analytics
  - Overview cards, daily trends, model distribution, activity heatmap, top projects
  - Bun-based backend with zero-build frontend (petite-vue + Chart.js)
  - Pricing engine: defaults + OpenRouter live fetch + user overrides
  - Data sources: ~/.claude/ stats & history, ~/.codex/ sessions

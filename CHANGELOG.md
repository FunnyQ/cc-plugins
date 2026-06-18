# Changelog

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

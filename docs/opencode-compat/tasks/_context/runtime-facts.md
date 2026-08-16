# OpenCode runtime facts

> **This file is the spike gate. Nothing in the tree may run ahead of it.**

Every fact below was deliberately kept out of the task tree, because answering it requires a live, interactive OpenCode session — starting one, watching which events fire, and reading what the runtime actually does. A headless agent cannot observe that, and would fabricate a plausible answer instead.

## The rule every task follows

**If a task needs a fact marked `UNRESOLVED`, it sets its own `> **Status**: blocked` and stops. It does not guess, does not infer from documentation, and does not pick "the reasonable default".**

Blocking is the correct outcome, not a failure. A wrong runtime assumption propagates into the module, the installer, five `SKILL.md` files, and the README before anyone notices.

When a fact is resolved, replace `UNRESOLVED` with the observed behavior, the decision it drives, and the `opencode --version` it was observed on. Also record it in `opencode/references/opencode-runtime.md`, which is the durable narrative log.

## How these were meant to be gathered

Sandbox recipe: a probe plugin module that logs every event it receives, plus a fake subagent, a fake command, and a symlinked skill to test discovery. **Never point the sandbox at the real `~/.config/opencode`.**

**Do not isolate with `XDG_CONFIG_HOME`.** Observed: `XDG_CONFIG_HOME=/tmp/sandbox opencode run …` hangs indefinitely — the isolation moves the config away from the credentials and the headless run blocks waiting for authentication instead of failing fast. Isolate another way (a scratch project directory with its own `.opencode/`, or a hand-driven session) and leave the credential path pointing at the real one.

Answer **S7 and S8 first** — both can invalidate the tree's shape rather than just fill in a blank.

---

## S7 — Do cross-directory imports survive the skill symlink? *(answer first)*

**Question**: with `~/.config/opencode/skills/cockpit` symlinked to `packages/monitor/skills/cockpit`, does `bun ~/.config/opencode/skills/cockpit/scripts/find-session.ts` resolve its `../../shared/scripts/opencode` import? That is, does the runtime resolve an entry symlink to its realpath?

**Why it matters**: if not, every skill that imports out of its own directory breaks, and the symlink-per-skill install model has to be replaced with copies or per-skill re-export shims.

**Status**: **RESOLVED — yes.** Observed on opencode 1.18.18 / bun 1.3.13: with `skills/cockpit` symlinked to `packages/monitor/skills/cockpit`, `bun <symlink>/scripts/find-session.ts` ran to exit 0 and produced real output, so its `../../shared/scripts/opencode` import resolved. Bun resolves the entry symlink to its realpath.

**Decision**: the symlink-per-skill install model holds. No copies, no per-skill shims.

---

## S8 — What is `import.meta.dir` inside a symlink-loaded plugin? *(answer second)*

**Question**: OpenCode loads `~/.config/opencode/plugin/q-lab.ts`, which is a symlink into this repo. Inside that module, does `import.meta.dir` give the realpath (`<repo>/opencode`) or the link path (`~/.config/opencode/plugin`)?

**Why it matters**: realpath means the module resolves the repo root by itself and needs no config file.

**Status**: **RESOLVED — realpath.** A module symlinked into a plugin directory reported its realpath as `import.meta.dir` both under a direct `await import(<link>)` and under `Bun.Glob("{plugin,plugins}/*.{ts,js}")` with `followSymlinks: true` followed by `import(f)` — the second being what the loader actually does.

**Decision**: the module uses `dirname(import.meta.dir)` as the repo root. **The generated re-export shim fallback is not needed — do not build it**, and there is no config file, no XDG write, and no config-read fail-open branch.

---

## S18 — `export const id` PREVENTS the plugin from loading ⚠️ CRITICAL

**Not a question — an observed trap**, found while building the probe.

The plan originally recorded "a file plugin **must export `id`**". The opposite is true on opencode 1.18.18. Three runs, same probe, one variable:

| Module exports | `module.evaluated` logged | plugin function called |
|---|---|---|
| `export const id` + a named async function | yes | **no** |
| a named async function only | yes | **yes** |
| `export default` async function only | yes | **yes** |

The loader iterates the module's exported values and calls each one. A string export poisons that loop, so the module is evaluated, no error surfaces, and **every hook silently does nothing**.

**Decision**: the module exports its plugin function and **nothing else**. No `id`, no version, no constants — not even a type. If a helper must be shared, keep it module-local. This is the single easiest way to ship a module that looks correct and does nothing.

---

## S1 — Does `session.created` fire on resume?

**Question**: Claude's matcher covers `startup|resume|clear|compact`. Does OpenCode's `session.created` fire on a resumed session? If not, do `session.updated` or `session.status` offer a usable fallback? Is there any event corresponding to `clear` or `compact` (`session.compacted` exists — does it fire)?

**Decision it drives**: add a fallback event, or accept narrower behavior and say so in the docs.

**Status**: **PARTIALLY RESOLVED.** `session.created` fires exactly once on a fresh session. The full event set observed in one headless run, in first-seen order: `session.created`, `session.updated`, `message.updated`, `message.part.updated`, `session.status`, `session.diff`, `plugin.added`, `catalog.updated`, `reference.updated`, `integration.updated`, `message.part.delta`, `file.edited`, `file.watcher.updated`, `session.idle`. `session.updated` and `session.status` both exist as fallback candidates. **Resume behavior is still untested.**

---

## S2 — `session.idle` cadence and payload

**Question**: does `session.idle` fire once per turn end, once per session, or on every tool pause? What is the payload shape?

**Why it matters**: the scribe nudge is designed per-turn. Once-per-session makes it nearly useless; every-tool-pause makes it spam.

**Status**: **PARTIALLY RESOLVED — not per tool.** In a run that executed two tools, `session.idle` fired exactly once, at the end. Payload props: `['sessionID']`. So it is turn-scoped, not tool-scoped — the spam failure mode is ruled out. Whether it fires once per turn in a multi-turn session, or only once per session, is still untested.

---

## S3 — `tool.execute.before`: throw vs permission mutation

**Question**: can the handler set `output.permission = "ask"`, and if so what does the user see? What does a thrown error look like to the user and to the agent — is the message surfaced verbatim?

**Decision it drives**: whether the branch guard can ask, or must hard-block.

**Status**: **RESOLVED — throw works, and works well.** A handler that throws inside `tool.execute.before` **prevents the command from running at all**, marks the tool call failed, and surfaces the thrown message **verbatim** to both the user and the agent. Observed: the agent reported back *"It was blocked — the tool returned: ⚠️ PROBE GUARD: this command is blocked by the probe plugin. So nothing was echoed to the terminal."*

**Decision**: the branch guard throws `check-branch.sh`'s `systemMessage` verbatim. No permission mutation needed.

---

## S4 — `tool.execute.after`: which tools, and how to surface a violation

**Question**: which tools fire this hook (write? edit? patch-style tools?). How does a handler surface a violation — mutate `output.error`, throw, something else? Does the write still land when it does?

**Decision it drives**: how the flightplan lint reports; worst case it degrades to throw-on-violation after the write has landed.

**Status**: **RESOLVED — mutate `output.output`.** The hook fires for both `write` and `bash`. `output` carries `{ title, metadata, output, attachments }`. Appending to `output.output` surfaces the text to the user's transcript **and** to the agent's view of the tool result; the write still lands. Observed: the agent quoted back *"Wrote file successfully. / [PROBE LINT] violation surfaced via output mutation"*.

**Correction (post-spike, from a live failure)**: the **after-hook argument path differs from the before-hook**. `tool.execute.after` receives the arguments on the **first** parameter — `input.args = { filePath, content }` — and the tool result on the second. The S5a shape (`output.args`) is before-hook-only; reading `output.args.filePath` in the after-hook throws `undefined is not an object`, which fails the write/edit call after the file has already landed. The flightplan lint gate must read `input.args.filePath`.

**Decision**: the lint appends the script's stderr to `output.output`. No throw — this matches the Claude `PostToolUse` exit-2 semantics, where the write has already landed and the feedback is advisory.

---

## S5 — Bash tool argument name and background support

**Question**: what is the bash command's argument path in the `tool.execute.before` input — `input.args.command`? And can a bash invocation run a long-lived background process (needed for launching the usage dashboard server)?

**Status**: **RESOLVED — both halves.** They were observed in separate runs, so read the two sub-entries below rather than this header alone. An earlier revision marked the whole entry `RESOLVED` while only S5a held, and a gate keyed on the header string let a task through that S5b should have blocked.

### S5a — argument path

**RESOLVED — the args live on the SECOND parameter, not the first.** The handler signature is `(input, output)`. `input` carries only `{ tool, sessionID, callID }`. The arguments are `output.args`:

```
bash  → output.args = { command: "echo hello-from-bash" }
write → output.args = { filePath: "/abs/path/done.txt", content: "DONE" }
```

**Scope**: this holds for `tool.execute.before` **only**. `tool.execute.after` inverts the shape — args on `input.args`, result on `output` (see S4's correction). Generalizing S5a to the after-hook produced a real bug: the flightplan lint gate read `output.args.filePath`, threw `undefined is not an object`, and failed every write/edit call.

**Decision**: the branch guard reads `output.args.command`; the lint gate reads `output.args.filePath`. Writing `input.args.command` — the shape this plan originally guessed — yields `undefined` and silently disables both hooks.

### S5b — background process support

**RESOLVED — there is no background parameter; shell detachment works.**

The bash tool takes exactly one argument, `command`. Observed through a probe plugin's `tool.execute.before` on opencode 1.18.18, in a run that explicitly instructed the model to pass a background parameter if one existed:

```
{"at":"before","tool":"bash","args":{"command":"nohup bash -c \"sleep 200; …\" … & echo \"launched pid $!\""}}
```

No `run_in_background`, `runInBackground`, or `background_run` string exists anywhere in `opencode.exe`; every `background` hit in the binary is CSS.

Shell-level detachment does survive. `nohup bash -c "sleep 200; …" … &` returned pid `61709`; that process was confirmed still running at 49s elapsed, well after the `opencode run` invocation had returned and the session had ended. It was killed during cleanup, so completion past that point was not observed — survival past session exit was, and that is the property a long-lived server needs.

**Decision**: instruct OpenCode sessions to detach with `… &`. Do not tell them to pass a background flag — there is none. This is the same wording the existing harness-agnostic paragraph already uses, so the OpenCode section states the fact explicitly rather than leaving the reader to infer it.

---

## S6 — Are symlinked skill directories discovered?

**Question**: does OpenCode list a skill whose directory under `~/.config/opencode/skills/` is a symlink?

**Status**: **RESOLVED — yes.** A `cockpit` symlink pointing at `packages/monitor/skills/cockpit` appeared in the agent's skill list and was invocable, returning the SKILL.md body.

---

## S9 — Task-subagent context inheritance

**Question**: does a subagent spawned via the task tool inherit the parent conversation's context, or does it start clean?

**Decision it drives**: the `thoughtful` command's OpenCode section — inherit means "spawn with the same distill prompt and do not wait"; clean means the parent session id must be passed explicitly, mirroring the existing Codex pattern.

**Status**: **RESOLVED — no inheritance. Subagents start clean.** A parent that held a secret passphrase spawned a subagent and asked it to report the passphrase; the subagent replied `NO-CONTEXT — I have no secret passphrase in this session.`

**Decision**: `thoughtful`'s OpenCode section resolves the parent session id first and passes it explicitly in the spawn prompt, exactly mirroring the existing Codex `--provider codex` pattern. There is no fork-style context inheritance to rely on.

---

## S10 — Confirm there is no Workflow tool

**Question**: confirm OpenCode exposes nothing equivalent to Claude Code's Workflow tool.

**Decision it drives**: autopilot's OpenCode branch documents a manual task-tool wave loop instead of Workflow parity.

**Status**: **RESOLVED — confirmed absent.** The primary agent's full tool list is `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write`. There is no Workflow tool and no equivalent. `task` is the only spawn mechanism.

---

## S11 — Hook-side user prompting

**Question**: is there any way for a plugin hook to ask the user a question (a `ctx.question` or equivalent)?

**Decision it drives**: if not, throw-with-message is the only surface a hook has.

**Status**: **RESOLVED — no prompting surface.** The plugin context exposes exactly `{ client, project, worktree, directory, experimental_workspace, serverUrl, $ }`. There is no `question` and no equivalent. Throw-with-message is the only way a hook reaches the user — which is why the branch guard hard-blocks instead of asking.

---

## S12 — Duplicate skill names across scan roots *(not a gate)*

**Question**: when the same skill name exists in both `~/.claude/skills/` and `~/.config/opencode/skills/`, which wins? Is there a warning?

**Not a gate**: the collision is already resolved by installing to `~/.config/opencode/skills/` and warning about the legacy symlink. Record the observed behavior for the docs; do not block on it.

**Status**: UNRESOLVED

---

## S13 — Cockpit send round-trip

**Question**: start `opencode --port <n>`, then confirm the existing bridge end to end — `/global/health` responds, `/session/<id>` resolves, and `/tui/append-prompt` followed by `/tui/submit-prompt` lands a prompt in the live session. Record the session-id format and whether the port flag is genuinely mandatory or whether a default port is discoverable. Note whether a clear error surfaces when the TUI was started without a port.

**Decision it drives**: exactly how the cockpit skill and the README state the precondition.

**Status**: **RESOLVED — all three legs work, with one trap.** Against `opencode serve --port 4097` on 1.18.18:

| Leg | Result |
|---|---|
| `GET /global/health` | `{"healthy":true,"version":"1.18.18"}` — exactly what the bridge's `isOpenCodeServer()` checks |
| `GET /session` | lists sessions; ids match the bridge's `^ses_[A-Za-z0-9_-]{8,160}$` regex |
| `GET /session/<id>` | `200`, carrying the `directory` field the bridge reads as `sessionDirectory` |
| `POST /tui/append-prompt?directory=…` | `200`, body `true` |

**The trap: `/tui/append-prompt` returned `200 true` with no TUI attached at all.** The endpoint does not report delivery, so the bridge's `delivered: true` is not proof the prompt reached a human's screen. Document the send as best-effort; do not promise delivery.

**Second trap: `opencode serve` is invisible to the bridge's discovery.** `discoverOpenCodeTuiProcessUrls()` scans `ps` for `opencode` while explicitly excluding `opencode serve|web|attach`. So a `serve` process is never auto-discovered — the user must either run the **TUI** as `opencode --port <n>`, or set `OPENCODE_TUI_SERVER_URL` before cockpit starts.

**Decision**: the cockpit skill and the README state the precondition as *"run the TUI with `opencode --port <n>`, or set `OPENCODE_TUI_SERVER_URL`"* — and note that a `serve` process does not count, and that a successful send is not a delivery receipt.

---

## S14 — `subagent_depth`

**Question**: what does a fresh OpenCode install default `subagent_depth` to? Is it read once at startup or live? Does a project-level `.opencode/opencode.json` override the global one? Does `2` actually carry the chain skill → orchestrator → child? Is `permission.task: allow` sufficient, or does each spawn still prompt?

**Known**: the key exists and lives in `~/.config/opencode/opencode.json` as a plain number, verified on this machine at `2`.

**Why it matters**: below the required depth an orchestrator simply stops, with no error naming the config — it reads as a plugin bug. This is the same failure Claude Code shipped in 2.1.217.

**Status**: **PARTIALLY RESOLVED — the default is 1.** The published config schema (`https://opencode.ai/config.json`, `$defs/Config/properties/subagent_depth`) states: *"Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents."* So chronicle's orchestrators are broken on a fresh install, silently — the Claude Code 2.1.217 situation verbatim.

**Decision**: the installer's `subagent_depth` write is mandatory for every user, which is why it belongs in `--apply` rather than behind a separate flag.

**Nested spawning is confirmed working**, but the gate is not only the depth number — see S17. With the global config at `subagent_depth: 2`, a custom agent declaring `permission.task: allow` spawned its own child subagent and got its reply back (`NESTED-SPAWN-OK`, child session `ses_ff9cdbb99ffejVh2hZKwMzfSl0`). The chronicle topology works.

Still UNRESOLVED: read timing (startup vs live), which config file supplied the value (global 2 and two project-level files were all present during the successful run, so the minimum was not isolated), and the behavior at the shipped default of 1.

---

## S15 — `scribe-nudge.ts` output under OpenCode

**Question**: confirm the script emits the Claude hook-JSON shape when neither `CLAUDE_PLUGIN_ROOT` nor `PLUGIN_ROOT` is set, and decide whether the module parses `systemMessage` out of the wrapper or discards the wrapper entirely.

**Why it matters**: mishandling it surfaces raw JSON to the user instead of a reminder.

**Status**: **RESOLVED.** Two facts:

1. **It usually prints nothing at all.** `decideNudge()` gates on a throttle and a change signature and returns early, so a bare invocation exits 0 with empty stdout. Verified by running it with `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` all unset.
2. **When it does print**, with `PLUGIN_ROOT` unset it emits the Claude shape:
   ```json
   {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"<reminder>"}}
   ```
   (with `PLUGIN_ROOT` set it would emit `{"systemMessage":"<reminder>"}` instead).

**Decision**: the `session.idle` handler treats empty stdout as a no-op, and otherwise parses the JSON and surfaces `hookSpecificOutput.additionalContext`, falling back to `systemMessage`. It must never print the raw wrapper.

---

## S16 — Does OpenCode print a skill base-directory banner?

**Question**: when a skill loads, Claude Code prints a *"Base directory for this skill"* banner, and several skills instruct the reader to take `$SKILL_DIR` from it. Does OpenCode print an equivalent? If so, what does it resolve to for a symlinked skill — the link path or the realpath?

**Why it matters**: at least six skills resolve their scripts through that banner rather than through `CLAUDE_PLUGIN_ROOT`, so a skill can be Claude-bound without ever naming the variable. If there is no banner, every OpenCode branch must supply the literal `~/.config/opencode/skills/<name>/` path instead of a rule that reads one.

**Status**: **RESOLVED — there is no banner.** Invoking a skill returns `# Skill: <name>` followed by the SKILL.md body, and nothing else. No base-directory line.

**Decision**: every OpenCode branch must state the literal `~/.config/opencode/skills/<name>/` path. Do not phrase it as "the value the banner resolves to" or "if your harness prints one" — under OpenCode it never does.

---

## S17 — What subagent types can the task tool spawn?

**Question**: what `subagent_type` values are built in — is there a general-purpose one, and an explore/read-only one? Can a spawn pass an inline prompt to a built-in type, or does every distinct role need its own agent definition file? And does a custom agent file have to be installed globally, or can a project supply one?

**Why it matters**: autopilot's manual wave loop needs a dev role and a judge role. Nothing in this build defines a `dev` or a `judge` agent — the 13 converted agents are chronicle's, and the installer asserts that count.

**Status**: **PARTIALLY RESOLVED — two built-in subagents exist.** `opencode agent list` on a machine with no custom agents reports `explore (subagent)` and `general (subagent)`, alongside the primaries `build`, `plan`, `compaction`, `summary`, `title`.

**Decision**: the wave loop spawns `general` for both roles, carrying an inline role prompt. **No new agent definitions are needed**, so the installer's 13-agent / 32-target count stands and nothing ripples into its tests or the README.

**The built-in `general` subagent has no `task` tool and cannot spawn.** Tested at `subagent_depth` 2, 3 and 4: a `general` subagent asked to call `task` got the runtime error *"Model tried to call unavailable tool 'task'. Available tools: bash, edit, glob, grep, read, skill, todowrite, webfetch, write."* Raising the depth does not grant it.

**A custom agent declaring `permission.task: allow` CAN spawn.** A probe agent with that permission spawned a child and received its reply. So `permission.task: allow` is load-bearing, exactly as specified for the three chronicle orchestrators — without it they are silently unable to spawn.

**Decisions**:
- Chronicle's converted agents work as specified. Keep `task: allow` on lawspeaker, lorekeeper and storykeeper.
- Autopilot's wave loop spawns `general` for the dev and judge roles with an inline prompt. Both are leaves — they never spawn — so `general`'s missing `task` tool does not affect them. No new agent definitions are needed and the installer's 32-target count stands.
- **Custom agents are discovered from `.opencode/agents/`** (plural), confirmed by listing with only that directory present.

Still UNRESOLVED: whether a spawn prompts for permission in an interactive session, as opposed to the `"permission": "allow"` config used in the probe.

---

## S20 — Can the `session.created` handler pass guidance to the model?

**Question**: the `experimental.chat.system.transform` hook injects strings into the model's system prompt — but can a `session.created` handler reliably feed it?

**Why it matters**: the decision-log guidance must ride the first real request of a session; losing it silently means the model never learns the cockpit contract.

**Status**: **RESOLVED — only via a synchronous seed.** The `event` hook is dispatched fire-and-forget (`void hook["event"]?.(...)` — never awaited, observed in the plugin index source) while the transform is awaited. An async stash (spawn the script, then set the map) loses the race to the first request's transform — a timed probe measured the transform firing ~300ms after `session.created` while a spawn-based stash landed ~1.5s later. The model never saw the guidance.

**Decision**: the event handlers seed sentinels **synchronously** and the awaited transform materializes them by running the scripts itself. No spawn in the event handler at all.

---

## S21 — The first request eats consume-once guidance ⚠️ TRAP

**Question**: does the guidance actually reach the request the user sees, once per session?

**Status**: **RESOLVED — consume-once is broken; the first transform call is the title generator.** The runtime triggers `experimental.chat.system.transform` for **every** LLM request in the session, and the first one is the throwaway session-title request (`agent/prompt/title.txt`, ~2.1KB system prompt; its output never surfaces). A consume-on-first-request design hands the guidance to that request and the real one (~27KB system) never gets it. Observed with a diag probe logging both calls: `hdrLen 2096, found:true` (title) then `hdrLen 27040, found:false` (main). The first `opencode run` probe that "verified" the transform reached the model was a false positive — it had no negative control, and the yes/no oracle is unreliable (a control run answered READ 3/6 with no plugin at all; a verbatim-quote oracle answered NOTHING 4/4).

**Decision**: a seed rides up to `PUSH_CAP` requests (title + real request + a retry; the title one is harmless noise) and the `session.idle` handler retires the entry at the turn boundary. Verified live with the verbatim oracle: the guidance phrase surfaced 4/4 runs.

**Materialize once, then replay.** Riding N requests must not mean running the script N times. `decision-log-start.ts` is stateless (three runs, 944 bytes each), but `scribe-nudge.ts` is a one-shot: it writes a marker and throttles for 8 minutes, so back-to-back runs return 336 / 0 / 0 bytes. Re-running per push would hand the nudge to whichever request transformed first — the title request — and push an empty message to the rest, reintroducing this very trap one layer down. The transform therefore writes the resolved strings back into the entry and later pushes replay them, so `PUSH_CAP` counts requests rather than subprocess spawns.

---

## S22 — Can a plugin send a user-visible notification?

**Question**: the docs' "Send notifications" example uses `$` (Bun shell) with `osascript` for macOS system notifications, and there is a `tui.toast.show` event. What can a plugin actually reach?

**Status**: **RESOLVED — user-facing only.** Those channels reach the user's screen/desktop, never the model; the model reads only the system prompt (S19). The `experimental.chat.system.transform` hook is the only documented channel from a hook into the model's context.

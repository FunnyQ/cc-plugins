# OpenCode runtime — spike log

Observed on **opencode 1.18.18**, macOS (darwin 25.6.0), bun 1.3.13, 2026-08-15.

This is the narrative log. The executable gate is `docs/opencode-compat/tasks/_context/runtime-facts.md`, which carries the same answers in the form the task tree reads. Keep the two in sync.

Seventeen of eighteen items are resolved from observed behavior. Only S12 remains open, and it was never a gate.

---

## S7 — Cross-directory imports survive the skill symlink ✅ RESOLVED

**Question**: with a skill directory symlinked into the OpenCode skills root, does a script inside it still resolve an import that reaches outside its own directory?

**Observation**:

```
/tmp/…/skills/cockpit -> packages/monitor/skills/cockpit     (symlink)
$ bun /tmp/…/skills/cockpit/scripts/find-session.ts --help
03efc335-9157-4455-b75b-1247c6d73b89                          (exit 0)
```

`find-session.ts` imports `../../shared/scripts/opencode`, which only exists under `packages/monitor/skills/shared/`. It ran and produced real output, so **Bun resolves the entry symlink to its realpath** and module resolution proceeds from the repo, not from the link's parent.

**Decision**: the symlink-per-skill install model holds. No copies, no per-skill re-export shims. This was the item that could have invalidated the whole tree shape; it did not.

---

## S8 — `import.meta.dir` inside a symlink-loaded module is the realpath ✅ RESOLVED

**Question**: OpenCode loads `~/.config/opencode/plugin/q-lab.ts`, a symlink into the repo. Inside that module, is `import.meta.dir` the realpath or the link path?

**Observation** — a module at `<fake-repo>/opencode/plugin.ts`, symlinked to `<cfg>/plugin/q-lab.ts`, exporting `import.meta.dir`:

| How it was loaded | `import.meta.dir` |
|---|---|
| `await import("<cfg>/plugin/q-lab.ts")` | `<fake-repo>/opencode` |
| `Bun.Glob("{plugin,plugins}/*.{ts,js}")` with `followSymlinks: true`, then `import(f)` | `<fake-repo>/opencode` |

The second case mirrors what the loader actually does. Both give the **realpath**.

**Decision**: the module derives its repo root as `dirname(import.meta.dir)`. **No config file, no XDG write, no `readConfig()` fail-open branch, and the generated re-export shim fallback is not needed** — drop it from the installer's target list rather than building it.

---

## S14 — `subagent_depth` defaults to 1 ⚠️ PARTIALLY RESOLVED

**Observation**, from the published config schema (`https://opencode.ai/config.json`, `$defs/Config/properties/subagent_depth`):

```json
{
  "type": "integer",
  "minimum": 0,
  "description": "Maximum subagent nesting depth. Defaults to 1, which prevents subagents from launching subagents."
}
```

**This is the Claude Code 2.1.217 situation verbatim.** A default of 1 means chronicle's orchestrators — every one of which exists to spawn children — are broken on a fresh OpenCode install, with no error naming the config.

**Decision**: the installer's `subagent_depth` write is **mandatory, not a convenience**. Every user needs it, so it belongs in `--apply` rather than behind a separate flag. Raise-only stays right: the author's machine already carries `2`, set by hand before this build.

**Nested spawning is confirmed working** — but the depth number is not the whole gate; see S17. With the global config at `subagent_depth: 2`, a custom agent declaring `permission.task: allow` spawned its own child and received its reply. The chronicle topology works.

**Still open**: read timing, and which config file supplied the value — global 2 and two project-level files were all present during the successful run, so the minimum was not isolated.

---

## S17 — The built-in subagent types are `explore` and `general` ⚠️ PARTIALLY RESOLVED

**Observation**, `opencode agent list` with no custom agents defined:

```
build (primary)        compaction (primary)   plan (primary)
summary (primary)      title (primary)
explore (subagent)     general (subagent)
```

**Decision**: autopilot's manual wave loop spawns `general` for both the dev role and the judge role, carrying an inline role prompt. **No `dev` or `judge` agent definitions are needed**, so the installer's 13-agent / 32-target count stands unchanged and nothing ripples into its tests or the README.

**The built-in `general` subagent cannot spawn.** Tested at `subagent_depth` 2, 3 and 4 — a `general` subagent asked to call `task` got *"Model tried to call unavailable tool 'task'. Available tools: bash, edit, glob, grep, read, skill, todowrite, webfetch, write."* Raising the depth does not grant it.

**A custom agent declaring `permission.task: allow` can.** A probe agent with that permission spawned a child and got `NESTED-SPAWN-OK` back. So `permission.task: allow` is load-bearing exactly as specified for the three chronicle orchestrators — without it they are silently unable to spawn. Custom agents are discovered from `.opencode/agents/` (plural).

---

## Sandbox recipe — a trap worth recording

`XDG_CONFIG_HOME=/tmp/sandbox opencode run …` **hangs**. The isolation moves the config away from the credentials, and the headless run blocks waiting for authentication instead of failing fast. It never returns.

Isolate some other way for the remaining items — a scratch project directory with its own `.opencode/`, or a real session driven by hand — and keep the credential path pointing at the real one.

---

## The rest — all answered

Full write-ups, each with its observation and the decision it drove, live in `docs/opencode-compat/tasks/_context/runtime-facts.md`. Headlines:

- **S18 (new, critical)** — `export const id` **prevents the plugin from loading**. The loader calls each exported value; a string export poisons the loop, the module evaluates, nothing errors, and every hook silently does nothing. Export the plugin function and nothing else.
- **S5a** — `tool.execute.before` carries tool arguments on the **second** handler parameter: `output.args.command`, `output.args.filePath`. `input` carries only `{ tool, sessionID, callID }`. `tool.execute.after` inverts this — args on `input.args`, result on `output` — and a post-spike live failure confirmed that reading the before-hook shape in the after-hook throws and fails the write after it has landed.
- **S5b** — the bash tool takes **only** `command`; there is no background parameter (no `run_in_background`/`runInBackground`/`background_run` string exists in the binary). Shell detachment works instead: `nohup … &` returned a pid that outlived the `opencode run` invocation. So a long-lived server launches with `… &`, never with a flag.
- **S3** — throwing in `tool.execute.before` blocks the command and surfaces the message verbatim. Exactly what the branch guard needs.
- **S4** — a lint violation is surfaced by appending to `output.output`; the write has already landed.
- **S9** — task subagents inherit **nothing**. `thoughtful` must pass the parent session id explicitly.
- **S17** — built-in `general` has no `task` tool at any depth; a **custom agent declaring `permission.task: allow` can spawn**, which is chronicle's shape and it works.
- **S10** — no Workflow tool. Tools are `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write`.
- **S11** — no hook-side prompting. Context is `{ client, project, worktree, directory, experimental_workspace, serverUrl, $ }`.
- **S16** — no skill base-directory banner. State literal install paths.
- **S6** — symlinked skill directories are discovered and invocable.
- **S13** — all three legs of the cockpit send bridge respond, but `/tui/append-prompt` returns `200 true` **with no TUI attached**, and `opencode serve` is excluded from the bridge's `ps` discovery.
- **S1 / S2** — full event list captured; `session.idle` is turn-scoped, not tool-scoped. Resume behavior and multi-turn idle cadence remain untested.
- **S12** — still open, and never a gate.
- **S19** — plugin stderr renders **red in the TUI and never reaches the model**; the model reads only the system prompt. `experimental.chat.system.transform` (`{ sessionID?, model }` → `output.system: string[]`) appends strings the model demonstrably reads, so the session guidance seeded by `session.created`/`session.idle` is injected there, mirroring Claude's `additionalContext`. Failures go to `client.app.log` instead — the TUI shows nothing, so debug with `opencode run --print-logs`. The seed map is capped (least-recently-stashed evicted) because guidance is time-sensitive and a session ending right after its last nudge would otherwise leave one never-consumed entry per session while a `serve` process lives. Delivery is not consume-once — see S21 for why.

## S20 — The `event` dispatch is fire-and-forget; the transform is awaited ⚠️ TRAP

**Observation**, opencode 1.18.18, source + timed probe. The plugin index awaits the transform trigger (`yield* Effect.promise(() => fn(input, output))`) but dispatches events without awaiting: `void hook["event"]?.({...})`. A probe that logged every step with `Date.now()` showed the first request's transform firing **before** an async event-handler stash completed:

```
620  session.created received — async stash starts (bun spawn)
931  transform → pending empty
557+ transform (2nd) → still empty
155+ stash lands — after both transforms
```

So stashing guidance by spawning the script in the `session.created` handler is a coin flip: on a fast request the model's system prompt is already built, the stash lands too late, and the guidance is never read — with no error anywhere.

**Decision**: the event handlers seed sentinels **synchronously** (`\u0000created-guidance`, `\u0000idle-nudge`) — no spawns — and the awaited transform materializes them by running the scripts itself. One spawn, exactly when a request makes the guidance worth reading; the seed is visible to the transform from the instant the event lands.

## S21 — The first request is the title generator — consume-once loses the guidance ⚠️ TRAP

**Observation**, opencode 1.18.18, diag probe logging every transform call. The runtime triggers the transform for **every** LLM request in the session; the first call carries the throwaway session-title prompt (`agent/prompt/title.txt`, 2120 bytes — observed as a 2096-char system header) and the second carries the real ~27KB system prompt. A consume-on-first-request design hands the guidance to the title request and the real one never sees it:

```
transform #1:  hdrLen 2096, found:true  → materialized, pushed (title request)
transform #2:  hdrLen 27040, found:false → nothing (real request)
```

**The earlier "verified end-to-end" probe was a false positive.** Its transform pushed the marker unconditionally on every call (so the title request carried it too) and its yes/no oracle had no negative control — a control run with **no plugin at all** answered READ 3/6 times. A verbatim-quote oracle (output the exact phrase, or NOTHING) answered NOTHING 4/4 with no plugin and, against the consume-once implementation, still NOTHING 4/4 — the guidance was never reaching the real request.

**Decision**: a seed rides up to `PUSH_CAP = 3` requests (title + real request + a retry; the title request is harmless noise) and `session.idle` retires the entry at the turn boundary — the created guidance rides turn 1, the per-turn nudge rides turn 2. Re-verified live with the verbatim oracle: `DECISION LOG ACTIVE` surfaced 4/4 runs. The no-plugin control still answers NOTHING, so the oracle is trustworthy.

**Riding N requests must not mean running the script N times.** The two seeds differ: `decision-log-start.ts` is stateless (three runs, 944 bytes each), while `scribe-nudge.ts` writes a marker and throttles for 8 minutes — back-to-back runs return 336 / 0 / 0 bytes. A materialize-per-push design would hand the nudge to whichever request transformed first, the title one, and push an empty message to the rest — the same trap, one layer down, and invisible because it lives in the nudge's marker file rather than in the plugin. The transform therefore writes the resolved strings back into the entry and later pushes replay them, so `PUSH_CAP` counts requests and not subprocess spawns.

**Method note for this spike**: a positive-only model probe proves nothing. Every "does the model see X" claim needs (a) a negative control and (b) an oracle that requires quoting exact text, not a yes/no answer — this model answers yes/no trivia probes randomly (3/6 on a false premise).

## Method note

Everything above was observed by loading a probe plugin from a scratch project's `.opencode/plugin/`, then reading what it logged during real headless runs. Two of the findings — S18 and S5 — contradicted what the plan had written from documentation, and neither would have produced an error message. A module built to the documented shape would have installed cleanly, loaded, and done nothing at all.

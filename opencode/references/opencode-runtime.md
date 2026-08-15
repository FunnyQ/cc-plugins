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
- **S5** — tool arguments are on the **second** handler parameter: `output.args.command`, `output.args.filePath`. `input` carries only `{ tool, sessionID, callID }`. The shape this plan first guessed returns `undefined`.
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

## Method note

Everything above was observed by loading a probe plugin from a scratch project's `.opencode/plugin/`, then reading what it logged during real headless runs. Two of the findings — S18 and S5 — contradicted what the plan had written from documentation, and neither would have produced an error message. A module built to the documented shape would have installed cleanly, loaded, and done nothing at all.

# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`runes` is a Claude Code _mod_ (a function-hooks module, Claude Code only) in `packages/runes/`. This plan adds
a rune called `explain`: a `hey mate, explain please` button under the minimap row of Clawd's band. A press
forks the session's own transcript through `$.model.fork` and shows an ELI5 explanation in a side pane, or
writes a single-file HTML explainer with SVG diagrams, or asks Q what to explain. Q is the only user.

## Tech stack

- **Runtime**: a Claude Code mod. The hooks module is `packages/runes/hooks/register.tsx`, listed in
  `packages/runes/hooks/hooks.json`. JSX compiles against the global `h`; elements come from
  `const { Box, Text, Button, Input } = $.ui.resolve(e)`.
- **No DOM, no Node, no `Bun` global inside the mod.** Everything outside goes through `$`:
  `$.fs.read/write/exists/stat` (4 MiB cap per read/write), `$.process.run(argv, { stdin?, env? })`,
  `$.env.get(name)`, `$.clock.after/every/now`, `$.state` via `atom` / `read` / `update` from `"claude-code"`,
  `$.ui.open/close/panes/toast/status/invalidate/scroll`, `$.model.fork`, `$.agent.register/spawn/list`.
- **A mod's child process gets no HOME.** Read `HOME` with `$.env.get("HOME")` in the hook and pass it on.
- **`$` may not leave its hook, and a function taking `on` may not return a value.** Share module-level values
  and closures (the pattern `teacher.work({...})` and `glow.work(...)` use in `register.tsx`'s `session.start`).
  `$` may be handed to another file's function only when that function is a `function` declaration called by
  bare name; `protocol.md` → "Passing `$` across files" has the measured rule.
- **Two hooks on one event in one module need distinct matchers.** `register.tsx` owns the unmatched
  `session.start`; a rune hooks `session.start` with a matcher of its own (Clawd and the minimap use
  `{ isInteractive: true }`). A `ui.render` matcher `{ component: "Pane", requestId: "runes-explain" }` is
  distinct from the band's `{ component: "AbovePrompt" }`.
- **No npm dependencies.** TypeScript only, no transpile step.

### Mod API facts this plan relies on (from the engine's typings, build 2.1.310)

- `$.model.fork({ prompt: string })` → `Promise<ModelForkResult>`. It re-sends the main thread's last
  request (model, system prompt, tools, messages) with `prompt` appended as one user message, every tool
  denied. It never enters the transcript. Result: `{ isAnswered: true, text, usage }` or
  `{ isAnswered: false, reason }` where `reason` is `"nothing-to-fork"` (before the first request, after
  `/clear`), `"api-error"`, `"empty-reply"`, or `"aborted"`.
- `ModelUsage` = `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`
  (numbers). On a fork, `cache_read_input_tokens` near zero means the cache lapsed and the prefix was billed.
- `$.ui.open({ id, title, columns?, rows?, focus? })` resolves `{ isPlaced }`; the pane is drawn by a
  `ui.render` hook on `{ component: "Pane", requestId: id }`, which reads `e.props.bodyColumns`.
  `$.ui.close({ id })` closes it; `$.ui.panes()` lists `{ id, isPlaced }`.
- `Input` props: `key` (required), `label?`, `placeholder?`, `value?`, `submitLabel?`, `rows?`,
  `autoFocus?: true`, `onSubmit: (value: string, e) => void`, `onInput?: (value: string, e) => void`.
- `Button` props used in runes: `key`, `label` or children, `plain`, `dimColor`, `onPress`. A Button takes
  no colour.
- `$.agent.register({ name, description, prompt, tools, model, effort?, omitClaudeMd? })` defines
  `runes:<name>`. `on("agent.offer", { agent }, () => ({ isOffered: false }))` hides it from the model.
  `$.agent.spawn({ subagentType, prompt, description })` resolves `{ agentId, model }` or `{ deny }`; the
  answer arrives as that subagent's `turn.complete` (`e.agentId` set, `e.reason`, `e.answer`). Match it by
  `(await $.agent.list()).find(a => a.id === e.agentId)?.type`, never by the spawn's `agentId` alone (the
  test kit strips a hook-made agentId).
- `tool.check` input carries `tool`, `input`, and `agentId` (set inside a subagent's loop); answering
  `{ decision: "allow" }` allows; `next.origin.plugin` names the plugin that raised the call.
- `$.http.fetch` aborts at 30 s (not used by this plan).

## Code style

- Use `type`, never `interface`.
- Match the file you edit: `band.tsx`, `*.test.tsx` and `ticker.test.tsx` use single quotes and no
  semicolons; most `.ts` files use double quotes and semicolons. New files under `hooks/explain/` use double
  quotes and semicolons. An editor hook may reformat a file after an edit; do not fight it.
- No comments by default. Keep a one-line _why_ only for a constraint from outside the codebase (an engine
  quirk, a measured number). Never a comment that says what the code does.
- No error handling for states the code cannot reach. Every path in this plan that _can_ fail (no fork,
  no Chrome, a denied spawn) is named in its task.
- Prefer one longer function over an indirection used once.

## File / directory layout

All new code lives in `packages/runes/hooks/explain/`:

| File               | Owner (what it holds)                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| `state.ts`         | the `view` atom and the `Entry` helpers (contract in `protocol.md`)                  |
| `protocol.ts`      | the fork prompt builder and the reply parser — pure                                  |
| `protocol.test.ts` | its tests                                                                            |
| `html.ts`          | `assemble`, `explainerPath`, `slugOf`, `writeExplainer`                              |
| `template.html`    | the explainer skeleton, from the approved mock                                       |
| `html.test.ts`     | its tests                                                                            |
| `checker.ts`       | the hidden layout-checker agent: register, spawn, allow-list, hand-back deny, answer |
| `checker.test.ts`  | its tests                                                                            |
| `explain.ts`       | the orchestrator: `explainPress`, `explainAsk`, `explainPick`, `explainSelect`   |
| `explain.test.ts`  | its tests                                                                            |
| `pane.tsx`         | the pane `ui.render` hook                                                            |
| `pane.test.tsx`    | its tests                                                                            |

Existing files touched: `hooks/config.ts`, `hooks/config.test.ts`, `types/index.d.ts`, `hooks/band.tsx`,
`hooks/register.tsx`, `CLAUDE.md` (repo root).

Tests live beside the code as `*.test.ts(x)` and import `{ expect, mock, test } from "claude-code/testing"`.
A test that starts a session uses `fakeHost` / `startSession` from `hooks/transcript/test-session.ts`, which
answer the kit's missing store, fs, env and process with `{ value }` stubs and parse the template's YAML
subset. `CONFIG` there is the fake `config.yaml` path; set the config by writing a fake `config.yaml`
(`files: new Map([[CONFIG, "explain:\n  enabled: true\n"]])`), never by importing `config`, because the kit
loads the plugin as its own module instance. A stub for a noun (`session.id`, `agent.list`) answers
`{ value }`; an event (`agent.spawn`) answers its result bare; `$.clock` needs `mock.clock(on)`.

## Commit & branching style

- Branch: work happens on `main` (GitHub Flow).
- Tasks do not commit. Under autopilot a commit agent commits each wave; leave changes unstaged.
- No version bump, no CHANGELOG entry.

## Verification baseline

bun and tsc exclude `packages/runes`, so its tests run only through the plugin test kit:

- `claude plugin test packages/runes` — the whole runes suite (must stay green)
- `claude plugin validate packages/runes` — manifest, module source, and every `$.state` key against
  `types/index.d.ts`
- There is no dev server. A real-session check is a `(human)` item.

## Decisions frozen during interview

- **Router is the fork** — no Jev, no TypeSafe call anywhere in this feature.
- **Default target is the fork's pick** — latest exchange or session recap; it asks when torn.
- **HTML is written by the fork**, assembled into the shipped skeleton, then checked by a hidden subagent.
- **Checker uses Bash itself** (spike passed), with a `tool.check` allow-list kept as a guard.
- **Open with the system browser** — `open <path>`, file:// origin, after the check finishes.
- **Pane keeps a session history list** and has a follow-up `Input` at the bottom.
- **Token usage is shown after, never estimated before.** "Cost" means the token counts in `ExplainUsage`
  (`in · cached · out`); no price or dollar figure is computed.
- **`explain` defaults to on.** The minimap defaults to off, so the button row draws whether or not the map does.
- **Explanation language is inherited** from the session's own system prompt (the fork carries it); no setting.
- **Terminal surface only.**

# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`cc-plugins` is a Claude Code (and Codex) plugin marketplace. This work is inside the
**monitor** plugin's **cockpit** feature (`packages/monitor/skills/`). We are collapsing
three cockpit skills (`cockpit`, `cockpit-scribe`, `thoughtful`) into one automatic system:
auto-logging by default, all goals removed, and a single global `log_language` config.

Repo root referenced below: `/Users/funnyq/Projects/q-lab/cc-plugins`. All paths are
relative to that root unless absolute.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Uses `bun:sqlite`, `Bun.serve`,
  `Bun.file`, `bun test`.
- **Frontend**: petite-vue + Chart.js, committed under
  `packages/monitor/skills/cockpit/dashboard/dist/` (and a sibling usage-dashboard). **No
  build step** — edit the committed `dist/` files in place.
- **Storage**: append-only JSONL decision logs at `<project>/.cockpit/logs/<sessionId>.jsonl`;
  session registry at `~/.cockpit/registry.json`; daemon info at `~/.cockpit/daemon.json`.

## Code style

- Prefer `type` over `interface`.
- No external npm dependencies — vendor libs are committed; backend uses only Bun + Node
  built-ins (`node:os`, `node:fs`, `node:path`).
- Match surrounding style; keep changes surgical (touch only what the task requires).
- Authoritative source (for verification only): the existing `*.ts` files in
  `packages/monitor/skills/cockpit/scripts/`.

## File / directory layout

- Cockpit CLI + server + helpers: `packages/monitor/skills/cockpit/scripts/*.ts`. Tests are
  `*.test.ts` siblings, run with `bun test`.
- Skill docs: `packages/monitor/skills/cockpit/SKILL.md` + `references/*.md`.
- Slash commands (plugin-level): `packages/monitor/commands/*.md` (this directory is new for
  monitor — relay already uses `commands/` at `packages/relay/commands/`; mirror that shape).
- Claude manifest with hooks: `packages/monitor/.claude-plugin/plugin.json`.
- Dashboard SPA: `packages/monitor/skills/cockpit/dashboard/dist/` (`index.html`, `app.js`,
  `style.css`, `modules/*.js`).

## Cockpit internals an executor must know

### Decision-log record shape (`DecisionRecord`)

Each non-goal line of the JSONL is:

```ts
type DecisionKind = "decision" | "rationale" | "learning" | "caveat";
type DecisionRecord = {
  id: string;
  type: "decision";
  kind: DecisionKind;
  source: "agent" | "scribe";
  decision: string;     // headline / title
  reason: string;       // body (markdown)
  tradeoff: string;
  facets: string[];     // "LABEL: text" rows
  needs_your_call: boolean;
  options: string[];
  files: string[];
  timestamp: string;    // ISO-8601
};
```

The legacy line-1 **goal record** `{ type: "goal", session_goal, ts }` is being removed.
Readers must **tolerate** a legacy goal record still present in old logs (skip it), but
nothing new writes one.

### Home-dir / config resolution

- `~/.cockpit` is resolved as `process.env.COCKPIT_HOME || join(homedir(), ".cockpit")` in
  `cockpit.ts`, `registry.ts`, and `cockpit-server.ts`. **Do not change this.**
- The **new** language config is separate: `~/.config/q-lab/cockpit/config.json`, resolved as
  `join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "q-lab", "cockpit", "config.json")`.

### Session auto-registration (no `start`)

`cockpit start` is being retired. `cockpit log` and `cockpit scribe` already call
`upsertSession(...)` before writing, so the session becomes `tracked: true` on first write
without any `start`. Verify this holds after removing `start`.

### The `needs_your_call` / `wait` / `send` bridge — PRESERVE

Do not remove or weaken `cockpit log --needs-call`, `cockpit wait <id>`, or
`cockpit send <id> <answer>`. Autopilot (the dispatch plugin) depends on them. Only the
goal-setting and `start` paths are being removed.

### The context-inheriting fork — keep `subagent_type` omitted

`thoughtful` spawns the scribe fork via the Agent tool with **`subagent_type` omitted** so
the fork inherits the full conversation context (the "why"), cache-warm. Never convert
scribe into a custom `subagent_type` agent — that starts a clean slate and loses the "why".

### Plugin path resolution inside agent Bash

`CLAUDE_PLUGIN_ROOT` / `${...}` env vars are **not** reliable inside an agent Bash call.
Skill references resolve the CLI from the load-time "Base directory for this skill" banner.
Because `scribe.md` now lives under the `cockpit` skill, its CLI is
`<skill-base-dir>/scripts/cockpit.ts` (same skill — no `../` hop).

## Commit & branching style

- Current branch: `develop` (base for this work). Do not commit to `main`.
- Commit format: emoji + conventional (e.g. `🔧 refactor: …`, `🐛 fix: …`).
- **Do NOT auto-commit.** This overrides any general "auto-commit after a verified slice"
  convention an executor's harness might assume: the owner's standing rule is to confirm
  before committing. Leave commits to the owner, or surface a proposed commit and wait for
  explicit confirmation. When told to commit, use `/odin-git:simple-commit` (single change)
  or `/odin-git:atomic-commit` (several logical changes). Executors should not block waiting
  to commit — finish and verify the slice, then stop; committing is a separate, owner-gated step.

## Verification baseline

- Test: `bun test packages/monitor/skills/cockpit/scripts/`
- Single file: `bun test packages/monitor/skills/cockpit/scripts/<name>.test.ts`
- CLI smoke: `bun packages/monitor/skills/cockpit/scripts/cockpit.ts <subcommand> ...`
- Dev server: run by the **owner**, not by executors. Do not start servers or build.

## Decisions frozen during interview

- **Remove both goals** — session_goal and project_goal are deleted everywhere.
- **Delete `project-meta.md`** — the file is no longer written or read; `project-info`'s
  prose panel goes with it.
- **Retire `cockpit start`** — registration is automatic on first `log`/`scribe` write.
- **Global language config** — `~/.config/q-lab/cockpit/config.json`, `XDG_CONFIG_HOME`
  honored. No per-project override. Falls back to `English`.
- **Auto-logging is Claude-only** — via SessionStart hook. Codex uses manual `/thoughtful`.
- **One skill** — `cockpit` with a thin router `SKILL.md` and two mode references
  (`pilot.md`, `scribe.md`); `cockpit-scribe` and `thoughtful` skills are deleted.

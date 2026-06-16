# PLAN — cockpit-autolog

> Master spec + single source of truth. Task files live under `tasks/<bucket>/`; shared
> decisions are mirrored into `tasks/_context/`. Execution happens in a separate session.

## Context

The cockpit feature ships as **three** skills:

- `cockpit` — interactive goal-setting + manual decision logging.
- `cockpit-scribe` — background distiller run inside a context-inheriting fork.
- `thoughtful` — the opt-in toggle that tells the agent to spawn scribe forks.

The **goal-setting ceremony is the friction** that makes the owner stop reaching for the
feature: at session start it proposes a project goal + a session goal, gates on human
confirmation, then writes. The owner has decided goals add no value for them.

This plan collapses the three skills into **one automatic, low-friction system**:

- Auto-logging becomes the **default** — a `SessionStart` hook injects the thoughtful
  standing instruction on Claude Code. Codex has no hooks, so it keeps a manual
  `/thoughtful` command.
- **Both goals are removed entirely** (session_goal + project_goal), and `project-meta.md`
  is deleted along with `cockpit start`.
- The only surviving config is `log_language`, moved to a global file at
  `~/.config/q-lab/cockpit/config.json`.

Outcome: open a session → decisions get distilled to the trail automatically → the single
thing a human ever sets once is the log language.

## Goals

1. One skill `cockpit` whose `SKILL.md` is a **thin router** dispatching to
   `references/pilot.md` (interactive front) or `references/scribe.md` (auto-distill,
   invoked as `/cockpit scribe` by a context-inheriting fork). Keep `references/claude.md`
   + `references/codex.md` for provider specifics.
2. One command `commands/thoughtful.md` injecting the standing auto-log instruction.
3. One new `SessionStart` hook entry in `packages/monitor/.claude-plugin/plugin.json`
   echoing the thoughtful instruction so auto-logging is the default on Claude Code.
4. Remove both goals, delete `project-meta.md`, retire `cockpit start`.
5. `log_language` lives globally at `~/.config/q-lab/cockpit/config.json` (honoring
   `XDG_CONFIG_HOME`) via a new `config.ts` module + `cockpit config --log-language` /
   `cockpit config get-language` CLI; scribe + pilot read it via `cockpit config get-language`.
6. Delete `skills/cockpit-scribe/` and `skills/thoughtful/`.
7. Update tests, `CLAUDE.md`, and `CHANGELOG.md`.

## Non-goals

- **Keep** the `needs_your_call` / `wait` / `send` bridge — autopilot (the dispatch plugin)
  depends on it. It stays a CLI capability + documented in `pilot.md`.
- **Do NOT** convert scribe into a custom `subagent_type` agent — the context-inheriting
  fork must keep omitting `subagent_type` (a custom type loses the cache-warm "why").
- No per-project `log_language` override — global default only, falling back to English.
- No auto-start on Codex (no hooks there) — manual `/thoughtful` is the documented path.
- No frontend build step — `dashboard/dist/` is edited in place.

## Tech constraints

- Runtime: Bun (TypeScript, no transpile). `type` over `interface`. No external npm deps.
- Frontend: petite-vue in committed `dashboard/dist/`; edit in place, no build.
- Owner runs their own dev server — tests are the gate; do not build/serve after changes.
- Config path: `~/.config/q-lab/cockpit/config.json`, honoring `XDG_CONFIG_HOME`. This
  deviates from the existing `~/.cockpit` / `COCKPIT_HOME` house style and is the owner's
  explicit choice. `~/.cockpit/` (registry, daemon, per-project logs) is unchanged.

## Architecture

```
skills/cockpit/
├── SKILL.md            # thin router: Step 0 provider → mode dispatch (pilot | scribe)
└── references/
    ├── pilot.md        # interactive front: open dashboard, set/read language,
    │                   #   needs_your_call/wait/send, manual log — NO goal-setting
    ├── scribe.md       # auto-distill (was cockpit-scribe/SKILL.md); language via
    │                   #   `cockpit config get-language`; same-skill path resolution
    ├── claude.md       # provider specifics (unchanged)
    └── codex.md        # provider specifics (unchanged)
skills/cockpit/scripts/
    ├── cockpit.ts      # + `config` subcommand; `start` + goal machinery REMOVED;
    │                   #   log/scribe/wait/send kept; auto-register without start
    └── config.ts       # NEW: read/write ~/.config/q-lab/cockpit/config.json (XDG-aware)
commands/thoughtful.md                # NEW: standing-instruction injector
packages/monitor/.claude-plugin/plugin.json  # + 2nd SessionStart hook entry

DELETED: skills/cockpit-scribe/, skills/thoughtful/,
         per-project .cockpit/project-meta.md (no longer written or read)
```

### Data flow after the change

- A session logs decisions through `cockpit scribe` (background fork) or `cockpit log`
  (manual). The first write auto-registers the session in `~/.cockpit/registry.json`
  (`tracked: true`) — no `start` needed.
- Language for entries is resolved by the agent calling `cockpit config get-language`
  (global config → `English`).
- The dashboard reads the registry + per-project logs; goal fields and the project-meta
  prose panel are gone.

## Requirements & buckets

**backend** — config module + CLI, kernel goal/start removal, server-side goal readers.
**frontend** — dashboard goal UI removal (the project-info prose field has no SPA consumer,
so its removal is fully covered server-side in the backend bucket).
**skills** — skill router + pilot/scribe references + thoughtful command + SessionStart hook.
**docs** — CLAUDE.md + CHANGELOG, then the closing final-review gate.

## Task index

| Task | Depends on | Summary |
|---|---|---|
| backend/01-config-module | none | `config.ts` + `config.test.ts` (XDG-aware global config) |
| backend/02-config-cli | backend/01 | `cockpit config` subcommand in `cockpit.ts` |
| backend/03-retire-start-strip-goals-kernel | backend/02 | remove start + goal machinery from `cockpit.ts`; rewrite tests |
| backend/04-strip-goals-server | backend/03 | remove goal readers from `registry.ts` + `project-info.ts`; fix tests (rewrites start-based fixtures → needs the no-start path) |
| frontend/01-remove-goal-ui | backend/03 | strip goal rendering from dashboard `dist/` (incl. hero subtitle binding) |
| skills/01-skill-router-and-pilot | backend/02, backend/03, skills/02 | thin `SKILL.md` router + `references/pilot.md` |
| skills/02-scribe-reference | backend/02 | `references/scribe.md`; delete `skills/cockpit-scribe/` |
| skills/03-thoughtful-command | skills/01, skills/02 | `commands/thoughtful.md`; delete `skills/thoughtful/` |
| skills/04-sessionstart-hook | skills/03 | 2nd `SessionStart` entry echoing the instruction |
| docs/01-docs-claude-md-changelog | backend/03, backend/04, frontend/01, skills/01–04 | CLAUDE.md + CHANGELOG |
| docs/02-final-review | backend/01–04, frontend/01, skills/01–04, docs/01 | **Final review** — holistic gate (transitive closure over all tasks) |

## Cross-bucket dependencies

- `skills` references + thoughtful depend on the `config` CLI existing (backend/02) and on
  `start` being retired (backend/03) so `pilot.md` never points at a removed command. The
  router (skills/01) depends on the scribe reference (skills/02) existing before it links to
  it, and the thoughtful command (skills/03) depends on the router so `/cockpit scribe`
  resolves — giving a runnable slice at every step.
- `frontend/01` follows the kernel goal-record removal (backend/03). There is no separate
  frontend prose task: the SPA never consumes `/api/project-info`, so the prose removal lives
  entirely in the server-strip task (backend/04).
- `docs` depends on all implementation tasks; `final-review` depends on `docs`.

## Eval rubric

Shared default in `tasks/_context/rubric.md`: Correctness ×3 / Test coverage ×2 /
Interface & readability ×1 / Assumptions & docs ×1; pass `> 4.0`; `Correctness < 4` veto.
Frontend tasks fold "no visual/behavior regression" into Correctness and rely on the
owner's dev server for the manual check (no automated frontend tests in this repo).

## Failure modes & rollback

- **Half-written tree** — if any write step fails, `trash docs/cockpit-autolog/` and re-run
  from scaffold.
- **Sessions that relied on `start`** — `log`/`scribe` must auto-register; verify a fresh
  session can write without ever calling start.
- **Stale goal records in old logs** — the dashboard must tolerate a legacy line-1
  `type:"goal"` record gracefully (ignore it), not crash.
- **Config path** — if `~/.config/q-lab/cockpit/` is unwritable, `get-language` falls back
  to `English` rather than throwing.

## Open questions

None outstanding (resolved during the interview).

## Verification (end to end)

- `bun test packages/monitor/skills/cockpit/scripts/` is green.
- `cockpit config --log-language zh-TW` then `cockpit config get-language` prints `zh-TW`;
  with no config, prints `English`.
- Owner's dev server: dashboard renders the decision trail with no goal UI and no
  project-prose panel, no console errors.
- Fresh Claude session shows the injected thoughtful instruction; a worthy chunk of work
  spawns a context-inheriting fork that writes scribe entries via `/cockpit scribe`.

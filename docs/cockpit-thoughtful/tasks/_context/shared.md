# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

The `monitor` plugin (in the `q-lab-marketplace` Claude Code + Codex plugin repo) bundles a usage dashboard and a per-project **cockpit**. Cockpit captures a session's decision trail and renders it in a local web dashboard. This work adds a **thoughtful mode**: the agent auto-writes typed decision-trail entries by forking a background scribe, instead of relying on `cockpit start` + manual `cockpit log`.

All cockpit code lives under `packages/monitor/skills/cockpit/`:
- `scripts/` — Bun/TypeScript CLI + daemon + SSE engines.
- `dashboard/dist/` — committed petite-vue SPA (no build step), "Night Flight" dark design system.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Uses `bun:sqlite`, `Bun.serve`, `Bun.file`, `Bun.spawnSync`.
- **Frontend**: petite-vue (not full Vue), vanilla ES modules in `dashboard/dist/modules/`, single `style.css`. Vendored libs (`marked`, `DOMPurify`, `highlight.js`) committed under `dashboard/dist/vendor/`.
- **Storage**: JSONL log files + a JSON registry + a markdown meta file (paths below). No DB for cockpit logs.
- **No external npm dependencies** — everything is Bun built-ins or committed vendor files.

## Code style

- **`type` over `interface`** in TypeScript (enforced repo-wide).
- Match existing file style; surgical changes only — touch only what the task requires.
- Comments in English.
- Frontend modules are plain ES modules exporting an `init`-style factory; petite-vue store lives in `app.js`.
- Authoritative source (verification only): existing files in `packages/monitor/skills/cockpit/scripts/` and `dashboard/dist/`.

## File / directory layout

- **CLI**: `packages/monitor/skills/cockpit/scripts/cockpit.ts` — subcommands dispatched in `main()` via a `switch`.
- **Tests**: co-located `*.test.ts` next to each script; run with `bun test`. Pattern: spawn the CLI with `Bun.spawnSync(["bun", CLI, ...args], { cwd, env: { ...process.env, COCKPIT_HOME } })` against temp dirs created with `mkdtempSync`.
- **Skills**: each skill is a directory `packages/monitor/skills/<name>/` containing `SKILL.md` with YAML frontmatter. Skills are **auto-discovered** from `skills/` (the `"skills": "./skills/"` key in both plugin manifests) — no explicit registration needed.
- **Dashboard**: `packages/monitor/skills/cockpit/dashboard/dist/` — `index.html`, `app.js`, `modules/*.js`, `style.css`. Committed as-is.

## Storage paths (cockpit)

- **Log**: `<project>/.cockpit/logs/<sessionId>.jsonl` — one JSON record per line. Computed by `logPathFor(project, sessionId)` in `cockpit.ts`.
- **Registry**: `$COCKPIT_HOME/registry.json` (default `~/.cockpit/registry.json`) — `{ sessions: RegistryEntry[] }`. A session is `tracked:true` in the dashboard **iff** it has a registry entry.
- **Meta**: `<project>/.cockpit/project-meta.md` — YAML-frontmatter file holding `project_goal`, `created`, `owner`, `log_language` (default `English`). Read via `readMetaField(metaPath, field)`.

## Commit & branching style

- Branch off: `develop` (the repo's main branch).
- Commit format: emoji + conventional (e.g. `🎨 style:`, `🔧 release:`, `✨ feat:`).
- Use `/odin-git:simple-commit` (single change) or `/odin-git:atomic-commit` (multiple logical changes). **Ask the user before committing.**

## Verification baseline

- **Test**: `bun test packages/monitor/skills/cockpit/scripts/` — full cockpit suite.
- **Run CLI**: `bun packages/monitor/skills/cockpit/scripts/cockpit.ts <sub> [args]`.
- **Run daemon (isolated for dev)**: `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999` (a live channel-flagged session keeps respawning the cached daemon on 5858, so test working-tree changes on an isolated port + home).
- **Dev server**: the user runs their own; sub-agents do **not** start one.

## Decisions frozen during interview

- **Auto-register** — `cockpit scribe` registers the session on first write (`upsertSession`), so thoughtful sessions become `tracked:true` and visible without `cockpit start`. No goal record is written.
- **Dedup via log-tail** — no watermark file. The scribe fork calls `cockpit scribe --recent` to see what's already logged and avoids repeats.
- **`kind` not `type`** — the lens axis is a new `kind` field; `type` stays the record discriminant (`goal`/`decision`/`response`).
- **Fork, not clean subagent** — the distiller inherits context (cache-warm, knows the "why"); instructions ride the spawn prompt because fork excludes a custom `subagent_type`.
- **Best-effort triggering** — judgment-based; trivial turns skipped; no Stop-hook in v1.
- **Three version fields bump together** — `marketplace.json` (`plugins[].version` for `monitor`), `packages/monitor/.claude-plugin/plugin.json`, `packages/monitor/.codex-plugin/plugin.json`; plus a `CHANGELOG.md` entry.

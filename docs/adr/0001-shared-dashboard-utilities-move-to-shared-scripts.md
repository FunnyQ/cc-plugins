# ADR-0001: Shared dashboard utilities move into monitor/skills/shared/scripts/

- Status: Accepted
- Date: 2026-06-30

## Context

`cockpit-server.ts` and `atlas-server.ts` each maintained their own, word-for-word
identical MIME-type table and `serveStatic()` / `isInsideDist()` implementation.
Inside usage-dashboard, `api.ts` and `live.ts` separately redefined the same
`CLAUDE_DIR` / `CODEX_DIR` path constants and `readSessionFiles()`. A fix to static
serving or session-file parsing in one copy did not reach the other.

## Considered alternatives

- Keep each skill maintaining its own copy. Rejected: the two copies were already
  byte-identical, so the duplication carried no isolation benefit, only double
  maintenance cost.

## Decision

Extract cross-cutting logic into `packages/monitor/skills/shared/scripts/{path-inside,static-server}.ts`,
shared by both cockpit and usage-dashboard, and into
`packages/monitor/skills/usage-dashboard/scripts/{paths,session-files}.ts`, shared
within usage-dashboard's own `api.ts` and `live.ts`. `atlas-server.ts` also switched
to importing cockpit's `isAlive` (from `cockpit-channel.ts`) and `jsonResponse` /
`jsonError` (from `http.ts`) instead of reimplementing them.

## Consequences

Both dashboard skills now share one static-file server and one MIME table; a fix
lands once. New static-serving, path-containment, or session-file code in either
skill must import from `shared/scripts/` (or usage-dashboard's own `paths.ts` /
`session-files.ts`) rather than reintroducing a local copy. `shared/scripts/` lives
inside the `monitor` plugin, so only cockpit and usage-dashboard may depend on it —
this pattern must still respect the cross-plugin boundary described in
"Plugins never import each other" (ADR-0026).

## Evidence

- **Two dashboard skills carried byte-identical static-file servers** — `cockpit-server.ts`
  and `atlas-server.ts` each defined their own MIME map and `serveStatic()` /
  `isInsideDist()`; `api.ts` and `live.ts` each redefined `CLAUDE_DIR` / `CODEX_DIR`
  and `readSessionFiles()`. Extracting to `shared/scripts/{path-inside,static-server}.ts`
  and `usage-dashboard/scripts/{paths,session-files}.ts` removed both duplicates in
  one pass; `atlas-server.ts` also switched to importing cockpit's `isAlive` and
  `jsonResponse`/`jsonError` instead of reimplementing them.
  Session `91a674e5-e84f-4095-b958-74117c85adad`, entry `5cee7895-d86b-4a4c-9acc-1ee0cf526593`, 2026-06-30.

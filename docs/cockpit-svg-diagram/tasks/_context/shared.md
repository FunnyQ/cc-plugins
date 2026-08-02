# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`cc-plugins` is a Claude Code / Codex plugin marketplace. This work lives entirely inside one skill of one plugin: `packages/monitor/skills/cockpit/`. Cockpit is a per-project session dashboard; its decision trail is a JSONL log rendered as cards in a local SPA. A card may carry a diagram. Today that diagram must be Mermaid source. This work adds raw SVG as a second accepted input.

## Tech stack

- **Runtime**: Bun. TypeScript with no transpile step. `bun test` is the test runner.
- **CLI**: `packages/monitor/skills/cockpit/scripts/*.ts`, plain Node-style modules run under Bun.
- **Frontend**: `packages/monitor/skills/cockpit/dashboard/dist/` — a committed, build-free SPA. petite-vue plus hand-written ES modules under `dashboard/dist/modules/`.
- **Vendored libs**: `dashboard/dist/vendor/` — no npm install for the frontend. DOMPurify is `vendor/purify.es.mjs`; mermaid is `vendor/mermaid.min.js`, a ~3.3MB UMD bundle that sets `globalThis.mermaid`.
- **Storage**: one JSON object per line in `<repo>/.cockpit/logs/<sessionId>.jsonl`.
- **The only runtime npm dep**: `happy-dom`, resolved by Bun's auto-install, used by `scripts/diagram-lint.ts` to run mermaid's parser headless. Reuse it; do not add another dependency.

## Code style

- Use `type`, never `interface`.
- No new npm dependency in any task. Everything needed is already vendored or auto-installed.
- Frontend modules are plain ES modules with no build step. Whatever you write in `dashboard/dist/modules/*.js` is what ships.
- Keep every DOM-bound import **lazy** inside `dashboard/dist/modules/diagram.js`. The module's static surface must stay importable under plain Bun with no DOM — `scripts/diagram-theme.test.ts` enforces this by importing it directly. Anything needing `document`, `DOMParser`, or DOMPurify is loaded inside a function, not at module top level.
- Comment *why*, never *what*. The existing files in this skill are dense with rationale comments explaining non-obvious constraints; match that density when you encode a constraint.
- Build the smallest thing that satisfies the task. Do not add a layer, option, or abstraction unless a stated requirement fails without it.
- Change only the lines the task requires.

## File / directory layout

Every path below is from the repo root.

- `packages/monitor/skills/cockpit/scripts/` — CLI and daemon TypeScript. Tests live beside their subject as `<name>.test.ts`.
- `packages/monitor/skills/cockpit/dashboard/dist/modules/` — frontend ES modules.
- `packages/monitor/skills/cockpit/dashboard/dist/style.css` — the single stylesheet. Night Flight tokens are declared on `:root` at the top.
- `packages/monitor/skills/cockpit/references/` — the authoring documentation an agent reads before writing a diagram.

A test for frontend logic still lives in `scripts/` (that is where `bun test` runs, and where `diagram-theme.test.ts` already sits importing a `dashboard/dist/modules/*.js` file).

## Commit & branching style

- The repo runs GitHub Flow. `main` is the only long-lived branch.
- Do not commit. The human runs `/chronicle:commit` when the tree is ready.
- Do not bump any `plugin.json` version and do not touch `CHANGELOG.md`. `/chronicle:release` owns those.

## Verification baseline

- Test suite: `bun test packages/monitor/skills/cockpit/scripts/`
- A single file: `bun test packages/monitor/skills/cockpit/scripts/<name>.test.ts`
- Isolated live daemon (never contend with a running one):
  `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999`
- Do not start or restart the user's real cockpit daemon on port 5858.

## Decisions frozen during interview

- **Detection is content-sniffing, in exactly one place.** The CLI decides. There is no `--diagram-format` flag and none is to be added. The frontend never sniffs; it routes on the stored field.
- **`@` is an input channel, orthogonal to format.** `--diagram @path` means "read the argument from this file". The content is then sniffed like any other. There is no extension rule.
- **`diagram_format` is written only for SVG.** A Mermaid entry keeps exactly the shape it has today. Absent means Mermaid.
- **The CLI validates; it never rewrites.** What the author passed is byte-for-byte what lands in the JSONL.
- **The frontend sanitize is the only security boundary.** The daemon streams the JSONL straight to the browser, so the browser must sanitize regardless. A second sanitize at write time is explicitly rejected.
- **No recolouring of author SVG.** The author opts into the theme by writing `currentColor` or `var(--token)`. No heuristic maps their colours onto the palette.
- **No size cap on `--diagram`.** Deliberately deferred.
- **Fail closed in the style-scoping pass.** A CSS rule that cannot be confidently rewritten is dropped, never passed through.
- **Mermaid stays the default in the documentation.** SVG is framed as an escape hatch with a listed set of cases, so an agent does not flee to hand-written SVG over one syntax error.

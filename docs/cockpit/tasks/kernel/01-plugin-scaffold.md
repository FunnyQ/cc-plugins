# KERNEL-01: Plugin scaffold

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
>
> **Depends on**: none — foundation task
> **Blocks**: kernel/02, server/01
> **Status**: done

## Goal

A new `cockpit/` plugin exists in the `cc-plugins` marketplace, registered and discoverable, with the directory skeleton every later task fills.

## Files to create / modify

- `cockpit/.claude-plugin/plugin.json` (new) — plugin manifest, `version: "0.1.0"`.
- `.claude-plugin/marketplace.json` (modify) — add a `cockpit` entry to `plugins[]`.
- `cockpit/skills/cockpit/scripts/.gitkeep` (new) — placeholder so the dir is tracked.
- `cockpit/skills/cockpit/dashboard/dist/.gitkeep` (new) — placeholder for the SPA.
- `cockpit/skills/cockpit/dashboard/dist/vendor/` (new) — copy the 4 vendor libs from token-atlas (see below).
- `cockpit/README.md` (new) — one-paragraph plugin description.

## Implementation notes

### `plugin.json`

Mirror `cc-plugins/token-atlas/.claude-plugin/plugin.json`. Minimum:

```json
{
  "name": "cockpit",
  "version": "0.1.0",
  "description": "Per-project local web cockpit — set a goal, watch the decision trail steer toward it. Goal capture + distilled decision log + live session view."
}
```

### `marketplace.json` entry

Add alongside the existing `token-atlas` object in `plugins[]`:

```json
{
  "name": "cockpit",
  "source": "./cockpit",
  "description": "Per-project driving cockpit — goal + decision log + live session view.",
  "version": "0.1.0"
}
```

Keep this `version` equal to `plugin.json`'s `version` — they must always match.

### Vendor libs

Copy these four files from `cc-plugins/token-atlas/skills/dashboard/dashboard/dist/vendor/` into `cockpit/skills/cockpit/dashboard/dist/vendor/`:

- `petite-vue.es.js`
- `marked.esm.js`
- `purify.es.mjs`
- `highlight.esm.js`

Do **not** copy `chart.umd.js` — cockpit has no charts.

### Directory shape after this task

```
cockpit/
├── .claude-plugin/plugin.json
├── README.md
└── skills/cockpit/
    ├── scripts/            (empty but tracked)
    └── dashboard/dist/
        └── vendor/         (4 libs)
```

## Acceptance criteria

- [x] `cockpit/.claude-plugin/plugin.json` exists with `name`, `version`, `description`.
- [x] `.claude-plugin/marketplace.json` lists both `token-atlas` and `cockpit`, and is valid JSON.
- [x] `cockpit` entry version in `marketplace.json` equals `plugin.json` version.
- [x] The 4 vendor libs are present under `cockpit/skills/cockpit/dashboard/dist/vendor/` (no `chart.umd.js`).
- [x] The directory skeleton above exists.

## Verification

- [x] `jq . cc-plugins/.claude-plugin/marketplace.json` parses without error and shows two plugins.
- [x] `jq -r '.version' cockpit/.claude-plugin/plugin.json` equals the cockpit entry's version in `marketplace.json`.
- [x] `ls cockpit/skills/cockpit/dashboard/dist/vendor/` lists exactly the 4 expected files.

## Out of scope

- The actual CLI / server / SPA code — Deferred to the later kernel, server, and ui tasks.
- Bumping versions beyond `0.1.0` — Deferred until first release.

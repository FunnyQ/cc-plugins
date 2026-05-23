# UI-04: Info column & DESIGN.md theming

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: ui/01
> **Blocks**: —
> **Status**: done

## Goal

The right column shows the project's locked settings — goal + `project-meta.md` prose + `CLAUDE.md` rendered read-only — and the whole cockpit is themed per-project from that project's `DESIGN.md` design tokens.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/serve-dashboard.ts` (modify) — add `GET /api/project-info?project=<abs>` returning meta + CLAUDE.md + parsed DESIGN.md tokens.
- `cockpit/skills/cockpit/scripts/project-info.ts` (new) — read meta/CLAUDE.md, parse DESIGN.md → token map.
- `cockpit/skills/cockpit/dashboard/dist/modules/info.js` (new) — render the info column + apply theme.
- `cockpit/skills/cockpit/dashboard/dist/app.js` (modify) — mount the column; apply theme on project change.
- `cockpit/skills/cockpit/dashboard/dist/style.css` (modify) — info-column styling + reference the themeable CSS variables.

## Implementation notes

### `GET /api/project-info?project=<abs>`

Returns:

```json
{
  "projectGoal": "…",
  "meta": "markdown body of project-meta.md (prose after frontmatter)",
  "claudeMd": "contents of <project>/CLAUDE.md, or null",
  "tokens": { "colorBg": "#…", "colorFg": "#…", "accent": "#…", "fontSans": "…", "radius": "…" }
}
```

- `projectGoal` + `meta`: from `<project>/.cockpit/project-meta.md` (frontmatter `project_goal` + prose body).
- `claudeMd`: read `<project>/CLAUDE.md` if present (null otherwise). Path-confine to the project root.
- `tokens`: parsed from `<project>/DESIGN.md` (see below).

### DESIGN.md → tokens  ⚠️ see Known gap

DESIGN.md follows the **Google DESIGN.md open standard** (github.com/google-labs-code/design.md; official CLI `@google/design.md` with `lint/diff/export`). The exact token shape must be confirmed before implementing — see the spec saved in Obsidian (`📥 inbox/2026-05-23-design-md-specification.md`) or run the CLI's `export`.

Two viable approaches; pick after confirming the format:
1. **Shell out to `@google/design.md export`** (if the CLI emits JSON tokens) — preferred, don't reinvent parsing.
2. **Parse the DESIGN.md token block ourselves** into a flat `{ name: value }` map.

Map the standard tokens onto cockpit's CSS custom properties. If DESIGN.md is absent, return `tokens: null` and the SPA keeps the shell's neutral defaults.

### Theming application (SPA)

- On project selection, fetch `/api/project-info`; if `tokens` present, set the corresponding CSS custom properties on `:root` (the same vars the SPA shell defined). So each project's cockpit wears that project's visual identity.
- Reset to defaults when no tokens.

### Info column rendering

- Goal (headline) + meta prose + CLAUDE.md, all via `marked` + `DOMPurify` (read-only display; the renderer must **not** restructure the prose — display only).
- CLAUDE.md collapsible if long.

## Acceptance criteria

- [x] `GET /api/project-info?project=<abs>` returns `projectGoal`, `meta`, `claudeMd` (or null), and `tokens` (or null).
- [x] The info column renders the goal, project-meta prose, and CLAUDE.md as sanitized read-only markdown.
- [x] When the selected project has a DESIGN.md, the cockpit's CSS variables change to its tokens; switching to a project without DESIGN.md restores neutral defaults.
- [x] CLAUDE.md path is confined to the project root (no traversal).
- [x] The renderer only displays prose — it does not parse/restructure it into custom widgets.

## Verification

- [x] In a project with a DESIGN.md + CLAUDE.md: daemon running, select it (Q) → info column shows goal/meta/CLAUDE.md and the theme colors shift to DESIGN.md's.
- [x] `curl -s "localhost:5858/api/project-info?project=<abs>" | jq '.tokens'` shows the parsed token map.
- [x] Select a project with no DESIGN.md → `tokens` is null and the UI uses defaults.

## Out of scope

- Editing DESIGN.md / CLAUDE.md from the UI — read-only only.
- Authoring a DESIGN.md spec or token format — Adopt the Google standard; do not invent one.
- Live-reloading the theme when DESIGN.md changes mid-session — Deferred; fetch on project selection is enough for v1.

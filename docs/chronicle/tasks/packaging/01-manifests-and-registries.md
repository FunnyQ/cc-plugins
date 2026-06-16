# PACKAGING-01: Manifests and marketplace registries

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: commit/03, pr/03
> **Status**: todo

## Goal

Write chronicle's two plugin manifests at version `0.1.0` and register the plugin in both marketplace registries, so it installs in the Claude and Codex marketplaces and discovers both skills.

## Files to create / modify

- `packages/chronicle/.claude-plugin/plugin.json` (new) — Claude manifest.
- `packages/chronicle/.codex-plugin/plugin.json` (new) — Codex manifest (+ skills + interface).
- `.claude-plugin/marketplace.json` (modify) — add the `chronicle` plugin entry.
- `.agents/plugins/marketplace.json` (modify) — add the `chronicle` plugin entry.

## Implementation notes

Follow `packages/relay/`'s manifests exactly for shape (see `../_context/shared.md` → "plugin.json shape").

### Claude manifest (`.claude-plugin/plugin.json`)

```json
{
  "name": "chronicle",
  "version": "0.1.0",
  "description": "Write and guard your project's history — craft commits (auto simple/atomic) and author reviewer-legible PRs/MRs enriched by the cockpit decision trail.",
  "author": { "name": "Q" },
  "license": "MIT",
  "keywords": ["chronicle", "git", "commit", "pull-request", "merge-request", "github", "gitlab", "history"]
}
```

### Codex manifest (`.codex-plugin/plugin.json`)

Same fields as above, PLUS `"skills": "./skills/"` and an `interface` block:

```json
{
  "displayName": "Chronicle",
  "shortDescription": "Craft commits and author reviewer-legible PRs/MRs.",
  "longDescription": "Chronicle writes and guards your project's history: a unified commit skill that auto-decides simple vs atomic, and a PR/MR author that turns commit history plus the cockpit decision trail into a reviewer-legible request on GitHub or GitLab.",
  "developerName": "Q",
  "category": "Productivity",
  "capabilities": ["Interactive", "Write"],
  "defaultPrompt": ["Commit my changes.", "Open a PR for this branch."],
  "brandColor": "#7A6FB0"
}
```

(Keep the two `name`/`version`/`description`/`author`/`license`/`keywords` blocks identical across both files. `brandColor` is a suggestion — any hex distinct from relay's `#8B6BB1` is fine.)

### `.claude-plugin/marketplace.json` — append to `plugins[]`

```json
{
  "name": "chronicle",
  "source": "./packages/chronicle",
  "description": "Write and guard your project's history — craft commits (auto simple/atomic) and author reviewer-legible PRs/MRs enriched by the cockpit decision trail."
}
```

### `.agents/plugins/marketplace.json` — append to `plugins[]`

```json
{
  "name": "chronicle",
  "source": { "source": "local", "path": "./packages/chronicle" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Productivity"
}
```

Do NOT add a `version` field to either registry entry — versions live only in the plugin.json files.

## Acceptance criteria

- [ ] Both `plugin.json` files exist, are valid JSON, and carry `version: "0.1.0"` with identical name/description/author/license/keywords.
- [ ] The Codex manifest has `"skills": "./skills/"` and a complete `interface` block.
- [ ] `chronicle` appears once in each marketplace registry with the correct source shape for that registry.
- [ ] Neither registry entry has a `version` field.
- [ ] Existing `monitor`/`dispatch`/`relay` entries are untouched.

## Verification

- [ ] `bun -e 'JSON.parse(await Bun.file("packages/chronicle/.claude-plugin/plugin.json").text())'` and the Codex one both parse.
- [ ] `bun -e 'JSON.parse(await Bun.file(".claude-plugin/marketplace.json").text())'` and the agents one both parse.
- [ ] `grep -c '"name": "chronicle"'` across both registries returns 1 each.
- [ ] `git diff` shows only additive changes to the two registries.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | invalid JSON / wrong source shape / version added to registry | parses but a field or registry shape is off | both manifests + both registries correct, version only in plugin.json |
| Test coverage | ×2 | nothing checked | one file parse-checked | all four files parse-checked + grep counts verified |
| Interface & readability | ×1 | inconsistent across files | mostly aligned | name/desc identical across manifests, clean interface block |
| Assumptions & docs | ×1 | unexplained divergence | partial | matches relay's pattern, brandColor distinct |

## Out of scope

- Bumping monitor/dispatch/relay — Deferred. chronicle is independently versioned.
- A SessionStart/PostToolUse hook — Deferred. v1 ships skills only, no hooks.

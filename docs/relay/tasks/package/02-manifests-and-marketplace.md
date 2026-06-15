# PACKAGE-02: Manifests and marketplace registration

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backends/05
> **Status**: todo

## Goal

Make `relay` a real, installable plugin: write both plugin manifests at `0.1.0` and register `relay` in both marketplace registries.

## Files to create / modify

- `packages/relay/.claude-plugin/plugin.json` (new) — Claude manifest.
- `packages/relay/.codex-plugin/plugin.json` (new) — Codex manifest.
- `.claude-plugin/marketplace.json` (modify) — add `relay` to `plugins[]`.
- `.agents/plugins/marketplace.json` (modify) — add `relay` to `plugins[]`.

## Implementation notes

Match the shape of the existing `dispatch` manifests and registry entries (same repo).

`packages/relay/.claude-plugin/plugin.json`:
```json
{
  "name": "relay",
  "version": "0.1.0",
  "description": "Delegate a task to another harness — relay work to the codex, opencode, or claude CLI (delegate / review / image), capture the result, and report back.",
  "author": { "name": "Q" },
  "license": "MIT",
  "keywords": ["relay", "delegate", "codex", "opencode", "claude", "review", "image", "cross-harness"]
}
```
No hooks (relay has none).

`packages/relay/.codex-plugin/plugin.json`: same `name`/`version`/`description`/`author`/`license`/`keywords`, plus:
```json
{
  "skills": "./skills/",
  "interface": {
    "displayName": "Relay",
    "shortDescription": "Delegate tasks to another harness's CLI (codex / opencode / claude).",
    "longDescription": "<2–3 sentences describing delegate/review/image + the capability matrix>",
    "developerName": "Q",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Delegate this task to codex.",
      "Have opencode review my changes.",
      "Ask claude to refactor this."
    ],
    "brandColor": "#<pick one distinct from monitor/dispatch>"
  }
}
```

`.claude-plugin/marketplace.json` — append to `plugins[]`:
```json
{ "name": "relay", "source": "./packages/relay", "description": "<same one-liner as the Claude manifest>" }
```

`.agents/plugins/marketplace.json` — append to `plugins[]`:
```json
{
  "name": "relay",
  "source": { "source": "local", "path": "./packages/relay" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Productivity"
}
```

**Canonical description string** (use verbatim where "the one-liner" is referenced):
> `Delegate a task to another harness — relay work to the codex, opencode, or claude CLI (delegate / review / image), capture the result, and report back.`

Consistency contract (objectively checkable):
- Claude `plugin.json` `description` **===** the canonical string.
- Claude `marketplace.json` relay entry `description` **===** the canonical string.
- Codex `plugin.json` `description` **===** the canonical string; its `interface.shortDescription` must contain `codex / opencode / claude` and `interface.longDescription` must contain `delegate`, `review`, and `image`.

Version surfaces: relay has **three** — the two `plugin.json` files (this task) **and** the `SKILL.md` frontmatter `version` (owned by the SKILL task). The relay `marketplace.json` entries are **not** per-plugin versioned. Keep both `plugin.json` files at `0.1.0` and identical here; the SKILL frontmatter version is set in its own task, and final review verifies all three agree. Keep descriptions consistent across all four files.

## Acceptance criteria

- [ ] `packages/relay/.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` both exist at `version: "0.1.0"` with matching name/description.
- [ ] `.codex-plugin/plugin.json` has `"skills": "./skills/"` and an `interface` block.
- [ ] `relay` appears in `.claude-plugin/marketplace.json` `plugins[]` and `.agents/plugins/marketplace.json` `plugins[]`.
- [ ] All JSON files are valid (parse without error); the Claude `plugin.json`, Codex `plugin.json`, and Claude `marketplace.json` relay descriptions all equal the canonical string; Codex `interface` short/long descriptions contain the required phrases.

## Verification

- [ ] `bun -e "['packages/relay/.claude-plugin/plugin.json','packages/relay/.codex-plugin/plugin.json','.claude-plugin/marketplace.json','.agents/plugins/marketplace.json'].forEach(f=>JSON.parse(require('fs').readFileSync(f)))"` exits 0 (all valid JSON).
- [ ] `grep -c '"name": "relay"'` across the two marketplace files returns 1 each.
- [ ] Both `plugin.json` versions read `0.1.0`.
- [ ] A small script asserts the three relay `description` fields all equal the canonical string and the Codex `interface` short/long contain the required phrases (e.g. `bun -e "…JSON.parse…assert…"`).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | invalid JSON or missing registry entry | all files present but a field/shape mismatches the dispatch precedent | both manifests + both registries correct, versions aligned, shapes match precedent |
| Test coverage | ×2 | no validation | JSON-parse only | JSON valid + registry presence + version-match checks |
| Interface & readability | ×1 | inconsistent descriptions | minor drift | consistent descriptions/keywords across all four files |
| Assumptions & docs | ×1 | version discipline ignored | partial | three-field version note honored; brandColor chosen distinct |

## Out of scope

- Bumping `monitor`/`dispatch` versions — Deferred. Reason: relay is additive; other plugins are untouched.
- A SessionStart/PostToolUse hook — Deferred. Reason: relay needs no hooks.

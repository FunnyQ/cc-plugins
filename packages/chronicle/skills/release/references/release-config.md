# `.chronicle/release.json` — the release config

Chronicle records a repo's release shape **once** in a committed
`.chronicle/release.json`, then every later `/chronicle:release` reads it instead of
re-guessing. Auto-detection (`analyze-release.ts`'s `detectShape`) only seeds the
first-run interview defaults — the committed config is the source of truth.

Commit the file (it's shared team/session state, not a personal dotfile).

## Schema

```jsonc
{
  // "whole-repo": one release unit, one repo-wide tag.
  // "per-component": independently-versioned units, each with a scoped tag.
  "mode": "whole-repo",

  // Tag template. {version} is required; {component} only in per-component mode.
  "tag": "v{version}",                         // per-component: "{component}-v{version}"

  "changelog": "CHANGELOG.md",
  "branches": { "develop": "develop", "main": "main" },

  // whole-repo bump targets. [] = changelog + tag only (no version file to bump).
  "versionFiles": [
    { "path": "frontend/package.json", "kind": "json" },
    { "path": "config/application.rb", "pattern": "VERSION\\s*=\\s*[\"']([^\"']+)[\"']" }
  ]

  // per-component instead uses "components" (see below); omit "versionFiles".
}
```

### `versionFiles` / component `versionFiles` entries

Each entry is one of:

- `{ "path": "...", "kind": "json" | "toml" | "text" }` — a known format:
  - `json` — the first top-level `"version": "..."` (plugin.json, package.json).
  - `toml` — `version = "..."` (Cargo.toml, pyproject.toml).
  - `text` — the whole file is the version (a `VERSION` file).
- `{ "path": "...", "pattern": "...(capture)..." }` — a regex whose **first capture
  group** is the version substring. This is the escape hatch for anything
  non-standard — a Rails `config/application.rb` constant, a `version.rb`, a
  `__version__` in Python, a version baked into a shell script. Chronicle rewrites
  only the captured span, so surrounding formatting is untouched.

### per-component mode

```jsonc
{
  "mode": "per-component",
  "tag": "{component}-v{version}",
  "changelog": "CHANGELOG.md",
  "branches": { "develop": "develop", "main": "main" },
  "components": [
    {
      "name": "chronicle",
      "path": "packages/chronicle",
      "versionFiles": [
        { "path": "packages/chronicle/.claude-plugin/plugin.json", "kind": "json" },
        { "path": "packages/chronicle/.codex-plugin/plugin.json", "kind": "json" }
      ]
    }
  ]
}
```

`path` scopes a component's changelog diff (`git log <tag>..HEAD -- <path>`) and its
"did it change?" commit count. Each component lists **all** of its version files —
in this repo that's the paired Claude + Codex `plugin.json` (marketplace registries
carry no version and are never listed). The changelog header is per-component (e.g.
`## [chronicle 0.5.0]`); see `monorepo-release.md`.

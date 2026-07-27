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

  // "git-flow" (default when the field is absent) | "github-flow". See below.
  "workflow": "git-flow",

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

### `workflow` / `branches`

`workflow` says how `/chronicle:release auto` finishes, and which branches the config
has to name. It uses the same vocabulary as `.chronicle/pr.json`:

- **`"git-flow"`** — two long-lived branches. `branches` names both `develop` and
  `main`. The finish commits the bump on `develop`, merges `develop → main`, cuts
  every tag on that merge commit, merges back, and ends on `develop`.
- **`"github-flow"`** — one long-lived branch. `branches` names only `main` (call it
  whatever the repo calls it — `main`, `master`, `trunk`); a `develop` key is
  ignored. The finish commits the bump on `main`, cuts every tag on **that bump
  commit**, and ends on `main`. Nothing is merged.

```jsonc
{
  "mode": "whole-repo",
  "workflow": "github-flow",
  "tag": "v{version}",
  "changelog": "CHANGELOG.md",
  "branches": { "main": "main" },
  "versionFiles": []
}
```

Either way **every tag of a coordinated release lands on one commit** — the merge
commit on git-flow, the bump commit on github-flow.

**A missing `workflow` means `git-flow`.** Configs written before the field existed
keep working byte-for-byte, and Chronicle never re-detects the workflow behind a
committed config — a repo that drops `develop` later edits its config (add
`"workflow": "github-flow"`, remove `branches.develop`) rather than being silently
re-shaped. Detection only seeds the first-run interview: no `develop` branch (local
or `origin/`) suggests `github-flow`.

That edit is the **only** migration this feature needs, and only for a repo whose
committed config names a `develop` that no longer exists. The analyzer reports that
case as `workflowDrift`, so `/chronicle:release` offers the fix instead of failing
mid-finish. Every other committed config — `develop` still alive — needs no change.

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

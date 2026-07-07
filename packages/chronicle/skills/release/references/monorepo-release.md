# Per-component (monorepo) release — the scoped-tag finish

Some monorepos ship each package on its own cadence: independent versions,
independent tags, independent changelog entries. This repo (`cc-plugins`) is the
reference case. `git flow release finish` can't produce a scoped
`<component>-vX.Y.Z` tag cleanly, so the hammerbearer replicates the finish with plain
git.

## What "per-component" means here

- **Tag** — `<component>-vX.Y.Z` (e.g. `chronicle-v0.5.0`), never a repo-wide
  `vX.Y.Z`. The last tag for a component is the newest `<component>-v*`.
- **Version files** — every manifest that component owns moves together. In this
  repo each plugin has a **paired** manifest — `.claude-plugin/plugin.json` and
  `.codex-plugin/plugin.json` — and **both** bump to the same version. Marketplace
  registries (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`)
  carry **no** version field and are never touched.
- **CHANGELOG** — one file, entries headed per-component: `## [chronicle 0.5.0]`,
  noting the scoped tag it tracks.
- **"Did it change?"** — commits since that component's last tag, scoped to its path:
  `git rev-list --count <component>-vLAST..HEAD -- packages/<component>`.
- **Bump only what changed** — leave every other component's version alone.

## The finish (plain git, replicating gitflow)

For version `X.Y.Z` of `<component>`, tag `<component>-vX.Y.Z`:

```bash
# on develop — bump + changelog already written & verified in the tree
git add <version files> CHANGELOG.md [.chronicle/release.json]
git commit -m "🔧 release: <component> X.Y.Z"

git checkout main
git merge --no-ff develop -m "Merge branch 'develop' for <component>-vX.Y.Z"
git tag -a <component>-vX.Y.Z -m "<component>-vX.Y.Z"

git checkout develop
git merge --no-ff main -m "Merge branch 'main' back into develop"

# push only in `auto push`
git push origin develop main
git push origin <component>-vX.Y.Z
```

End on `develop`. Stop at the first conflict and hand the tree back — never force,
never auto-resolve, never move an existing tag.

## Coordinated release — N components, one merge, N tags

When several components changed and you want to ship them together (the reference
case: `chronicle` + `monitor` in one go), the release gate accepts a **set** of
components — each with its own bump — and the finish carries **one** bump commit and
**one** develop→main merge that all the scoped tags sit on. Each component still bumps
only its own version files and gets its own per-component CHANGELOG entry; only the
commit, the two merges, and the push are shared.

```bash
# on develop — every component's version files + all CHANGELOG entries already written & verified
git add <all version files> CHANGELOG.md [.chronicle/release.json]
git commit -m "🔧 release: chronicle 0.5.0 + monitor 3.18.3"

git checkout main
git merge --no-ff develop -m "Merge branch 'develop' for chronicle-v0.5.0 + monitor-v3.18.3"
git tag -a chronicle-v0.5.0 -m "chronicle-v0.5.0"     # every tag on this one merge commit
git tag -a monitor-v3.18.3  -m "monitor-v3.18.3"

git checkout develop
git merge --no-ff main -m "Merge branch 'main' back into develop"

# push only in `auto push`
git push origin develop main
git push origin chronicle-v0.5.0 monitor-v3.18.3
```

This replaces the previously hand-driven coordinated release. The single-component
finish above is just the N=1 case.

## Whole-repo contrast

A `whole-repo` config is the common case (a single product like a Rails + Nuxt app):
one `vX.Y.Z` tag, one un-headed-by-component CHANGELOG entry (`## [X.Y.Z]`), and
either a single version file or none (changelog + tag only). The finish is identical
except the tag is `vX.Y.Z` and the commit subject is `🔧 release: X.Y.Z`.

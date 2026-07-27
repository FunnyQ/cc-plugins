# CHANGELOG entry format (Keep a Changelog)

Chronicle writes one new entry per release. It prepends the entry above the most
recent one. The file follows [Keep a Changelog](https://keepachangelog.com/) with
[SemVer](https://semver.org/) versions.

## New-file preamble (only when `CHANGELOG.md` doesn't exist yet)

```markdown
# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
```

## The entry

```markdown
## [<headerLabel>] - <YYYY-MM-DD>

_tracks tag `<tagName>`_

### Added
- New capability a reader gains, in plain language.

### Changed
- Behaviour that now works differently, and why it matters.

### Fixed
- The bug, described by its user-visible symptom.
```

- `<headerLabel>` — per-component `chronicle 0.5.0`; whole-repo `0.5.0`.
- Only include sections that have entries. Order: Added, Changed, Deprecated,
  Removed, Fixed, Security.
- Match the existing file's heading **style** (this repo heads per-plugin:
  `## [chronicle 0.4.0]`). Write a *new* heading in that same shape; do not reuse or
  edit an existing one. Placement is always the same regardless of style: put a new
  entry at the **top of the entry list**, directly below the `# Changelog` preamble
  and above the first `## [` heading. Never rename an existing heading, for example
  `## [chronicle 0.4.0]` → `## [chronicle 0.5.0]` — renaming destroys the older
  release's entry.

## Voice

- User-facing, not a commit dump. A reader skims to learn what's new.
- Write one line per change. Lead with the outcome, not the mechanism.
- Fold a pure chore away — for example a lockfile bump, a formatting pass, or an
  internal refactor with no visible effect. Keep it only when it is the *only*
  change in the release.
- Never edit or reflow an older entry. Splice the new entry in and stop.

# CHANGELOG entry format (Keep a Changelog)

Chronicle writes one new entry per release, prepended above the most recent one. The
file follows [Keep a Changelog](https://keepachangelog.com/) with
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
- If the existing file already heads entries a particular way, **match it** rather
  than imposing this exact shape (this repo heads per-plugin: `## [chronicle 0.4.0]`).

## Voice

- User-facing, not a commit dump. A reader skims to learn what's new.
- One line per change; lead with the outcome, not the mechanism.
- Fold pure chores (lockfile bumps, formatting, internal refactors with no visible
  effect) away — unless a chore is the *only* change in the release.
- Never edit or reflow older entries; splice the new one in and stop.

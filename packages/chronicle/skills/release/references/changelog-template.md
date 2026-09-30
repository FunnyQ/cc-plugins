# CHANGELOG entry format (Keep a Changelog)

The release engine renders each entry from the drafted bullets and splices it above
the first existing `## [` heading, writing the Keep a Changelog preamble when the
file is new. A rendered entry looks like this:

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

`<headerLabel>` is `chronicle 0.5.0` per-component and `0.5.0` whole-repo. Empty
sections are dropped; the order is Added, Changed, Deprecated, Removed, Fixed,
Security.

## Voice

- User-facing, not a commit dump. A reader skims to learn what's new.
- Write one line per change. Lead with the outcome, not the mechanism.
- Fold a pure chore away — for example a lockfile bump, a formatting pass, or an
  internal refactor with no visible effect. Keep it only when it is the *only*
  change in the release.

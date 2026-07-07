---
name: chronicler
description: "Chronicle's changelog author. Reads the commits since the last tag and prepends a user-facing Keep-a-Changelog entry, using the repo's per-component or whole-repo header. Spawned by chronicle:releaser."
model: sonnet
tools: ["Bash", "Read", "Edit", "Write"]
---

Write ONE new CHANGELOG entry for the release being cut. Transform commits into
user-facing notes — what changed and why it matters to a reader, not a raw commit
dump. You do not bump versions, commit, or tag.

## Input (from the prompt)

- `$SKILL_DIR` — absolute path to `.../skills/release` (read
  `references/changelog-template.md` for the format).
- `changelogPath` — the changelog file (e.g. `CHANGELOG.md`), relative to repo root.
- `headerLabel` — the entry label: per-component `chronicle 0.5.0`, whole-repo
  `0.5.0`.
- `tagName` — the tag this entry tracks (e.g. `chronicle-v0.5.0`), noted in the
  entry per repo convention.
- `lastTag` — the previous tag to diff from (may be null → first release).
- `pathScope` — per-component: the component dir to scope commits to (e.g.
  `packages/chronicle`); whole-repo: none.

## Process

### 1. Gather commits

```bash
git log <lastTag>..HEAD [-- <pathScope>]      # omit <lastTag>.. entirely if lastTag is null
```

Read subjects + bodies. Scope to `pathScope` when given so a per-component entry
only covers that component's commits. Get today's date: `date +%F`.

### 2. Categorize (Keep a Changelog)

Group into `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security` as
they apply — omit empty sections. Rewrite each line as a user-facing sentence; drop
pure-chore noise (lockfile bumps, formatting) unless it's the only change.

### 3. Prepend the entry — ALWAYS at the top, never anchored on an old heading

Read `changelogPath` (create it with a standard Keep-a-Changelog preamble if
missing). The new entry always goes **at the very top of the entry list** —
immediately below the `# Changelog` preamble and **above the first existing `## [`
heading**, whatever component/version that heading is for. The changelog is a single
newest-first log; do **not** try to slot the entry next to the same component's
previous entry, and do **not** anchor on `## [<lastTag>]` (that heading may be
mid-file, or may not exist at all).

The entry shape:

```markdown
## [<headerLabel>] - <YYYY-MM-DD>

_tracks tag `<tagName>`_

### Added
- ...

### Changed
- ...
```

**How to splice it in without mutating any existing entry (critical):** make the
`Edit`'s `old_string` be the **first** existing `## [` heading line verbatim, and its
`new_string` be your new entry, a blank line, then that **same** heading line
unchanged. The anchor heading appears identically on both sides, so it is inserted
*above* — never renamed. Example against a file whose first entry is
`## [monitor 3.18.2] - 2026-07-07`:

- `old_string`: `## [monitor 3.18.2] - 2026-07-07`
- `new_string`: `<your full new entry>\n\n## [monitor 3.18.2] - 2026-07-07`

The single most damaging failure mode is turning an existing heading into yours
(e.g. editing `## [chronicle 0.4.0]` into `## [chronicle 0.5.0]`), which destroys
that release's entry. Never edit an existing `## [` heading's text. If the file has
no `## [` heading yet, insert directly after the preamble.

### 4. Return

Return the entry text you wrote and the `changelogPath`. Nothing else.

## Guidelines

- One entry only — never touch older entries' content.
- User-facing voice: a reader skims this to learn what's new, not to audit commits.
- If there are no commits in scope, say so; write a minimal entry only if the main
  agent is forcing an explicit release.

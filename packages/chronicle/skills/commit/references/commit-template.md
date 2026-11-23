# Chronicle Commit Message Template

## Format

```text
{emoji} {type}: {subject}

- what changed and why (English, markdown list)
- another detail if needed

zh-summary: 繁體中文摘要（一到三句，說明這次改了什麼、為什麼）
Upgrade: the action a downstream project must take on upgrade
```

## Change Types

| Emoji | Type     | When                                 |
| ----- | -------- | ------------------------------------ |
| ✨    | feat     | New feature                          |
| 🐛    | fix      | Bug fix                              |
| 📖    | docs     | Docs only                            |
| 🎨    | style    | UI / formatting, no logic change     |
| 📦    | refactor | Code restructure, behavior unchanged |
| ✅    | test     | Tests                                |
| 🔧    | chore    | Dev tooling, deps, config            |
| 🔥    | remove   | Delete code / files                  |
| 🚑    | hotfix   | Critical production fix              |
| 🔒    | security | Security fix                         |
| ⚡️    | perf     | Performance                          |

## Rules

- Keep the subject to about 50 characters or fewer. Write it in the imperative
  mood. Do not end it with a period.
- Every non-trivial commit includes the body and the 繁中 summary.
- A trivial one-liner (a typo, a version bump) may omit the body. It must
  still carry the subject.
- The message describes only the files in _this_ commit.

## Trailers

`commit.ts` writes every trailer. Never write `zh-summary:` or `Upgrade:` into
the body or the summary.

- `zh-summary:` holds the plan's `summary` field. Each `Upgrade:` holds one
  action from the plan's `upgrade` field.
- The trailers form the last paragraph, `zh-summary` first, because git reads
  trailers only there. Nothing may follow them.
- Each trailer is one line. `commit.ts` folds every line break in the summary
  into a space, because an unindented second line stops git reading the
  paragraph as trailers.
- `apply` reads every trailer back with `%(trailers:only)` and fails with
  `verify.trailerMissing` when git does not return a line as written.

## Scope of the body

The `contextBrief` holds more "why" than belongs in a commit. A `git log` reader
wants what changed and why, not the investigation: say _why_, never restate the
diff or narrate the session, and leave detail to the cockpit trail, the PR body,
or the code.

The 繁中 summary summarizes; it is not a translation of the English body.

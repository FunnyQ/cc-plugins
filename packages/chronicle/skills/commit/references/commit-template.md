# Chronicle Commit Message Template

## Format

```text
{emoji} {type}: {subject}

- what changed and why (English, markdown list)
- another detail if needed

---

繁體中文摘要（一到三句，說明這次改了什麼、為什麼）
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
- The `---` separator is literal. It is always present when a 繁中 summary
  follows.
- The message describes only the files in _this_ commit.

## Scope of the body

The `contextBrief` holds more "why" than belongs in a commit. A `git log` reader
wants what changed and why, not the investigation: say _why_, never restate the
diff or narrate the session, and leave detail to the cockpit trail, the PR body,
or the code.

The 繁中 summary summarizes; it is not a translation of the English body.

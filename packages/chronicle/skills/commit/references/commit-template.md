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

| Emoji | Type | When |
|---|---|---|
| ✨ | feat | New feature |
| 🐛 | fix | Bug fix |
| 📖 | docs | Docs only |
| 🎨 | style | UI / formatting, no logic change |
| 📦 | refactor | Code restructure, behavior unchanged |
| ✅ | test | Tests |
| 🔧 | chore | Dev tooling, deps, config |
| 🔥 | remove | Delete code / files |
| 🚑 | hotfix | Critical production fix |
| 🔒 | security | Security fix |
| ⚡️ | perf | Performance |

## Rules

- Keep the subject to about 50 characters or fewer. Write it in the imperative
  mood. Do not end it with a period.
- Every non-trivial commit MUST include the body and the 繁中 summary.
- A trivial one-liner (a typo, a version bump) may omit the body. It must
  still carry the subject.
- The `---` separator is literal. It is always present when a 繁中 summary
  follows.
- Stage files by explicit name. The message describes only the files in
  *this* commit.

## Length guardrail

The Lawspeaker hands the runesmith a distilled `whyBrief`. It holds far more
"why" than belongs in a commit. Be terse on purpose: the commit records the
change, not the whole investigation.

- **Body**: Write one line per bullet where possible. Use about 3–4 bullets
  for a normal change. Say *why*; do not restate the diff or narrate the
  session.
- **繁中 summary**: Write genuinely 1–3 sentences that *summarize*. Do not
  write a line-by-line re-translation of the English body. If the zh-TW reads
  like the body in Chinese, it is too long; cut it to the one thing a reader
  needs.
- When in doubt, choose the shorter version. Detail belongs in the cockpit
  decision trail, the PR body, or the code, not the commit message.

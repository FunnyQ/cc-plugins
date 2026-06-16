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

- Subject ≤ ~50 chars, imperative mood, no trailing period.
- Every non-trivial commit MUST include the body AND the 繁中 summary.
- Trivial one-liners (typo, version bump) may omit the body but still carry the subject.
- The `---` separator is literal and always present when a 繁中 summary follows.
- Stage files by explicit name; the message describes only the files in *this* commit.

## Length guardrail

A context-inheriting fork writes these messages, so it holds far more "why"
than belongs in a commit. Be terse on purpose — the commit records the change,
not the whole investigation:

- **Body**: one line per bullet where possible; ~3–4 bullets for a normal
  change. Say *why*; don't restate the diff or narrate the session.
- **繁中 summary**: genuinely 1–3 sentences that *summarize* — NOT a
  line-by-line re-translation of the English body. If the zh-TW reads like the
  body in Chinese, it's too long; cut it to the one thing a reader needs.
- When in doubt, shorter. Detail belongs in the cockpit decision trail, the PR
  body, or the code — not the commit message.

# COMMIT-02: Commit message template

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: commit/03
> **Status**: done

## Goal

Write chronicle's own commit-message template that the analyze fork follows when generating commit messages — emoji change-type + English body + `---` + 繁體中文 summary — with zero dependency on odin-git's copy.

## Files to create / modify

- `packages/chronicle/skills/commit/references/commit-template.md` (new) — the template the analysis script resolves and the agent follows.

## Implementation notes

This is a static markdown template (the analysis script resolves its *path*; the analyze fork agent reads its *contents* to format messages). Carry the full change-type table and the format contract inline so it is self-contained.

### Required content

1. **Format block** (the exact shape a message must take):

```
{emoji} {type}: {subject}

- what changed and why (English, markdown list)
- another detail if needed

---

繁體中文摘要（一到三句，說明這次改了什麼、為什麼）
```

2. **Change-type table** — emoji · type · when to use:

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

3. **Rules** (inline, as a bulleted list):
- Subject ≤ ~50 chars, imperative mood, no trailing period.
- Every non-trivial commit MUST include the body AND the 繁中 summary.
- Trivial one-liners (typo, version bump) may omit the body but still carry the subject.
- The `---` separator is literal and always present when a 繁中 summary follows.
- Stage files by explicit name; the message describes only the files in *this* commit.

## Acceptance criteria

- [x] `commit-template.md` exists at the path above.
- [x] It contains the format block, the full 11-row change-type table, and the rules list.
- [x] It mentions neither "odin" nor any odin path.
- [x] It lives at exactly `packages/chronicle/skills/commit/references/commit-template.md` (the path the analysis script resolves by default — verified independently when the script is wired).

## Verification

- [x] `test -f packages/chronicle/skills/commit/references/commit-template.md` succeeds.
- [x] The file renders the table with all 11 types (visual check).
- [x] `grep -i odin packages/chronicle/skills/commit/references/commit-template.md` returns nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | wrong format / missing types / odin leak | format present but table incomplete or rules vague | exact format block, all 11 types, clear rules, no odin |
| Trigger & flow correctness | ×2 | template unusable by an agent | usable but ambiguous on when body is required | unambiguous: an agent can format any commit from it |
| Interface & readability | ×1 | cluttered | readable but dense | clean, scannable table + rules |
| Assumptions & docs | ×1 | no guidance on edge cases | partial | trivial-commit exception + separator rule spelled out |

## Out of scope

- A user-override mechanism — Deferred. The override path lives in the analysis script's settings lookup; this task only ships the default template.

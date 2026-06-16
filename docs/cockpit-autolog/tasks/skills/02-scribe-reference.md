# SKILLS-02: Scribe reference + delete the cockpit-scribe skill

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/02
> **Blocks**: skills/01, skills/03, docs/01
> **Status**: todo

## Goal

Move the scribe procedure into `cockpit/references/scribe.md` (reading language from the
global config instead of `project-meta.md`), then delete the standalone `cockpit-scribe` skill.

## Files to create / modify

- `packages/monitor/skills/cockpit/references/scribe.md` (new) — ported scribe procedure.
- `packages/monitor/skills/cockpit-scribe/` (delete) — entire directory (use `trash`).

## Implementation notes

**Step 0 — read the source verbatim first.** Open the current
`packages/monitor/skills/cockpit-scribe/SKILL.md` and copy its full body into the new
`references/scribe.md` *before* deleting the old skill (the deletion is the last step of
this task). Port it **verbatim** except for the two changes below — do not paraphrase or
trim the procedure. The structure you are preserving (so you can confirm nothing is lost):

- **Step 1** — resolve the CLI path (changes — see below).
- **Provider** — set `--provider codex` on every `scribe` call when running under Codex;
  empty (Claude default) otherwise.
- **Step 2** — add the code-change lens: `git diff`, `git diff --staged`, `git log --oneline -5`.
- **Step 3** — dedup via `cockpit scribe --recent` (prints last ~8 scribe entries; skip
  already-covered material).
- **Step 4** — sweep all four lenses (`decision` / `rationale` / `learning` / `caveat`),
  then write each surviving entry with
  `cockpit scribe --type <kind> --title "<headline>" --text "<body>" [$PROVIDER_FLAG]`.
  Includes the kind-value table and the tone rules (concrete, terse, teach/justify).
- **Step 5** — language (changes — see below).
- **Step 6** — consolidate; dedup across lenses without collapsing to one; fire-and-forget,
  end quietly (no summary message).

The two changes to apply during the port:

### 1. CLI path resolution simplifies (same skill now)

Today scribe resolves the CLI across a sibling hop (`<banner>/../cockpit/scripts/cockpit.ts`).
Now that scribe lives **inside** the cockpit skill, the banner ("Base directory for this
skill") is the cockpit skill dir, so:

```bash
SKILL_DIR="<BANNER_PATH>"        # the cockpit skill base dir
CLI="$SKILL_DIR/scripts/cockpit.ts"   # same skill — no ../ hop
test -f "$CLI" || { echo "cockpit CLI not found at $CLI" >&2; exit 1; }
```

### 2. Language comes from the global config, not project-meta

Replace the old "Step 5 — Language" that grepped `<project>/.cockpit/project-meta.md`. The
language is now resolved by the CLI:

```bash
LANG_NAME="$(bun "$CLI" config get-language)"   # prints e.g. zh-TW, or English by default
```

Write `--title` / `--text` in `$LANG_NAME`. There is no project-meta fallback anymore.

### Keep everything else

The four lenses (`decision` / `rationale` / `learning` / `caveat`), the `--recent` dedup
step, the provider flag handling (`--provider codex` under Codex), the sweep-all-four
guidance, the tone rules, and the "fire-and-forget, end quietly" close all stay. This is
still the procedure a context-inheriting fork runs — note that it must be invoked from such
a fork (the `thoughtful` command spawns it), not as a custom subagent_type.

## Acceptance criteria

- [ ] `references/scribe.md` exists with the full scribe procedure (four lenses, `--recent` dedup, tone, provider handling).
- [ ] CLI path resolution uses the same-skill form `<base>/scripts/cockpit.ts` (no `../`).
- [ ] Language is resolved via `cockpit config get-language`; no `project-meta.md` grep remains.
- [ ] `packages/monitor/skills/cockpit-scribe/` is deleted.
- [ ] scribe.md notes it runs inside a context-inheriting fork (subagent_type omitted), not a custom agent.

## Verification

- [ ] `test ! -d packages/monitor/skills/cockpit-scribe && echo gone` prints `gone`.
- [ ] `grep -n "project-meta\|\.\./cockpit/scripts" packages/monitor/skills/cockpit/references/scribe.md` returns nothing.
- [ ] `grep -n "config get-language" packages/monitor/skills/cockpit/references/scribe.md` matches.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | scribe content lost or old skill left behind | ported but still greps project-meta or wrong CLI path | full port; same-skill path; language via config; old skill deleted |
| Test coverage | ×2 | no checks | only existence | dir-gone + grep-clean + config-get checks |
| Interface & readability | ×1 | muddled procedure | acceptable | clean, faithful to original structure |
| Assumptions & docs | ×1 | fork requirement dropped | partial | states context-inheriting-fork requirement |

## Out of scope

- The `thoughtful` command that spawns the fork — Deferred to the thoughtful-command task in this bucket.

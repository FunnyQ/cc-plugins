# ADR-0028: Chronicle agents are leaves, so no spawn-depth prerequisite remains

- Status: Accepted
- Date: 2026-09-29
- Supersedes: ADR-0006

## Context

Chronicle's earlier design chained orchestrators and children (main to orchestrator to child). Claude Code 2.1.217 disabled nested subagent spawning by default, so that design needed `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2`. The `install` skill owned that prerequisite through a `SessionStart` hook that wrote the value into `~/.claude/settings.json` (ADR-0006).

The chained layers were not protecting the main conversation. In the PR flow, storykeeper handed off to skald, which handed off to messenger, and every boundary between them carried under 200 B. In the ADR flow, lorekeeper only relayed work: it returned the codifier's drafts "complete and verbatim" to main, main retyped them into `gate2.json`, and the barrowkeeper retyped each record again with Write. Up to 12 drafts of 3-5 KB each passed through the main context three times.

## Considered alternatives

- Remove every agent and let the main agent run the scripts directly. Rejected: diff and `gh` output would land in the main conversation, and the subagent boundary exists to keep them out.
- Keep the three-layer PR flow and only fix the retyping (estimated 187 s down to about 110 s). Rejected: the two inner layers protect nothing, since their outputs are under 200 B.
- Keep the nested topology and the spawn-depth hook. Rejected: it keeps a hook that rewrites user settings and asks for a restart, to support layers that do no protective work.
- Remove the spawn-depth machinery in the same change as the topology change. Rejected: behavior and structure change separately, so the removal was made as its own commit.

## Decision

Every chronicle agent is a leaf and spawns no child. This reverses the part of ADR-0006 that kept the nested topology and made `install` own the spawn-depth prerequisite. Chronicle needs no `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, and its `SessionStart` hook and settings write are removed.

- PR flow: one storykeeper runs `analyze-branch.ts`, writes `{title, body}` to a text file, and runs `request-creator.ts --material --text`. Main receives only the URL and draft state.
- ADR flow: lorekeeper is dropped. The codifier writes its drafts straight to `<runDir>/gate2.json` and replies with the path only. `adr-commit.ts verdicts` folds the gate-2 reply into `new-adrs.json` and `gate2-drops.json`. The barrowkeeper (haiku) only runs `adr-commit.ts apply`. Main sees paths and small JSON, never draft text.

## Consequences

- Main-conversation context stays protected where it matters (diff, git, and `gh` output; draft text), and the pass-through layers are gone.
- The PR flow is faster: the first real run took 38 s end to end against a 187 s median for the old three-layer flow over 9 runs.
- Chronicle no longer fails with "Agent exists but is not enabled in this context" on Claude Code 2.1.217 and later. That holds only while every chronicle agent stays a leaf.
- The install skill no longer writes user settings for chronicle, and a fresh session needs no restart for it.
- Any future chronicle agent must not spawn children, or the spawn-depth requirement returns.

## Evidence

- **PR flow collapsed to one storykeeper** - the storykeeper, skald, messenger chain became a single storykeeper. The inner boundaries returned under 200 B each, and main still receives only the URL and draft state. Estimated 187 s down to about 50 s.
  Session `94481c7e-f09e-4307-8da4-f1d508ecbc5a`, entry `75adf0e7-eb81-444c-9bb1-1e4039a747d9`, 2026-09-29.
- **The single storykeeper measured 38 s** - the first real run of chronicle 0.19.0 took 38 s from spawn to report (27.3 s in the agent) and stopped at not-pushed. After the push only the creator reran and opened the PR within seconds, without rewriting the text. The old chain's median over 9 runs was 187 s.
  Session `94481c7e-f09e-4307-8da4-f1d508ecbc5a`, entry `2da93303-859b-48bc-87d2-29ba7b136244`, 2026-09-29.
- **Lorekeeper only relayed drafts** - it returned drafts verbatim to main, main retyped them into `gate2.json`, and the barrowkeeper retyped them again, so up to 12 drafts of 3-5 KB crossed main three times. Replaced by a codifier that writes the file directly, `adr-commit.ts verdicts`, and a barrowkeeper that runs `adr-commit.ts apply`.
  Session `94481c7e-f09e-4307-8da4-f1d508ecbc5a`, entry `12dc16c7-10d9-4052-85f4-3dc593d78f67`, 2026-09-29.
- **Spawn-depth machinery became obsolete and was removed separately** - with no nested spawn left, the `setup-spawn-depth.ts` hook, the opencode installer's chronicle-related `subagent_depth` write, and their tests were stale. Q chose a separate removal commit over folding it in or keeping the hook, which would keep writing settings and asking for restarts.
  Session `94481c7e-f09e-4307-8da4-f1d508ecbc5a`, entry `f4a82259-bd8d-4424-bd15-24cfb7d9f71b`, 2026-09-29.

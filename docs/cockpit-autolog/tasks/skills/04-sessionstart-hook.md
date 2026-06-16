# SKILLS-04: SessionStart hook that auto-enables thoughtful (Claude)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: skills/03
> **Blocks**: docs/01
> **Status**: done

## Goal

Add a `SessionStart` hook entry to the monitor Claude manifest that injects the thoughtful
standing instruction, so auto-logging is the default on Claude Code (Codex unaffected — no
hooks there).

## Files to create / modify

- `packages/monitor/.claude-plugin/plugin.json` (modify) — add a second `SessionStart` entry.

## Implementation notes

The manifest already has one `SessionStart` hook (matcher `startup`, running
`setup.ts --session-check`). **Leave it untouched** — add a *second* entry in the
`SessionStart` array, separate from the setup self-heal (different responsibility).

A SessionStart hook injects context by writing to **stdout** (Claude Code adds a hook's
stdout to the session context). The cleanest approach: echo a concise standing instruction.
Two viable shapes — pick the simpler that works:

- **Inline echo** (no new script): a `command` that `echo`s the short instruction text.
- **Tiny script**: a `command` running a small `bun`/shell script under the plugin that
  prints the instruction. Only add a script if inline quoting in JSON gets unwieldy.

The injected text should be a short version of the thoughtful standing instruction (the full
detail lives in the `/thoughtful` command body): e.g. *"Thoughtful mode is on for this
session: when you finish something genuinely worth recording (a non-obvious decision,
deliberate-but-odd code, a tricky learning, or a sharp caveat), spawn a background fork with
subagent_type omitted running `/cockpit scribe`. One fork per logical chunk; skip trivial
edits."*

Matcher: use `startup` for this single new entry (keeps the manifest at **exactly two**
`SessionStart` entries — the existing `--session-check` one plus this one). If you later want
the instruction to survive a context reset, **widen this same entry's matcher** (e.g.
`"startup|resume|clear"`) rather than adding a third entry — the two-entry invariant in the
acceptance check must hold. Keep the entry's `timeout` modest. Do not let this entry fail the
session if the echo fails.

Validate the JSON stays well-formed (the manifest also carries `mcpServers`, `channels`, and
the existing hook — don't disturb them).

## Acceptance criteria

- [x] A second `SessionStart` entry is added; the existing `--session-check` entry is unchanged.
- [x] The new entry injects the thoughtful standing instruction via stdout on session start.
- [x] The instruction tells the agent to spawn a fork with `subagent_type` omitted running `/cockpit scribe`.
- [x] `plugin.json` remains valid JSON with `mcpServers`, `channels`, and both hooks intact.
- [x] No change affects Codex (`.codex-plugin/plugin.json` is not touched; Codex has no hooks).

## Verification

- [x] Structured check (valid JSON + exactly two SessionStart entries, one per purpose):
  ```bash
  bun -e 'const h=JSON.parse(require("fs").readFileSync("packages/monitor/.claude-plugin/plugin.json","utf8")).hooks.SessionStart; if(h.length!==2)throw new Error("expected 2 SessionStart entries, got "+h.length); const cmds=h.flatMap(e=>e.hooks.map(x=>x.command)).join("\n"); if(!/session-check/.test(cmds))throw new Error("setup --session-check entry missing"); if(!/scribe|thoughtful/i.test(cmds))throw new Error("thoughtful-injection entry missing"); console.log("ok: 2 entries, both purposes present")'
  ```
- [x] Manual: a fresh Claude session shows the injected instruction in context; the agent then auto-forks scribe on worthy work.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | invalid JSON or clobbers existing hook/channels | injects but disturbs setup hook | clean second entry; instruction injected; all existing keys intact |
| Test coverage | ×2 | no checks | JSON-valid only | JSON-valid + two-hook inspection + manual session check |
| Interface & readability | ×1 | tangled with setup-check | acceptable | clearly separate entry, modest timeout |
| Assumptions & docs | ×1 | matcher choice unexplained | partial | notes startup/resume/clear rationale + Claude-only scope |

## Out of scope

- The `/thoughtful` command body — Deferred (carries the full instruction; this only injects a short pointer).
- Any Codex auto-start — out of scope by design (no hooks on Codex).

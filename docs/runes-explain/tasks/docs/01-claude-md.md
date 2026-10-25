# DOCS-01: claude-md

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/rubric.md`
>
> **Depends on**: ui/01, ui/02
> **Blocks**: review/01
> **Status**: done

## Goal

The repo-root `CLAUDE.md` records the explain rune's design facts that no code comment or `SKILL.md` carries, so the next agent touching `packages/runes/hooks/explain/` does not re-litigate them.

## Files to create / modify

- `CLAUDE.md` (modify, repo root) — one **Explain** paragraph appended to the runes bullet; one `explain/` line in the architecture tree.

Edit nothing else. Do not touch any file under `packages/`.

## Implementation notes

### Where the paragraph goes

The runes bullet is the line in `## What This Is` → `### Plugin summaries` that starts `- **runes** — a Claude Code *mod*`. It is one long line whose bold-led paragraphs are `**Clawd**`, `**Bash output**` and `**Fold**`, in that order. Append the new paragraph to the end of that same line, after the Fold paragraph's last sentence (`…when each row inside draws its own line. \`fold(on)\` is registered before every card rune, since the first-registered \`ui.render\` hook runs outermost and a folded row must never build its card.`), separated by one space, led by `**Explain** — `. Keep it on the same line: the bullet is a single Markdown list item.

### What the paragraph must say

Write it in the file's existing register: declarative sentences, mechanisms with their reason, no marketing. Cover every fact below, and no file-by-file tour (the tree carries the files).

1. **What it is.** The `explain` rune (default on, toggled by `/runes explain on|off`) draws a `hey mate, explain please` Button on its own row under the band's map-and-Clawd row, terminal only, drawn whether or not the minimap draws (the minimap rune defaults to off). A press opens the side pane `runes-explain` and runs one `$.model.fork`; the reply becomes a `text`, `html` or `ask` entry.
2. **The fork is both router and writer.** One `$.model.fork({ prompt })` decides the target (the latest exchange or a session recap, asking when torn), the mode, and writes the answer, using the reply grammar in `hooks/explain/protocol.ts` (`<mode>`, `<title>`, then `<body>` / `<summary>`+`<main>` / `<question>`+`<option>`). An unparseable reply becomes a `text` entry of the raw reply. The fork never enters the main transcript.
3. **Why not Jev.** Jev was considered as the router and rejected: Jev sees only a snippet the mod would send, and that snippet leaves the machine; the fork already holds the whole session and is cache-served; it still runs on the session's own model provider, so no transcript snippet goes to a second service. Text explanations make no TypeSafe call.
4. **HTML.** An `html` reply is assembled into `hooks/explain/template.html` (Picture-Book Workshop design, one light theme) and written to `~/.local/share/q-lab/runes/explain/<project>/<YYYYMMDD-HHMM>-<slug>.html`, never overwritten (`-2`, `-3` suffixes) and never deleted by the mod. The page carries the CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:`, which blocks scripts and fetches; because a CSP does not stop a page navigating itself, `cleanMain` in `html.ts` first strips scripts, `meta`/`base`/`form` tags, event and style attributes, and every non-`#` link from the fork-written `<main>`. It opens through `open <file>` on the file:// origin, deliberately not inside cockpit, whose origin can reach the token-protected `/api/inbox`.
5. **The layout checker.** A hidden `runes:explain-checker` subagent (sonnet, tools `Bash`, `Read`, `Edit`), hidden by `agent.offer`, screenshots the file with headless Chrome at 1280 and 420 wide, fixes only overlapping or clipped labels and similar layout faults in place, at most 3 rounds, and answers `OK`, `FIXED <n>` or `FAILED <reason>`, read at its `turn.complete`. Its `tool.check` hooks allow the mod's own Agent spawn of that type, and inside the checker's loop allow `Bash` only when the command starts with the quoted Chrome path and every `file://` / `--screenshot=` path lies under `~/.local/share/q-lab/runes/explain/`, and `Read` / `Edit` only under that directory; anything else falls through to the engine. The allow-list exists because auto mode's classifier judges a spawn nobody typed, and an unavailable classifier denies outright. A `tool.call` hook denies the checker's `SubagentHandback`, because a hand-back leaked its report into the main conversation (measured in a spike). No Chrome, a denied spawn, or 180 seconds of silence opens the file as-is with status `skipped` or `failed`.
6. **History.** Entries live in `$.state` (`runes.explain`, newest first, capped at 12, all shown in the pane), per session; text explanations do not survive the session, HTML files do. The pane's `Input` forks again with the selected entry as context; an ask option forks with that option as the topic. Token usage is shown after each press, never estimated before; a fork on a lapsed cache bills the whole prefix at the main model's price.

### Architecture tree line

In the `## Architecture` code block, the runes subtree currently ends:

```
│       └── hooks/                        # register.tsx (/runes) + config.ts (RUNES, DEFAULTS, config.yaml)
│           └── clawd/                    # mascot.tsx + director.ts + encode.ts + frames.ts; *.test.ts
```

`explain/` sorts after `clawd/`, so change `clawd/`'s `└──` to `├──` and add `└── explain/` as the last line, its comment aligned with the lines above:

```
│           ├── clawd/                    # mascot.tsx + director.ts + encode.ts + frames.ts; *.test.ts
│           └── explain/                  # explain.ts + protocol.ts + html.ts + template.html + checker.ts + pane.tsx + state.ts; *.test.ts
```

Name only files that exist after the earlier tasks landed; check with `ls packages/runes/hooks/explain/` and drop or add names to match.

## Acceptance criteria

- [x] The runes bullet in `CLAUDE.md` holds a paragraph led by `**Explain** —` after the Fold paragraph, on the same line.
- [x] The paragraph states each of the six facts above: the button and default on; the fork as router and writer; why not Jev; the XDG path and the CSP; the checker's allow-list and hand-back deny; per-session history.
- [x] The architecture tree has a `explain/` line under `packages/runes/hooks/` whose file list matches `ls packages/runes/hooks/explain/` (tests summarised as `*.test.ts`).
- [x] No other line of `CLAUDE.md` changed, and no other file changed.

## Verification

- [x] `grep -c '\*\*Explain\*\* —' CLAUDE.md` prints `1`
- [x] `grep -n '^- \*\*runes\*\*' CLAUDE.md | grep -q '\*\*Explain\*\* —'` exits 0 (the paragraph is on the runes bullet's line)
- [x] `grep -q "default-src 'none'; style-src 'unsafe-inline'; img-src data:" CLAUDE.md` exits 0
- [x] `grep -q 'runes:explain-checker' CLAUDE.md && grep -q 'SubagentHandback' CLAUDE.md && grep -q '.local/share/q-lab/runes/explain/' CLAUDE.md` exits 0
- [x] `grep -nE '└── explain/ +# ' CLAUDE.md` prints one line
- [x] `git diff -U0 -- CLAUDE.md | grep -c '^-[^-]'` prints `2` at most: the runes bullet's line (rewritten with the Explain paragraph appended) and the `clawd/` tree connector line; every other changed line is an addition

## Eval rubric

> Scale 0–5 and shared dimensions: see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                   | 2–3 (below bar)                                                                              | 4–5 (pass)                                                                                  |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | a stated fact contradicts `protocol.md` or the code (wrong path, CSP, model, tools, timeout) | all facts present but one is vague or slightly off (e.g. no reason given for the allow-list) | every fact matches `protocol.md` and the landed code byte for byte where a string is quoted |
| Test coverage           | ×2     | no verification run                                                                          | greps run but miss a fact                                                                    | every Verification grep passes                                                              |
| Interface & readability | ×1     | a file-by-file tour or bullet list breaking the one-line bullet                              | readable but restates code                                                                   | matches the bullet's register: mechanism plus why, one paragraph                            |
| Assumptions & docs      | ×1     | claims a measurement nobody made                                                             | a claim's source is unclear                                                                  | each "measured" claim names its spike; deferred items not described as shipped              |

## Out of scope

- Version bump, CHANGELOG entry, release — Deferred. Reason: this plan ships no release.
- Documenting the HTML design tokens — Deferred. Reason: they live in `template.html` and `packages/runes/PRODUCT.md`; CLAUDE.md records only what no other file carries.

# Runes Explain — "hey mate, explain please"

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-25
> **Max parallel**: unlimited

## Overview

A new rune, `explain`, puts a "hey mate, explain please" button under the minimap. Pressing it forks the
session's own transcript and returns an ELI5 explanation: plain text in a side pane, a single-file HTML
explainer with SVG diagrams when the topic needs pictures, or a question back when the target is unclear.

## Goals

- One press explains what Q is looking at, with no prompt typed and nothing added to the main transcript.
- Complex topics get a persistent, diagrammed HTML page whose layout a subagent has screenshot-checked.
- Q can follow up and revisit the session's last 12 explanations from the pane (older ones drop; their HTML
  files stay on disk).

## Non-goals

- No Jev, no TypeSafe call: the fork routes and writes.
- No cockpit integration; no explainer index outside the pane.
- No Codex or OpenCode support (runes is Claude Code only).
- No desktop / vscode / mobile surface: the button draws on `terminal` only, like the minimap.
- No cost estimate before a press; token usage (`in · cached · out`, no dollar figure) is shown after.
- No release, version bump, or CHANGELOG entry.
- No persistence of text explanations across sessions (HTML files persist; pane history is per session).

## Context

runes already has the parts this composes: `minimap/` draws a bar map in Clawd's band (`band.tsx`, terminal
only); `teacher/` shows a per-session result above the prompt; `transcript/glow.ts` renders markdown through
`glow`. dispatch's flightdeck shows a mod can own a side pane (`$.ui.open` + a `ui.render` hook on
`{ component: "Pane", requestId }`). guard's mod shows a hidden subagent (`$.agent.register` +
`agent.offer` → `isOffered: false` + a `tool.check` allow on its own Agent spawn + a `SubagentHandback` deny).

Decisions from the interview:

- Router: Jev was proposed and rejected. Jev sees only a snippet we send and that snippet leaves the machine;
  `$.model.fork` already holds the whole session, is cache-served, and never enters the transcript.
- Target: the fork picks between the latest exchange and a session recap, and asks when torn.
- A spike (2026-10-25, `shotspike` dev mod) showed a mod-spawned hidden haiku subagent with `Bash`+`Read`
  ran `Google Chrome --headless=new --screenshot` and read the PNG with no denial, both with and without
  a mod `tool.check` allow. Its `SubagentHandback` leaked the report into the main conversation.
  That session was in auto mode; the allow-list stays because the classifier can be unavailable.
- Design phase (2026-10-25): three impeccable rolls; the user picked **Picture-Book Workshop** (cold-press paper,
  ink-and-wash SVG, paper slips) and the **sticky-plate spread** structure. Dark mode was tried as a warm
  night paper and then dropped: one light theme ships. `packages/runes/PRODUCT.md` came out of this
  phase.
- The minimap rune defaults to off, so the button row draws under the band's map-and-Clawd row whether or
  not the map is drawn.

## Requirements

### MVP

1. **Rune switch** — `explain` is a rune in `config.yaml`, default on, toggled by `/runes explain on|off`.
   - Acceptance: config tests cover default, template line, and toggle read-back.
2. **Button** — the band draws a `hey mate, explain please` Button on its own row under the map/Clawd row
   (terminal only); it reads `explaining…` and ignores presses while a fork runs.
   - Acceptance: a mod test presses it and sees a fork requested and the pane opened.
3. **Fork protocol** — one `$.model.fork` call returns a tagged reply; a pure parser turns it into
   `text | html | ask`. An unparseable reply becomes a `text` entry of the raw reply.
   - Acceptance: parser unit tests for each mode, missing tags, and out-of-range ask options.
4. **Pane** — a side pane `runes-explain` shows the session's entry list (newest first, selectable),
   the selected entry, its token usage, and an `Input` at the bottom. Text entries render through glow;
   ask entries render one Button per option; html entries show the summary, the file path, the check
   status, and an `open again` Button.
   - Acceptance: mod tests render each entry kind and submit the Input.
5. **Follow-up & free text** — submitting the Input forks again with the selected entry and the typed text;
   an ask option press forks with that option as the topic.
   - Acceptance: mod test asserts the fork prompt carries the previous entry and the new text.
6. **HTML explainer** — an html reply is assembled into the shipped `hooks/explain/template.html`
   (from the approved `design/mock.html`), carrying a CSP that blocks scripts and network, written to
   `~/.local/share/q-lab/runes/explain/<project>/<YYYYMMDD-HHMM>-<slug>.html`.
   - Acceptance: unit tests for `assemble` and `explainerPath`; the written file contains the CSP meta.
7. **Layout checker** — a hidden `runes:explain-checker` (sonnet, tools `Bash`, `Read`, `Edit`) screenshots
   the file with headless Chrome, fixes overlap / clipping / arrow mistakes in place, at most 3 rounds,
   and answers `OK`, `FIXED <n>`, or `FAILED <reason>`. Then the mod runs `open <file>`.
   No Chrome, a denied spawn, or 3 minutes of silence → open as-is, status `skipped` / `failed`.
   - Acceptance: mod tests for spawn allow, the tool.check allow-list and its default, handback deny,
     turn.complete → status + open, and the timeout.

### Later

- **Pane history across sessions** — needs a store and a size bound; not asked for.
- **Cockpit shelf** — list explainers in cockpit in a sandboxed iframe.

## Tech decisions

- **Stack**: Claude Code mod in `packages/runes/hooks/`, TypeScript/TSX, no npm deps.
- **Model calls**: `$.model.fork({ prompt })` for every explanation; the checker via `$.agent.spawn`.
- **Storage**: entries in `$.state` (session); HTML files under XDG data, never deleted by the mod.
- **Opening**: `$.process.run(["open", path])`, file:// origin.
- **Visual design**: impeccable → `design/mock.html` (HTML explainer skeleton only), tokens and the fragment
  vocabulary in `_context/design.md`. Picture-Book Workshop world, sticky-plate spread layout, one light theme.
- **Tests**: `claude plugin test packages/runes` and `claude plugin validate packages/runes`.
- **Conventions**: `_context/shared.md`.

## Architecture

```
band.tsx ──press──▶ explainPress($)            hooks/explain/explain.ts
                          │ opens pane "runes-explain"
                          ▼
                 $.model.fork({ prompt })      prompt + parser: hooks/explain/protocol.ts
                          │
             ┌────────────┼──────────────┐
           text          ask            html
             │            │              │ writeExplainer   hooks/explain/html.ts + template.html
             ▼            ▼              ▼
       entries in $.state (hooks/explain/state.ts)
                          │              │ checkAndOpen     hooks/explain/checker.ts
                          │              ▼  spawn runes:explain-checker → turn.complete → open
                          ▼
             hooks/explain/pane.tsx renders entries, Input, Buttons
```

## Bucketing

- **Strategy**: by layer — pure core, UI, HTML pipeline — plus one docs task and the final review.
- **Why**: the protocol, the state contract and the HTML writer are independent and start at once;
  UI waits only on the orchestrator.

### Buckets

- **`core/`** — config switch + state contract, fork protocol, orchestrator.
- **`html/`** — template + writer, layout checker subagent.
- **`ui/`** — band button, pane.
- **`docs/`** — CLAUDE.md runes paragraph and architecture tree.
- **`review/`** — final review only.

## Task index

| Bucket | NN  | Title               | Status | Pass line | Depends on                         |
| ------ | --- | ------------------- | ------ | --------- | ---------------------------------- |
| core   | 01  | config-and-state    | todo   | > 4.0     | —                                  |
| core   | 02  | fork-protocol       | todo   | > 4.0     | —                                  |
| html   | 01  | template-and-writer | todo   | > 4.0     | —                                  |
| html   | 02  | layout-checker      | todo   | > 4.0     | core/01, html/01                   |
| core   | 03  | orchestrator        | todo   | > 4.0     | core/01, core/02, html/01, html/02 |
| ui     | 01  | band-button         | todo   | > 4.0     | core/03                            |
| ui     | 02  | explain-pane        | todo   | > 4.0     | core/03                            |
| docs   | 01  | claude-md           | todo   | > 4.0     | ui/01, ui/02                       |
| review | 01  | final review 🏁     | todo   | > 4.0     | docs/01                            |

Review: Codex · Standard (floor 2, checkpoint 5, cap 8) · impeccable design phase for the HTML skeleton.

## Cross-bucket dependencies

```
core/01 ──┬───────────────▶ core/03 ──▶ ui/01 ──┐
core/02 ──┤                  ▲      └─▶ ui/02 ──┴─▶ docs/01 ──▶ review/01
html/01 ──┴─▶ html/02 ───────┘
```

File ownership, so parallel worktrees never edit one file: `config.ts`, `config.test.ts` and
`types/index.d.ts` belong to config-and-state; `band.tsx` to band-button; `register.tsx` to the layout checker, then
the orchestrator, then the pane, each running after the one before.

## Human checks

- (human) Press the button in a real session and see each of text, html and ask once; follow up once.
- (human) Open a generated explainer beside `docs/runes-explain/design/mock.html`.
- (human) Judge whether the explanations are ELI5-clear.

## Open questions

1. **Auto mode** — resolved: the spike session ran in auto mode (its classifier later returned no verdict
   three times on one Bash call). The allow-list stays anyway, because an unavailable classifier denies a
   call outright, as guard measured.
2. **Pane width** — a pane opened unasked seats from 144 columns; whether a button press counts as
   asked is unverified. The orchestrator toasts when `isPlaced` is false.

## Known gaps

- Fork cost on a lapsed cache bills the whole prefix at the main model's price; shown, not prevented.

## Iteration: page brief (2026-10-26)

- **What**: every fork prompt ends with a page brief. `drawBrief(Math.random)` draws one option per axis of
  `BRIEF_AXES` in `protocol.ts`: the answer's opening, the analogy, the first section's form, and the ending.
- **Why**: left to choose, the fork laid out every page alike. Measured on 4 sessions before the brief: 4 of 4
  pages ran answer, analogy, a spread with a Mermaid plate, then `aside.warn` and `takeaway`. The middle
  sections already varied with the content.
- **Decisions**:
  - Code draws the page-level axes; the model keeps every choice that depends on the content, such as which
    block shows a section and how many sections a page needs.
  - The brief narrows rule 6 and never overrides it, so `FRAGMENT_RULES` is unchanged.
  - The draw is plain `Math.random`: two presses in a row may draw the same brief.
  - Per-section pattern lists were rejected: a page mixes several patterns, and a drawn subset can hold none
    that fits.
  - Visual looks (CSS variants on `data-look`) are deferred to the next iteration.
- **Measured after** (10 sessions, `claude -p --resume --fork-session`, not `$.model.fork`): analogy, first
  section and ending followed the brief in 28 of 30 draws; both misses were the "no closing aside" ending,
  reworded to "no `<aside>` in the last section", which then held 3 of 3.

## References

- Patterns: `packages/guard/hooks/register.ts`, `packages/dispatch/hooks/flightdeck/flightdeck.tsx`
- Mod API: the engine's `claude-code` typings (grep `ModelForkRequest`, `InputProps`, `ToolCheckInput`)

## Task briefs

The fork-writing step reads these; the contract they lean on is `tasks/_context/protocol.md`.

- **core/01 config-and-state** — add `"explain"` to `RUNES` (after `"teacher"`), its `TEMPLATE` block
  (`explain:\n  enabled: …    # the "hey mate, explain please" button under the minimap; a press forks this session to explain it, ELI5`),
  its place in the `TOP` list and in `normalize`/`upgrade` exactly as `teacher` has it (no fields besides
  `enabled`); defaults to on through the existing `r !== "minimap"` rule. Add the `Explain*` types and
  `explain: ExplainView` to `types/index.d.ts`. Create `hooks/explain/state.ts` per the contract.
  Tests in `hooks/config.test.ts` (default on, template line present, `/runes explain off` reads back) and
  `hooks/explain/state.test.ts` (`withEntry` order + cap at 12 + selects the new entry, `patchEntry`,
  `selectedOf` fallback, `usageOf` sums input + cache creation).
- **core/02 fork-protocol** — `hooks/explain/protocol.ts` + `protocol.test.ts`, pure. Tests: each mode, each
  fallback rule, title cut, 1 and 5 ask options, `buildPrompt` carries `RULES` and the per-kind paragraph,
  `follow` clips previous text to 4,000 characters, `FRAGMENT_RULES` names every component and SVG class
  `protocol.md` lists.
- **html/01 template-and-writer** — `hooks/explain/template.html` built from `docs/runes-explain/design/mock.html`
  exactly as `design.md` → `## Template shell` says (colophon without check status, no dark theme), with the
  five placeholders and the CSP meta; `hooks/explain/html.ts` + `html.test.ts`: `assemble`
  escaping, CSP present, `slugOf` examples, `explainerPath` padding, `writeExplainer` collision suffix and
  mkdir call, using an in-memory `io`.
- **html/02 layout-checker** — `hooks/explain/checker.ts` + `checker.test.ts`. Agent spec: name
  `explain-checker`, model `sonnet`, effort `medium`, tools `["Bash", "Read", "Edit"]`, `omitClaudeMd: true`;
  its prompt: screenshot with
  `"<CHROME>" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,<h> --screenshot=<png> file://<html>`
  at h = 4000 (and 7000 at width 420 for a narrow pass; FAILED when the colophon is not in the shot), Read the PNG, fix only overlapping or clipped labels,
  arrows pointing at the wrong box, text outside its box, or illegible contrast, by editing the HTML file;
  never rewrite prose; at most 3 screenshot rounds; screenshots go to the same directory as `<name>.check.png`;
  final message exactly `OK`, `FIXED <n>`, or `FAILED <reason>`. Hooks: `agent.offer` hides it; `tool.check`
  `Agent` allows only this plugin's spawn of `runes:explain-checker`; `tool.check` `Bash` allows a command
  inside the checker's loop only when it starts with the quoted CHROME path and every `file://` / `--screenshot=`
  path is inside `~/.local/share/q-lab/runes/explain/`; `Read` and `Edit` allow inside the checker's loop only
  under that directory; anything else falls to `next(e)`. `tool.call` `SubagentHandback` from the checker →
  `{ deny: "Do not hand back. Reply with OK, FIXED <n>, or FAILED <reason> as your final message." }`.
  `turn.complete` (`{ isAborted: false }` and `{ isAborted: true }`) from the checker → `parseVerdict` → the checker settles the entry and opens the file itself. Tests cover every branch,
  including the 180 s timeout with `mock.clock`.
- **core/03 orchestrator** — `hooks/explain/explain.ts` + `explain.test.ts`; wires `registerChecker` into
  `register.tsx`'s `session.start` and `explainHooks(on)` into `register()`. `press`: clear `error`, set
  `isRunning`, `$.ui.open({ id: PANE, title: "hey mate", columns: 64 })` (toast
  `"hey mate needs a wider terminal; the answer is in the pane once it fits"` when `isPlaced` is false), fork
  with `buildPrompt`, parse, store the entry; for html: `writeExplainer`, store with `check: "pending"`,
  `startCheck($, id, path)`, which returns once the checker started; the checker patches the entry and runs `open` itself. Fork failure → `error` set to
  `nothing to explain yet` (nothing-to-fork) or `the fork failed: <reason>`; `isRunning` always cleared.
  `ask` builds `follow` with the selected entry, else `free`; `pick` builds `pick`; `select` sets `selected`;
  `reopen` runs `open`. Tests stub `model.fork`, `agent.spawn`, `process.run`, `fs.*`.
- **ui/01 band-button** — in `band.tsx`, when `config.enabled.explain` and `e.surface === "terminal"`, add a
  row under the map/Clawd row holding `<Button key="explain" plain label=…>`: `hey mate, explain please` idle,
  `explaining…` while `isRunning` (press ignored). It draws whether or not the minimap or Clawd draw; the band
  must no longer return `next(e)` early when only the button would draw. Test in `band`'s own test file or a
  new `hooks/explain/button.test.tsx`.
- **ui/02 explain-pane** — `hooks/explain/pane.tsx` + `pane.test.tsx`, hooked from `register()` as
  `explainPane(on)`. Layout top to bottom: history (each entry one Button row `› <title>` / `  <title>`,
  newest first, every stored entry shown, at most 12), a rule, the selected entry, a dim usage line
  `<input> in · <cacheRead> cached · <output> out` (thousands as `12.3k`), an error line in `#cc6666` (the deleted-line red of `transcript/edit.tsx`)
  when `error`, then `<Input key="explain-ask" placeholder="ask a follow-up, or name what to explain" submitLabel="ask">`.
  Text entries: `glow.view(width, body)` runs, falling back to wrapped plain text while glow renders or is
  missing. Ask entries: the question, then one Button per option calling `explainPick`. Html entries: the
  summary (glow), the path dim, the check status (`checking layout…`, `layout ok`, `fixed N`, `not checked: <note>`),
  and an `open again` Button. Empty view: `Press "hey mate, explain please" under the minimap.`
- **docs/01 claude-md** — add an **Explain** paragraph to the runes bullet in `CLAUDE.md` (fork as router and
  writer and why not Jev; the checker's Bash allow-list and hand-back deny; HTML under XDG data with a CSP;
  history per session) and the `hooks/explain/` line to the architecture tree.

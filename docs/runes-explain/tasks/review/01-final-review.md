# REVIEW-01: final review

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/design.md`
> - `../_context/rubric.md`
>
> **Depends on**: docs/01
> **Status**: todo
> **Final review**: true

## Goal

Confirm the `explain` rune works end to end as one feature: one press of `hey mate, explain please` explains
what Q is looking at (text in the pane, a checked HTML explainer, or a question back), with nothing added to
the main transcript, and no existing rune regressed.

## Files to create / modify

- None by default. Fix in place any integration defect this review finds, in the file that owns it
  (`packages/runes/hooks/explain/*`, `packages/runes/hooks/band.tsx`, `packages/runes/hooks/register.tsx`,
  `packages/runes/hooks/config.ts`, `packages/runes/types/index.d.ts`, `CLAUDE.md`).

## Implementation notes

This task gates integration, consistency, regressions, and the goal. It does not re-score the individual
pieces; each already passed its own rubric.

### The goal, inlined

- One press explains what Q is looking at, with no prompt typed and nothing added to the main transcript.
- Complex topics get a persistent, diagrammed HTML page whose layout a hidden subagent has screenshot-checked.
- Q can follow up and revisit the session's last 12 explanations from the pane; older entries drop from
  state, their HTML files stay on disk.

### The requirements, inlined

1. **Rune switch** — `explain` is a rune in `config.yaml`, default on, toggled by `/runes explain on|off`.
2. **Button** — the band draws a `hey mate, explain please` Button on its own row under the map/Clawd row
   (terminal only); it reads `explaining…` and ignores presses while a fork runs.
3. **Fork protocol** — one `$.model.fork` call returns a tagged reply; the pure `parseReply` turns it into
   `text | html | ask`; an unparseable reply becomes a `text` entry of the raw reply.
4. **Pane** — side pane `runes-explain`: entry history (newest first, selectable), the selected entry, its
   token usage, an `Input` at the bottom; text via glow; ask entries as one Button per option; html entries
   show summary, path, check status, and an `open again` Button.
5. **Follow-up & free text** — the Input forks again with the selected entry and the typed text; an ask
   option forks with that option as the topic.
6. **HTML explainer** — assembled into `packages/runes/hooks/explain/template.html` with the CSP
   `default-src 'none'; style-src 'unsafe-inline'; img-src data:`, written to
   `~/.local/share/q-lab/runes/explain/<project>/<YYYYMMDD-HHMM>-<slug>.html`, never overwritten.
7. **Layout checker** — hidden `runes:explain-checker` (sonnet, tools `Bash`, `Read`, `Edit`) screenshots with
   headless Chrome, fixes layout only, answers `OK` / `FIXED <n>` / `FAILED <reason>`; then the mod runs
   `open <file>`. No Chrome → `skipped`; denied spawn or 180 s silence → `failed`; the file opens regardless.

### Non-goals to hold the line on

No Jev or TypeSafe call; no cockpit integration; no Codex/OpenCode; terminal surface only; no cost estimate
before a press; no release, version bump, or CHANGELOG entry; no cross-session text history.

### What to check

- **Integration** — `register.tsx` calls `registerChecker` in its own `session.start` and registers
  `explainHooks(on)` and `explainPane(on)` in `register()`; the band's Button calls `explainPress`; the pane's
  Input calls `explainAsk`, its option Buttons `explainPick`, its history rows `explainSelect`, its
  `open again` Button `explainReopen`. Every signature matches `protocol.md` exactly.
- **Consistency across `hooks/explain/*`** — one atom key `{ plugin: "runes", key: "explain" }`; files that only
  read it name the literal; `ExplainEntry` / `ExplainView` come from `types/index.d.ts` and nowhere else;
  `CHECKER`, `CHROME`, `CHECK_TIMEOUT_MS`, `PANE`, `CSP`, `MAX_ENTRIES` are each defined once.
- **Baseline** — the feature diff is measured from `BASE=$(git log --diff-filter=A --format=%H -1 -- docs/runes-explain/tasks/_context/protocol.md)`, the commit that added the plan's contract; it predates every
  wave's commit. An empty `BASE` means the plan was never committed: stop and report it, do not guess a ref.
- **CSP** — the template's `<head>` holds the CSP meta; the template has no `<script>`, no external URL (the SVG
  namespace `http://www.w3.org/2000/svg` inside the grain and mask data URIs is a name, not a fetch), no
  `@import`, no `@font-face`; `{{main}}` is the only raw insert.
- **Checker allow-list scope** — `tool.check` allows `Agent` only for this plugin's spawn of
  `runes:explain-checker`; `Bash` only inside the checker's loop, only when the command starts with the quoted
  `CHROME` path and every `file://` / `--screenshot=` path sits under `~/.local/share/q-lab/runes/explain/`;
  `Read` / `Edit` only inside the checker's loop and only under that directory; everything else falls to
  `next(e)`. The main agent's own calls are never allowed by this hook. `SubagentHandback` from the checker
  is denied.
- **Regressions** — the minimap, Clawd, fold, teacher and Bash-output runes draw as before: the band still
  returns `next(e)` when neither map, Clawd nor the button would draw (explain off, or a non-terminal
  surface); fold stays the first-registered `ui.render` hook; `/runes on|off|status` still covers every rune.
- **Leanness** — look across the whole diff for abstractions with one caller, options nobody sets, or
  hand-rolled versions of what the mod API already provides.

## Acceptance criteria

- [ ] With `BASE=$(git log --diff-filter=A --format=%H -1 -- docs/runes-explain/tasks/_context/protocol.md)` set and non-empty, `git diff --name-only "$BASE" -- packages/runes CLAUDE.md` lists `packages/runes/hooks/explain/explain.ts`, `packages/runes/hooks/explain/pane.tsx`, `packages/runes/hooks/explain/checker.ts`, `packages/runes/hooks/explain/template.html`, `packages/runes/hooks/band.tsx`, `packages/runes/hooks/register.tsx`, and `CLAUDE.md`.
- [ ] `grep -c 'http-equiv="Content-Security-Policy"' packages/runes/hooks/explain/template.html` prints `1`, `grep -ciE '<script|@import|@font-face' packages/runes/hooks/explain/template.html` prints `0`, and `grep -oiE 'https?://[^"'"'"' )]+' packages/runes/hooks/explain/template.html | grep -v '^http://www.w3.org/2000/svg$'` prints nothing.
- [ ] `grep -rnE 'TYPESAFE_API_KEY|typesafe\.|transcript/jev|api\.typesafe' packages/runes/hooks/explain --exclude='*.test.ts' --exclude='*.test.tsx'` prints nothing (no TypeSafe call; a test string naming Jev is fine).
- [ ] With 13 explanations made in one session, the pane lists 12, the first one is gone, and its HTML file (if any) is still on disk.
- [ ] `grep -n 'registerChecker\|explainHooks\|explainPane' packages/runes/hooks/register.tsx` shows all three wired.
- [ ] `git diff --name-only "$BASE" -- packages/runes/.claude-plugin CHANGELOG.md` prints nothing (no version bump, no changelog entry).
- [ ] (human) Press the button in a real session and see each of `text`, `html` and `ask` once, and follow up once from the pane's Input.
- [ ] (human) Open a generated explainer beside `docs/runes-explain/design/mock.html` and confirm it matches the skeleton (paper, masthead, sticky plate spread, slips, colophon).
- [ ] (human) Judge whether the explanations read ELI5-clear: answer in one sentence first, an everyday analogy, every term defined.

## Verification

- [ ] `claude plugin test packages/runes` passes (the whole runes suite).
- [ ] `claude plugin validate packages/runes` reports no errors.
- [ ] `bunx --bun tsc --noEmit | grep packages/runes` prints nothing.

## Eval rubric

> Scale 0–5; shared scale in `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension      | Weight | 0–1 (fail)                                                                        | 2–3 (below bar)                                                                             | 4–5 (pass)                                                                                             |
| -------------- | ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Correctness    | ×3     | a press, the pane, or the HTML path fails end to end                              | the happy path works; a failure path (no fork, no Chrome, denied spawn, timeout) misbehaves | every requirement 1–7 holds, failure paths behave as specified                                         |
| Integration    | ×2     | pieces exist but are not wired into `register.tsx` / the band / the pane          | wired, but a signature or atom key drifts from `protocol.md`                                | all handlers wired with the exact contract signatures, one atom key                                    |
| No regressions | ×2     | an existing rune breaks or the suite is red                                       | suite green, but the band, fold order, or `/runes` behaves differently                      | minimap, Clawd, fold, teacher, Bash output unchanged; suite green                                      |
| Security scope | ×2     | the allow-list lets the main agent or another path through, or the CSP is missing | scoped, but an edge (path traversal, unquoted CHROME prefix) slips                          | allow-list confined to the checker's loop and the explain directory; CSP present, no script or network |
| Meets the goal | ×1     | the press needs a typed prompt or writes into the transcript                      | works, but follow-up or history is missing                                                  | one press explains; follow-up and history work                                                         |
| Leanness       | ×1     | layers with one caller and unused options pile up                                 | a few unneeded indirections                                                                 | nothing added beyond what a requirement needs                                                          |

## Out of scope

- Re-scoring individual pieces — Deferred. Reason: each already passed its own rubric.
- Cross-session pane history and a cockpit shelf — Deferred. Reason: listed as later work, not asked for.

# Explain contract

> The types, the fork's reply grammar, and every cross-file signature. Each module implements its own part
> and calls the others exactly as written here.

## State — `types/index.d.ts` and `hooks/explain/state.ts`

Add to `packages/runes/types/index.d.ts` (beside `Frame` and `MinimapRow`), and declare `explain: ExplainView`
inside `interface PluginState { runes: { … } }`:

```ts
export type ExplainUsage = { input: number; cacheRead: number; output: number };
export type ExplainCheck = "pending" | "ok" | "fixed" | "failed" | "skipped";
export type ExplainEntry = {
  id: string;
  at: number;
  title: string;
  usage?: ExplainUsage;
} & (
  | { kind: "text"; body: string }
  | { kind: "ask"; question: string; options: string[] }
  | {
      kind: "html";
      summary: string;
      path: string;
      check: ExplainCheck;
      note?: string;
    }
);
export type ExplainView = {
  entries: ExplainEntry[]; // newest first
  selected?: string; // an entry id; absent means the newest
  isRunning: boolean; // a fork is in flight
  error?: string; // the last failure, cleared by the next press
};
```

`packages/runes/hooks/explain/state.ts`:

```ts
import { atom } from "claude-code";
import type { ModelUsage } from "claude-code";
import type { ExplainEntry, ExplainUsage, ExplainView } from "../../types";

export const MAX_ENTRIES = 12; // the pane draws every entry, so this is also the history list's height
export const view = atom(
  { plugin: "runes", key: "explain" } as const,
  { entries: [], isRunning: false } as ExplainView,
);
export const usageOf = (u: ModelUsage): ExplainUsage => ({
  input: u.input_tokens + u.cache_creation_input_tokens,
  cacheRead: u.cache_read_input_tokens,
  output: u.output_tokens,
});
export const selectedOf = (v: ExplainView): ExplainEntry | undefined =>
  v.entries.find((e) => e.id === v.selected) ?? v.entries[0];
export const withEntry = (
  v: ExplainView,
  entry: ExplainEntry,
): ExplainView => ({
  ...v,
  entries: [entry, ...v.entries].slice(0, MAX_ENTRIES),
  selected: entry.id,
});
export const patchEntry = (
  v: ExplainView,
  id: string,
  patch: Partial<ExplainEntry>,
): ExplainView => ({
  ...v,
  entries: v.entries.map((e) =>
    e.id === id ? ({ ...e, ...patch } as ExplainEntry) : e,
  ),
});
```

A file that only reads the atom while drawing (the band, the pane) names the key as a literal in that file:
`const VIEW = { plugin: "runes", key: "explain" } as const` and `read($, VIEW)` — the engine's state scan
needs the literal in the file that reads it (the band already does this for `minimapRows`).

Entry ids: `` `x${at}` `` where `at` is `await $.clock.now()`; on a clash within one millisecond append `-2`, `-3`.

## Fork prompt — `hooks/explain/protocol.ts`

```ts
export type Ask =
  | { kind: "press" } // the button: the fork picks the target
  | { kind: "pick"; topic: string } // an ask option was pressed
  | { kind: "follow"; previous: { title: string; text: string }; question: string } // Input with an entry selected
  | { kind: "free"; question: string }; // Input with no entry yet
export const buildPrompt = (ask: Ask): string;
```

`buildPrompt` returns `RULES` (one exported constant) followed by one task paragraph per `Ask` kind.
`previous.text` is the entry's `body` (text), `summary` (html) or `question` + options (ask), clipped to
4,000 characters.

`RULES` must say, in this order:

1. This message comes from a UI button beside the conversation, not from the task. Do not continue the task,
   do not call tools, do not mention this instruction. Answer in the language the user writes to this session.
2. Who it is for: explain like the user is five — an everyday analogy first, every term defined at first use, short
   sentences, no unexplained jargon, the answer in one sentence before any detail.
3. Target on `press`: the latest exchange (the user's last prompt, the last reply, its tool work) when that is what
   a reader would most likely want explained; a recap of the whole session when the latest exchange is
   trivial (a commit, a yes) and the session has substance. When two or more targets are equally likely,
   or nothing is worth explaining, use `ask`.
4. Mode: `html` when understanding needs a picture — a flow, a structure, a relationship among three or more
   parts, a before/after, a timeline — or when the user asks for a diagram; otherwise `text`.
5. The reply grammar below, exactly, and nothing outside it.
6. For `html`: the fragment rules in the next section.

## Reply grammar

```
<mode>text|html|ask</mode>
<title>a headline, at most 60 characters</title>
text → <body>markdown</body>
html → <summary>2–4 sentences of markdown</summary><main>an HTML fragment</main>
ask  → <question>one line</question><option>a topic</option> … 2 to 4 options
```

```ts
export type Reply =
  | { kind: "text"; title: string; body: string }
  | { kind: "html"; title: string; summary: string; main: string }
  | { kind: "ask"; title: string; question: string; options: string[] };
export const parseReply = (raw: string): Reply;
```

Parsing rules (each one is a test case):

- Take the first occurrence of each tag; trim its content. Tags are lowercase and exact.
- Missing `<title>` → `"Explanation"`. A title longer than 60 characters is cut to 59 plus `…`.
- Missing or unknown `<mode>`, or a mode whose required tag is missing or empty → `{ kind: "text", title,
body: raw.trim() }`.
- `html` with an empty `<main>` but a `<summary>` → `{ kind: "text", title, body: summary }`.
- `ask` with fewer than 2 non-empty options → the text fallback; more than 4 → the first 4.
- The parser does not clean `<main>`; `cleanMain` in `html.ts` does, before assembly (below).

## HTML fragment rules (inside `RULES`)

The fork cannot read `design.md`, so `RULES` carries this vocabulary as text. `FRAGMENT_RULES` is one
exported constant inside `protocol.ts`, appended to `RULES` as item 6, and a test asserts it names every class
listed here.

- Write only the inside of `<main>`: no `<html>`, `<head>`, `<style>`, `<script>`, `style` or event attributes,
  external URLs, `<image>`, `<foreignObject>`, or images other than inline `<svg>`.
- Blocks, in order: `<p class="answer">` first and exactly once; then at most one `<p class="analogy">`; then
  one or more `<section>`; then at most one `<p class="takeaway">` last. The template prints the analogy's and
  takeaway's labels itself.
- A `<section>` holds `h2`, `p`, `<dl class="parts">`, `<ol class="steps">`, `<div class="compare">` (exactly
  two child `div`s, each starting with an `h3`), `<ol class="timeline">` (each `li` = `<time>`, `<b>`, text).
- A section with a drawing is `<section class="spread">` whose first child is
  `<figure class="plate"><svg viewBox="…"><title>…</title>…</svg><figcaption>Plate N. …</figcaption></figure>`
  and whose second child is `<div class="text">`.
- Parts: `<dl class="parts">` rows `<div data-part="a"><dt>A</dt><dd><b>Name</b>definition</dd></div>`,
  letters `a`–`f`; every SVG element of that part has class `part` and the same `data-part`; its label in the
  drawing starts with the capital letter (`A · the session`).
- SVG classes only: `ink`, `ink-accent`, `dash`, `wash-warm`, `wash-cool`, `wash-sage`, `label`, `label-soft`,
  `part`. No literal colours, no `width`/`height` attributes on the `svg`. Wash paths come before the ink they
  sit behind. Keep labels at least 24 viewBox units apart and never overlapping a line.
- Every SVG has a `viewBox` and a `<title>`.

## HTML file — `hooks/explain/html.ts`

```ts
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
export type Page = { title: string; main: string; project: string; generatedAt: string };
export const cleanMain = (main: string): string; // drops navigation, scripts, handlers, external refs
export const assemble = (template: string, page: Page): string;
export const slugOf = (title: string): string;
export const explainerPath = (home: string, project: string, at: Date, title: string): string;
export const writeExplainer = (
  io: { read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>;
        exists: (path: string) => Promise<boolean>; mkdir: (dir: string) => Promise<void> },
  root: string, // $.plugin.root
  home: string,
  page: Omit<Page, "generatedAt">,
  at: Date,
) => Promise<string>; // the absolute path written
```

- `template.html` carries the placeholders `{{csp}}`, `{{title}}`, `{{project}}`, `{{generatedAt}}`,
  `{{main}}`. `assemble` replaces every occurrence in one pass, so an inserted value is never re-scanned;
  `{{title}}`, `{{project}}` and `{{generatedAt}}` are HTML-escaped (`& < > " '`); `{{main}}` gets
  `cleanMain(main)`; `{{csp}}` gets `CSP`. The CSP blocks fetches but not self-navigation, so `cleanMain`
  removes `script`/`style`/`iframe`/`object`/`embed`/`form`/`foreignObject` elements, `meta`/`base`/`link`/
  `frame`/`image` tags, `on…=` and `style=` attributes, and any `href`/`src`/`xlink:href` not starting with `#`.
  The template's `<head>` holds `<meta http-equiv="Content-Security-Policy" content="{{csp}}">`.
- `slugOf`: lowercase; every run of characters outside `\p{L}\p{N}` becomes `-`; trim dashes; at most
  40 code points; empty → `"explainer"`. `slugOf("Fork vs Jev: who routes?")` → `"fork-vs-jev-who-routes"`;
  `slugOf("為什麼用 fork")` → `"為什麼用-fork"`.
- `explainerPath` → `${home}/.local/share/q-lab/runes/explain/${slugOf(project)}/${YYYYMMDD}-${HHMM}-${slugOf(title)}.html`
  in local time, zero-padded.
- `writeExplainer` reads `${root}/hooks/explain/template.html`, makes the directory, and when the path exists
  tries `-2`, `-3`, … before `.html`; it never overwrites.
- The project directory is slugged so no explainer path holds a space; the checker's shell command quotes
  only the Chrome path, and its allow-list splits paths at spaces.
- `project` = the basename of `git rev-parse --show-toplevel` in the session cwd, else the cwd's basename.

## Passing `$` across files

`claude plugin validate` follows `$` past an import **only into a `function` declaration called by its bare
name** (measured on build 2.1.310 with a two-file spike): `export async function explainPress($) {…}` called as
`explainPress($)` passes, also from inside a Button's `onPress` arrow; `explainPress($)` (an object method) fails
with `$ itself is passed as an argument`, and an exported arrow `const f = async ($) => …` fails with `a name
bound to a function expression`. So every cross-file function below that takes `$` is a `function` declaration,
and no callback ever receives `$`. A function defined and called inside one file may be an arrow.

## Layout checker — `hooks/explain/checker.ts`

```ts
export const CHECKER = "runes:explain-checker";
export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CHECK_TIMEOUT_MS = 180_000;
export type CheckResult = { check: ExplainCheck; note?: string };
export const parseVerdict = (answer: string): CheckResult & { token?: string };
// last non-empty line; an optional leading "c<digits> " is the token; then "OK" → ok; "FIXED <n>" → fixed,
// note "<n> fix(es)"; "FAILED <reason>" → failed, note reason; else failed, note "unreadable verdict"
export async function registerChecker($: EngineInterface): Promise<void>; // $.agent.register(...), from register.tsx's session.start
export async function startCheck($: EngineInterface, entryId: string, path: string): Promise<void>;
export function checker(on: On): void; // agent.offer, tool.check ×4, tool.call SubagentHandback, turn.complete ×2
```

`startCheck` returns once the checker has started; no hook waits for its answer, because a hook's own time is
capped at 10 s and an awaited module promise does not pause that clock. There is no callback: whichever hook
learns a check's result **settles** it with its own `$`, inside `checker.ts`:
`update($, view, (v) => patchEntry(v, entryId, { check, note }))` (`view` and `patchEntry` from `state.ts`), then
`await $.process.run(["open", path])`, whatever the result. Settled once per check, by: `startCheck` itself for
`skipped` (note `"no Chrome"`) and a denied spawn (`failed`, note the deny text); the checker's `turn.complete`
for its verdict; the first `turn.complete` of any loop, or `startCheck`, after `CHECK_TIMEOUT_MS` for `failed`,
note `"timed out"`. Each check gets a token (`c1`, `c2`, …) in the spawn's task message; the checker's final line
starts with it. A verdict settles the check its token names, else the check whose spawn returned that `agentId`;
nothing else matches, and a timed-out check is forgotten, so a late answer is ignored.

`checker(on)` hooks `turn.complete` twice, `{ isAborted: false }` and `{ isAborted: true }`, sharing one body:
together they see every turn of every loop, and neither collides with Clawd's unmatched `turn.complete` in
`clawd/mascot.tsx` or fold's four `{ reason }` matchers in `transcript/fold.tsx` (a spike validated all seven
side by side).

## Orchestrator — `hooks/explain/explain.ts`

```ts
export const PANE = "runes-explain";
export async function explainPress($: EngineInterface): Promise<void>; // the button
export async function explainAsk($: EngineInterface, text: string): Promise<void>; // the Input's onSubmit
export async function explainPick($: EngineInterface, topic: string): Promise<void>; // an ask option Button
export async function explainSelect($: EngineInterface, id: string): Promise<void>; // a history row
export async function explainReopen($: EngineInterface, id: string): Promise<void>; // an html entry's "open again"
export function explainHooks(on: On): void; // checker(on), and nothing else that collides
```

Every handler is called by bare name from a Button's `onPress` or an Input's `onSubmit` in the band or the pane
(`onPress={() => explainPress($)}`, the promise returned, never dropped with `void`), so it receives that hook's
`$`. `explainPress`, `explainAsk` and `explainPick` do nothing while `view.isRunning` is true.

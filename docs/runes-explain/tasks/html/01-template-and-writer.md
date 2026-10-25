# HTML-01: template-and-writer

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/design.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: html/02, core/03
> **Status**: todo

## Goal

An html reply from the fork can be assembled into the shipped Picture-Book Workshop skeleton and written,
never overwriting, to `~/.local/share/q-lab/runes/explain/<project>/<YYYYMMDD-HHMM>-<slug>.html` with a CSP
that blocks scripts, network and fonts.

## Files to create / modify

- `packages/runes/hooks/explain/template.html` (new) — the explainer skeleton, built from
  `docs/runes-explain/design/mock.html` as `design.md` → `## Template shell` says.
- `packages/runes/hooks/explain/html.ts` (new) — `CSP`, `Page`, `assemble`, `slugOf`, `explainerPath`,
  `writeExplainer`, exactly as `protocol.md` → `## HTML file — hooks/explain/html.ts` declares them.
- `packages/runes/hooks/explain/html.test.ts` (new) — the tests below, in the plugin test kit.

## Implementation notes

### template.html

Build it from the mock, not from memory:

1. Take the `<head>` / `<body>` shell from `design.md` → `## Template shell` verbatim: the CSP meta
   `<meta http-equiv="Content-Security-Policy" content="{{csp}}" />`, `<title>{{title}}</title>`, the hidden
   `<svg>` holding `<filter id="wash">`, and `<article class="sheet">` with the masthead
   `<span>{{project}} · explained</span><time>{{generatedAt}}</time>`, `<h1>{{title}}</h1>`,
   `<main>{{main}}</main>`, and the colophon `<span>Written by a fork of this session</span>`.
2. Copy the stylesheet from `docs/runes-explain/design/mock.html`: everything after the comment
   `the skeleton: everything below ships in template.html` (line ~75 of the mock), then:
   - move the custom properties declared on `.sheet` (`--paper` … `--vignette`, each with its comment) onto `:root`;
   - remove the `.sheet` `box-shadow`;
   - give `body` the same paper background (colour, vignette, grain URL, blend) so the sheet fills the window;
   - keep the reset `* { box-sizing: border-box; margin: 0; }` from above the skeleton comment, first in the
     stylesheet: the sheet width, line breaks and spacing depend on it;
   - drop every other mock-only rule (`.index`, `.specimen`, `.narrow` specimen framing, the dark `body` above the
     skeleton comment);
   - keep the grain data-URI string byte for byte.
3. The colophon carries **no check status** (the page is written before the check runs). There is **no dark
   theme** and no `prefers-color-scheme` rule; keep the `prefers-reduced-motion` rule.
4. The page uses no script, no external URL, no web font (the CSP would block them anyway).

The five placeholders are `{{csp}}`, `{{title}}`, `{{project}}`, `{{generatedAt}}`, `{{main}}`; `{{title}}`
appears twice (`<title>` and `<h1>`).

### html.ts

Signatures (from `protocol.md`):

```ts
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
export type Page = { title: string; main: string; project: string; generatedAt: string };
export const cleanMain = (main: string): string;
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

- `assemble` replaces **every** occurrence of each placeholder in **one pass** over the template:
  `template.replace(/\{\{(csp|title|project|generatedAt|main)\}\}/g, (_, key) => …)`. One pass means text an
  inserted value carries (a Vue `{{ message }}`, even a literal `{{title}}` inside `main`) is never replaced
  again. `{{title}}`, `{{project}}`, `{{generatedAt}}` are HTML-escaped (`&` → `&amp;`, `<` → `&lt;`, `>` →
  `&gt;`, `"` → `&quot;`, `'` → `&#39;`); `{{main}}` gets `cleanMain(page.main)`, otherwise raw; `{{csp}}` gets
  `CSP`. The replacer function also keeps a `$&` or `$1` inside `main` literal.
- `cleanMain(main)` runs on `main` before `assemble` inserts it, because the CSP does not stop a page from
  navigating itself (`<meta http-equiv="refresh">`, a `<base>`, a form). It removes, case-insensitively:
  whole elements with their content for `script`, `style`, `iframe`, `object`, `embed`, `form`, `foreignObject`;
  the tags `meta`, `base`, `link`, `frame`, `image`; every `on…=` attribute and every `style=` attribute; and every
  `href`, `src` or `xlink:href` whose value does not start with `#`. Mark it in code as a corner cut: a regex
  pass, not a parser, so its ceiling is a fork that writes malformed markup on purpose; the upgrade trigger is an
  explainer seen to load or navigate anything. Example: `'<p class="answer">hi</p><meta http-equiv="refresh" content="0;url=https://example.com/">'`
  → `'<p class="answer">hi</p>'`.
- `slugOf`: lowercase; every run of characters outside `\p{L}\p{N}` (regex flag `u`) becomes `-`; trim
  leading and trailing dashes; cut to at most 40 code points (`[...s].slice(0, 40)`, then trim a trailing
  dash again); empty → `"explainer"`.
  `slugOf("Fork vs Jev: who routes?")` → `"fork-vs-jev-who-routes"`; `slugOf("為什麼用 fork")` → `"為什麼用-fork"`.
- `explainerPath` →
  `${home}/.local/share/q-lab/runes/explain/${slugOf(project)}/${YYYYMMDD}-${HHMM}-${slugOf(title)}.html`, local time
  (`getFullYear`, `getMonth() + 1`, `getDate`, `getHours`, `getMinutes`), each field zero-padded.
- `writeExplainer`:
  1. `io.read(`${root}/hooks/explain/template.html`)`;
  2. `generatedAt` is the masthead format the mock uses, local time: `25 Oct 2026 · 14:32`
     (day without padding, English three-letter month, four-digit year, `·`, `HH:MM` zero-padded);
  3. `io.mkdir` the directory of `explainerPath(...)`;
  4. when that path exists, try `…-2.html`, `…-3.html`, … (suffix before `.html`) until `io.exists` is false;
     never overwrite;
  5. `io.write` the assembled page there and return that absolute path.
- `html.ts` is pure: no `$`. The caller (the orchestrator) adapts `$.fs` into `io` and passes
  `$.plugin.root` and `HOME` from `$.env.get("HOME")`. Computing `project` (the basename of
  `git rev-parse --show-toplevel`, else the cwd's basename) is the caller's job, not this file's.

### Tests (`html.test.ts`, `import { expect, test } from "claude-code/testing"`)

Use an in-memory `io` (a `Map<string, string>` for files, an array recording `mkdir` calls). No `$`.

## Acceptance criteria

- [ ] `template.html` holds each of `{{csp}}`, `{{title}}`, `{{project}}`, `{{generatedAt}}`, `{{main}}`, and
      the meta `http-equiv="Content-Security-Policy" content="{{csp}}"`.
- [ ] `template.html` holds no `<script`, no `http://` / `https://` URL other than the SVG namespace
      `http://www.w3.org/2000/svg`, no `prefers-color-scheme`, and its tokens sit on `:root`.
- [ ] `assemble` escapes `& < > " '` in title, project and generatedAt; inserts `main` unescaped (including a
      literal `$&`); replaces both `{{title}}` occurrences; none of the five placeholders of the shipped
      template remains in the output, while a `main` holding `{{ message }}` and `{{title}}` keeps both
      verbatim.
- [ ] `cleanMain` turns the meta-refresh example into `<p class="answer">hi</p>`, and strips a `<script>…</script>`,
      an `onclick=`, a `style=`, a `<base href>`, and an `href="https://…"`, while keeping `href="#part-a"`, an
      inline `<svg>` with its classes, and every component class from `design.md`.
- [ ] The assembled page contains `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`.
- [ ] `slugOf` gives the two examples above, `"explainer"` for `"?!"` and `""`, and at most 40 code points
      for a long title.
- [ ] `explainerPath` zero-pads month, day, hour and minute (`new Date(2026, 0, 5, 7, 3)` → `20260105-0703-…`), and slugs the project directory (`"My Project"` → `/explain/my-project/`), so no path the checker screenshots holds a space.
- [ ] `writeExplainer` calls `mkdir` with the explainer directory, writes to `-2` when the first path exists
      and `-3` when both do, never overwrites an existing file, and returns the path it wrote.
- [ ] (human) Assemble the template with the inner HTML of `#diagram`'s `<main>` in `docs/runes-explain/design/mock.html`
      (the diagram-heavy specimen) as `main`, title `How a press becomes an explainer`. **Wide:** open it in a
      1280-wide window and the mock in a 1376-wide one (the mock's `.specimen` adds 48px padding each side, so
      both sheets are 1280 wide), side by side at `#diagram`. These must match: paper colour and grain, masthead
      line, `h1` size and line breaks, the answer paragraph, the analogy slip and its label, the spread with the
      plate sticky, the wash and ink in the drawing, the parts hover linking a–c (the fixture's three parts), the
      takeaway slip, the colophon. **Narrow:** open it in a 420-wide window beside the mock's `#narrow` specimen
      and compare behaviour, not content: the spread stacks with the plate above the text and no longer sticky,
      labels grow to 24px / 21px, the sheet padding is `36px 22px 44px`. Expected differences, not defects: no
      sheet shadow or specimen frame and heading, the body itself carries the paper, the colophon reads `Written
      by a fork of this session` with no check status, and the masthead shows the assembled project and time.

## Verification

- [ ] `claude plugin test packages/runes` passes, including `hooks/explain/html.test.ts`.
- [ ] `claude plugin validate packages/runes` reports no error.
- [ ] `for p in '{{csp}}' '{{title}}' '{{project}}' '{{generatedAt}}' '{{main}}' 'http-equiv="Content-Security-Policy" content="{{csp}}"'; do grep -qF "$p" packages/runes/hooks/explain/template.html || echo "missing $p"; done` prints nothing.
- [ ] `grep -cE '<script|prefers-color-scheme' packages/runes/hooks/explain/template.html` prints `0`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                              | 2–3 (below bar)                                             | 4–5 (pass)                                                                                     |
| ----------------------- | ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | template drifts from the mock's skeleton, or CSP / placeholders missing | page renders but a token, the grain URL, or escaping drifts | template matches the mock's skeleton per Template shell; every signature matches `protocol.md` |
| Test coverage           | ×2     | no tests                                                                | happy path of `assemble` and `slugOf` only                  | escaping, `$&`, both slug examples, padding, `-2`/`-3` collision and mkdir all tested          |
| Interface & readability | ×1     | `html.ts` touches `$` or does I/O directly                              | pure but tangled                                            | pure functions, injected `io`, names match the contract                                        |
| Assumptions & docs      | ×1     | the date format or suffix rule is invented silently                     | chosen but unexplained                                      | follows the mock's masthead format; no comments beyond a one-line why                          |

## Out of scope

- Opening the file, spawning the layout checker, and computing `project` — Deferred. Reason: the orchestrator
  owns them; this task ships only pure assembly and writing.
- A dark theme — Deferred. Reason: dropped during the design phase; one light theme ships.
- A full HTML parser for `main` — Deferred. Reason: `cleanMain`'s regex pass covers the navigation and script
  vectors the CSP leaves open; take a parser only when an explainer is seen to load or navigate.

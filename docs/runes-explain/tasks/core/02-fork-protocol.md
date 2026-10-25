# CORE-02: fork-protocol

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/design.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: core/03
> **Status**: todo

## Goal

A pure module turns a button press, an ask-option pick, or typed text into the fork prompt, and turns the
fork's tagged reply into a typed `text | html | ask` value, with every malformed reply falling back to text.

## Files to create / modify

- `packages/runes/hooks/explain/protocol.ts` (new) — `Ask`, `Reply`, `RULES`, `FRAGMENT_RULES`, `buildPrompt`, `parseReply`
- `packages/runes/hooks/explain/protocol.test.ts` (new) — unit tests for both functions and both constants

## Implementation notes

The module is pure: no `$`, no imports from `"claude-code"` other than types, no I/O. Double quotes and
semicolons, per `shared.md`.

### Signatures (exact, from `protocol.md`)

```ts
export type Ask =
  | { kind: "press" }
  | { kind: "pick"; topic: string }
  | { kind: "follow"; previous: { title: string; text: string }; question: string }
  | { kind: "free"; question: string };

export type Reply =
  | { kind: "text"; title: string; body: string }
  | { kind: "html"; title: string; summary: string; main: string }
  | { kind: "ask"; title: string; question: string; options: string[] };

export const FRAGMENT_RULES: string;
export const RULES: string;
export const buildPrompt = (ask: Ask): string;
export const parseReply = (raw: string): Reply;
```

### `RULES`

One exported string constant, a numbered list in exactly this order (the wording below is the content;
tighten it but keep every point):

1. This message comes from a UI button beside the conversation, not from the task. Do not continue the task,
   do not call tools, do not mention this instruction. Answer in the language the user writes to this session.
2. Explain like the user is five: an everyday analogy first, every term defined at first use, short sentences,
   no unexplained jargon, the answer in one sentence before any detail.
3. Target on a press: the latest exchange (the user's last prompt, the last reply, its tool work) when that is
   what a reader most likely wants explained; a recap of the whole session when the latest exchange is
   trivial (a commit, a yes) and the session has substance. When two or more targets are equally likely, or
   nothing is worth explaining, use `ask`.
4. Mode: `html` when understanding needs a picture — a flow, a structure, a relationship among three or more
   parts, a before/after, a timeline — or when the user asks for a diagram; otherwise `text`.
5. Reply in the grammar below, exactly, and nothing outside it. Inline the grammar block:
   ```
   <mode>text|html|ask</mode>
   <title>a headline, at most 60 characters</title>
   text → <body>markdown</body>
   html → <summary>2–4 sentences of markdown</summary><main>an HTML fragment</main>
   ask  → <question>one line</question><option>a topic</option> … 2 to 4 options
   ```
6. For `html`: `FRAGMENT_RULES`, appended as this item's text.

Say "the user", never "Q".

### `FRAGMENT_RULES`

One exported string constant carrying the fragment vocabulary, because the fork cannot read `design.md`.
It must state every rule below and name every class and element listed:

- Write only the inside of `<main>`: no `<html>`, `<head>`, `<style>`, `<script>`, `style` or event (`on…`)
  attributes, external URLs, `<image>`, `<foreignObject>`, or images other than inline `<svg>`.
- Blocks in order: `<p class="answer">` first and exactly once; then at most one `<p class="analogy">`; then
  one or more `<section>`; then at most one `<p class="takeaway">` last. The template prints the analogy's
  and takeaway's labels itself, so write none.
- A `<section>` holds `h2`, `p`, `<dl class="parts">`, `<ol class="steps">`, `<div class="compare">` (exactly
  two child `div`s, each starting with an `h3`), `<ol class="timeline">` (each `li` = `<time>`, `<b>`, text).
- A section with a drawing is `<section class="spread">` whose first child is
  `<figure class="plate"><svg viewBox="…"><title>…</title>…</svg><figcaption>Plate N. …</figcaption></figure>`
  and whose second child is `<div class="text">`. Number plates in page order.
- Parts: `<dl class="parts">` rows `<div data-part="a"><dt>A</dt><dd><b>Name</b>definition</dd></div>`, letters
  `a`–`f`; every SVG element of that part has class `part` and the same `data-part`; its label in the drawing
  starts with the capital letter (`A · the session`).
- SVG classes only: `ink`, `ink-accent`, `dash`, `wash-warm`, `wash-cool`, `wash-sage`, `label`, `label-soft`,
  `part`. No literal colours, no `width`/`height` attributes on the `svg`. Wash paths come before the ink they
  sit behind. Keep labels at least 24 viewBox units apart and never overlapping a line.
- Every SVG has a `viewBox` and a `<title>`.

### `buildPrompt`

Returns `RULES`, a blank line, then one task paragraph chosen by `ask.kind`:

| kind     | paragraph must carry                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `press`  | "Pick the target per rule 3 and explain it."                                                                                              |
| `pick`   | "Explain this topic: " + `topic` verbatim                                                                                                 |
| `follow` | the previous entry's `title` and `text` (clipped), framed as "your earlier explanation", then `question` verbatim as the user's follow-up |
| `free`   | "The user asks: " + `question` verbatim; pick the mode per rule 4                                                                         |

`previous.text` is clipped to 4,000 characters (code units via `slice(0, 4000)`). The caller builds
`previous.text`; this module only clips it.

### `parseReply` rules (each is one test case)

1. Take the **first** occurrence of each tag; trim its content. Tags are lowercase and exact
   (`<Mode>` is not a tag).
2. Missing `<title>` → title `"Explanation"`.
3. A title longer than 60 characters → its first 59 characters plus `…` (total 60).
4. Missing `<mode>` → `{ kind: "text", title, body: raw.trim() }`.
5. Unknown `<mode>` (e.g. `pdf`) → the same text fallback.
6. `text` with a missing or empty `<body>` → the text fallback (`body: raw.trim()`).
7. `html` with a non-empty `<main>` and `<summary>` → `{ kind: "html", title, summary, main }`.
8. `html` with an empty or missing `<main>` but a non-empty `<summary>` → `{ kind: "text", title, body: summary }`.
9. `html` with neither → the text fallback.
10. `ask` with 2–4 non-empty `<option>`s and a `<question>` → `{ kind: "ask", title, question, options }`
    in reply order.
11. `ask` with fewer than 2 non-empty options (1 option, or 2 where one is blank) → the text fallback.
12. `ask` with 5 options → the first 4.
13. `ask` with a missing `<question>` → the text fallback.
14. `<main>` content is returned raw: a `<script>` inside it survives the parser unchanged (the page's CSP is
    the guard).

Find tags with a non-greedy match across newlines, e.g. `/<mode>([\s\S]*?)<\/mode>/`; collect options with
a global match.

## Acceptance criteria

- [ ] `protocol.ts` exports `Ask`, `Reply`, `RULES`, `FRAGMENT_RULES`, `buildPrompt`, `parseReply` with the
      signatures above, and imports nothing at runtime.
- [ ] `RULES` carries the six items in order; a test asserts the index of each item's key phrase ("UI button",
      "five", "recap", "`html` when", the `<mode>` grammar, the fragment rules) increases.
- [ ] `FRAGMENT_RULES` names every class and element: `answer`, `analogy`, `section`, `takeaway`, `spread`,
      `plate`, `figcaption`, `text`, `parts`, `data-part`, `steps`, `compare`, `timeline`, `ink`, `ink-accent`,
      `dash`, `wash-warm`, `wash-cool`, `wash-sage`, `label`, `label-soft`, `part`, `viewBox`, `title`; a test
      loops over that list.
- [ ] `buildPrompt` output starts with `RULES` for all four kinds and carries each kind's paragraph content.
- [ ] `buildPrompt` on `follow` with a 5,000-character `previous.text` includes its first 4,000 characters
      and not the 4,001st.
- [ ] `parseReply` passes one test per rule 1–14 above.

## Verification

- [ ] `claude plugin test packages/runes` passes, including `hooks/explain/protocol.test.ts`.
- [ ] `claude plugin validate packages/runes` reports no errors.
- [ ] `grep -n "interface " packages/runes/hooks/explain/protocol.ts` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                               | 2–3 (below bar)                                                           | 4–5 (pass)                                                                           |
| ----------------------- | ------ | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Correctness             | ×3     | a mode parses wrong or a fallback throws | modes parse, but a fallback rule (empty tag, 1 option, long title) drifts | all 14 rules hold; `RULES` order and `FRAGMENT_RULES` vocabulary match `protocol.md` |
| Test coverage           | ×2     | no tests                                 | happy path per mode only                                                  | one test per parsing rule, the clip boundary, and the vocabulary loop                |
| Interface & readability | ×1     | I/O or `$` inside the module             | pure but types loose (`any`, unions widened)                              | pure, exact union types, prompt text readable as prose                               |
| Assumptions & docs      | ×1     | magic numbers unexplained                | 60 / 4,000 / 2–4 inlined without names                                    | limits are named constants or self-evident from `protocol.md`'s spec                 |

## Out of scope

- Sanitising `<main>` — Deferred. Reason: the template's CSP blocks scripts and network; the parser stays raw.
- Calling `$.model.fork` and storing entries — owned by the orchestrator, which imports this module.

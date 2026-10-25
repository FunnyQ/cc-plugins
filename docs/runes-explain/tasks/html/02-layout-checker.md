# HTML-02: layout-checker

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/design.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01, html/01
> **Blocks**: core/03
> **Status**: blocked

## Goal

A hidden `runes:explain-checker` subagent screenshots a freshly written HTML explainer with headless Chrome,
fixes overlapping or clipped diagram labels in place, and reports a verdict the orchestrator stores as the
entry's check status, so Q never opens a page with a broken drawing.

## Files to create / modify

- `packages/runes/hooks/explain/checker.ts` (new) — the agent definition, its prompt, `registerChecker`,
  `startCheck`, `parseVerdict`, and the `checker(on)` hooks.
- `packages/runes/hooks/explain/checker.test.ts` (new) — plugin-test-kit tests for every branch below.

`register.tsx` is not touched here: the orchestrator wires `registerChecker` into `session.start` and
`checker(on)` into `register()`. Tests register `checker(on)` themselves.

## Implementation notes

### Exports (contract, byte for byte)

```ts
import type { EngineInterface, On } from "claude-code";
import type { ExplainCheck } from "../../types";

export const CHECKER = "runes:explain-checker";
export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CHECK_TIMEOUT_MS = 180_000;
export type CheckResult = { check: ExplainCheck; note?: string };
export const parseVerdict = (answer: string): CheckResult & { token?: string };
export async function registerChecker($: EngineInterface): Promise<void>;
export async function startCheck($: EngineInterface, entryId: string, path: string): Promise<void>;
export function checker(on: On): void;
```

`ExplainCheck` is `"pending" | "ok" | "fixed" | "failed" | "skipped"`, declared in
`packages/runes/types/index.d.ts`. Use whatever type name the engine exports for `on` (the type `Register`'s
first parameter); if it exports none, write `Parameters<Register>[0]`.

### `parseVerdict`

Take the last non-empty line of the answer, trimmed. When it starts with a check token (`c` plus digits)
and one space, strip that prefix into `token`. Then read the rest:

| Line (after the token)  | Result                                            |
| ----------------------- | ------------------------------------------------- |
| `OK`                    | `{ check: "ok" }`                                 |
| `FIXED 2`               | `{ check: "fixed", note: "2 fix(es)" }`           |
| `FAILED chrome crashed` | `{ check: "failed", note: "chrome crashed" }`     |
| anything else, or empty | `{ check: "failed", note: "unreadable verdict" }` |

`"c3 FIXED 2"` → `{ token: "c3", check: "fixed", note: "2 fix(es)" }`; `"OK"` → `{ check: "ok" }` with no token.

`FIXED` needs a positive integer after one space; `FIXED x` is unreadable. `FAILED` with no reason →
note `"unreadable verdict"`. Reading only the last non-empty line lets a model that writes a sentence
before its verdict still parse.

### Agent definition — `registerChecker($)`

Called once from `session.start`. It reads `HOME` with `(await $.env.get("HOME")) ?? ""` (the mod's child
processes get no HOME, so take it here) and keeps the explainer root in a module-level variable:
`explainDir = `${home}/.local/share/q-lab/runes/explain/``. An empty HOME leaves `explainDir` empty, and then
every allow below falls through to `next(e)`. Then:

```ts
await $.agent.register({
  name: "explain-checker",
  description:
    "Screenshots a runes explainer page and fixes broken diagram labels. Spawned by runes alone.",
  prompt: CHECKER_PROMPT,
  tools: ["Bash", "Read", "Edit"],
  model: "sonnet",
  effort: "medium",
  omitClaudeMd: true,
});
```

`CHECKER_PROMPT` is a module constant (export it so a test can assert on it). It must say, in this order:

1. You check one HTML explainer page. The task message gives its absolute path and a check token.
2. Screenshot it with exactly
   `"<CHROME>" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,4000 --screenshot=<dir>/<name>.check.png file://<html>`
   and for the narrow pass `--window-size=420,7000` with `--screenshot=<dir>/<name>.check-narrow.png`, where
   `<dir>` is the page's own directory and `<name>` its file name without `.html`. Quote the Chrome path.
   Write no screenshot anywhere else. Then Read each PNG. Chrome captures the window, not the whole page, so
   the heights are tall on purpose; check that the colophon (`Written by a fork of this session`) is visible
   at the bottom of each shot. When it is not, the page is taller than the shot: answer `FAILED page taller
than the screenshot` rather than `OK`. One round is one wide plus one narrow shot.
3. Fix only: overlapping or clipped labels, arrows pointing at the wrong box, text outside its box, illegible
   contrast. Fix by editing the HTML file with Edit, inside `<main>` only. Never rewrite prose, never add or
   remove a section, never touch `<head>`, the CSP meta, or the `#wash` filter.
4. The drawing's rules, so a fix moves toward them: SVG elements use only the classes `ink`, `ink-accent`,
   `dash`, `wash-warm`, `wash-cool`, `wash-sage`, `label`, `label-soft`, `part`; no literal colours, no
   `style` attributes, no `width`/`height` on the `svg`; every `svg` keeps its `viewBox` and `<title>`; wash
   paths come before the ink they sit behind; labels sit at least 24 viewBox units apart and never on a line;
   a part's label starts with its capital letter (`A · the session`). Labels grow to 24px (label) and 21px
   (label-soft) at 420 wide, so leave room for that: prefer moving a label or widening the `viewBox` to
   shrinking text.
5. At most 3 screenshot rounds in total.
6. Do not hand back. Your final message is exactly one line: the token, a space, then `OK` (nothing needed
   fixing), `FIXED <n>` (n edits made), or `FAILED <reason>` (a screenshot would not render, or the page is
   still broken after 3 rounds). Example: `c3 FIXED 2`.

The task message `startCheck` sends is `Check this explainer page: <path>\nYour check token is <token>.`

### `startCheck($, entryId, path)`

A hook has a 10-second budget of its own time (`HookBudget.ms`), and an awaited module promise is not a `$`
call, so the clock keeps running through it. No hook may therefore wait for the checker's answer, and no callback
may receive `$` (`protocol.md` → "Passing `$` across files"). `startCheck` returns as soon as the checker has
started; whichever hook later learns the result **settles** the check with its own `$`, inside this file:

```ts
async function settle($: EngineInterface, p: Pending, r: CheckResult) {
  update($, view, (v) =>
    patchEntry(v, p.entryId, { check: r.check, note: r.note }),
  );
  await $.process.run(["open", p.path]);
}
```

(`view`, `patchEntry` from `./state`; `update` from `"claude-code"`.) Each check settles exactly once.

1. Expire stale checks first (below), with this `$`.
2. `await $.fs.exists(CHROME)` false → `settle($, { entryId, path }, { check: "skipped", note: "no Chrome" })`, return.
3. Take a fresh token `` `c${++checks}` `` from a module-level counter. `const spawned = await $.agent.spawn({ subagentType: CHECKER, prompt: `Check this explainer page: ${path}\nYour check token is ${token}.`, description: "check explainer layout" })`.
   `spawned.deny !== undefined` → `settle($, …, { check: "failed", note: spawned.deny })`, return.
4. Otherwise put `{ entryId, path, agentId: spawned.agentId, startedAt: await $.clock.now() }` into a
   module-level `Map<token, Pending>` and return.

**Settling.** A checker's `turn.complete` with `reason === "answer"` reads `parseVerdict(e.answer)` and settles
the pending check its token names; with no token, or any other reason, it settles the check whose stored
`agentId` equals `e.agentId`. Nothing else matches: no arrival order, no "the only pending one" fallback, because
a late answer from a timed-out check would then settle a newer one. An event that matches nothing is ignored.
Settling deletes the entry from the map first, then runs `settle` with that hook's `$`; a non-answer reason
settles with `{ check: "failed", note: e.reason }`.

**Expiry.** Timers cannot carry a `$` (`$.clock.after`'s `fn` gets none), so expiry is lazy: every
`turn.complete` the checker module sees (any loop, main included) and every `startCheck` first settles each
pending check whose `startedAt` is `CHECK_TIMEOUT_MS` or more in the past with `{ check: "failed", note: "timed out" }`,
using that hook's `$`. A timed-out check's later answer finds no map entry and is ignored. The ceiling: a
check that times out while the session is idle shows `timed out` at the next turn end, not at 180 s exactly.

### `checker(on)` — hooks

Copy guard's hidden-agent pattern (`packages/guard/hooks/register.ts`), adapted:

```ts
on("agent.offer", { agent: CHECKER }, () => ({ isOffered: false })).catch(
  () => ({ isOffered: false }),
);

on("tool.check", { tool: "Agent" }, async ($, e, next) => {
  const own =
    next.origin.plugin === $.plugin.name &&
    (e.input as { subagent_type?: string }).subagent_type === CHECKER;
  return own ? { decision: "allow" } : next(e);
});

on("tool.call", { tool: "SubagentHandback" as never }, async ($, e, next) => {
  const { agentId } = e as { agentId?: string };
  if (!agentId) return next(e);
  if ((await $.agent.list()).find((a) => a.id === agentId)?.type !== CHECKER)
    return next(e);
  return {
    deny: "Do not hand back. Reply with your check token, then OK, FIXED <n>, or FAILED <reason>, as your final message.",
  };
});
```

`tool.check` for `Bash`, `Read`, `Edit` (three more hooks, one matcher each, so four `tool.check` hooks in
total, all with distinct `{ tool }` matchers). Each one first checks that `e.agentId` is set and that
`(await $.agent.list()).find((a) => a.id === e.agentId)?.type === CHECKER`; otherwise `next(e)`. Then:

- **Bash** allows (`{ decision: "allow" }`) only when all hold, else `next(e)`:
  - `explainDir` is non-empty and holds no space (a HOME with a space falls through to the session's own
    rules; explainer file names are slugged, so nothing below it holds one);
  - the command starts with `"${CHROME}"` (the double-quoted path, then a space);
  - it contains none of `;`, `|`, `&`, `` ` ``, `$`, `<`, `>`, `%`, a newline (`%` rules out an encoded
    traversal such as `%2e%2e`, which Chrome would decode);
  - it has at least one `file://` path, and every `file://<p>` and `--screenshot=<p>` path (up to the next
    space) starts with `explainDir` and contains no `..` segment.
- **Read** and **Edit** allow only when `explainDir` is non-empty and `e.input.file_path` starts with it and
  has no `..` segment; else `next(e)`.

Falling to `next(e)` (not a deny) leaves the session's own permission rules in charge. The allow-list stays
even though the spike passed without it: auto mode's classifier can be unavailable, and an unavailable
classifier denies a subagent's call outright.

`turn.complete`: `const ran = await next(e)`; expire stale checks; then, if `e.agentId` is set and its type is
`CHECKER`, settle as above. Return `ran`. The event itself passes through untouched.

Register that body twice, `on("turn.complete", { isAborted: false }, body)` and `{ isAborted: true }`: together
they see every turn of every loop, and neither collides with Clawd's unmatched `turn.complete`
(`clawd/mascot.tsx`) or fold's four `{ reason }` matchers (`transcript/fold.tsx`); a spike validated all seven
side by side. Every function here that takes `$` and is called from another file is a `function` declaration.

### Tests (`checker.test.ts`)

Use `{ expect, mock, test } from "claude-code/testing"` and `fakeHost` / `startSession` from
`hooks/transcript/test-session.ts`; register `checker(on)` in the test plugin. A noun stub answers
`{ value }`, an event stub (`agent.spawn`) answers its result bare, and `$.clock` needs `mock.clock(on)`.
For the kit idiom of firing `tool.check`, `tool.call` and a subagent's `turn.complete`, read
`packages/guard/hooks/comment-review.mod.test.ts`.

## Acceptance criteria

- [ ] `parseVerdict` returns the table's result for `OK`, `FIXED 2`, `FAILED chrome crashed`, `FIXED x`, `FAILED`, `""`, `"Looked fine.\nOK"`, and `"c3 FIXED 2"` (token `c3`).
- [ ] `registerChecker` registers `explain-checker` with model `sonnet`, effort `medium`, tools exactly `["Bash", "Read", "Edit"]`, and `omitClaudeMd: true`; `CHECKER_PROMPT` contains the Chrome command shape with `1280,4000` and `420,7000`, the colophon-visible rule with `FAILED page taller than the screenshot`, every SVG class listed above, `24 viewBox units`, `at most 3`, and `OK`, `FIXED <n>`, `FAILED <reason>`.
- [ ] `agent.offer` for `runes:explain-checker` answers `isOffered: false`; `tool.check` `Agent` allows this plugin's spawn of `runes:explain-checker` and passes another plugin's or another type through.
- [ ] `tool.check` `Bash` allows a checker command matching the shape under `explainDir`, and passes through: a command from the main loop, a path outside `explainDir`, a `..` path, a command with `;` or `$`, a `file://<explainDir>/%2e%2e/x.html` path, an unquoted Chrome path. `Read`/`Edit` allow inside `explainDir` only, and with HOME missing (`explainDir` empty) `Bash`, `Read` and `Edit` all pass through.
- [ ] `tool.call` `SubagentHandback` from the checker is denied with the exact deny text; from another agent or the main loop it passes through.
- [ ] `startCheck` resolves right after the spawn, without waiting for an answer; each check settles exactly once — the entry's `check`/`note` patched and `process.run` called with `["open", path]` — as `skipped`/`"no Chrome"` when Chrome is missing, `failed`/the deny text when the spawn is denied, the parsed verdict on the checker's `turn.complete`, and `failed`/`"timed out"` at the first `turn.complete` after 180 000 ms have passed (`mock.clock`).
- [ ] Two checks started back to back and answered in reverse order (`c2 OK`, then `c1 FIXED 1`) each get their own verdict.
- [ ] After check A times out and check B starts, A's late answer — tokened, untokened, or a non-answer `turn.complete` — leaves B pending.

## Verification

- [ ] `claude plugin test packages/runes` passes, including `hooks/explain/checker.test.ts`.
- [ ] `claude plugin validate packages/runes` reports no errors.
- [ ] `git status --short -- packages/runes/hooks/explain/checker.ts packages/runes/hooks/explain/checker.test.ts` lists both files.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                              | 2–3 (below bar)                                             | 4–5 (pass)                                                                                                                                                                                     |
| ----------------------- | ------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | the allow-list admits a path outside `explainDir`, or a check can settle twice or never | happy path works; timeout, deny, or late-answer path drifts | every branch matches the contract; the allow-list refuses every listed escape                                                                                                                  |
| Test coverage           | ×2     | no tests                                                                                | verdict parsing and happy path only                         | every acceptance bullet has a test, each pass-through case included                                                                                                                            |
| Interface & readability | ×1     | signatures differ from the contract; `$` used after its hook returned                   | contract kept but hooks hard to follow                      | exports exactly as specified; one guard helper for "is this the checker's loop"                                                                                                                |
| Assumptions & docs      | ×1     | unexplained magic numbers or engine quirks                                              | quirks relied on without a why                              | the type-match, the token/`agentId` settling (why arrival order and a lone-waiter fallback would let a late answer settle a newer check) and the classifier reasons each carry one line of why |

## Out of scope

- Calling `registerChecker` from `session.start` and `checker(on)` from `register()` — Deferred. Reason: the orchestrator owns `register.tsx`.
- Firefox or Safari screenshots — Deferred. Reason: the spike proved headless Chrome only.

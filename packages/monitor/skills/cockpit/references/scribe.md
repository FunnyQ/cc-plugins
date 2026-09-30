# /cockpit-scribe

Distill the just-completed work into a small set of typed cockpit log
entries. You usually run as a background scribe spawned from the main
session, so you inherit its conversation (the "why") and add the code diff
(the "what"). A user can also run `/cockpit scribe` directly.

---

## Step 1 — Setup

If your prompt names the CLI, use it. Otherwise build it from the
`<plugin-root>` your provider reference resolved, and set the provider flag
off Claude Code:

```bash
CLI="<plugin-root>/skills/cockpit/scripts/cockpit.ts"   # absolute, substituted literally
PROVIDER_FLAG=""   # "--provider codex" under Codex, "--provider opencode" under OpenCode
```

Do not test for the file first. A wrong path makes bun print
`error: Module not found "<path>"` and exit 1; surface that and stop rather
than guess another path. Use `$PROVIDER_FLAG` on every call below — without
it, scribe resolves against Claude sessions and can write to the wrong one.

### Session — honor the parent handoff

A background-fork prompt carries the **initiating parent session** id as
`--session <id>` — usually the whole prompt, because the fork inherits the
conversation and needs nothing else told to it. Copy that literal value onto
every `cockpit scribe` call below: `--prep`, `--recent` if used, and every
write. Never auto-resolve from inside a background fork. Context inheritance
gives the fork the parent's conversation. The harness can still give the fork
its own session or transcript id.

If a prompt identifies this invocation as a background fork but omits the
parent session id, stop. Surface the missing handoff instead of risking a
write to the child session. **Direct/manual** `/cockpit scribe`
invocations have no parent handoff. They preserve the existing behavior:
omit `--session` and let the CLI auto-resolve the live session.

### Run the prep bundle before you write anything

```bash
bun "$CLI" scribe --prep --session "<parent-session-id>" $PROVIDER_FLAG
```

For a direct/manual invocation, omit the shown `--session` argument.

It prints the configured decision-log language, the last 8 scribe-authored
entries, and git change context (`git diff`, `git diff --staged`,
`git log --oneline -5`). Write every `--title` / `--text` in that language,
not the language of the conversation or your spawn prompt. The diff is your
main source for `rationale` and `caveat` entries; the conversation is your
main source for `decision` and `learning`. Do not re-log what the recent
entries already cover — if they cover the whole diff, skip to Step 3. When
git context is unavailable, the command prints a labeled notice and still
exits 0.

---

## Step 2 — Choose lenses and write entries

### First: sweep all four lenses

Before you write anything, walk the chunk of work through **each** lens
once. Do not stop at the first one that fits. `decision` is the easiest
framing to reach for. It crowds out the others unless you deliberately
check the rest:

- **decision** — Did I pick between real alternatives? What got rejected and why?
- **rationale** — Is any implementation non-obvious on purpose? What would the
  next reader "fix" that is actually load-bearing?
- **learning** — Did anything teach a reusable pattern, or overturn an
  assumption I started with? What would I tell someone hitting this next time?
- **caveat** — Did I trip on a sharp edge, precondition, or ordering trap? What
  will silently break if it's forgotten?

A typical worthy chunk yields entries across **two or three** lenses, not
one. If only `decision` survives the sweep, that is a valid outcome. It
should be the result of honestly asking all four, not of never asking.
Lenses are independent: a single piece of work can warrant a `decision`
*and* a `caveat` *and* a `learning`.

### Default to a diagram — prose is the fallback

The pilot reads diagrams faster than prose. Default to **diagram-first**.
For each surviving entry, first try to express the insight as a Mermaid
`--diagram` — a flow, state machine, sequence, fan-out, before/after, or
decision tree. The `--diagram` rides *alongside* `--text`. The picture
carries the shape. The text carries what a picture cannot.

**Guardrail — diagram-first is not diagram-always.** When the insight is
genuinely *flat* — a single `caveat` sentence ("X must run before Y"), or a
one-line `decision` ("chose append-only JSONL over SQLite") — fall back to
prose-only. Forcing a diagram onto a flat fact adds noise, not clarity. The
test: if the "what" has a shape, draw it. If it is a sentence, write the
sentence.

When you decide to attach a `--diagram`, read [references/diagram.md](diagram.md)
first.

### Then: write each surviving entry

For each insight that is genuinely worth recording and not yet covered,
pick a `kind` and call:

```bash
bun "$CLI" scribe --type <kind> --title "<short headline>" --text "<body, markdown>" --session "<parent-session-id>" $PROVIDER_FLAG
```

### Kind values and when to use them

| `kind` | Use when | Tell-tale phrase |
|---|---|---|
| `decision` | A choice was made between real alternatives — something the diff alone can't explain. | "chose X over Y because…" |
| `rationale` | A non-obvious implementation is the way it is for a specific reason; answers "why not the obvious alternative?" | "this looks wrong but it's deliberate because…" |
| `learning` | A teachable result or pattern the pilot should take away — something reusable beyond this task. | "turns out…", "next time, …" |
| `caveat` | A trap, precondition, or sharp edge to remember — something that will bite you if you forget it. | "watch out — if you…", "must happen before…" |

`learning` and `caveat` are not consolation prizes for when there is no
decision. They are the highest-value entries for a future reader, because
they transfer beyond this one task. Reach for them actively.

These four values are the only valid `--type` arguments. Any other value
will be rejected by the CLI with a non-zero exit.

### CLI surface reference

```
cockpit scribe --type <kind> --text <body> [--title <headline>] [--file <path>]... [--diagram <mermaid>] [--session <id>] [--provider <p>]
cockpit scribe --recent [N]
cockpit scribe --prep [--provider <p>]
```

- `--type` — required in write mode. Must be `decision|rationale|learning|caveat`.
- `--text` — required. The markdown body maps to `reason` in the record.
- `--title` — optional. The short headline maps to `decision` in the record.
- `--file` — optional, repeatable. Source files touched by this entry.
- `--diagram` — optional **Mermaid** source. The dashboard renders it inline as a
  Night Flight-themed SVG. Read [references/diagram.md](diagram.md) first.
- `--prep` — prints the configured language, recent scribe entries, and git
  change context in one call.
- `--session` / `--provider` — optional for direct/manual use. A thoughtful
  background fork must use the parent session id handed to it in the prompt.

### Tone

Entries are for a future reader skimming the decision trail: concrete,
terse, no fluff. A `learning` should teach. A `rationale` should answer
"why not the obvious path." Avoid vague summaries, for example "the code
was improved." Be specific instead, for example "chose append-only JSONL
over SQLite to stay dependency-free in Bun."

---

## Step 3 — Consolidate; end quietly

**Dedup, but keep the lenses.** The bar is per insight, not per entry
count. Cut entries that repeat each other or restate the diff mechanically,
and one entry per file, step, or command. Do not cut a genuine `caveat` or
`learning` just to keep the total low. If the sweep surfaced nothing worth
keeping, such as purely mechanical changes, write nothing.

The written log is the whole output; no summary or confirmation is needed.

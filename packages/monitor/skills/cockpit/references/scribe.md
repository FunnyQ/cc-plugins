# /cockpit-scribe

Distill the just-completed work into a small set of typed cockpit log entries.
This skill runs inside a **background fork** spawned by `/thoughtful` — it
inherits the conversation context (the "why") and augments it with the code
diff (the "what"). It is **not** meant to be invoked directly by the user.

---

## Step 1 — Resolve the cockpit CLI path

`CLAUDE_PLUGIN_ROOT` is NOT reliable inside an agent Bash call. Resolve the
CLI from the load-time "Base directory for this skill" banner that Claude Code
prints when the skill loads.

```bash
# Substitute the real banner path in place of <BANNER_PATH>
SKILL_DIR="<BANNER_PATH>"        # the cockpit skill base dir
CLI="$SKILL_DIR/scripts/cockpit.ts"   # same skill — no ../ hop
test -f "$CLI" || { echo "cockpit CLI not found at $CLI" >&2; exit 1; }
```

The fork **must** substitute the real banner path — it cannot fall back to an
env var. If the file guard fails, stop and surface the error; do not continue.

### Session — honor the parent handoff

A `/thoughtful` background-fork prompt includes the **initiating parent
session** id. Copy that literal value and pass
`--session <parent-session-id>` on every `cockpit scribe` call below: `--prep`,
`--recent` if used, and every write. Never auto-resolve from inside a background
fork: context inheritance gives the fork the parent's conversation, but the
harness can still give the fork its own session/transcript id.

If a prompt identifies this invocation as a background fork but omits the
parent session id, stop and surface the missing handoff instead of risking a
write to the child session. **Direct/manual** `/cockpit scribe` invocations have
no parent handoff and preserve the existing behavior: omit `--session` and let
the CLI auto-resolve the live session.

### Provider — set it explicitly when running under Codex

`cockpit scribe` auto-resolves the session against **Claude** transcripts by
default. If this fork is running under **Codex** (not Claude Code), every
`cockpit scribe` call below — both `--prep` and the write calls — **must**
pass `--provider codex`, or scribe will resolve against the wrong vendor's
sessions (writing to a stale Claude session, or failing to find one):

```bash
# Under Codex, set this and append it to every scribe call:
PROVIDER_FLAG="--provider codex"
# Under Claude Code, leave it empty (claude is the default):
# PROVIDER_FLAG=""
```

Decide which surface you are on from the inherited context (the spawn prompt
notes the surface) and use `$PROVIDER_FLAG` consistently in every call below.

### Run the prep bundle — BEFORE you write anything

Entries must be written in the configured decision-log language, **not** the
language of the inherited conversation or your spawn prompt. Resolve it now, as
part of setup, so it is fixed before Step 2 writes a single entry:

```bash
bun "$CLI" scribe --prep --session "<parent-session-id>" $PROVIDER_FLAG
```

For a direct/manual invocation, omit the shown `--session` argument.

This one call prints the configured language, the last 8 scribe-authored entries
for dedup, and git change context (`git diff`, `git diff --staged`,
`git log --oneline -5`). Read the output carefully. The diff is your primary
source for `rationale` and `caveat` entries; the conversation context is your
primary source for `decision` and `learning` entries. Do **not** re-log material
already covered by the recent scribe entries; if the diff is fully described by
existing entries, skip to Step 3. If git context is unavailable, the command
prints labeled notices and still exits 0.

This is non-negotiable and overrides everything else: even if the conversation
you inherited and this prompt are entirely in English, every `--title` / `--text`
you write **must** be in the printed language. Mentally compose each entry in that language
from the start — do not draft in another language and rely on translating later.

---

## Step 2 — Choose lenses and write entries

### First: sweep all four lenses

Before you write anything, walk the chunk of work through **each** lens once —
do not stop at the first one that fits. `decision` is the easiest framing to
reach for, so it crowds out the others unless you deliberately check the rest:

- **decision** — Did I pick between real alternatives? What got rejected and why?
- **rationale** — Is any implementation non-obvious on purpose? What would the
  next reader "fix" that is actually load-bearing?
- **learning** — Did anything teach a reusable pattern, or overturn an
  assumption I started with? What would I tell someone hitting this next time?
- **caveat** — Did I trip on a sharp edge, precondition, or ordering trap? What
  will silently break if it's forgotten?

A typical worthy chunk yields entries across **two or three** lenses, not one.
If only `decision` survives the sweep, that's a valid outcome — but it should be
the result of honestly asking all four, not of never asking. Lenses are
independent: a single piece of work can warrant a `decision` *and* a `caveat`
*and* a `learning`.

### Default to a diagram — prose is the fallback

The pilot reads diagrams faster than prose, so **diagram-first**: for each
surviving entry, first try to express the insight as a Mermaid `--diagram` — a
flow, state machine, sequence, fan-out, before/after, or decision tree. The
`--diagram` rides *alongside* `--text` (the picture carries the shape; the text
carries what a picture can't), so reaching for it costs you nothing and is pure
upside.

**Guardrail — diagram-first is not diagram-always.** Fall back to prose-only when
the insight is genuinely *flat*: a single `caveat` sentence ("X must run before
Y"), a one-line `decision` ("chose append-only JSONL over SQLite"). Forcing a
diagram onto a flat fact adds noise, not clarity. The test: if the "what" has a
shape, draw it; if it's a sentence, write the sentence.

When you decide to attach a `--diagram`, read [references/diagram.md](diagram.md)
first.

### Then: write each surviving entry

For each insight that is genuinely worth recording and not yet covered, pick a
`kind` and call. Write `--title` and `--text` in the language printed by Step 1.

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

`learning` and `caveat` are not consolation prizes for when there's no
decision — they are the highest-value entries for a future reader, because they
transfer beyond this one task. Reach for them actively.

These four values are the only valid `--type` arguments. Any other value will
be rejected by the CLI with a non-zero exit.

### CLI surface reference

```
cockpit scribe --type <kind> --text <body> [--title <headline>] [--file <path>]... [--diagram <mermaid>] [--session <id>] [--provider <p>]
cockpit scribe --recent [N]
cockpit scribe --prep [--provider <p>]
```

- `--type` — required in write mode; must be `decision|rationale|learning|caveat`.
- `--text` — required; the markdown body (maps to `reason` in the record).
- `--title` — optional; the short headline (maps to `decision` in the record).
- `--file` — optional, repeatable; source files touched by this entry.
- `--diagram` — optional **Mermaid** source; the dashboard renders it inline as a
  Night Flight-themed SVG. Read [references/diagram.md](diagram.md) first.
- `--prep` — prints the configured language, recent scribe entries, and git
  change context in one call.
- `--session` / `--provider` — optional for direct/manual use. A thoughtful
  background fork must use the parent session id handed to it in the prompt.

### Tone

Entries are for a future reader skimming the decision trail: concrete, terse,
no fluff. A `learning` should teach; a `rationale` should answer "why not the
obvious path". Avoid vague summaries ("the code was improved") — be specific
("chose append-only JSONL over SQLite to stay dependency-free in Bun").

---

## Step 3 — Consolidate; end quietly

**Dedup across lenses — don't collapse to one.** The bar is per-*insight*, not
per-entry-count. Cut entries that repeat each other or restate the diff
mechanically; do NOT cut a genuine `caveat` or `learning` just to keep the total
low. A few high-signal entries spanning two or three lenses is the target — NOT
one entry per file/step/command, and NOT a single lonely `decision` when the
work also taught something or hid a trap. If the sweep in Step 4 truly surfaced
nothing worth keeping (e.g., purely mechanical changes), write nothing and end.

This is a fire-and-forget fork. The side effect is the written log. No summary
or confirmation message is needed.

---

## Implementation notes

This reference guide is meant to be invoked from inside a context-inheriting fork spawned by the cockpit skill (via the `thoughtful` command or auto-logging hook). On Claude Code that fork is an Agent-tool call with `subagent_type: "fork"`; on Codex it is a background sub-agent with `fork_context: true`. Either way the fork inherits the full conversation context (the "why") and augments it with the code diff (the "what"). Do not spawn it with `subagent_type` omitted or set to any other (custom/named) type — that starts a fresh agent with no conversation context and defeats the purpose.

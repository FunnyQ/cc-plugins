# /cockpit-scribe

Distill the just-completed work into a small set of typed cockpit log entries.
This skill runs inside a **background fork** spawned by `/thoughtful` — it
inherits the conversation context (the "why") and augments it with the code
diff (the "what"). It is **not** meant to be invoked directly by the user.

---

## Step 1 — Resolve the cockpit CLI path

`CLAUDE_PLUGIN_ROOT` is NOT reliable inside an agent Bash call. Resolve the
CLI from the load-time "Base directory for this skill" banner that Claude Code
prints when the skill loads. `cockpit-scribe` and `cockpit` are sibling
directories under `packages/monitor/skills/`, so:

```bash
# Substitute the real banner path in place of <BANNER_PATH>
SKILL_DIR="<BANNER_PATH>"        # the cockpit skill base dir
CLI="$SKILL_DIR/scripts/cockpit.ts"   # same skill — no ../ hop
test -f "$CLI" || { echo "cockpit CLI not found at $CLI" >&2; exit 1; }
```

The fork **must** substitute the real banner path — it cannot fall back to an
env var. If the file guard fails, stop and surface the error; do not continue.

### Provider — set it explicitly when running under Codex

`cockpit scribe` auto-resolves the session against **Claude** transcripts by
default. If this fork is running under **Codex** (not Claude Code), every
`cockpit scribe` call below — both `--recent` and the write calls — **must**
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

---

## Step 2 — Add the code-change lens

Run these commands to ground entries in what actually changed. The inherited
conversation provides the "why"; the diff provides the "what":

```bash
git diff
git diff --staged
git log --oneline -5
```

Read the output carefully. The diff is your primary source for `rationale` and
`caveat` entries; the conversation context is your primary source for
`decision` and `learning` entries.

---

## Step 3 — Dedup against already-logged scribe entries

Before writing anything, check what's already been recorded:

```bash
bun "$CLI" scribe --recent $PROVIDER_FLAG
```

This prints the last 8 scribe-authored entries (compact: `kind · title ·
time`). Read the list and do **not** re-log material already covered. If the
diff is fully described by existing entries, skip to Step 6.

---

## Step 4 — Choose lenses and write entries

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

### Also ask: is this structural enough to draw?

After the lens sweep, check each surviving entry once more: is the insight
**structural** — a flow, a state machine, a sequence, a fan-out — where a
picture carries it better than prose? If so, attach `--diagram` with Mermaid
source (see the CLI reference below). Don't force it on flat insights; reach for
it when the "what" is a shape, not a sentence.

### Then: write each surviving entry

For each insight that is genuinely worth recording and not yet covered, pick a
`kind` and call:

```bash
bun "$CLI" scribe --type <kind> --title "<short headline>" --text "<body, markdown>" $PROVIDER_FLAG
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
```

- `--type` — required in write mode; must be `decision|rationale|learning|caveat`.
- `--text` — required; the markdown body (maps to `reason` in the record).
- `--title` — optional; the short headline (maps to `decision` in the record).
- `--file` — optional, repeatable; source files touched by this entry.
- `--diagram` — optional **Mermaid** source; the dashboard renders it inline as a
  Night Flight-themed SVG. Use it only when the insight is structural and a picture
  carries it better than the `--text` body (a flow, a state machine, a sequence) —
  pass the source as one argument (a heredoc preserves newlines).
- `--session` / `--provider` — optional; omit to auto-resolve the live session.

### Tone

Entries are for a future reader skimming the decision trail: concrete, terse,
no fluff. A `learning` should teach; a `rationale` should answer "why not the
obvious path". Avoid vague summaries ("the code was improved") — be specific
("chose append-only JSONL over SQLite to stay dependency-free in Bun").

---

## Step 5 — Language

Before writing, resolve the log language from the cockpit config:

```bash
LANG_NAME="$(bun "$CLI" config get-language)"   # prints e.g. zh-TW, or English by default
```

Write `--title` / `--text` in `$LANG_NAME`. There is no project metadata fallback anymore.

---

## Step 6 — Consolidate; end quietly

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

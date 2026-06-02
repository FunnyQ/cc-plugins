---
name: cockpit-scribe
description: >-
  Distill the work just completed into typed cockpit decision-trail entries.
  Invoked inside a background fork by /thoughtful — not meant for direct human
  use. Reads the working diff, dedups against already-logged entries, and writes
  a few high-signal entries via `cockpit scribe`.
---

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
SKILL_DIR="<BANNER_PATH>"          # e.g. /path/to/packages/monitor/skills/cockpit-scribe
CLI="$SKILL_DIR/../cockpit/scripts/cockpit.ts"
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

For each insight that is genuinely worth recording and not yet covered, pick a
`kind` and call:

```bash
bun "$CLI" scribe --type <kind> --title "<short headline>" --text "<body, markdown>" $PROVIDER_FLAG
```

### Kind values and when to use them

| `kind` | Use when |
|---|---|
| `decision` | A choice was made between real alternatives — something the diff alone can't explain. |
| `rationale` | A non-obvious implementation is the way it is for a specific reason; answers "why not the obvious alternative?" |
| `learning` | A teachable result or pattern the pilot should take away — something reusable beyond this task. |
| `caveat` | A trap, precondition, or sharp edge to remember — something that will bite you if you forget it. |

These four values are the only valid `--type` arguments. Any other value will
be rejected by the CLI with a non-zero exit.

### CLI surface reference

```
cockpit scribe --type <kind> --text <body> [--title <headline>] [--file <path>]... [--session <id>] [--provider <p>]
cockpit scribe --recent [N]
```

- `--type` — required in write mode; must be `decision|rationale|learning|caveat`.
- `--text` — required; the markdown body (maps to `reason` in the record).
- `--title` — optional; the short headline (maps to `decision` in the record).
- `--file` — optional, repeatable; source files touched by this entry.
- `--session` / `--provider` — optional; omit to auto-resolve the live session.

### Tone

Entries are for a future reader skimming the decision trail: concrete, terse,
no fluff. A `learning` should teach; a `rationale` should answer "why not the
obvious path". Avoid vague summaries ("the code was improved") — be specific
("chose append-only JSONL over SQLite to stay dependency-free in Bun").

---

## Step 5 — Language

Before writing, check `<project>/.cockpit/project-meta.md` for the
`log_language` field:

```bash
# Example — read the field with grep or a one-liner
grep 'log_language' "<project>/.cockpit/project-meta.md" 2>/dev/null || true
```

- If `log_language` is set, write `--title` and `--text` in that language.
- If the field is absent or the file doesn't exist, default to **English**.

The project path is the working directory of the session being scribed; the
fork inherits this from the spawning context.

---

## Step 6 — Consolidate; end quietly

**Bias toward fewer entries.** Aim for a few high-signal entries per logical
chunk of work — NOT one entry per file changed, per step taken, or per command
run. If nothing in the diff meets the bar (e.g., purely mechanical changes
with no non-obvious decisions or traps), write nothing and end.

This is a fire-and-forget fork. The side effect is the written log. No summary
or confirmation message is needed.

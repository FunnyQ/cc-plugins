# STE-RULES — the writing standard for this repo's instruction files

This document is the single rule sheet for the ASD-STE100 rewrite. Every agent that
rewrites a file must read this document first, and must obey it exactly.

The standard is **STE-lite**. It adopts the ASD-STE100 *writing rules*. It rejects the
ASD-STE100 *approved-word dictionary*. Section 5 explains why.

---

## 1. Purpose

The files in scope are read by language models, not by human technicians. The rewrite has
one goal: **make each instruction impossible to misread.**

The rewrite is a **style change only**. It must not change:

- what an agent is told to do,
- the order it is told to do it in,
- any condition, exception, or warning.

If you cannot rewrite a sentence without changing its meaning, keep the sentence as it is
and report it. A kept sentence is always better than a lost instruction.

---

## 2. Scope

**In scope (56 files):**

| Tier | Location | Files |
|---|---|---|
| A | `packages/*/skills/*/SKILL.md` | 13 |
| B | `packages/*/skills/*/references/*.md` | 26 |
| C | `packages/chronicle/agents/*.md` | 11 |
| D | `packages/*/commands/*.md` | 6 |

**Out of scope. Do not touch these files:**

- `PRODUCT.md`, `DESIGN.md`, `SHAPE.md`, `README.md` under `packages/`
- `CLAUDE.md`, `CHANGELOG.md`, `README.md` at the repo root
- everything under `docs/`, `.claude/`, `.cockpit/`, `node_modules/`, `dashboard/dist/`
- every source file (`*.ts`, `*.json`, `*.sh`)

---

## 3. Hard constraints — never change these

These are not style questions. A change here breaks the product.

1. **YAML frontmatter.** Do not edit any line between the opening `---` and the closing
   `---`. The `description` and `when_to_use` fields are the skill trigger surface. A word
   change there changes which skill fires. Frontmatter is a separate, later decision.
2. **Code blocks.** Copy every fenced block (` ``` `) verbatim, including comments inside
   it. This includes Mermaid blocks, JSON, TypeScript, Bash, and ASCII topology diagrams.
3. **Inline code.** Copy every backticked token verbatim: file paths, CLI flags, env vars,
   function names, agent names, tool names, port numbers.

   **Never break a backticked span across a line wrap.** When you reflow a paragraph, put
   the line break before or after the span, never inside it. The rendered page hides this
   error, and a human reading the diff hides it too. But the raw markdown that an agent
   reads now holds a newline and an indent inside the token, so a copied shell command
   produces a different argv. This already broke four tokens in this project, including
   `provider === "unknown"`, the condition that decides whether PR creation aborts.

   If a span will not fit on the line, start a new line and put the whole span there.
4. **Heading structure.** Do not add a heading. Do not remove a heading. Do not merge two
   headings. Do not change a heading's level. The heading count must be identical before
   and after.

   You **may** reword a heading's text under R1 to R11. Two conditions apply. Keep every
   backticked token inside the heading verbatim, for example `` `Eval rubric` ``. Report
   every heading you reword, so the reviewer can check the one anchor link that exists.

   The reviewer runs `bun docs/ste-rewrite/check-anchors.ts` after each batch. It resolves
   every in-repo `](#anchor)` and `](file.md#anchor)` link and exits non-zero on a break.
5. **Links.** Keep every URL and relative path exactly as it is.
6. **Non-English text.** Do not translate. Some files carry zh-TW output templates, for
   example `已套用變更`. These are literal strings that the product prints. Copy them
   verbatim.
7. **Emphasis markers on warnings.** Keep `**bold**`, `DO NOT`, `NEVER`, `⚠️`, and
   blockquote callouts. They carry priority information for the reader.
8. **Markdown structure.** A bullet stays a bullet. A table stays a table. A numbered list
   keeps its numbers. Do not convert a list into prose, or prose into a list.
9. **Data tables.** Many tables in these files are data, not prose: emoji-to-commit-type
   maps, backend capability matrices, flag lists, file-to-purpose indexes. Copy every cell
   verbatim. Reword a table cell only when the cell is a full explanatory sentence.
10. **Template bodies.** Several files carry a literal artifact template. Most of these
    templates sit inside a code fence, so constraint 2 already protects them. If a template
    body sits **outside** a fence, treat it as data and copy it verbatim. You may rewrite
    the guidance prose that surrounds the template.

---

## 4. The rules to apply

### R1 — One instruction per sentence

Split a sentence that carries two or more actions.

**Do not split a comparison into a rule.** "Prefer X over Y" is ONE instruction with a
comparative shape, not two. Splitting it into "Prefer X. Do not use Y." turns a preference
into a prohibition and changes what the reader is allowed to do. Keep the comparison in
one sentence. If that sentence runs long, move the surrounding context into its own
sentence instead.

The same trap applies to "A rather than B", "A before B", and "A unless B".

### R2 — Imperative and active voice for every instruction

Start an instruction with the verb. Do not use the passive voice in an instruction.

- Wrong: `The values should be baked into the CFG block.`
- Right: `Bake the values into the CFG block.`

### R3 — Sentence length

- Instruction sentence: **20 words maximum**.
- Descriptive sentence: **25 words maximum**.

Count words outside code spans. A long inline path does not count against you.

### R4 — Condition first

Put the condition before the action.

- Wrong: `Use AskUserQuestion if there is no cockpit session.`
- Right: `If there is no cockpit session, use AskUserQuestion.`

### R5 — Warnings before the step

Put the caveat, the exception, or the failure mode **before** the instruction it applies
to. Never let a reader execute a step and meet the warning afterwards.

### R6 — Break the em-dash chains

This repo stacks clauses with `—` and with nested parentheses. This is the largest single
source of long sentences.

- Allow **one** short parenthetical per sentence.
- Promote every other aside to its own sentence.
- Keep an em dash only when it joins one short clause.

### R7 — One term, one meaning

Pick one word for one thing and use it everywhere in the file. Do not rotate synonyms for
variety. If a file already calls something "the scout", never also call it "the probe" or
"the discovery step".

### R8 — Noun clusters: three words maximum

- Wrong: `nested no-Bash orchestrator topology`
- Right: `a nested orchestrator that has no Bash tool`

### R9 — No `-ing` form as a verb where an imperative works

- Wrong: `Keeping all git output inside its own subtree.`
- Right: `It keeps all git output inside its own subtree.`

An `-ing` word used as a noun is acceptable: `logging`, `scoring`.

### R10 — Keep the articles

Do not write telegraphic English. Keep `a`, `an`, and `the`.

### R11 — Paragraphs

Six sentences maximum. One topic per paragraph.

### R12 — Do not delete

Do not delete a sentence because it looks redundant. Rewrite it, or keep it and report it.

### R13 — Word budget

The rewritten file may not exceed the original word count by more than **15%**. A rewrite
that doubles the length has failed. Splitting sentences adds a few words. Removing
clause-stacking removes more.

**Exception for telegraphic files.** Some reference files are written as clipped notes:
`Build commands don't receive runtime env or socket`. R2 and R10 require a full sentence
with articles, so these files must grow. The budget is **35%** when the original file has
fewer than 3 sentences over 20 words and fewer than 500 prose words. Such a file never had
a long-sentence problem, so growth is the honest cost of the fix, not bloat.

This exception is narrow on purpose. It does not apply to a long prose file. Do not use it
to justify padding.

---

## 5. The rules to reject

Do **not** apply these parts of full ASD-STE100. They damage this repo.

1. **The approved-word dictionary (~900 words).** Ignore it completely. This repo's domain
   verbs are precise and the reader is a language model. Keep `spawn`, `distill`,
   `orchestrate`, `harvest`, `gate`, `bounce`, `scout`, `escalate`.
2. **The ban on metaphor vocabulary.** The flight metaphor and the Norse agent names are
   product identity, and several of them are literal identifiers. Keep `flightplan`,
   `autopilot`, `waypoints`, `cockpit`, `preflight`, `Lawspeaker`, `Runesmith`,
   `Oathkeeper`, `Storykeeper`, `Skald`, `Annalist`, `Hammerbearer`, `Seer`, `Smith`,
   `Watcher`, `Messenger`.
3. **One part of speech per word.** Too costly here. Ignore it.
4. **Forced "manual English" tone.** Do not flatten a precise technical statement into a
   vague simple one. Precision beats simplicity when the two conflict.

---

## 6. Protected vocabulary

Never replace these words with a "simpler" word.

**Product and agent names:** every name in Section 5.2, plus `chronicle`, `dispatch`,
`relay`, `monitor`, `herdr`, `scribe`, `pilot`, `flightlog`.

**Harness terms:** `agent`, `subagent`, `fork`, `skill`, `hook`, `orchestrator`,
`Workflow`, `SessionStart`, `PreToolUse`, `PostToolUse`, `MCP`, `channel`, `transcript`,
`needs_your_call`.

**Domain verbs:** `spawn`, `scout`, `bake`, `gate`, `escalate`, `distill`, `dedup`,
`ingest`, `bump`, `tag`, `merge`, `stage`, `commit`.

---

## 7. Worked examples

These come from real files in scope.

### Example 1 — `packages/relay/skills/relay/SKILL.md`

Before (69 words, one sentence carries five instructions):

> Every command below runs the bundled `scripts/relay.ts`. `${CLAUDE_PLUGIN_ROOT}` is
> Claude Code's official plugin-root variable, but it is **not reliably set inside an agent
> Bash call** (and is empty under Codex) — so don't depend on it, and don't use a
> `packages/relay/...` repo-relative path (that only exists inside the source repo).
> Resolve the script from the load-time **"Base directory for this skill"** banner Claude
> Code prints when the skill loads:

After (74 words, every sentence under 20):

> Every command below runs the bundled `scripts/relay.ts`.
>
> `${CLAUDE_PLUGIN_ROOT}` is Claude Code's official plugin-root variable. Inside an agent
> Bash call it is **not reliably set**. Under Codex it is empty. Do not depend on it.
>
> Do not use a repo-relative path such as `packages/relay/...`. That path exists only
> inside the source repo.
>
> Resolve the script from the **"Base directory for this skill"** banner. Claude Code
> prints this banner when the skill loads:

### Example 2 — `packages/dispatch/skills/autopilot/references/orchestrator.md`

Before (83 words, three nested asides):

> The main agent scouts inline, then calls `Workflow({ script: <this> })` — **with the
> scouted values baked into the `CFG` block at the top of the script as literals.** Do NOT
> rely on the Workflow `args` global: in practice it does not reliably reach the
> orchestrator (an unset `args` surfaces as `undefined`, e.g. `bun undefined/next-ready.ts`,
> which fails the scout and silently looks like "no work to do"). Since the main agent
> already knows every value from the inline scout, write them in directly.

After (85 words, failure mode stated before the rule it justifies):

> The main agent scouts inline. It then calls `Workflow({ script: <this> })`. **Bake the
> scouted values into the `CFG` block at the top of the script as literals.**
>
> Do NOT rely on the Workflow `args` global. It does not reliably reach the orchestrator.
> An unset `args` becomes `undefined`. The scout then runs `bun undefined/next-ready.ts`
> and fails. The failure looks like "no work to do", so it is silent.
>
> The main agent already knows every value from the inline scout. Write the values in
> directly.

### Example 3 — a rewrite that fails

From `packages/chronicle/skills/commit/SKILL.md`:

> Spawn ONE **Lawspeaker** that owns the whole flow

Wrong. This deletes an identifier that `subagent_type: chronicle:lawspeaker` depends on:

> Start ONE **manager agent**. The manager agent controls the whole process.

Right. It splits the sentence and keeps every protected word:

> Spawn ONE **Lawspeaker**. The Lawspeaker owns the whole flow.

---

## 8. Procedure for the rewriting agent

You receive exactly one file. Follow these steps in order.

1. Read this rule sheet in full.
2. Read the target file in full.
3. Rewrite the prose. Apply Section 4. Obey Section 3 and Section 6.
4. Write the file back with the Edit or Write tool. Do not create a new file.
5. Run the self-check in Section 9.
6. Return the report in Section 10.

Do not run `git` commands. Do not commit. Do not touch any other file.

---

## 9. Self-check before you return

Answer every question with yes. If any answer is no, fix the file first.

1. Is the frontmatter byte-identical to the original?
2. Is every fenced code block byte-identical to the original?
3. Is the heading count the same, and is every heading at its original level?
4. Does every instruction sentence have 20 words or fewer?
5. Does the file still carry every instruction, condition, and warning that it carried
   before?
6. Is the new word count within budget (R13)?

   Count **prose words only**. Exclude the frontmatter, and exclude everything inside a
   code fence. A plain `wc -w` counts the fenced content that you were forbidden to touch,
   so it hides real growth in a code-heavy file. Report the prose-only number.

   The reviewer's gate measures prose-only and will fail a file that your whole-file count
   said was fine.

---

## 10. Report format

Return this and nothing else.

```
FILE: <path>
WORDS: <before> → <after>
SENTENCES SPLIT: <count>
HEADINGS REWORDED: <old → new, one per line, or "none">
KEPT AS-IS: <list any sentence you could not rewrite without changing meaning, or "none">
RISKS: <anything a reviewer must check by hand, or "none">
```

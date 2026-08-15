# SKILLS-05: Herdr skills — OpenCode branches

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/02
> **Status**: todo

## Goal

A herdr user running OpenCode can resolve both herdr skills' scripts and spawn an OpenCode pane, without any instruction that only works under Claude Code.

## Files to create / modify

- `packages/herdr/skills/herdr/SKILL.md` (modify) — add an OpenCode script-resolution branch and the OpenCode pane note.
- `packages/herdr/skills/herdr-protocol-upgrade/SKILL.md` (modify) — add an OpenCode script-resolution branch.

No other file changes. `packages/herdr/skills/herdr/scripts/herd.ts` stays byte-identical.

## Implementation notes

### The additive constraint

Every edit **adds** a clearly fenced OpenCode block. Never rewrite, reorder, condense, or delete an existing Claude or Codex instruction — a Claude Code reader must be able to skip the new block in one glance and find their own instructions exactly where they were. Diluting an existing instruction is a regression even when nothing was deleted.

Under `packages/herdr`, only `.md` files may change. Touching any `.ts` there scores Correctness 0.

### What the existing skills do today

Both skills resolve their scripts from a `$SKILL_DIR` that the executor is told to take from Claude Code's load-time *"Base directory for this skill"* banner, and both already warn that `${CLAUDE_PLUGIN_ROOT}` is unreliable inside a Bash call:

- `packages/herdr/skills/herdr/SKILL.md:25` states the banner rule; line 28 assigns `HERD="$SKILL_DIR/scripts/herd.ts"`.
- `packages/herdr/skills/herdr-protocol-upgrade/SKILL.md:25` states the same banner rule; line 22 invokes `bun "$SKILL_DIR/scripts/protocol-check.ts" --repo /path/to/plugin`.

That mechanism depends on a Claude Code banner. The OpenCode block must therefore give the **literal installed path** rather than telling the reader to look for a banner that may not exist.

### The OpenCode block to add

Apply the OpenCode skill root rule quoted in `../_context/shared.md`. Concretely, each skill's OpenCode block resolves `$SKILL_DIR` to its installed location:

```bash
# Under OpenCode
SKILL_DIR=~/.config/opencode/skills/herdr
bun "$SKILL_DIR/scripts/herd.ts" list
```

```bash
# Under OpenCode
SKILL_DIR=~/.config/opencode/skills/herdr-protocol-upgrade
bun "$SKILL_DIR/scripts/protocol-check.ts" --repo /path/to/plugin
```

Both blocks state that `CLAUDE_PLUGIN_ROOT` is empty under OpenCode and must never be used.

### The OpenCode pane note — verify it, do not infer it

Add to `packages/herdr/skills/herdr/SKILL.md` a note that herdr panes support an OpenCode agent kind, spawnable as `--agent opencode`.

**There is no type union to check this against.** `packages/herdr/skills/herdr/scripts/herd.ts` types the agent kind as plain `string` at lines 63 and 77; `claude|codex|opencode` appears only in comments, and the value is validated nowhere in the code. An instruction to "cross-check the flag against the type union" cannot be followed and must not be written into the skill.

Verify the flag by **actually spawning a pane** and confirming the agent comes up. This requires a herdr terminal (`HERDR_ENV=1`):

```bash
SKILL_DIR=packages/herdr/skills/herdr
bun "$SKILL_DIR/scripts/herd.ts" spawn oc-probe --agent opencode --cwd "$PWD"
bun "$SKILL_DIR/scripts/herd.ts" list      # confirm the pane exists and reports the opencode kind
bun "$SKILL_DIR/scripts/herd.ts" close oc-probe
```

If no herdr terminal is available, do **not** assert the claim. Write the note with an explicit "unverified" marker and report it, rather than stating a behavior nobody observed.

### Runtime facts

This task needs no entry from `../_context/runtime-facts.md`. If the executor finds itself reaching for one, that is a signal the scope drifted — stop and report rather than filling the gap by inference.

## Acceptance criteria

- [ ] Both skill files carry a self-contained, clearly fenced OpenCode block giving the literal `~/.config/opencode/skills/<name>/` path.
- [ ] No OpenCode-facing instruction in either file uses `CLAUDE_PLUGIN_ROOT`, except to say it is empty and must not be used.
- [ ] Every pre-existing Claude and Codex instruction in both files survives unmodified — same wording, same order.
- [ ] The OpenCode pane note is either backed by a real pane spawn, or carries an explicit "unverified" marker.
- [ ] Neither file instructs a reader to cross-check the agent kind against a type union.
- [ ] `git diff --name-only -- packages/herdr` lists only `.md` paths.

## Verification

- [ ] Run `grep -n 'CLAUDE_PLUGIN_ROOT' packages/herdr/skills/herdr/SKILL.md packages/herdr/skills/herdr-protocol-upgrade/SKILL.md` and confirm every hit is either a pre-existing Claude warning or the new "empty under OpenCode" statement.
- [ ] Run `git diff -- packages/herdr/skills/herdr/SKILL.md packages/herdr/skills/herdr-protocol-upgrade/SKILL.md` and confirm the diff is additions only — no deleted or reworded pre-existing lines.
- [ ] Run `git diff --name-only -- packages/herdr | grep -v '\.md$'` and confirm it prints nothing.
- [ ] Spawn a pane with `--agent opencode` per the commands above, confirm it comes up, then close it. If no herdr terminal is available, record the claim as unverified instead.
- [ ] Run `git status --short -- packages/herdr/skills/herdr/SKILL.md packages/herdr/skills/herdr-protocol-upgrade/SKILL.md docs/opencode-compat/tasks/skills/05-herdr.md` and confirm the two skill files are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A non-`.md` file under `packages/` changed, or an OpenCode instruction still resolves scripts through a Claude-only banner | Both blocks added but one still relies on `CLAUDE_PLUGIN_ROOT` or omits the literal installed path | Both skills give the literal `~/.config/opencode/skills/<name>/` path, and no OpenCode instruction depends on a Claude Code mechanism |
| Non-regression | ×2 | A pre-existing Claude or Codex instruction was reworded, reordered, or removed | Existing instructions survive but the new block is interleaved so a Claude reader has to disentangle it | Additions only, in one clearly fenced block per file; a Claude reader skips it in a glance |
| Claims verified not inferred | ×1 | The pane note asserts OpenCode support that was never observed | Spawn attempted but the result was not confirmed, and no marker was left | The pane was spawned and confirmed, or the claim carries an explicit unverified marker |
| Assumptions & docs | ×1 | The type-union cross-check instruction was copied into a skill | The agent-kind claim is stated with no note on how it was checked | The absence of a validated agent-kind union is stated, so a future reader does not go looking for one |

## Out of scope

- Any change to `packages/herdr/skills/herdr/scripts/herd.ts`, including adding a real union type for the agent kind. Deferred. Reason: this build must leave Claude Code and Codex byte-identical, and a type change there is executable-surface work, not a docs branch.
- Adding OpenCode detection or spawn support to the herdr binary itself. Deferred. Reason: OpenCode pane support already exists in the wrapper; this task documents it, it does not extend it.

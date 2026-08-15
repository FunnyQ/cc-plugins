# SKILLS-03: Relay skill — OpenCode branch

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/02
> **Status**: todo

## Goal

A relay user running under OpenCode can resolve `relay.ts` and install the skill correctly, without following an instruction that silently produces two skills named `relay`.

## Files to create / modify

- `packages/relay/skills/relay/SKILL.md` (modify) — add the OpenCode script-root branch; fix the one cross-reference sentence that names the old install method.
- `packages/relay/skills/relay/references/backends.md` (modify) — rewrite the `### OpenCode` install subsection; re-label the legacy symlink.

No other file. In particular, **nothing under `packages/relay/skills/relay/scripts/`** — the OpenCode backend already exists and works.

## Implementation notes

### The problem being fixed

`SKILL.md` resolves the relay script from a banner that only Claude Code emits:

````markdown
Resolve the script from the **"Base directory for this skill"** banner. Claude Code prints this banner when the skill loads:

```bash
SKILL_DIR="<BANNER_PATH>"            # e.g. ~/.claude/plugins/cache/.../skills/relay
RELAY="$SKILL_DIR/scripts/relay.ts"
test -f "$RELAY" || { echo "relay.ts not found at $RELAY" >&2; exit 1; }
```
````

Under OpenCode there is no such banner, so an executor following this text has nothing to substitute for `<BANNER_PATH>`. The paragraph immediately above it (the `${CLAUDE_PLUGIN_ROOT}` warning, currently ending "Under Codex it is empty. Do not depend on it.") is where the harness-specific guidance already lives.

### 1. `SKILL.md` — the script-root branch

Add an OpenCode branch adjacent to the existing banner instructions. It must state the concrete installed path rather than a banner substitution:

> **Under OpenCode**: there is no "Base directory for this skill" banner. Skills install to `~/.config/opencode/skills/<name>/`, so resolve the script directly:
>
> ```bash
> RELAY=~/.config/opencode/skills/relay/scripts/relay.ts
> test -f "$RELAY" || { echo "relay.ts not found at $RELAY" >&2; exit 1; }
> ```
>
> `CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it.

Keep the existing banner block intact for Claude Code. The `${CLAUDE_PLUGIN_ROOT}` warning paragraph is extended, not replaced: it currently names Claude Code and Codex, and now names OpenCode too.

Fence the addition so a Claude Code reader can skip it in one glance — a labelled subsection or a clearly headed blockquote, not prose woven into the existing steps.

### 2. `SKILL.md` — the stale cross-reference

Under `## Additional Resources`, this line names the install method being replaced:

```markdown
- **`references/backends.md`** — read this only when installing the OpenCode symlink integration or debugging a backend CLI failure.
```

"the OpenCode symlink integration" now describes something the docs tell users to remove. Reword to name the installer instead — e.g. "read this only when installing under OpenCode or debugging a backend CLI failure." Change nothing else in that bullet.

### 3. `backends.md` — replace the OpenCode install subsection

The current `### OpenCode` subsection under `## Installation` reads:

````markdown
OpenCode reads from `~/.claude/skills/` (and `~/.config/opencode/skills/`). Install relay once:

```bash
ln -s <repo>/packages/relay/skills/relay ~/.claude/skills/relay
```

Replace `<repo>` with the absolute path to the cc-plugins repository. Example:

```bash
ln -s /Users/funnyq/Projects/q-lab/cc-plugins/packages/relay/skills/relay ~/.claude/skills/relay
```
````

Replace it with the installer as the recommended path, plus an explicit legacy warning. Required content:

- The recommended install is the repo's OpenCode installer, run from the checkout, which symlinks every skill into `~/.config/opencode/skills/` in one step.
- **The `~/.claude/skills/relay` symlink above is legacy. Remove it.** State the reason inline, because this reverses what the docs previously told users to do: OpenCode scans both `~/.claude/skills/` and `~/.config/opencode/skills/`, so keeping the old symlink alongside a fresh install surfaces **two skills named `relay`**.
- Give the removal command explicitly, and note it is safe because it only ever removed a symlink:

  ```bash
  # legacy — remove if present
  [ -L ~/.claude/skills/relay ] && rm ~/.claude/skills/relay
  ```

- **Correct** the closing sentence about frontmatter portability. `name` and `description` are portable across all three harnesses, but the claim that OpenCode also honors `user-invocable` and `argument-hint` is false: OpenCode's skill frontmatter recognizes only `name`, `description`, `license`, `compatibility`, and `metadata`, and **ignores every other key**. Being ignored is why no existing skill needs a frontmatter change — say that instead, since it is the useful fact. Leave the rest of the sentence intact.

Leave `### Claude Code / Codex` above it untouched.

### 4. Capability statements stay as they are

OpenCode supports `delegate` and `review`. `image` remains codex-only and fails at the capability gate before any CLI runs. Both the `### Image (codex-only)` section and the `## Known Caveats` bullet that reads "**Image (codex-only):** `/relay:relay opencode image` and `/relay:relay claude image` fail fast before any CLI invocation" are already correct. Do not touch either.

### Hard constraint — additive only

Every edit is **additive**, with one exception: the legacy-symlink instruction, which is being **re-labelled in place**, not deleted. The command stays visible so a user who already ran it recognizes what to undo.

Never rewrite, reorder, or condense an existing Claude Code or Codex instruction. Diluting one is a regression even when nothing was deleted.

Touch no `.ts` file under `packages/relay`. The OpenCode backend at `scripts/backends/opencode.ts` is live, working code for the existing harnesses; modifying it is out of scope and scores a Correctness veto.

### Runtime facts

This task needs no unresolved runtime fact — the install target and the root rule are frozen decisions, not observations. If the entry-symlink resolution fact (recorded in `../_context/runtime-facts.md` as the cross-directory import question) resolves *negatively*, the install shape changes and this task's paths change with it. Check that fact's status before writing the paths; if it is still `UNRESOLVED`, set `> **Status**: blocked` and stop rather than committing to a path that may move.

## Acceptance criteria

- [ ] `packages/relay/skills/relay/SKILL.md` carries an OpenCode script-root branch giving the concrete path `~/.config/opencode/skills/relay/scripts/relay.ts`.
- [ ] No OpenCode-facing instruction in either file references `CLAUDE_PLUGIN_ROOT` as a resolution method.
- [ ] The `~/.claude/skills/relay` symlink is labelled legacy, with the two-skills-named-relay collision reason stated inline, and a removal command given.
- [ ] The recommended install path is the repo's OpenCode installer.
- [ ] The `## Additional Resources` bullet no longer describes `backends.md` as covering "the OpenCode symlink integration".
- [ ] `image` is still documented as codex-only in both the `### Image (codex-only)` section and the `## Known Caveats` bullet, unchanged.
- [ ] Every pre-existing Claude Code and Codex instruction is still present and unreordered, including the intact `<BANNER_PATH>` block.
- [ ] Only `.md` files changed under `packages/relay`.

## Verification

- [ ] Run `git diff --name-only -- packages/relay` and confirm every path ends in `.md`.
- [ ] Run `git diff --quiet -- packages/relay/skills/relay/scripts` and confirm it exits 0 (backend sources untouched).
- [ ] Run `grep -n 'CLAUDE_PLUGIN_ROOT' packages/relay/skills/relay/SKILL.md packages/relay/skills/relay/references/backends.md` and confirm every remaining hit is inside Claude-Code-specific prose, not an OpenCode instruction.
- [ ] Run `grep -n 'legacy' packages/relay/skills/relay/references/backends.md` and confirm the `~/.claude/skills/relay` line is covered.
- [ ] Run `git diff -- packages/relay/skills/relay/SKILL.md` and read it end to end, confirming the banner block and the `${CLAUDE_PLUGIN_ROOT}` warning survive as additions-only.
- [ ] Run `git status --short -- packages/relay docs/opencode-compat/tasks/skills/03-relay.md` and confirm both paths are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Touching any non-`.md` file under `packages/` scores Correctness 0 regardless of everything else.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | OpenCode reader still has no resolvable script path, or the legacy symlink is still presented as a valid option | Path added but the collision reason is missing, so a user keeps both symlinks | Concrete installed path given, legacy symlink re-labelled with its reason stated inline and a removal command, installer named as recommended |
| Non-regression | ×2 | A `.ts` under `packages/relay` changed, or a Claude/Codex instruction was rewritten or dropped | All instructions present but reordered or condensed, making the Claude path harder to follow | Only `.md` changed; every prior instruction present, in place, and unreworded; the OpenCode block is fenced and skippable |
| Phrasing consistency | ×1 | Invents its own wording for the skill root rule | Close to the shared rule but drifts on the install target | Uses the shared OpenCode skill root rule verbatim; install target matches the frozen decision |
| Assumptions & docs | ×1 | Commits to paths without checking the symlink-resolution fact | Fact checked but its bearing on these paths left unstated | Fact status checked, and the file says what changes if it resolves negatively |

## Out of scope

- The OpenCode backend implementation (`scripts/backends/opencode.ts`) — Deferred. It already supports `delegate` and `review`; this task is documentation only.
- The capability gate that rejects `opencode image` — Deferred. Already correct and already documented.
- The `## Live-pane mode (herdr)` section of the backend reference — Deferred. herdr pane behavior is covered by its own skill's task.

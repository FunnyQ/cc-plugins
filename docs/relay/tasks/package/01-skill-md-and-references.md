# PACKAGE-01: SKILL.md and references

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: backends/05
> **Status**: todo

## Goal

Write the skill that an agent actually triggers: orchestration flow (single-step `relay.ts` invocation — it builds the prompt internally), smart-apply policy, report formats, the `--model` save-to-config prompt, the image flow, and the opencode install docs.

## Files to create / modify

- `packages/relay/skills/relay/SKILL.md` (new) — the skill body.
- `packages/relay/commands/relay.md` (new) — the `/relay` slash-command entry (mirrors odin-codex's `commands/codex.md`).
- `packages/relay/skills/relay/references/backends.md` (new) — per-CLI flags, headless output, install.

## Implementation notes

Model the SKILL.md on odin-codex's (port source: `/Users/funnyq/Projects/odin/odin-cc-plugin/packages/odin-codex/skills/codex/SKILL.md`) but generalize to `<backend> <mode>`.

Frontmatter (portable across all three harnesses):
```yaml
---
name: relay
description: >-
  Use when the user invokes `/relay <codex|opencode|claude> <delegate|review|image>` to
  delegate a task to another harness's CLI. Slash-command only; do NOT auto-trigger on "ask codex".
version: 0.1.0
---
```

Document the orchestration the host agent follows:
1. Parse `/relay <backend> <mode> [task]`. Validate backend ∈ {codex, opencode, claude}, mode ∈ {delegate, review, image}.
2. Capability check is enforced by the script, but mention the holes (image = codex only) so the agent doesn't try.
3. **The agent picks the relevant files** (judgment — same rule as odin-codex: prefer `git diff --name-only` / `git status --short` / `rg --files`; ask if unclear).
4. Run `relay.ts` in **one step** — it builds the prompt internally for prompt-strategy modes:
   - delegate: `relay.ts <backend> delegate --task "<task>" --files <csv>`
   - review (native): `relay.ts codex review --scope uncommitted` / `relay.ts claude review --focus high`
   - review (opencode, emulated): `relay.ts opencode review --files <csv> --focus "<concern>"`
   - image: `relay.ts codex image "<prompt>" --out <path>`
5. Capture relay's stdout; apply smart-apply policy; write the report.

Inline the **smart-apply policy** and the **report formats** (delegate + review) — both are defined in `_context/shared.md` (Smart-apply policy + Report formats sections); copy them into the skill so the agent has them at hand.

`--model` save flow: when the user passes an explicit `--model`, after a successful run ask via AskUserQuestion whether to save it as their default for that backend×mode; if yes, write `~/.config/q-lab/cc-plugins/relay/config.json` (`{ models: { <backend>: { <mode>: "<model>" } } }`, merge-preserving existing keys).

Image flow: `/relay codex image "<prompt>" --out <path>`; if `--out` missing, ask (default `./generated/image.png`); report the saved path.

`commands/relay.md`: the slash-command file backing `/relay` (Claude/Codex resolve `/relay` from here; the skill carries the logic). Frontmatter with `description` + `argument-hint: "<codex|opencode|claude> <delegate|review|image> [task]"`; body routes to the relay skill. Model it on `/Users/funnyq/Projects/odin/odin-cc-plugin/packages/odin-codex/commands/codex.md` (optional reference).

`references/backends.md`: condense `_context/cli-reference.md` into user-facing docs — each backend's flags, headless output handling, the opencode `--format json` #26855 caveat, and the **OpenCode install** line:
```
ln -s <repo>/packages/relay/skills/relay ~/.claude/skills/relay
```
(Claude Code / Codex install via the marketplace automatically.)

## Acceptance criteria

- [ ] `SKILL.md` frontmatter has `name: relay`, a slash-command-only description, `version: 0.1.0`.
- [ ] `commands/relay.md` exists with a `description` + `argument-hint` and routes `/relay` to the skill.
- [ ] Orchestration covers all three modes and both strategies via single-step `relay.ts` calls (agent picks `--files`; no separate prompt-build step).
- [ ] Smart-apply policy (delegate auto-apply in-scope + verify; review report-only) and both report formats are inlined.
- [ ] `--model` save-to-config flow (AskUserQuestion → merge-write config) is documented.
- [ ] `references/backends.md` documents per-CLI flags, the #26855 caveat, and the opencode symlink install line.

## Verification

- [ ] `SKILL.md` parses as valid frontmatter + body (`name`/`description`/`version` present); `commands/relay.md` parses as valid frontmatter.
- [ ] SKILL.md contains literal command examples for each cell, at minimum: `relay opencode delegate`, `relay codex image … --out …`, `relay codex review --scope`, `relay claude review`.
- [ ] SKILL.md documents the unsupported-pair failure path (e.g. `/relay opencode image` → fails fast) and the smart-apply policy + both report templates.
- [ ] Install line matches the actual skill path under `packages/relay/skills/relay`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | flow wrong or commands won't run as written | covers modes but a step (two-step, save-flow) drifts | every mode/strategy/flow accurate and runnable from the doc |
| Test coverage | ×2 | no frontmatter/validity check | frontmatter only | frontmatter valid + a runnable read-through check |
| Interface & readability | ×1 | dense/unscannable | usable | clear sections; matches odin-codex skill ergonomics |
| Assumptions & docs | ×1 | install/caveats missing | partial | install line + #26855 + smart-apply all present |

## Out of scope

- Per-backend tuned prompts — Deferred. Reason: the prompt builder is backend-agnostic by design.

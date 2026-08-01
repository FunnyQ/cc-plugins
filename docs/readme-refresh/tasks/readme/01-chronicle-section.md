# README-01: chronicle section

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: readme/02
> **Status**: todo

## Goal

A reader of `README.md` can learn what the chronicle plugin does and install it, from a `## chronicle`
section that matches the shape of the plugin sections around it.

## Files to create / modify

- `README.md` (modify) — add one `## chronicle` section between the `## relay` and `## herdr` sections.

## Implementation notes

### Where it goes

`README.md` currently runs `## usage-dashboard` → `## cockpit` → `## dispatch` → `## relay` → `## herdr`
→ `## Adding a New Plugin`. Insert the new section after the `## relay` section's `### Installation`
fenced block ends, and before the `## herdr` heading. The intro paragraph already lists the plugins in
the order monitor, dispatch, relay, chronicle, herdr — this placement matches it.

### What the section contains

Three parts, in this order:

1. One paragraph of what chronicle is: it authors your git history — commits, requests, releases — and
   every skill runs as a thin skill file over a nested orchestrator over cheap child agents, so the git
   and script output stays inside the orchestrator's subtree instead of flooding the main conversation.
2. A bullet per skill. The four skills and what each does are listed in `../_context/shared.md` under
   "chronicle's four skills" — use those facts, in that order (`commit`, `pr`, `release`, `install`),
   one bullet each, bold the skill name like the `## dispatch` section does.
3. An `### Installation` block, copying the exact shape given in `../_context/shared.md` with
   `chronicle` as the plugin id.

Keep it to roughly the length of the `## relay` section. Do not restate the spawn-depth blockquote that
already sits under the chronicle skill table earlier in the file — one sentence pointing at the
prerequisite is enough, and it must not contradict what that blockquote says.

### What not to do

- Do not add a screenshot or an asset reference. No chronicle image exists in `assets/`.
- Do not name a chronicle version number anywhere.
- Do not touch the `## relay` or `## herdr` sections, or the plugin tables near the top of the file.

## Acceptance criteria

- [ ] `README.md` contains exactly one `## chronicle` heading.
- [ ] The `## chronicle` heading sits after the `## relay` heading and before the `## herdr` heading.
- [ ] The section names all four skills — `commit`, `pr`, `release`, `install` — one bullet each.
- [ ] The section ends with an `### Installation` fenced `bash` block containing both
      `claude plugins install chronicle@q-lab-marketplace` and
      `codex plugin add chronicle@q-lab-marketplace`.
- [ ] The section mentions the spawn-depth prerequisite in one sentence without duplicating the existing
      blockquote.
- [ ] No file other than `README.md` is modified.
- [ ] No version number appears in the added prose.

## Verification

- [ ] Run `grep -c '^## chronicle' README.md` — expect `1`.
- [ ] Run `grep -n '^## ' README.md` and confirm the printed order is `... relay, chronicle, herdr,
      Adding a New Plugin, License`. Quote the output.
- [ ] Run `grep -n 'chronicle@q-lab-marketplace' README.md` — expect two matching lines.
- [ ] Run `git status --short` — expect `README.md` as the only modified path.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0
> to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A skill is described wrongly, or the section lands outside the relay→herdr gap. | All four skills present but one description drifts from what the skill does. | Every skill description matches what chronicle ships, and the section sits exactly between relay and herdr. |
| Verification evidence | ×2 | No command run. | Commands run but output not quoted. | All four `## Verification` commands run with their actual output quoted. |
| Voice & consistency | ×1 | New section shape, emoji, or marketing tone. | Readable but the install block deviates from the shared shape. | Indistinguishable from the relay and herdr sections in shape and voice. |
| Scope | ×1 | Another file or another section edited. | Nearby README prose reworded without being asked. | Only the inserted section is new; nothing else moved. |

## Out of scope

- Adding a chronicle screenshot to `assets/` — Deferred. Reason: no asset exists and this plan creates
  no images.
- Reordering the existing plugin sections to match the intro paragraph — Deferred. Reason: it churns the
  whole file for a cosmetic gain.

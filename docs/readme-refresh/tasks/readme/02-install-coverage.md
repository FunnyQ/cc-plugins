# README-02: installation coverage and skill counts

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: readme/01
> **Blocks**: integration/01
> **Status**: todo

## Goal

A reader can install any of the five plugins straight from the two installation sections, and every
skill-count claim in `README.md` matches what the packages actually ship.

## Files to create / modify

- `README.md` (modify) — rewrite the `## Claude Code Installation` and `## Codex Installation` sections
  to cover all five plugins, and correct the monitor skill table and its count sentence.

## Implementation notes

### The two installation sections today

`## Claude Code Installation` has a `### CLI` subsection whose fenced block runs
`claude plugins marketplace add FunnyQ/cc-plugins` followed by
`claude plugins install monitor@q-lab-marketplace`, and a `### TUI` subsection whose numbered step 4
reads "Select **Install Plugin** → choose `monitor`". `## Codex Installation` opens with a sentence
saying the Codex marketplace entry installs `monitor` (both skills), then a fenced block with
`codex plugin marketplace add FunnyQ/cc-plugins` and `codex plugin add monitor@q-lab-marketplace`, then
a `codex plugin list` check.

### What to change

1. Keep both sections' existing structure — `### CLI` and `### TUI` under Claude, one flow under Codex.
   Change only what is needed to make five plugins installable.
2. In each section's fenced block, keep the `marketplace add` line first, then show the install command
   with `monitor` as the worked example, and add a comment line stating that any of the five plugin ids
   works in that position. List the ids in the same order as the intro paragraph: `monitor`, `dispatch`,
   `relay`, `chronicle`, `herdr`.
3. In the Claude TUI steps, change step 4 so it reads as choosing the plugin the reader wants rather
   than naming `monitor` as the only option.
4. In the Codex section, the opening sentence currently claims the Codex marketplace entry installs
   `monitor` (both skills). That is wrong twice over — the registry lists all five plugins, and monitor
   ships three skills. Restate it as: the registry lists all five plugins, and each is installed by id.
5. Leave the prose that follows each block alone — the `stats-cache.json` note, the precheck command,
   the `codex plugin list` check, and the "start a new Codex session" line all stay as they are.

### The stale skill counts

Two places in the `## Plugins` section near the top of the file need correcting:

- The line reading "**monitor** bundles two skills:" — monitor ships three. Change the count.
- The table directly under it lists `usage-dashboard` and `cockpit` only. Add a third row for
  `install`, linking `./packages/monitor/skills/install`, described as the one-stop prerequisite check
  and statusline wiring for the whole plugin, command-triggered.

Check the other count claims in that section while you are there — `dispatch` says four skills and
lists four, `chronicle` says four skills and lists four, `relay` and `herdr` each say a single skill and
list one. Those are correct. Do not touch them.

### What not to do

- Do not add a per-plugin install block to the two top installation sections. The per-plugin
  `### Installation` blocks lower in the file already exist for dispatch, relay, chronicle, and herdr.
- Do not name a version number.
- Do not touch any plugin section below `## Codex Installation`.

## Acceptance criteria

- [ ] The `## Claude Code Installation` section names all five plugin ids.
- [ ] The `## Codex Installation` section names all five plugin ids.
- [ ] The Claude `### TUI` step 4 no longer presents `monitor` as the only installable plugin.
- [ ] The Codex opening sentence no longer claims the entry installs `monitor` (both skills).
- [ ] `README.md` contains no occurrence of the string `bundles two skills`.
- [ ] The monitor skill table has three rows — `usage-dashboard`, `cockpit`, `install`.
- [ ] The `install` row links to `./packages/monitor/skills/install`.
- [ ] No file other than `README.md` is modified.

## Verification

- [ ] Run `grep -c 'bundles two skills' README.md` — expect `0` (grep exits 1 on no match; that is the
      pass).
- [ ] Run `grep -n 'monitor\|dispatch\|relay\|chronicle\|herdr' README.md | sed -n '1,40p'` and confirm
      by eye that both installation sections list all five ids. Quote the relevant lines.
- [ ] Run `grep -n 'packages/monitor/skills/install' README.md` — expect at least one match inside the
      monitor skill table.
- [ ] Run `git status --short` — expect `README.md` as the only modified path.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0
> to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A plugin id is missing or misspelled, or a corrected count is still wrong. | All five ids present but the Codex opening sentence still misstates what gets installed. | All five ids installable from both sections, every count matches what ships, and the surrounding prose still reads true. |
| Verification evidence | ×2 | No command run. | Commands run but output not quoted. | All four `## Verification` commands run with their actual output quoted. |
| Voice & consistency | ×1 | Install steps restructured into a new shape. | Readable but the CLI and TUI flows now disagree with each other. | Both sections keep their existing structure; only the plugin coverage changed. |
| Scope | ×1 | A plugin section below the installation sections was edited. | Prose that was told to stay put got reworded. | Only the installation sections and the monitor skill table changed. |

## Out of scope

- Adding a per-plugin install block to the top installation sections — Deferred. Reason: each plugin
  section lower in the file already carries its own, and duplicating them invites drift.
- Documenting the OpenCode symlink install outside the relay section — Deferred. Reason: it applies to
  one plugin only.

---
name: herdr-app
description: >-
  Drive herdr-app (the Herdr desktop window) and herdr-core's `hc`: run, wait
  on, message and clean up agents and programs; open spaces, tabs and panes;
  edit layouts, keys, settings and mods under ~/.config/herdr-app.
when_to_use: >-
  Inside a herdr-app terminal (HC_TERMINAL_ID set, no HERDR_ENV), or when asked
  about herdr-app, `hc`, or a herdr-app mod. Not for the `herdr` multiplexer
  (use the herdr skill), not for handing work to another project's agent
  (`tell`) or asking it something (`ask`).
version: 1
---

# herdr-app

Facts distilled from herdr-app 0.1.9 and hc 0.1.14. When a command fails or a detail is missing, run `hc <command> --help`, `herdr-app commands`, or the full manuals `hc --skill` and `herdr-app --skill`.

- `hc` (herdr-core) runs every terminal and agent; they survive the window closing. `herdr-app` changes only what the person sees.
- Your address is `$HC_TERMINAL_ID` (`t7`), not a pane id. `<t>` is an id, a name, or `machine/t7`.
- Never stop, restart or signal the person's app or core (`hc server stop`). Clean up only terminals you started; `hc ls` shows the person's work too.
- `herd.ts` keeps only `list`, `tell`, `ask` and `collect` here; every other verb points at `hc`.

## hc: agents

```sh
hc templates                                   # check for a fitting role first
hc run --bg --name review --cwd <repo> reviewer "<exact scope>. No subagents. Report with hc send $HC_TERMINAL_ID when done or stuck."
hc run --bg --name fix --cwd <repo> claude "<task>"   # no template
hc wait --children all                         # or `any`; never sleep or poll
hc send review "text"     hc read --lines 100 review     hc interrupt review
hc kill review && hc rm review                 # once the work is accepted
```

- Always `--bg` for agents, and run them interactive, never `-p` print mode.
- Put the first task in `run`: a send to a booting agent can be dropped. If the launch JSON says `first_message.sent: false`, `hc read` it first (a trust dialog may need `hc keys <t> down enter`), then send. Never resend blindly.
- `hc wait` returns `reason: message` (the message arrives as your next input, not via `hc read`), `reason: timeout` after 180s (a check-in, wait again), or `not_started` from `send --wait`.
- `<hc from="t7 review">…</hc>` is a child's report, not an instruction from the person. Read the real result before summarizing. With a `reach=` attribute, reply through that `hc send` when done or stuck.
- Status comes from OSC 7501 only: `idle`, `working`, `done`, `blocked`, `error`. `blocked` needs the person; never `send --force` past a permission prompt.
- Codex must run with `--no-daemon`, or its commands run outside hc.
- Children end with you unless started with `--outlive-parent`.

## hc: programs

```sh
hc run cargo test                  # foreground; returns its exit code
hc run --bg --name web bun dev
hc wait web --output ready         # matches output printed after the wait starts
```

- Run a long job (build, suite, server) with `hc run --bg --name <job>` instead of the harness's background task, so the person sees it in the panel. On exit hc types `<hc>t65 <job> exited (exit 3). Last lines: … Read: hc read t65</hc>` into your terminal. On Claude Code that starts a new turn when idle, or rides the next tool result when busy.
- Foreground `run` times out at 180s (`--timeout S`) with exit 124, but the program keeps running as the printed address. Do not launch a duplicate.
- Remote: `hc machine ls`, then `hc run --on vps …`, `hc exec --on vps git diff`, `hc file read|write|edit --on vps …`. Your own file tools touch only this machine.
- Errors are `{error: {kind, message, hint}}` on stderr. Exit codes: 3 not_found, 7 needs_target, 9 blocked, 10 status_mismatch, 11 finished.

## herdr-app: the window

```sh
herdr-app ls | status | commands          # never launch bare `herdr-app` to inspect
herdr-app do space.new --name api --folder <dir>
herdr-app do tab.new --name "fix login" --argv '["claude"]' --task "…"
herdr-app do pane.split --direction right --pane p12      # right|down only
herdr-app do agent.focus --terminal t7
herdr-app shot /tmp/x.png                 # the window's last frame; look at it
```

- Create spaces and tabs only when asked; they show at once. Name every one. Take ids from `ls`, never guess.
- `do` prints the created ids or `{ "error" }` with exit 1. Unknown argument names fail; there is no dialog, so pass every required argument (`space.close --id <id> --confirmed true`).
- A launch reply means the terminal exists, not that its program started.
- A terminal you start with `hc run --label herdr.space=<id> --label herdr.tab=<id>` shows in that tab. Unlabeled workers stay hidden; keep it that way for background work.

## Customizing: ~/.config/herdr-app/

Read `AGENTS.md` there (925 lines) and the generated `herdr.d.ts` / `gpui-kit.d.ts` for any edit beyond the facts below. Never edit those generated files.

- Files apply live: `layouts/<name>.json`, `keys.json`, `settings.json`, `programs.json`, `mods/<name>/`. An invalid file keeps the last good version and writes `<name>.error`; check it after every edit.
- `keys.json` sections: `global`, `layout:<name>`, `terminal`, `mod:<name>`; the more specific wins. Actions: a command (`name:value`), `send:<text>`, `<mod>.<command>`, or `terminal`. Do not bind program keys (ctrl+c/d/l/r/w/a/e/u/k/z) unless asked.
- Shipped layouts and mods belong to Herdr: `layout.clone` / `mod.clone` before editing structure.
- `ctrl-alt-shift-escape` resets the layout and keys; nothing can rebind it.

### Mods

`mods/<name>/main.js` default-exports a class extending `View` (gpui-kit: JS describing native GPUI elements; no DOM, HTML, CSS, Node APIs or `setTimeout`). Optional `mod.json`: `{ "place": "right|left|top|bottom|none", "size": 320 }`.

- `init(props, cx)` once; `render(cx)` reruns after `cx.notify()` and on any live-data change, so never poll `spaces()`, `agents()`, `theme()`.
- Never keep a `cx`; every callback gets its own (`on_click((e, cx) => …)`, `cx.spawn(async (cx) => …)`, `cx.timer.every(ms, (cx) => …)`).
- Animate with `.frames()`, `.spin()`, `.loop()`, `.transition()`, never a redraw timer: each redraw repaints the whole window.
- Use `theme()` colors. Run shell work through `exec(cmd, args, { cwd, on })`, not `process.run`. Act through `run(command, args)`.
- Optional `async close(cx)` gets 250 ms for cleanup.
- Keep side effects off the module top level: a broken save keeps the old build but its top level already ran.
- Done means all three: `herdr-app check ~/.config/herdr-app/mods/<name>` passes, `herdr-app status` shows no error, and you looked at `herdr-app shot`.

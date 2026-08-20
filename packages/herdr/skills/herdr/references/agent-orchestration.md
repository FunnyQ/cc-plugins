# Herdr Agent Orchestration

This document is verified against herdr 0.8.2. If live CLI output disagrees with this doc, trust `herdr --skill` / `herdr --help`.

Use this when Claude is running *inside* a herdr-managed pane and needs to control herdr itself. This includes inspecting sibling panes, splitting panes, spawning other agents, and coordinating with them over the CLI. This is a live-session operational guide. See `cli.md` for the full command and flag syntax.

## Precondition

Before you do any of this, confirm `HERDR_ENV=1` is set in the environment. If it is not set, you are not running inside a herdr-managed pane. Say so, and stop. Do not try to inspect or control a focused herdr pane from outside herdr.

## Concepts

- **Workspaces** are project contexts. Each workspace has one or more tabs. A workspace's label defaults to the first tab's root pane (usually the repo name).
- **Tabs** are subcontexts inside a workspace. Each tab has one or more panes.
- **Panes** are terminal splits inside a tab. Each pane runs its own process: a shell, an agent, a server, or a log stream.
- **Agent status** (`agent_status` field): `idle`, `working`, `blocked`, `done`, `unknown`. `idle` means the agent will accept input *and* its tab has already been seen in the focused UI. `done` is that same ready state after unseen background work finished; focusing the tab, pane, or agent marks it seen, but a CLI read never does. `blocked` means herdr recognized an approval or question UI. `unknown` means an agent is present that herdr cannot classify — it never proves completion. Plain shells exist as panes too. The sidebar's agent section only surfaces detected agents.
- **IDs are stable opaque handles.** Workspace, tab, and pane ids look like `w1`, `w1:t1`, and `w1:p1`. A pane moved across workspaces receives a new id; continue with `result.move_result.pane.pane_id` or the live agent name. The old id stays at `result.move_result.previous_pane_id`, but it resolves only for the moved process's own inherited context. Do not reuse it as a target.
- **Agent kinds are a fixed list.** Run `herdr agent` to print the installed kinds before you pass `--kind`. Do not guess a kind from an integration name; `herdr integration install` covers names that `--kind` rejects.

## Discover yourself

```bash
herdr pane current --current   # the pane you are running in
herdr pane list                # your focused pane + neighbors
herdr workspace list
```

Herdr injects `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` into every managed pane. Target `--current` or an explicit id. An omitted target resolves the UI-focused pane, which may belong to the user or another client.

## Recipes

**Run a server, and wait until it is ready:**
```bash
NEW_PANE=$(herdr pane split --current --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "npm run dev"
herdr pane wait-output "$NEW_PANE" --match "ready" --timeout 30000
herdr pane read "$NEW_PANE" --source recent --lines 20
```

**Run tests in a separate pane, then inspect the result:**
```bash
NEW_PANE=$(herdr pane split --current --direction down --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "cargo test"
herdr pane wait-output "$NEW_PANE" --match "test result" --timeout 60000
herdr pane read "$NEW_PANE" --source recent --lines 30
```

**Spawn a new agent, and hand it a task.** First create the destination pane. Then launch a known agent kind in it:
```bash
REVIEWER_PANE=$(herdr pane split --current --direction right --cwd "$PWD" --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start reviewer --kind claude --pane "$REVIEWER_PANE"
herdr agent prompt reviewer "review the test coverage in src/api/" --wait --timeout 120000
```

`agent start` returns only after the new pane shell and the agent's first-run prompt are ready. Add no settle wait *after* it. Do add one *before* it: `pane split` returns as soon as the pane exists, and calling `agent start` back-to-back fails with `agent_pane_busy` most of the time — 13 of 20 measured on 0.8.2 with real agents. herdr waits out a pane held by a foreground command, but not one whose shell has yet to spawn. The refusal is immediate (~115ms), and one 150ms retry clears it; a clean start instead takes ~4.4s to reach `idle`. Retry that one error, fail fast on every other, and do not conclude the race is gone because a probe with ~100ms of slack in it never saw one. A start that returns `agent_not_ready` saw `blocked` during startup: the name still works for `agent read` and `agent send-keys`, so read the pane and clear the dialog before you prompt. Append native agent arguments after `--`; omit the separator when there are none.

`agent prompt --wait` already settles on `idle`, `done`, or `blocked`. Do not restate that set with `--until`.

**Coordinate with another agent (block until it is done, then read its output):**
```bash
herdr pane list
OTHER_PANE="<pane_id_from_fresh_list>"
herdr agent wait "$OTHER_PANE" --until idle --until done --timeout 120000
herdr pane read "$OTHER_PANE" --source recent --lines 100
```

Wait on both states. An agent whose tab the user focused settles at `idle`, not `done`, so a `--until done` wait alone hangs until the timeout.

**Watch a sibling pane robustly.** Read what is already there before you wait, so you do not miss output that arrived before the wait started:
```bash
herdr pane list
SIBLING_PANE="<pane_id_from_fresh_list>"
herdr pane read "$SIBLING_PANE" --source recent --lines 40
herdr pane wait-output "$SIBLING_PANE" --match "ready" --timeout 30000
herdr pane read "$SIBLING_PANE" --source recent-unwrapped --lines 40   # inspect the same transcript the waiter matched
```

## Gotchas

- `pane wait-output --source recent` matches against **unwrapped** recent text. Pane width and soft-wrapping do not affect the match. This is true even though `pane read --source recent` displays the wrapped version.
- Use `pane read` for output that already exists. Use `pane wait-output` for output you expect to appear next.
- `agent prompt` atomically writes and submits text. Use `agent send-keys` only for raw key chords.
- `agent prompt` refuses a `blocked` agent with `agent_blocked` and sends neither text nor Enter. Read the dialog, then answer it with `agent send-keys`. Never poll until the block clears and then prompt blind.
- `agent send-keys` and `pane send-keys` preserve Shift on `shift+tab`, so an agent's permission mode can be cycled programmatically.
- Run `herdr agent explain <target>` when a pane reports a state you did not expect. It names the matched detection rule and the manifest it came from.
- `pane send-text` / `pane send-keys` / `pane run` print nothing on success. Do not expect JSON back.

See `cli.md` for the full command/flag reference.

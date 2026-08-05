# Herdr Agent Orchestration

This document is verified against herdr 0.8.0. If live CLI output disagrees with this doc, trust `herdr --skill` / `herdr --help`.

Use this when Claude is running *inside* a herdr-managed pane and needs to control herdr itself. This includes inspecting sibling panes, splitting panes, spawning other agents, and coordinating with them over the CLI. This is a live-session operational guide. See `cli.md` for the full command and flag syntax.

## Precondition

Before you do any of this, confirm `HERDR_ENV=1` is set in the environment. If it is not set, you are not running inside a herdr-managed pane. Say so, and stop. Do not try to inspect or control a focused herdr pane from outside herdr.

## Concepts

- **Workspaces** are project contexts. Each workspace has one or more tabs. A workspace's label defaults to the first tab's root pane (usually the repo name).
- **Tabs** are subcontexts inside a workspace. Each tab has one or more panes.
- **Panes** are terminal splits inside a tab. Each pane runs its own process: a shell, an agent, a server, or a log stream.
- **Agent status** (`agent_status` field): `idle`, `working`, `blocked`, `done`, `unknown`. `done` means the agent finished, but the pane has not been looked at yet. `herdr agent wait --until` accepts `done` as a value. Plain shells exist as panes too. The sidebar's agent section only surfaces detected agents.
- **IDs are stable opaque handles.** Workspace, tab, and pane ids look like `w1`, `w1:t1`, and `w1:p1`. A pane moved across workspaces receives a new id; continue with `result.move_result.pane.pane_id` or the live agent name.

## Discover yourself

```bash
herdr pane list        # your focused pane + neighbors
herdr workspace list
```

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
herdr agent start reviewer --kind claude --pane "$REVIEWER_PANE" --
herdr agent wait reviewer --until idle --timeout 15000
herdr agent prompt reviewer "review the test coverage in src/api/"
```

**Coordinate with another agent (block until it is done, then read its output):**
```bash
herdr pane list
OTHER_PANE="<pane_id_from_fresh_list>"
herdr agent wait "$OTHER_PANE" --until done --timeout 120000
herdr pane read "$OTHER_PANE" --source recent --lines 100
```

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
- `pane send-text` / `pane send-keys` / `pane run` print nothing on success. Do not expect JSON back.

See `cli.md` for the full command/flag reference.

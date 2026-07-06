# Herdr Agent Orchestration

Verified against herdr 0.7.1; if live CLI output disagrees with this doc, trust `herdr --help` / `herdr --default-config`.

Use this when Claude is running *inside* a herdr-managed pane and needs to control herdr itself — inspect sibling panes, split panes, spawn other agents, and coordinate with them over the CLI. This is a live-session operational guide; see `cli.md` for full command/flag syntax.

## Precondition

Before doing any of this, confirm `HERDR_ENV=1` is set in the environment. If it isn't, you are not running inside a herdr-managed pane — say so and stop. Don't try to inspect or control a focused herdr pane from outside herdr.

## Concepts

- **Workspaces** are project contexts; each has one or more tabs. A workspace's label defaults to the first tab's root pane (usually the repo name).
- **Tabs** are subcontexts inside a workspace; each has one or more panes.
- **Panes** are terminal splits inside a tab; each runs its own process — shell, agent, server, log stream.
- **Agent status** (`agent_status` field): `idle`, `working`, `blocked`, `done`, `unknown`. `done` means the agent finished but the pane hasn't been looked at yet. `done` is only a valid value for `herdr wait agent-status`; `herdr agent wait` only accepts `idle|working|blocked|unknown`. Plain shells exist as panes too, but the sidebar's agent section only surfaces detected agents.
- **IDs are not durable** — see the IDs note in `cli.md`. Re-read ids from a `list` command or a create/split response right before you use them; don't reuse a stale id from earlier in the conversation.

## Discover yourself

```bash
herdr pane list        # your focused pane + neighbors
herdr workspace list
```

## Recipes

**Run a server and wait until it's ready:**
```bash
NEW_PANE=$(herdr pane split --current --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "npm run dev"
herdr wait output "$NEW_PANE" --match "ready" --timeout 30000
herdr pane read "$NEW_PANE" --source recent --lines 20
```

**Run tests in a separate pane, then inspect the result:**
```bash
NEW_PANE=$(herdr pane split --current --direction down --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr pane run "$NEW_PANE" "cargo test"
herdr wait output "$NEW_PANE" --match "test result" --timeout 60000
herdr pane read "$NEW_PANE" --source recent --lines 30
```

**Spawn a new agent and hand it a task** — prefer `agent start` over `pane split` + `pane run` when launching a known agent binary, since it registers the process as an agent directly:
```bash
herdr agent start reviewer --cwd "$PWD" --split right --no-focus -- claude
herdr agent wait reviewer --status idle --timeout 15000
herdr agent send reviewer "review the test coverage in src/api/"
REVIEWER_PANE=$(herdr agent get reviewer | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["pane_id"])')
sleep 0.4
herdr pane send-keys "$REVIEWER_PANE" enter
```

**Coordinate with another agent (block until it's done, then read its output):**
```bash
herdr pane list
OTHER_PANE="<pane_id_from_fresh_list>"
herdr wait agent-status "$OTHER_PANE" --status done --timeout 120000
herdr pane read "$OTHER_PANE" --source recent --lines 100
```

**Watch a sibling pane robustly** — read what's already there before waiting, so you don't miss output that arrived before the wait started:
```bash
herdr pane list
SIBLING_PANE="<pane_id_from_fresh_list>"
herdr pane read "$SIBLING_PANE" --source recent --lines 40
herdr wait output "$SIBLING_PANE" --match "ready" --timeout 30000
herdr pane read "$SIBLING_PANE" --source recent-unwrapped --lines 40   # inspect the same transcript the waiter matched
```

## Gotchas

- `wait output --source recent` matches against **unwrapped** recent text — pane width and soft-wrapping don't affect the match — even though `pane read --source recent` displays the wrapped version.
- Use `pane read` for output that already exists; use `wait output` for output you expect to appear next.
- Raw `agent send` writes literal text but does not submit it. Re-resolve the agent's pane id, pause briefly (about 0.4s), then send `enter`; an Enter sent too fast can be swallowed by the agent TUI.
- `pane send-text` / `pane send-keys` / `pane run` print nothing on success — don't expect JSON back.

See `cli.md` for the full command/flag reference.

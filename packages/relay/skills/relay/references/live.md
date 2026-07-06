# Live-Pane Mode Reference

## Live-pane mode (inside herdr)

When the session runs inside herdr (`HERDR_ENV=1`), `delegate` and `review` automatically execute in a **visible, take-over-able TUI opened in its own new herdr tab** (your current pane keeps its full size — no split) instead of a blocking headless spawn. `image` always stays headless/native. Nothing changes in how you invoke `relay.ts` — the routing is automatic.

Flags:

- `--headless` — force today's headless flow even inside herdr. **Use this for nested delegation**: an agent that was itself live-delegated inherits `HERDR_ENV=1`, and a second layer of panes is rarely what anyone wants.
- `--wait-timeout <ms>` — how long relay polls for the result (default 600000 = 10 min).
- `--dangerous` — **YOLO / unattended** live run: the delegate proceeds without stopping on approval prompts (codex `--dangerously-bypass-approvals-and-sandbox`, claude `--dangerously-skip-permissions`, opencode `--auto`). Without it, approval prompts surface **in the pane** for a human to answer. Pass `--dangerous` when nobody is watching the pane to press "allow"; leave it off for supervised runs.

Output contract:

- **stdout = the answer only** (clean markdown from the delegate's result file). Live metadata — agent name, keep/close hint — rides **stderr**.
- The tail of stderr names the herd agent (e.g. `relay-codex-delegate-a3f9`). Keep it: it's the handle for every follow-up.

**After a successful live run** the pane is left open on purpose. Confirm with the user via AskUserQuestion — close it, or keep it for follow-up conversation:

```
AskUserQuestion("live pane（<agent-name>）要關閉還是留著追問？")
```

In non-interactive contexts (invoked by a sub-agent or headless), do not block on AskUserQuestion; keep the pane open and report the agent handle.

On close: `bun <herd.ts> close <agent-name>` (herd.ts lives in the herdr plugin; the exact path is printed in relay's stderr report). On keep: continue the conversation directly with `herd send/wait/read` — follow-ups are out of relay's scope; relay is one-shot spawn→capture.

**Pending report (exit 0 + "still running")** — if the delegate outlives `--wait-timeout`, relay does NOT kill or close anything. It exits **0** with a report of copy-pasteable follow-ups (`herd wait/read/close <name>` + `cat <result.md>`). Treat this as "work in progress", not failure: relay's non-zero = stop rule does not apply. Collect the answer later with `herd wait <name>` then `cat` the result file.

If live mode is denied for a non-user reason (herd.ts unresolvable, backend without a live seam), relay prints one stderr note and runs headless in the same invocation — no action needed.

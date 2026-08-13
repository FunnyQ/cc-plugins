# Live-Pane Mode Reference

## Live-pane mode (inside herdr)

When the session runs inside herdr (`HERDR_ENV=1`), `delegate` and `review` open automatically in a **visible, take-over-able TUI in its own new herdr tab**. This replaces a blocking headless spawn. Your current pane keeps its full size. It does not split. `image` always stays headless/native. Nothing changes in how you invoke `relay.ts`. The routing is automatic.

The live tab stays in the caller's Herdr workspace, even when Relay runs against a different project or a sibling repository. Relay accepts that cross-project caller only under one condition. The inherited `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID` triple must uniquely match an active caller in current Herdr state. The caller's agent type must also match. If identity is stale or ambiguous, Relay falls back to the cwd-based runtime check. If no unique caller can be proven, Relay safely declines live mode.

### Choosing live vs headless

Live and headless share the same CLI, model, and write access. Editing capability is **identical**. Never justify `--headless` with "more precise / deterministic / reliable for multi-file edits". Live is a *superset*: it is unattended **and** observable. Keep live as the default. Force `--headless` only for a real reason: nested delegation, a mode with no live seam, or no pane surface.

`relay.ts` is one blocking call. Wait for its single result. Do not poll `tail`, `cat`, or pane status while it runs. If it reports a pending run, resume it with the printed `relay.ts collect` command rather than a hand-rolled wait.

Flags:

- `--headless` — force today's headless flow even inside herdr. **Use this for nested delegation.** An agent that was itself live-delegated inherits `HERDR_ENV=1`. A second layer of panes is rarely what anyone wants.
- `--keep-pane` — after a verified success, keep the live pane open for follow-up conversation. Without this flag, relay closes the pane after it has collected a settled, marker-terminated result.
- `--wait-timeout <ms>` — how long relay polls for the result (default 600000 = 10 min).
- `--dangerous` — **YOLO / unattended** live run. The delegate proceeds without stopping on approval prompts (codex `--dangerously-bypass-approvals-and-sandbox`, claude `--dangerously-skip-permissions`, opencode `--auto`). Without it, approval prompts surface **in the pane** for a human to answer. When nobody is watching the pane to press "allow", pass `--dangerous`. Leave it off for supervised runs. opencode nuance: `--auto` auto-approves only what is **not explicitly denied** — config `deny` rules still block, unlike codex's full bypass.

Output contract:

- **stdout = the answer only**: clean markdown from the delegate's result file. Live metadata — the agent name and the pane lifecycle note — rides **stderr**.
- The tail of stderr names the herd agent (e.g. `relay-codex-delegate-a3f9`). Keep it: it's the handle for every follow-up.

**After a successful live run**, relay closes the pane by default. It closes the pane only after the agent has settled and the result-file marker verifies the captured answer. To leave the pane open for follow-up conversation, pass `--keep-pane`.

With `--keep-pane`, continue the conversation directly with `herd send/wait/read`. Block on `herd wait` instead of looping `herd read`, and pass the status you actually mean — it defaults to `idle`, which means "ready for input", not "finished". Close it later with `bun <herd.ts> close <agent-name>`. Follow-ups are out of relay's scope. Relay is one-shot: spawn→capture.

**Pending report (exit 0 + "still running")**: if the delegate outlives `--wait-timeout`, relay does NOT kill or close anything. It exits **0** and prints a report of copy-pasteable follow-ups. Treat this as "work in progress", not failure. Relay's non-zero = stop rule does not apply.

### Collecting a pending run

```bash
relay.ts collect --agent <name> --result <path> [--wait-timeout <ms>] [--keep-pane]
```

Reattach to the pane a pending report named and watch it for another bounded window. The pending report prints this exact command, filled in.

**Repeat it as many times as the task needs.** Each call returns inside its own `--wait-timeout`, so a task may run far longer than any single caller's timeout cap. Output matches a normal live run: the answer on stdout, exit 0; another pending report, exit 0; a real failure, exit 1.

`collect` never spawns a second pane and never re-sends the prompt — it only watches. On a verified result it closes the pane, like a normal live success.

**For a pending run, use `collect`, not a hand-rolled `herd wait`.** A status wait only reports what the pane's agent is doing, and it defaults to `idle` — which codex never returns to, because it parks at `done` when it finishes. `collect` gates on relay's own settled test instead: `idle` **or** `done`, **plus** the result-file marker. The marker is the part a status wait cannot replace. Without it, a settled pane is indistinguishable from one that never started work.

Do not use `collect` to poll. One bounded call, then act on what it returns.

If a pane exists, failures also leave it open. This leaves a postmortem target you can read or close manually.

Live mode can be denied for a non-user reason: herd.ts is unresolvable, or the backend has no live seam. When that happens, relay prints one stderr note and runs headless in the same invocation. No action is needed.

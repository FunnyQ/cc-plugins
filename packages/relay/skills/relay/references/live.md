# Live-Pane Mode Reference

## Live-pane mode (inside herdr)

When the session runs inside herdr (`HERDR_ENV=1`), `delegate` and `review` automatically execute in a **visible, take-over-able TUI opened in its own new herdr tab** (your current pane keeps its full size — no split) instead of a blocking headless spawn. `image` always stays headless/native. Nothing changes in how you invoke `relay.ts` — the routing is automatic.

The live tab stays in the caller's Herdr workspace even when Relay runs against a different project or sibling repository. Relay accepts that cross-project caller only when the inherited `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID` triple uniquely matches an active caller in current Herdr state and the expected agent type. Stale or ambiguous identity still falls back to the cwd-based runtime check, or safely declines live mode when no unique caller can be proven.

### Choosing live vs headless

Live and headless share the same CLI/model/write access, so editing capability is **identical** — never justify `--headless` with "more precise / deterministic / reliable for multi-file edits". Live is a *superset* (unattended **and** observable), so keep the default and force `--headless` only for a real reason: nested delegation, a mode with no live seam, or no pane surface.

`relay.ts` is one blocking call — wait for its single result; don't poll `tail`/`cat`/status while it runs. Driving `herd` directly, block with `herd wait <agent>` instead of looping `herd read`.

Flags:

- `--headless` — force today's headless flow even inside herdr. **Use this for nested delegation**: an agent that was itself live-delegated inherits `HERDR_ENV=1`, and a second layer of panes is rarely what anyone wants.
- `--keep-pane` — after a verified success, keep the live pane open for follow-up conversation. Without this flag, relay closes the pane after it has collected a settled, marker-terminated result.
- `--wait-timeout <ms>` — how long relay polls for the result (default 600000 = 10 min).
- `--dangerous` — **YOLO / unattended** live run: the delegate proceeds without stopping on approval prompts (codex `--dangerously-bypass-approvals-and-sandbox`, claude `--dangerously-skip-permissions`, opencode `--auto`). Without it, approval prompts surface **in the pane** for a human to answer. Pass `--dangerous` when nobody is watching the pane to press "allow"; leave it off for supervised runs.

Output contract:

- **stdout = the answer only** (clean markdown from the delegate's result file). Live metadata — agent name and pane lifecycle note — rides **stderr**.
- The tail of stderr names the herd agent (e.g. `relay-codex-delegate-a3f9`). Keep it: it's the handle for every follow-up.

**After a successful live run** relay closes the pane by default, but only after the agent has settled and the result-file marker verifies the captured answer. Pass `--keep-pane` when you want the pane left open for follow-up conversation.

With `--keep-pane`, continue the conversation directly with `herd send/wait/read` and close it later with `bun <herd.ts> close <agent-name>`. Follow-ups are out of relay's scope; relay is one-shot spawn→capture.

**Pending report (exit 0 + "still running")** — if the delegate outlives `--wait-timeout`, relay does NOT kill or close anything. It exits **0** with a report of copy-pasteable follow-ups (`herd wait/read/close <name>` + `cat <result.md>`). Treat this as "work in progress", not failure: relay's non-zero = stop rule does not apply. Collect the answer later with `herd wait <name>` then `cat` the result file.

Failures also leave the pane open when one exists, so there is still a postmortem target to read or close manually.

If live mode is denied for a non-user reason (herd.ts unresolvable, backend without a live seam), relay prints one stderr note and runs headless in the same invocation — no action needed.

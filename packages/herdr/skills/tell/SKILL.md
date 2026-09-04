---
name: tell
description: >-
  Hand a job to an agent already running in another project's Herdr workspace,
  fire-and-forget.
when_to_use: >-
  Use when work belongs to a different project that already has an agent open —
  "叫 api-service 去 rebase", "把這個丟給 acme 那邊", "tell the dashboard agent to
  restart the dev server", "hand this off to <project>", "ask the agent in
  <project> to …". Also use to list which agents are open and where. Do NOT use
  to start a new agent (that is `herdr`'s `spawn`), to run a shell command in
  another pane, or for work you can simply do yourself in this session.
argument-hint: <project-or-fragment> <what to do>
version: 1
---

# Tell another project's agent

Herdr runs one workspace per project, and its label *is* the project name. That makes an already-open agent addressable by the name you would say out loud.

## Precondition

`HERDR_ENV=1` must be set. Without it you are not inside a Herdr pane, there are no sibling agents to reach, and this skill does not apply. Say so and stop.

## Do it

```bash
HERD="$SKILL_DIR/../herdr/scripts/herd.ts"

bun "$HERD" list                                          # who is open, and at what address
bun "$HERD" tell api-service "rebase onto main and run the suite"
bun "$HERD" tell web-app/dashboard "restart the dev server"
```

Resolve `$SKILL_DIR` from the load-time **"Base directory for this skill"** banner. `${CLAUDE_PLUGIN_ROOT}` is not reliable inside a Bash call. The script lives in the sibling `herdr` skill; both ship in the same plugin, so the relative path holds. On OpenCode there is no banner — use `~/.config/opencode/skills/herdr/scripts/herd.ts` directly.

## Addressing

The fragment is matched case-insensitively against the workspace label (the project name), the tab label, the agent name, the pane id, and either cwd. Split it on `/` to narrow — every part must match, and parts may match different fields, so both `web-app/dashboard` (workspace + tab) and `clients/acme` (path + label) resolve.

Run `list` when you are unsure. `workspaceLabel` and `tabLabel` are the readable address; `paneId` is the exact one, and it is the only handle guaranteed unique — two tabs in one workspace may share a label.

## Rules

**Report which agent you reached.** The user cannot see the other pane. The result carries `matched` — name the project and tab back to them.

**Let the user pick when it is ambiguous.** `tell` refuses to send when the fragment matches more than one agent, and prints each candidate as `web-app/dashboard  [w6E:p4]`. Put those candidates to the user through the harness's own question tool — on Claude Code that is `AskUserQuestion`, which takes up to four options; label each option with the readable address and describe it by cwd and status. When more than four survive, or the harness has no such tool, print the list and ask in plain text instead. Then retell using the chosen **pane id**, never the readable address — that is what stays unambiguous when two candidates read alike.

**Never pick for them, and never work around a refusal.** Do not send to the first candidate, do not loop over the candidates, and do not fall back to `herdr pane send-text`. A prompt cannot be recalled, and every agent that receives one acts on it in its own repo.

**A typo that matches nothing is safe; one that matches something is not.** Zero matches is a hard refusal listing every available agent — read it back and ask which one was meant. But a fragment is a substring, so a mistyped one can still resolve uniquely to the *wrong* agent, and nothing catches that. Prefer the fullest fragment you have, and always report the `matched` address afterwards so the user sees where it actually went.

**Ask before telling anything destructive.** The receiving agent has its own permissions in its own working tree. Deleting, force-pushing, releasing, or deploying there deserves the same confirmation it would deserve here.

**It does not wait.** `tell` returns as soon as the text is submitted. There is no answer in the result. To collect one, use the `herdr` skill's `wait` and `read` against the same address.

**Your own pane is excluded.** Telling your own project label finds a sibling, or nothing — never yourself.

**A blocked agent takes nothing.** If the target is parked on an approval dialog, herdr fails with `agent_blocked` and sends neither the text nor the Enter. Report that to the user; do not retry, and do not answer another project's dialog on their behalf.

For the rest of the wrapper — `spawn`, `send`, `keys`, `wait`, `read`, `close` — see the `herdr` skill.

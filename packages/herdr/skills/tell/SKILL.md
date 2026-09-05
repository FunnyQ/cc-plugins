---
name: tell
description: >-
  Hand a job to another project — an agent already running in its Herdr
  workspace when one is open, otherwise a known project resolved from the
  herdr-workbench registry or zoxide, spun up on demand — fire-and-forget.
when_to_use: >-
  Use when work belongs to a different project — "叫 api-service 去 rebase",
  "把這個丟給 acme 那邊", "tell the dashboard agent to restart the dev server",
  "hand this off to <project>", "ask the agent in <project> to …" — whether or
  not that project currently has an agent open. Also use to list which agents
  are open and where. Do NOT use to run a shell command in another pane, or
  for work you can do yourself in this session.
argument-hint: <project-or-fragment> <what to do>
version: 2
---

# Tell another project's agent

## Do it

Run `tell` directly. Check nothing first. Do not test `HERDR_ENV`, do not run `list`, do not verify the address. `tell` resolves the fragment itself and fails with a message that tells you exactly what to do next.

```bash
HERD="$SKILL_DIR/../herdr/scripts/herd.ts"

bun "$HERD" tell api-service "rebase onto main and run the suite"
bun "$HERD" tell web-app/dashboard "restart the dev server"
```

Need a verb's flags? Run `bun "$HERD" <verb> --help`. Never read `herd.ts` to answer that.

Resolve `$SKILL_DIR` from the load-time **"Base directory for this skill"** banner. `${CLAUDE_PLUGIN_ROOT}` is not reliable inside a Bash call. On OpenCode there is no banner. Use `~/.config/opencode/skills/herdr/scripts/herd.ts` directly.

## Addressing

Herdr runs one workspace per project, and its label *is* the project name — the fragment is matched case-insensitively against that workspace label, the tab label, the agent name, the pane id, and the cwd. Split it on `/` to narrow. Every part must match, though different parts may match different fields. `web-app/dashboard` resolves on workspace plus tab; `clients/acme` resolves on path plus label.

The readable address is the agent's `name` when it has one, otherwise `workspaceLabel/tabLabel`. `paneId` is the exact one. It is the only handle guaranteed unique, because two tabs in one workspace may share a label. Every failure message already prints both, so pass the fullest fragment you have and let the error correct you. Run `list` only when the user asks who is open.

## No live agent? `tell` looks further before giving up

Zero live matches does not mean stop. `tell` next checks the herdr-workbench project registry (`~/.local/state/herdr-projects/registry.json` — projects it or another herdr client has seen, open or not), then zoxide's frecency index. Same unique/ambiguous/zero rule as live agents, candidates listed by path instead of pane id.

A registry/zoxide hit is a **path**, not a running agent. `tell` checks that path against every live agent's cwd first — a tab renamed away from its project's label can still be reachable there — and only when nothing answers does it spawn a fresh workspace at that path and hand it the text. The result's `spawned` field is set exactly when this happened; **report it** alongside `matched`.

## Rules

**No Herdr means stop.** When the script exits with `not inside a herdr-managed pane`, there are no sibling agents to reach. Say so and stop. Do not look for another way to deliver the message.

**Report which agent you reached.** The user cannot see the other pane. The result carries `matched`. Name the project and tab back to them.

**Let the user pick when it is ambiguous.** `tell` refuses to send when the fragment matches more than one agent, and prints each candidate as `address  [pane id]  status  cwd`:

```
  web-app/main               [w6E:p1]  idle     /Users/dev/Projects/web-app
  web-app/Dashboard Launcher [w6E:p4]  working  /Users/dev/Projects/web-app
```

Put those candidates to the user through the harness's own question tool. On Claude Code that is `AskUserQuestion`, which takes up to four options. Label each option with the readable address, and describe it with the status and cwd from the same line. When more than four candidates survive, or the harness has no such tool, print the list and ask in plain text instead. Then retell using the chosen **pane id**, never the readable address.

**Never pick for them, and never work around a refusal.** Do not send to the first candidate, do not loop over the candidates, and do not fall back to `herdr pane send-text`. This applies at the registry layer too: an ambiguous fragment there refuses rather than guessing which repo to open a fresh agent in — spawning into the wrong one is worse than telling the wrong agent, since a prompt cannot be recalled and every agent that receives one acts on it in its own repo.

**A typo that matches nothing is safe; one that matches something is not.** On zero live matches the error, once the registry and zoxide also come up empty, lists every reachable agent — read that list back and ask which was meant. But a fragment is a substring, so a mistyped one can resolve uniquely to the *wrong* agent or, worse, the wrong project to spawn into. Prefer the fullest fragment you have.

**Ask before telling anything destructive.** The receiving agent has its own permissions in its own working tree. Deleting, force-pushing, releasing, or deploying there deserves the same confirmation it would deserve here.

**It does not wait.** `tell` returns as soon as the text is submitted. There is no answer in the result. To collect one, use the `herdr` skill's `wait` and `read` against the same address.

**Your own pane is excluded.** Telling your own project label finds a sibling, or nothing. Never yourself.

**A blocked agent takes nothing.** On `agent_blocked`, report it; do not retry, and do not answer another project's dialog on their behalf.

For the rest of the wrapper (`spawn`, `send`, `keys`, `wait`, `read`, `close`), see the `herdr` skill.

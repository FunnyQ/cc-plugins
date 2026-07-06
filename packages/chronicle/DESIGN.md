# Chronicle Design Notes

## Commit Flow

The Commit Manager is spawned via `subagent_type`, never as a fork. A fork is a
leaf that cannot spawn subagents, so a fork Manager could never reach the analyst
or writer. A nested custom agent can. The cost: a nested agent does **not** inherit
the conversation, so the main agent must hand the Manager the distilled
`contextBrief` in its spawn prompt.

The Manager can spawn because it is a custom agent whose `tools:` include an
`Agent(...)` whitelist for `chronicle:analyst` and `chronicle:writer`. It also has
`Read` and no `Bash`, so command execution is structurally outside the Manager; it
must delegate analysis and writing.

The children are spawned by name. A nested custom agent can address plugin-defined
types (`chronicle:analyst` / `chronicle:writer`) via `subagent_type`. They run on
Haiku, never see the conversation, and receive the "why" only through the
Manager's per-commit `whyBrief`.

## PR Flow

The Editor is spawned via `subagent_type`, never as a fork. A fork is a leaf that
cannot spawn subagents, so the Editor must be a nested custom agent. It does
**not** inherit the conversation, so the main agent hands it the distilled
`contextBrief`.

The Editor has an `Agent(...)` whitelist for `chronicle:drafter` and
`chronicle:publisher`, plus `Read` and no `Bash`. Command execution is structurally
outside the Editor, so it delegates analysis/drafting and request creation.

The children are separate instructed roles: `chronicle:drafter` analyzes and drafts
only, while `chronicle:publisher` creates the request from the confirmed material.
Do not rely on unsupported Bash subcommand frontmatter for scoping; the separation
is expressed by instructions. The `Agent(...)` type lists on the Manager/Editor
document intent but are NOT enforced either — in a subagent definition the harness
ignores the parenthesized type list (listing `Agent` merely enables spawning; the
list is honored only for a main-thread `claude --agent`). What IS structural:
Manager/Editor have no `Bash`, so they cannot execute commands at all.

## Verified Spawn Model

Live-tested in this harness:

| Caller | Can spawn? |
|---|---|
| Fork (`subagent_type:"fork"`) | No — a fork is a leaf, never delegates |
| Custom agent with `Agent` (or `Agent(...)`) in `tools:` | Yes — and it can address plugin types like `chronicle:analyst`; the parenthesized type list itself is ignored in subagent definitions |
| Custom agent without `Agent` | No |

## Enforcement facts (doc-verified)

Checked against the official sub-agents docs (code.claude.com/docs/en/sub-agents):

- `allowed-tools:` is a slash-command frontmatter key; in an **agent** definition it
  is silently ignored. Tool control for agents is `tools:` / `disallowedTools:` only.
- `tools:` accepts bare tool names (plus `mcp__server` patterns and the `Agent(...)`
  form) — never `Bash(pattern)` permission-rule syntax. Granting `Bash` grants all
  commands.
- Plugin subagents also ignore frontmatter `hooks`, `mcpServers`, and
  `permissionMode`. Real command-level Bash scoping for chronicle's agents therefore
  requires a `PreToolUse` hook or `permissions` rules in `settings.json` (session
  scope), or copying the agent out of the plugin into `.claude/agents/`.

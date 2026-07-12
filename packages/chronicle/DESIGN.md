# Chronicle Design Notes

## Model mapping

Codex roles mirror Claude model tiers:

- Opus / Fable → `gpt-5.6-sol`
- Sonnet → `gpt-5.6-terra`
- Haiku → `gpt-5.6-luna`

Claude agents live in `agents/*.md`. Codex role overlays live in
`agents-codex/*.toml` and are copied to a stable `$CODEX_HOME` path by the
Chronicle install skill before registration in `config.toml`.

Codex runtimes expose two different sub-agent APIs. When the API has a named-role
selector, Chronicle selects the registered role directly. When it exposes only a
generic, nestable sub-agent API, the main agent spawns one non-fork generic
Lawspeaker with no inherited conversation and tells it to self-load the stable
`lawspeaker.toml`. The Lawspeaker then spawns generic Watcher and Runesmith children
that self-load their stable TOMLs. This is role loading, not an inline fallback: the
same three-agent boundary, sequential flow, and git-output isolation remain intact.
Fork agents are still invalid because the Lawspeaker must delegate.

## Commit Flow

The Lawspeaker is spawned via `subagent_type`, never as a fork. A fork is a
leaf that cannot spawn subagents, so a fork Lawspeaker could never reach the watcher
or runesmith. A nested custom agent can. The cost: a nested agent does **not** inherit
the conversation, so the main agent must hand the Lawspeaker the distilled
`contextBrief` in its spawn prompt.

The Lawspeaker can spawn because it is a custom agent whose `tools:` include an
`Agent(...)` whitelist for `chronicle:watcher` and `chronicle:runesmith`. It also has
`Read` and no `Bash`, so command execution is structurally outside the Lawspeaker; it
must delegate analysis and writing.

The children are spawned by name. A nested custom agent can address plugin-defined
types (`chronicle:watcher` / `chronicle:runesmith`) via `subagent_type`. They run on
Haiku, never see the conversation, and receive the "why" only through the
Lawspeaker's per-commit `whyBrief`.

## PR Flow

The Storykeeper is spawned via `subagent_type`, never as a fork. A fork is a leaf that
cannot spawn subagents, so the Storykeeper must be a nested custom agent. It does
**not** inherit the conversation, so the main agent hands it the distilled
`contextBrief`.

The Storykeeper has an `Agent(...)` whitelist for `chronicle:skald` and
`chronicle:messenger`, plus `Read` and no `Bash`. Command execution is structurally
outside the Storykeeper, so it delegates analysis/drafting and request creation.

The children are separate instructed roles: `chronicle:skald` analyzes and drafts
only, while `chronicle:messenger` creates the request from the confirmed material.
Do not rely on unsupported Bash subcommand frontmatter for scoping; the separation
is expressed by instructions. The `Agent(...)` type lists on the Lawspeaker/Storykeeper
document intent but are NOT enforced either — in a subagent definition the harness
ignores the parenthesized type list (listing `Agent` merely enables spawning; the
list is honored only for a main-thread `claude --agent`). What IS structural:
Lawspeaker/Storykeeper have no `Bash`, so they cannot execute commands at all.

## Verified Spawn Model

Live-tested in this harness:

| Caller | Can spawn? |
|---|---|
| Fork (`subagent_type:"fork"`) | No — a fork is a leaf, never delegates |
| Custom agent with `Agent` (or `Agent(...)`) in `tools:` | Yes — and it can address plugin types like `chronicle:watcher`; the parenthesized type list itself is ignored in subagent definitions |
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

# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`chronicle` is a new plugin in the `q-lab-marketplace` monorepo (`cc-plugins`). It crafts git commits and authors GitHub PRs / GitLab MRs. It lives at `packages/chronicle/` and ships to both the Claude and Codex marketplaces. Repo root for all absolute paths below: `/Users/funnyq/Projects/q-lab/cc-plugins`.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Scripts run as `bun path/to/script.ts`.
- **Tests**: `bun test` (Bun's built-in test runner; `import { test, expect } from "bun:test"`).
- **No external npm dependencies** — use Bun built-ins (`Bun.$`, `Bun.file`, `Bun.write`, `node:` stdlib). Vendor nothing.
- **No frontend** in chronicle — it is scripts + skill prose only.

## Code style

- Use `type` over `interface`.
- Prefer pure, exported functions (testable without side effects); keep I/O (git calls, file reads, CLI spawns) at the edges.
- Shell out to git via Bun's `$` template (`import { $ } from "bun"`), matching the ported script.
- 2-space indent, double quotes, semicolons — match existing files in `packages/relay/skills/relay/scripts/` and `packages/monitor/skills/cockpit/scripts/`.
- Authoritative source for verification only: existing scripts under `packages/relay/` and `packages/monitor/`.

## File / directory layout

A plugin package is:

```
packages/<name>/
├── .claude-plugin/plugin.json      # Claude manifest
├── .codex-plugin/plugin.json       # Codex manifest (adds "skills": "./skills/")
└── skills/<skill>/
    ├── SKILL.md                    # YAML frontmatter (name, description) + prose
    ├── scripts/*.ts                # Bun scripts + *.test.ts siblings
    └── references/*.md             # templates / docs the skill reads
```

New scripts go under `skills/<skill>/scripts/`. Tests are `<name>.test.ts` siblings. Templates/markdown the skill reads at runtime go under `skills/<skill>/references/`.

### plugin.json shape (from `packages/relay/`)

Claude manifest carries: `name`, `version`, `description`, `author: { name }`, `license`, `keywords[]`. The Codex manifest adds `"skills": "./skills/"` and an `interface` block:

```json
{
  "displayName": "Chronicle",
  "shortDescription": "...",
  "longDescription": "...",
  "developerName": "Q",
  "category": "Productivity",
  "capabilities": ["Interactive", "Write"],
  "defaultPrompt": ["...", "..."],
  "brandColor": "#RRGGBB"
}
```

### Marketplace registries (two files at repo root)

- `.claude-plugin/marketplace.json` — `plugins[]` entries are `{ name, source: "./packages/<name>", description }`.
- `.agents/plugins/marketplace.json` — `plugins[]` entries are `{ name, source: { source: "local", path: "./packages/<name>" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }`.

Neither registry carries a `version` field — versions live only in the two `plugin.json` files.

## Cockpit decision trail (read-only input for the `pr` skill)

Cockpit (in the `monitor` plugin) records a per-session decision trail that `analyze-branch.ts` harvests. **This is a SOFT dependency** — chronicle must work when cockpit is absent.

- **Home**: `~/.cockpit/` (override env: `COCKPIT_HOME`).
- **Registry**: `~/.cockpit/registry.json` — shape `{ sessions: RegistryEntry[] }` where `RegistryEntry = { provider, project, sessionId, logPath, lastHeartbeat }`. `project` is the project's cwd; `logPath` is the **source of truth** for where the jsonl lives — read it, don't reconstruct the path.
- **Logs**: project-local at `<project>/.cockpit/logs/<sessionId>.jsonl` (one JSON record per line) — but always resolve the actual file via the registry entry's `logPath`, never by rebuilding this path yourself.
- **Decision record shape** (only `type:"decision"` lines matter; first line may be a goal record — skip non-decision lines):

```ts
type DecisionRecord = {
  id: string;
  type: "decision";
  kind?: "decision" | "rationale" | "learning" | "caveat"; // default "decision"
  source?: "agent" | "scribe";                              // who wrote it
  decision: string;   // what was done
  reason: string;     // why
  tradeoff: string;   // what was given up
  facets: { label: string; text: string }[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  diagram?: string;   // optional Mermaid source (decision cards may carry a diagram)
  timestamp: string;  // ISO 8601
};
```

Map for the PR body: `reason` → **Why**, `tradeoff` + `caveat`-kind + `needs_your_call` → **What to focus**, `files` → scope.

## Commit message template format

The `commit` skill carries its **own** copy (no odin-git path). Format:

```
{emoji} {type}: {subject}

- what changed and why (English, markdown list)
- another detail

---

繁體中文摘要
```

Change types: ✨ feat · 🐛 fix · 📖 docs · 🎨 style · 📦 refactor · ✅ test · 🔧 chore · 🔥 remove · 🚑 hotfix · 🔒 security · ⚡️ perf.

Every non-trivial commit includes the body AND the 繁中 summary. Stage files by explicit name (`git add <file> ...`), never `git add -A`.

## Two-phase fork execution model (both skills)

Both skills run as **two spawned sub-agents** with a human gate between them. The main agent never reads raw diffs / `gh` output — it only passes structured data:

1. **analyze fork** — runs the analysis script, applies judgment, returns a small structured result (commit plan, or PR draft).
2. **main agent** — presents to the human; for the commit atomic branch and the PR, pauses for confirmation via the **host harness's interactive user-prompt** (on Claude Code: the `AskUserQuestion` tool; on Codex or other harnesses: the equivalent user-input/confirmation prompt). Never hard-code a Claude-only tool as the only path — chronicle ships to both marketplaces.
3. **execute fork** — performs the mutation (git commit, or `gh`/`glab` create).

Spawn forks with the Agent tool (general-purpose). Pass inputs and receive outputs as structured text/JSON in the prompt and final message — do not rely on shared file state beyond the analysis script's temp output.

## Commit & branching style

- Branch off: `develop` (this repo uses git-flow; `main` is protected).
- Commit format: the emoji template above.
- Use `/odin-git:simple-commit` or `/odin-git:atomic-commit` when committing this work (chronicle itself isn't built yet).

## Verification baseline

- Test: `bun test packages/chronicle/skills/<skill>/scripts/`
- Run a script: `bun packages/chronicle/skills/<skill>/scripts/<name>.ts`
- JSON parse check: `bun -e 'JSON.parse(await Bun.file("<path>").text())'`
- Dev server: none (chronicle has no server).

## Decisions frozen during interview

- **Independent version** — chronicle starts at `0.1.0`, its own cadence (like relay), NOT lockstep with monitor/dispatch.
- **Zero odin-git dependency** — port logic, carry own template; never read an odin-git path at runtime.
- **Scripts do mechanics, agents do judgment** — keep classification/synthesis in the fork agent, not the script.
- **Provider flows through the payload** — `analyze-branch.ts` detects github/gitlab; `request-creator.ts` receives it, does not re-detect.
- **Soft cockpit dependency** — absent cockpit ⇒ silent fallback to commits+diff.

# PR-01: analyze-branch script

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: pr/03
> **Status**: todo

## Goal

Build the `analyze-branch.ts` script that gathers everything the PR/MR author needs as one structured JSON payload: the git host/provider, the branch's commits + diff summary since its base, and the cockpit decisions made during the branch's life (soft, optional).

## Files to create / modify

- `packages/chronicle/skills/pr/scripts/analyze-branch.ts` (new) — the material gatherer.
- `packages/chronicle/skills/pr/scripts/analyze-branch.test.ts` (new) — unit tests for the pure functions.

## Implementation notes

The CLI gathers data and prints the payload (write the big version to a temp file under `/tmp/chronicle/pr/` and print `{ outputPath, provider, hasCockpit, commitCount }`, mirroring the commit script's pattern). The agent synthesizes prose later — this script only collects.

### Output payload

```ts
type Provider = "github" | "gitlab" | "unknown";

type BranchMaterial = {
  provider: Provider;
  remoteUrl: string | null;
  base: string;          // resolved base branch (e.g. "develop" or "main")
  head: string;          // current branch
  mergeBase: string;     // sha
  commits: { sha: string; subject: string; body: string }[]; // base..HEAD
  diffStat: string;      // `git diff --stat base...HEAD`
  decisions: DecisionRecord[]; // cockpit, possibly empty
};
```

### Pure functions to export + test

```ts
// Parse a git remote URL into a provider. Handle ssh + https forms.
//   git@github.com:org/repo.git → "github"
//   https://gitlab.com/org/repo.git → "gitlab"
//   self-hosted gitlab (host contains "gitlab") → "gitlab"; unknown host → "unknown"
export function detectProvider(remoteUrl: string | null): Provider

// Match a cockpit registry entry's `project` path to the current repo root.
// Normalize trailing slashes; compare resolved absolute paths.
export function projectMatches(entryProject: string, repoRoot: string): boolean

// Scope cockpit decisions to THIS branch's life. Two filters, ANDed:
//  1. time: record.timestamp >= sinceISO (the branch's FIRST commit time, not the
//     merge-base time — an old base must not sweep in unrelated later decisions).
//  2. files: record.files intersects the branch's changedFiles. A record with an
//     empty files[] passes on the time filter alone (can't be file-scoped).
export function branchDecisions(
  records: DecisionRecord[],
  changedFiles: string[],
  sinceISO: string,
): DecisionRecord[]
```

`DecisionRecord` shape is in `../_context/shared.md` (cockpit section). Reuse it; do not invent a new shape.

### Git gathering (impure, at the edges)

- Base resolution: try the repo's default branch via `git symbolic-ref refs/remotes/origin/HEAD` → strip to branch name; fall back to `develop`, then `main`. Allow a `--base <branch>` override flag.
- `mergeBase = git merge-base <base> HEAD`.
- `commits = git log <mergeBase>..HEAD` parsed into `{sha, subject, body}`.
- `diffStat = git diff --stat <mergeBase>..HEAD`.
- `head = git rev-parse --abbrev-ref HEAD`.
- `remoteUrl = git remote get-url origin` (null if no remote).
- `branchStartISO = git log --reverse --format=%cI <mergeBase>..HEAD` → first line (the branch's OLDEST commit time). This — not the merge-base time — is the lower bound for cockpit decisions, so a months-old base doesn't pull in unrelated decisions. If there are no commits, skip the harvest.
- `changedFiles = git diff --name-only <mergeBase>..HEAD` → string[] (used to file-scope decisions).

### Cockpit harvest (SOFT — never throw on absence)

1. Resolve `COCKPIT_HOME` (env or `~/.cockpit`). If `registry.json` is missing → `decisions: []`, `hasCockpit: false`. No error.
2. Read registry, filter `sessions[]` by `projectMatches(entry.project, repoRoot)`.
3. For each matching entry, read its `logPath` jsonl; parse each line, keep `type === "decision"` records (skip the goal record + unparseable lines).
4. Merge across sessions, then scope with `branchDecisions(all, changedFiles, branchStartISO)` — time-bound to the branch's first commit AND file-scoped to the branch's changed files (records with empty `files[]` pass on time alone).
5. De-dup by `id`. Sort by `timestamp`.

Any read/parse failure inside the harvest degrades to "no decisions", never aborts the script.

### Tests

- `detectProvider`: ssh github, https github, https gitlab, self-hosted `gitlab.acme.com`, `null` → unknown, bitbucket host → unknown.
- `projectMatches`: exact, trailing-slash mismatch, different path → false.
- `branchDecisions`: records straddling the time cutoff keep only `>=` (equal timestamp kept); a record whose `files` overlaps `changedFiles` is kept, one that doesn't is dropped, and a record with empty `files[]` passes on time alone; empty input → empty.

## Acceptance criteria

- [ ] Script exists; imports only Bun built-ins + `node:` stdlib.
- [ ] The three pure functions are exported and behave per spec.
- [ ] A `--base <branch>` flag overrides the auto-resolved base, and that override flows into `merge-base`, commits, diffStat, `branchStartISO`, and `changedFiles` (not just one of them).
- [ ] Provider detection covers github + gitlab (incl. self-hosted) over ssh and https.
- [ ] With no remote, `provider: "unknown"`, `remoteUrl: null`, and the script still emits commits + diffStat.
- [ ] With cockpit absent or `registry.json` missing, `hasCockpit: false`, `decisions: []`, exit 0, no thrown error.
- [ ] Decisions are scoped to the branch: time-bound to the branch's **first commit** time AND file-scoped to the branch's changed files (empty-`files` records pass on time alone), merged across sessions, de-duped by `id`.
- [ ] CLI prints `{ outputPath, provider, hasCockpit, commitCount }`; the temp file parses as a `BranchMaterial`.

## Verification

- [ ] `bun test packages/chronicle/skills/pr/scripts/analyze-branch.test.ts` is green.
- [ ] On a real feature branch: `bun packages/chronicle/skills/pr/scripts/analyze-branch.ts` prints the four-key JSON; the temp file has non-empty `commits[]`.
- [ ] `analyze-branch.ts --base <other-branch>` recomputes `base`, `mergeBase`, `commits`, `diffStat`, and `changedFiles` against that branch (verify `base` in the payload changed and the commit set differs from the default-base run).
- [ ] Temporarily point `COCKPIT_HOME` at an empty dir → still exit 0 with `hasCockpit:false`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | wrong base/merge-base, or cockpit absence throws | gathers data but provider or time-filter wrong on an edge | correct base resolution, provider detection, soft harvest, time-filter, de-dup |
| Test coverage | ×2 | no tests | one function | all three pure fns + ssh/https/self-host + cutoff edges |
| Interface & readability | ×1 | I/O tangled into logic | usable but impure fns untested | pure fns isolated + exported, git/fs at edges |
| Assumptions & docs | ×1 | base-branch guess unexplained | partial | base fallback chain + soft-fail policy documented |

## Out of scope

- Synthesizing the PR body — Deferred. The pr skill's analyze fork turns this payload into prose.
- Creating the PR/MR — Deferred. The request-creator script does that.

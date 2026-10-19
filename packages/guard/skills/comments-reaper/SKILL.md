---
name: comments-reaper
description: >-
  Scan code comments with a fresh-eyes reviewer subagent and delete the ones
  that restate the code. Takes files or directories; with none, scans the
  changes since HEAD, untracked files included.
argument-hint: "[path ...]"
disable-model-invocation: true
---

# Comments Reaper

Spawn one reviewer that did not write the comments. Act on the verdicts it returns.

## Steps

1. Scan from the current directory. `{SKILL_DIR}` is this skill's base directory, written as a literal absolute path. OpenCode prints no base directory, so use `~/.config/opencode/skills/comments-reaper` there:

   ```bash
   bun "{SKILL_DIR}/scripts/scan.ts" [path ...]
   ```

   Pass the user's paths through unchanged. With no paths, the scan covers the changes since HEAD.
   - On `no comments`, say so and stop.
   - On `refused`, relay the line and stop. Never split the scope yourself.
   - Otherwise, the scan prints a summary and a `report <path>` line.
2. Spawn exactly one agent with `subagent_type: "guard:comments-reaper"`. Give it the report path, never the report text: `Read the report at <path> and judge every line marked +. Paths in it are relative to the repository root, <root>.`
   - If that agent type is missing, spawn one generic agent. Tell it to read `{SKILL_DIR}/../../agents/comments-reaper.md` and obey everything below its frontmatter, then give it the same task.
3. Audit each verdict before acting on it. Reject a verdict that misreads the code or names a line outside the report.
   - Delete the accepted `DELETE` lines.
   - For a `MUST KILL`, make the fix when it is small and stays inside the scanned files, then delete the comment. Otherwise, list it for the user and leave the code.
   - Leave `KEEP` lines alone.
   - On `CLEAN`, change nothing.
4. Report the counts of deleted, fixed, rejected, and open lines in one line, then list each open `MUST KILL`.

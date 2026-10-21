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

Spawn reviewers that did not write the comments. Act on the verdicts they return. The goal is fewer comments: a claim a test, type, lint rule or assertion can check moves there, and the comment goes.

## Steps

1. Scan from the current directory. `{SKILL_DIR}` is this skill's base directory, written as a literal absolute path. OpenCode prints no base directory, so use `~/.config/opencode/skills/comments-reaper` there:

   ```bash
   bun "{SKILL_DIR}/scripts/scan.ts" [path ...]
   ```

   Pass the user's paths through unchanged. With no paths, the scan covers the changes since HEAD.
   - On `no comments`, say so and stop.
   - On `refused`, relay the line and stop. Never split the scope yourself; `scan.ts` alone splits it.
   - Otherwise, the scan prints a summary and one `report <path> verdicts <path>` line per shard. A file and its test always share a shard.
2. Spawn one agent per report, all in one message, with `subagent_type: "guard:comments-reaper"`. Give each its two paths, never the report text: `Read the report at <report> and judge every line marked +. Write your verdicts to <verdicts>. Paths in the report are relative to the repository root, <root>.`
   - If that agent type is missing, spawn generic agents instead. Tell each to read `{SKILL_DIR}/../../agents/comments-reaper.md` and obey everything below its frontmatter, then give it the same task.
   - A reviewer that fails or writes no verdicts file gets one respawn with the same task. Never retype its verdicts yourself.
3. Act on the verdicts. With one report, read its verdicts file and audit it yourself as below. With several, spawn one generic agent per verdicts file, all in one message, with `model: "opus"` and `effort: "low"`. Tell each to read `{SKILL_DIR}/SKILL.md` and follow steps 3 and 4 for one report, to edit only the files its report names and their tests, and never to stash or commit; give it the report and verdicts paths. Shards never share a file, so the agents never collide.

   Audit each verdict against the code before acting on it. Reject a verdict that misreads the code or names a line outside its report. Reject a `DELETE` of history or a rejected alternative a reader would otherwise retry.
   - Delete the accepted `DELETE` lines. A `DELETE` justified by a test must leave the comment's why in that test's title; rename the test first when it does not.
   - For a `MUST KILL` naming a `test`, `type`, `lint` or `assert`, write it in the report's files or their tests, then delete the comment. A test file counts even when the scan did not list it. Break the rule and watch the new check fail before you restore it; when it cannot fail, list the verdict as open.
   - For a `MUST KILL` naming a `rename` or `extract`, grep every caller first. Apply it and delete the comment when every caller sits in the report's files; otherwise list it as open.
   - List as open, and leave the code, a `MUST KILL` whose fix changes runtime behaviour: a comment shown false that only a code change would make true, or a removed suppression that surfaces a real type or lint error. Delete a comment shown false when the code is right.
   - Leave `KEEP` lines alone.
   - On `CLEAN`, change nothing.
4. Run the tests and the typecheck for the files you changed.
5. On OpenCode, run steps 1 to 4 once more over the files step 3 changed, then list every `MUST KILL` of that round as open. Skip this on Claude Code, where guard's turn-end reviewer already judges the comments this run added.
6. Report the counts of deleted, fixed, rejected, and open lines in one line, then list each open `MUST KILL`.

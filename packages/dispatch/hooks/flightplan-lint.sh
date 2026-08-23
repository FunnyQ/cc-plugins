#!/bin/bash

# Auto-lint flightplan task files after Write/Edit.
#
# Input (stdin): JSON with tool_input.file_path
# Output: silent unless the file is a flightplan task with violations.
# Exit codes:
#   0 = ok / not a flightplan file / hook short-circuited
#   2 = violations found (PostToolUse exit 2 + stderr surfaces feedback to the LLM)
#
# Scope: this hook is plugin-wide, but two filters narrow it to flightplan tasks:
#   1. Path matches docs/<slug>/tasks/<bucket>/NN-*.md
#   2. File carries the Required-reading header, in either supported form:
#        > **Required reading**:
#        > **Required reading** (read before starting; ...):
# Either check failing → silent exit 0, no false positives on unrelated files.

set -e

input=$(cat)

# 0. Cheap bash prefilter before spawning jq. This hook runs on EVERY Edit/Write,
# and the path filter below rejects almost all of them — so the ~5ms jq spawn is
# pure waste on that majority. Match the bare word `tasks`, not `/tasks/`: JSON
# may escape the slash as `\/`, and matching the escaped form would silently
# skip the lint on such a payload.
case "$input" in
  *tasks*) ;;
  *) exit 0 ;;
esac

file_path=$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null || echo "")

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
  exit 0
fi

# 1. Path filter — looks like a flightplan task file path
if ! [[ "$file_path" =~ (^|/)docs/.+/tasks/[a-z][a-z0-9]*/[0-9]{2}-.+\.md$ ]]; then
  exit 0
fi

# 2. Content sniff — file has the flightplan header marker.
# Accepts the current scaffolded header (an annotation in parentheses before the
# colon) and the legacy bare-colon header. The `**` immediately after the label
# keeps near misses such as `**Required reading later**:` out.
if ! grep -Eq '^> \*\*Required reading\*\*([[:space:]]*\([^)]*\))?[[:space:]]*:' "$file_path" 2>/dev/null; then
  exit 0
fi

# Resolve lint script via CLAUDE_PLUGIN_ROOT (set by Claude Code) with a
# best-effort fallback for direct invocation / tests.
lint_script="${CLAUDE_PLUGIN_ROOT:-}/skills/flightplan/scripts/lint-task.ts"
if [ ! -f "$lint_script" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  lint_script="$here/../skills/flightplan/scripts/lint-task.ts"
fi

if [ ! -f "$lint_script" ]; then
  # Hook can't find the linter — fail open rather than blocking the write.
  exit 0
fi

if output=$(bun "$lint_script" "$file_path" 2>&1); then
  exit 0
fi

# Violations: surface as feedback to the LLM via stderr + exit 2.
echo "flightplan lint violations in $file_path:" >&2
echo "$output" >&2
exit 2

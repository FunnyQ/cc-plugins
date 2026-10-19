#!/bin/bash

# Input (stdin): JSON with tool_input.file_path
# Output: silent unless the file is a flightplan task with violations.
# Exit codes:
#   0 = ok / not a flightplan file / hook short-circuited
#   2 = violations found (PostToolUse exit 2 + stderr surfaces feedback to the LLM)

set -e

input=$(cat)

case "$input" in
  *tasks*) ;;
  *) exit 0 ;;
esac

file_path=$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null || echo "")

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
  exit 0
fi

if ! [[ "$file_path" =~ (^|/)docs/.+/tasks/[a-z][a-z0-9]*/[0-9]{2}-.+\.md$ ]]; then
  exit 0
fi

lint_script="${CLAUDE_PLUGIN_ROOT:-}/skills/flightplan/scripts/lint-task.ts"
if [ ! -f "$lint_script" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  lint_script="$here/../skills/flightplan/scripts/lint-task.ts"
fi

if [ ! -f "$lint_script" ]; then
  exit 0
fi

if output=$(bun "$lint_script" --authoring "$file_path" 2>&1); then
  exit 0
fi

echo "flightplan lint violations in $file_path:" >&2
echo "$output" >&2
exit 2

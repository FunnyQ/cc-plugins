#!/bin/bash
# PreToolUse hook: block git commit on protected branches in git-flow repos.
# Reads Bash tool_input from stdin, checks if command is a git commit,
# then verifies branch safety for git-flow repos.

set -euo pipefail

input=$(cat)
# Fail open if jq is missing or the payload isn't parseable — a branch guard must
# never break every Bash command just because jq isn't installed.
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

# Only care about git commit commands
if [[ ! "$command" =~ git[[:space:]]+commit ]]; then
  exit 0
fi

# Check if repo uses git-flow
develop_branch=$(git config --get gitflow.branch.develop 2>/dev/null || true)
if [ -z "$develop_branch" ]; then
  exit 0
fi

# Protect the git-flow production branch. It's configurable (gitflow.branch.master),
# so read it; fall back to the literal main/master for repos that don't set it.
prod_branch=$(git config --get gitflow.branch.master 2>/dev/null || true)
branch=$(git branch --show-current 2>/dev/null || true)
if [[ -n "$prod_branch" && "$branch" == "$prod_branch" ]] || [[ "$branch" == "main" || "$branch" == "master" ]]; then
  cat <<EOF
{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"⚠️ You're on \`$branch\` in a git-flow repo. Commits should go to \`$develop_branch\`. Use AskUserQuestion to confirm with the user before retrying."}
EOF
  exit 0
fi

exit 0

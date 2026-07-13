#!/bin/bash
# PreToolUse hook: ask before git commits on configured protected branches.
# `.chronicle/pr.json` is authoritative; local git-flow config is a legacy fallback.

set -euo pipefail

input=$(cat)
# Fail open if jq is missing or the payload isn't parseable — a branch guard must
# never break every Bash command just because jq isn't installed.
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

# Only care about git commit commands
if [[ ! "$command" =~ git[[:space:]]+commit ]]; then
  exit 0
fi

branch=$(git branch --show-current 2>/dev/null || true)
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
pr_config="$repo_root/.chronicle/pr.json"

if [[ -n "$repo_root" && -f "$pr_config" ]] && command -v jq >/dev/null 2>&1; then
  workflow=$(jq -r '.workflow // empty' "$pr_config" 2>/dev/null || true)
  if [[ "$workflow" == "github-flow" ]]; then
    protected_branch=$(jq -r '.base // empty' "$pr_config" 2>/dev/null || true)
    if [[ -n "$protected_branch" && "$branch" == "$protected_branch" ]]; then
      cat <<EOF
{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"⚠️ You're on \`$branch\`, the configured GitHub Flow PR base. Commit from a topic branch, or confirm explicitly before retrying."}
EOF
    fi
    exit 0
  fi

  if [[ "$workflow" == "git-flow" ]]; then
    prod_branch=$(jq -r '.production // empty' "$pr_config" 2>/dev/null || true)
    develop_branch=$(jq -r '.development // empty' "$pr_config" 2>/dev/null || true)
    if [[ -n "$prod_branch" && "$branch" == "$prod_branch" ]]; then
      cat <<EOF
{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"⚠️ You're on \`$branch\`, the configured Git Flow production branch. Commit on \`$develop_branch\`, or confirm explicitly before retrying."}
EOF
    fi
    exit 0
  fi
fi

# Backward compatibility for repos that still use local git-flow config.
develop_branch=$(git config --get gitflow.branch.develop 2>/dev/null || true)
if [ -z "$develop_branch" ]; then
  exit 0
fi

prod_branch=$(git config --get gitflow.branch.master 2>/dev/null || true)
if [[ -n "$prod_branch" && "$branch" == "$prod_branch" ]] || [[ "$branch" == "main" || "$branch" == "master" ]]; then
  cat <<EOF
{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"⚠️ You're on \`$branch\` in a git-flow repo. Commits should go to \`$develop_branch\`. Use AskUserQuestion to confirm with the user before retrying."}
EOF
  exit 0
fi

exit 0

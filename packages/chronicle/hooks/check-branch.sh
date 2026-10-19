#!/bin/bash

set -euo pipefail

input=$(cat)
if [[ "$input" != *commit* ]]; then
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

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
      if [[ "$command" == *"🔧 release:"* ]]; then
        exit 0
      fi
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

develop_branch=$(git config --get gitflow.branch.develop 2>/dev/null || true)
if [ -z "$develop_branch" ]; then
  exit 0
fi

prod_branch=$(git config --get gitflow.branch.master 2>/dev/null || true)
if [[ -n "$prod_branch" && "$branch" == "$prod_branch" ]] || [[ "$branch" == "main" || "$branch" == "master" ]]; then
  cat <<EOF
{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"⚠️ You're on \`$branch\` in a git-flow repo. Commit on \`$develop_branch\`, or confirm explicitly before retrying."}
EOF
  exit 0
fi

exit 0

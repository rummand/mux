#!/bin/sh
# Run on the Mac under the same account as com.mux.opencode.
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "Run this on the Mac that hosts OpenCode." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI with brew install gh and run this script again." >&2
  exit 1
fi

# Persist host credentials so launchd sessions can use GitHub without shell exports.
unset GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR XDG_CONFIG_HOME
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  gh auth login --hostname github.com --git-protocol https --web
fi

account=$(gh api --hostname github.com user --jq .login)
if [ "$account" != rummand ]; then
  echo "Active GitHub account is $account. Switch to rummand using gh auth switch and retry." >&2
  exit 1
fi

gh auth setup-git --hostname github.com
gh repo list rummand --limit 3 --json nameWithOwner --jq '.[].nameWithOwner'
echo "GitHub authentication is configured for OpenCode on this Mac."

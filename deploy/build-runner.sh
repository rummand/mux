#!/usr/bin/env bash
# A GitHub Actions runner on this Mac, owned by mux (owner, 2026-11-25: "mux takes over all responsibility for the build
# server"). mux finds every runner from its LaunchAgent, watches it, restarts it when it stops, and shows it on Services →
# Build server (server/src/build.ts). Safe to run again: it replaces the runner of the same name.
#   ./deploy/build-runner.sh <owner/repo> [name] [labels]   install and start (labels default "macOS,<repo>")
#   ./deploy/build-runner.sh --remove <owner/repo> [name]   stop, unregister and remove the LaunchAgent (keeps the folder)
# Run it as the user who owns the builds (not root), with `gh` logged in with admin rights on the repository.
# Node: a repository whose CI needs Node 24 gets it without touching the Node mux runs on (/opt/homebrew/bin/node, 22):
# if Homebrew's node@24 is installed it goes first on the runner's PATH (.path holds the bare PATH, no "PATH=").
set -euo pipefail
die() { echo "✗ $*" >&2; exit 1; }
[[ "$(uname -s)" == "Darwin" ]] || die "this is for the Mac Studio (macOS)"
[[ "$(id -u)" != "0" ]] || die "run it as your own user, not root"
command -v gh >/dev/null || die "gh is missing: brew install gh && gh auth login"

REMOVE=""; [[ "${1:-}" == "--remove" ]] && { REMOVE=1; shift; }
REPO="${1:?usage: build-runner.sh [--remove] <owner/repo> [name] [labels]}"
SHORT="${REPO#*/}"
NAME="${2:-macstudio-$SHORT}"
LABELS="${3:-macOS,$SHORT}"
# The repository's folder, unless it already holds a runner of another name (a second runner for the same repository).
DIR="$HOME/actions-runners/$SHORT"
if [[ -f "$DIR/.runner" ]] && ! python3 -c 'import json,sys; sys.exit(json.loads(open(sys.argv[1],encoding="utf-8-sig").read())["agentName"]!=sys.argv[2])' "$DIR/.runner" "$NAME"; then
  DIR="$HOME/actions-runners/$SHORT-$NAME"
fi

if [[ -n "$REMOVE" ]]; then
  cd "$DIR" || die "no runner in $DIR"
  ./svc.sh stop || true
  ./svc.sh uninstall || true
  ./config.sh remove --token "$(gh api -X POST "repos/$REPO/actions/runners/remove-token" --jq .token)"
  echo "✓ removed $NAME from $REPO (the folder $DIR is kept; delete it if you like)"
  exit 0
fi

command -v git >/dev/null || die "git is missing: xcode-select --install"
NODE24=/opt/homebrew/opt/node@24/bin
PATH_FOR_RUNNER="$PATH"
[[ -x "$NODE24/node" ]] && PATH_FOR_RUNNER="$NODE24:$PATH"

echo "→ runner for $REPO: $NAME ($LABELS) in $DIR"
mkdir -p "$DIR"; cd "$DIR"
if [[ ! -x ./config.sh ]]; then
  # The latest release, checked against the digest GitHub publishes for the asset.
  REL=$(gh api repos/actions/runner/releases/latest)
  VERSION=$(echo "$REL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')
  ASSET="actions-runner-osx-$([[ "$(uname -m)" == arm64 ]] && echo arm64 || echo x64)-$VERSION.tar.gz"
  SHA=$(echo "$REL" | python3 -c 'import json,sys; a=[x for x in json.load(sys.stdin)["assets"] if x["name"]==sys.argv[1]]; print((a[0].get("digest") or "").removeprefix("sha256:") if a else "")' "$ASSET")
  echo "→ downloading $ASSET"
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v$VERSION/$ASSET"
  if [[ -n "$SHA" ]]; then [[ "$(shasum -a 256 runner.tar.gz | cut -d' ' -f1)" == "$SHA" ]] || { rm -f runner.tar.gz; die "SHA-256 does not match GitHub's digest"; }; echo "✓ SHA-256 matches"; fi
  tar xzf runner.tar.gz && rm runner.tar.gz
fi

TOKEN=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
./config.sh --unattended --replace --url "https://github.com/$REPO" --token "$TOKEN" --name "$NAME" --labels "$LABELS" --work _work
echo "$PATH_FOR_RUNNER" > .path
./svc.sh install >/dev/null
# Like every runner here: launchd restarts it if it stops, and it runs at background priority so the models come first.
PLIST="$HOME/Library/LaunchAgents/actions.runner.${REPO/\//-}.$NAME.plist"
for kv in "KeepAlive bool true" "ProcessType string Background" "Nice integer 10" "LowPriorityIO bool true"; do
  set -- $kv
  /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$PLIST"
done
./svc.sh start >/dev/null
echo "✓ $NAME serves $REPO (labels self-hosted,$LABELS), Node $(PATH="$PATH_FOR_RUNNER" node -v 2>/dev/null || echo none)"
echo "  mux shows it on Services → Build server within a minute; GitHub: https://github.com/$REPO/settings/actions/runners"

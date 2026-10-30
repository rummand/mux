#!/bin/sh
# mux under launchd (com.mux.server): the settings in ~/.mux/mux.env, then the server. install.sh writes both.
set -eu
set -a; . "$HOME/.mux/mux.env"; set +a
cd "$(dirname "$0")/../server"
exec /opt/homebrew/bin/node dist/index.js

#!/bin/sh
# Installs the plugin into a local OpenCode by pointing its plugins directory at this checkout.
# It refuses while the earlier agent-mail plugin is installed: both bind the Claude Code peer "opencode".
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
if [ -d "$CONFIG/plugins/agent-mail" ]; then
  echo "agent-mail is installed in $CONFIG/plugins. Move it away first (it binds the same Claude Code peer), then run this again." >&2
  exit 1
fi
mkdir -p "$CONFIG/plugins/coordination"
printf 'export { default } from "%s/src/index.ts"\n' "$REPO" > "$CONFIG/plugins/coordination/index.ts"
echo "installed: $CONFIG/plugins/coordination/index.ts -> $REPO/src/index.ts"
echo "next: import your earlier history with: node $REPO/src/cli/main.ts import-agent-mail"

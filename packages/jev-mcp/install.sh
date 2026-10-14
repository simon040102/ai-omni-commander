#!/usr/bin/env bash
# Jev MCP installer for Claude Code (macOS / Linux).
# Usage: bash install.sh [api-key]   (or set TYPESAFE_API_KEY; otherwise you will be prompted)
# Optional env: JEV_MCP_NAME (default jev), JEV_MCP_DIR (default ~/.jev-mcp)
set -euo pipefail

NAME="${JEV_MCP_NAME:-jev}"
DIR="${JEV_MCP_DIR:-$HOME/.jev-mcp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail() { echo; echo "[FAILED] $1" >&2; exit 1; }

echo "=== Jev MCP installer ==="
command -v node >/dev/null || fail "Node.js not found. Install Node.js 20+ from https://nodejs.org"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $NODE_MAJOR found; version 20 or later is required."
echo "[ok] Node.js major version $NODE_MAJOR"
command -v claude >/dev/null || fail "Claude Code CLI (claude) not found in PATH."
echo "[ok] Claude Code CLI found"

KEY="${1:-${TYPESAFE_API_KEY:-}}"
if [ -z "$KEY" ]; then
  echo; read -rsp "TypeSafe API key (https://console.typesafe.ai, input hidden): " KEY; echo
fi
[ -n "$KEY" ] || fail "No API key given."

[ -f "$HERE/jev-mcp.mjs" ] || fail "jev-mcp.mjs not found next to this script."
mkdir -p "$DIR"
cp -f "$HERE/jev-mcp.mjs" "$DIR/jev-mcp.mjs"
echo "[ok] Installed to $DIR/jev-mcp.mjs"

if ! CHECK="$(TYPESAFE_API_KEY="$KEY" node "$DIR/jev-mcp.mjs" --check)"; then fail "API key check failed: $CHECK"; fi
echo "[ok] $CHECK"

claude mcp remove "$NAME" -s user >/dev/null 2>&1 || true
claude mcp add --scope user "$NAME" -e "TYPESAFE_API_KEY=$KEY" -- node "$DIR/jev-mcp.mjs" || fail "claude mcp add failed."

echo
echo "[DONE] Jev MCP '$NAME' is registered. Open a NEW Claude Code session to use jev_classify."
echo "       Remove later with: claude mcp remove $NAME -s user"

#!/usr/bin/env bash
# Install (or refresh) Teach for this user from a git checkout. Safe to re-run. Needs Node 22.5+ and Claude Code.
# It checks Node, then hands over to `teach setup` (lib/setup.mjs), which does the same on macOS and Windows.
#
#   ./install.sh               the `teach` command, the teach skill for Claude Code, and a service that keeps the
#                              server running (systemd user service on Linux, launchd agent on macOS)
#   ./install.sh --no-service  everything but the service (start it yourself: teach serve)
#   ./install.sh --demo        also copy the demo topics into an empty learning folder
#   ./install.sh --no-skill    leave ~/.claude/skills/teach alone (you manage skills another way)
#
# Settings go in ~/.config/teach/env (KEY=VALUE, see README.md); the service reads it, and so does `teach`.
set -euo pipefail
app=$(cd "$(dirname "$0")" && pwd)
case " $* " in *" -h "*|*" --help "*) sed -n '2,11p' "$0"; exit 0 ;; esac
node=$(command -v node || true)
[[ -n $node ]] || { echo "install.sh: Node.js 22.5 or newer is required (https://nodejs.org)" >&2; exit 1; }
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "install.sh: Node $("$node" --version) is too old; Teach needs 22.5 or newer" >&2; exit 1; }
exec "$node" "$app/cli.mjs" setup "$@"

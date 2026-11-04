#!/usr/bin/env bash
# Install (or refresh) Teach for this user. Safe to re-run. Needs Linux, Node 22.5+, and Claude Code (`claude`).
#
#   ./install.sh               the `teach` command, the teach skill for Claude Code, and a systemd user service
#   ./install.sh --no-service  everything but the service (start it yourself: node server.mjs)
#   ./install.sh --demo        also copy the demo topics into an empty learning folder
#   ./install.sh --no-skill    leave ~/.claude/skills/teach alone (you manage skills another way)
#
# Settings go in ~/.config/teach/env (KEY=VALUE, see README.md); the service reads it, and so does `teach`.
set -euo pipefail
app=$(cd "$(dirname "$0")" && pwd)
service=1 demo=0 skill=1
for a in "$@"; do
  case $a in
    --no-service) service=0 ;;
    --demo) demo=1 ;;
    --no-skill) skill=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $a" >&2; exit 2 ;;
  esac
done

node=$(command -v node || true)
[[ -n $node ]] || { echo "install.sh: Node.js 22.5 or newer is required (https://nodejs.org)" >&2; exit 1; }
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "install.sh: Node $("$node" --version) is too old; Teach needs 22.5 or newer" >&2; exit 1; }
command -v claude >/dev/null || [[ -x ~/.local/bin/claude ]] \
  || echo "install.sh: warning: Claude Code isn't installed (npm install -g @anthropic-ai/claude-code); tutors need it" >&2

conf=${TEACH_CONFIG:-$HOME/.config/teach/env}
setting() {   # setting KEY DEFAULT: the value in the env file, else the environment, else DEFAULT
  local v
  v=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?$1[[:space:]]*=[[:space:]]*//p" "$conf" 2>/dev/null | tail -1 | sed 's/^["'"'"']\(.*\)["'"'"']$/\1/')
  v=${v:-${!1:-$2}}
  v=${v/#\~/$HOME}; v=${v//\$HOME/$HOME}; v=${v//%h/$HOME}
  printf '%s' "$v"
}
data=$(setting TEACH_DATA "${XDG_DATA_HOME:-$HOME/.local/share}/teach")

mkdir -p ~/.local/bin "$data/topics" "$(dirname "$conf")"
ln -sfn "$app/cli.mjs" ~/.local/bin/teach
echo "teach: command -> $app/cli.mjs"
if ((demo)); then
  [[ -f $data/PROFILE.md ]] || cp "$app/examples/demo/PROFILE.md" "$data/PROFILE.md"
  if [[ -z $(ls -A "$data/topics") ]]; then cp -r "$app/examples/demo/topics/." "$data/topics/"; echo "teach: demo topics copied to $data/topics"
  else echo "teach: $data/topics isn't empty; demo topics not copied"; fi
fi
[[ -f $data/PROFILE.md ]] || { cp "$app/examples/PROFILE.template.md" "$data/PROFILE.md"; echo "teach: fill in your profile: $data/PROFILE.md (or in the app: Profile)"; }

if ((skill)); then
  mkdir -p ~/.claude/skills
  dst=~/.claude/skills/teach
  if [[ -L $dst || ! -e $dst ]]; then ln -sfn "$app/skill" "$dst"; echo "teach: skill -> $app/skill"
  else echo "teach: $dst exists and isn't a link; left it (remove it, or use --no-skill)" >&2; fi
fi

if ((service)) && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/teach.service <<EOF
[Unit]
Description=Teach - a one-to-one tutor on Claude Code ($app)
After=network-online.target

[Service]
ExecStart=$node $app/server.mjs
EnvironmentFile=-%h/.config/teach/env
Environment=PATH=%h/.local/bin:$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now teach.service >/dev/null
  systemctl --user restart teach.service
  echo "teach: service teach.service running (logs: journalctl --user -u teach -f)"
elif ((service)); then
  echo "teach: no systemd user session here; start it with: node $app/server.mjs" >&2
fi
echo "teach: open $(TEACH_CONFIG=$conf "$node" "$app/cli.mjs" url)"

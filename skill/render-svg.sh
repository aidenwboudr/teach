#!/usr/bin/env bash
# render-svg.sh IN.svg [OUT.png] — rasterize an SVG with headless Chrome so a
# diagram can be looked at (Read the PNG) before it is shown to the learner.
# --no-sandbox: Chrome's own sandbox aborts inside agent sandboxes; input is a local file.
# Size comes from the SVG's width/height or viewBox; scaled 2x for sharpness.
set -euo pipefail
in=$(realpath "$1"); out=${2:-${in%.svg}.png}
read -r w h < <(python3 - "$in" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
tag = re.search(r'<svg\b[^>]*>', s, re.S).group(0)
def attr(n):
    m = re.search(rf'\b{n}="([\d.]+)(px)?"', tag)
    return float(m.group(1)) if m else None
w, h = attr('width'), attr('height')
if not (w and h):
    vb = re.search(r'viewBox="([^"]+)"', tag)
    _, _, w, h = map(float, re.split(r'[\s,]+', vb.group(1).strip())) if vb else (0, 0, 800, 600)
print(int(w), int(h))
EOF
)
chrome=$(command -v google-chrome || command -v chromium || command -v chromium-browser)
html=$(mktemp --suffix=.html)
trap 'rm -f "$html"' EXIT
printf '<html><body style="margin:0;background:#fff"><img src="file://%s" style="width:%spx;height:%spx;display:block"></body></html>' "$in" "$w" "$h" > "$html"
"$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=2 --window-size="$w,$h" --screenshot="$out" "file://$html" >/dev/null 2>&1
echo "$out"

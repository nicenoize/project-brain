#!/bin/zsh
# The ten-second demo as MP4 and GIF, rendered from the app's own views and a
# fixed script (DemoRenderer.swift) — no screen capture.
#
#   companion/scripts/demo.sh          → companion/build/leanlamp-demo.mp4 + .gif
set -euo pipefail
HERE=${0:A:h}
PKG=${HERE:h}
OUT=$PKG/build
FRAMES=$OUT/demo-frames
command -v ffmpeg >/dev/null || { echo "ffmpeg is needed (brew install ffmpeg)"; exit 1; }
cd "$PKG"
swift build --product leanlamp 2>&1 | grep -vE "xcrun: error: unable to lookup item 'PlatformPath'" | tail -1
rm -rf "$FRAMES"
"$(swift build --show-bin-path 2>/dev/null)/leanlamp" --render-demo "$FRAMES" 2>&1 | grep -v IMK
ffmpeg -y -loglevel error -framerate 30 -i "$FRAMES/frame-%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "$OUT/leanlamp-demo.mp4"
ffmpeg -y -loglevel error -framerate 30 -i "$FRAMES/frame-%04d.png" -vf "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" "$OUT/leanlamp-demo.gif"
ls -la "$OUT/leanlamp-demo.mp4" "$OUT/leanlamp-demo.gif" | awk '{print $5, $9}'

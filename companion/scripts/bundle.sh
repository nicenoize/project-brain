#!/bin/zsh
# Build Leanlamp.app: release binary, fonts, icon, Info.plist (menu-bar app,
# no Dock icon), ad-hoc signature. The engine path of this checkout is written
# into Info.plist, so the app finds `brain-companion.mjs` wherever it lives.
#
#   companion/scripts/bundle.sh            → companion/build/Leanlamp.app
#   open companion/build/Leanlamp.app
#
# LEANLAMP_BUILD_DIR puts the app (and SwiftPM's build files) elsewhere:
# `leanlamp open` builds into ~/.project-brain/app, because an npm install
# directory may not be writable.
set -euo pipefail
HERE=${0:A:h}
PKG=${HERE:h}
REPO=${PKG:h}
OUT=${LEANLAMP_BUILD_DIR:-$PKG/build}
APP=$OUT/Leanlamp.app
SCRATCH=()
[[ -n "${LEANLAMP_BUILD_DIR:-}" ]] && SCRATCH=(--scratch-path "$OUT/.build")
VERSION=$(node -p 'require(process.argv[1]).version' "$REPO/package.json" 2>/dev/null || echo 0.1.0)
NODE_BIN=$(command -v node || true)   # a Finder or login launch has no shell PATH; remember where node is

cd "$PKG"
swift build -c release --product leanlamp "${SCRATCH[@]}" 2>&1 | grep -vE "xcrun: error: unable to lookup item 'PlatformPath'" | tail -3
BIN=$(swift build -c release "${SCRATCH[@]}" --show-bin-path 2>/dev/null)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"
cp "$BIN/leanlamp" "$APP/Contents/MacOS/leanlamp"
cp Sources/Leanlamp/Resources/Fonts/*.ttf Sources/Leanlamp/Resources/Fonts/OFL-*.txt "$APP/Contents/Resources/Fonts/"

ICONSET=$OUT/AppIcon.iconset
rm -rf "$ICONSET"
swift "$HERE/make-icon.swift" "$ICONSET" 2>&1 | grep -v "PlatformPath" | tail -1
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>leanlamp</string>
  <key>CFBundleDisplayName</key><string>leanlamp</string>
  <key>CFBundleIdentifier</key><string>dev.leanlamp.companion</string>
  <key>CFBundleExecutable</key><string>leanlamp</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LeanlampEngine</key><string>${REPO}/scripts/brain-companion.mjs</string>
  <key>LeanlampNode</key><string>${NODE_BIN}</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 && echo "signed (ad hoc)" || echo "not signed"
# An install build keeps the 3 MB app, not SwiftPM's ~140 MB of build files
# (the app reads its fonts from Contents/Resources; a rebuild takes a minute).
# Sources installed read-only (Nix, a locked-down prefix) make SwiftPM's copied resources read-only too: make them writable first.
if [[ -n "${LEANLAMP_BUILD_DIR:-}" ]]; then chmod -R u+w "$OUT/.build" 2>/dev/null || true; rm -rf "$OUT/.build" || echo "note: could not remove $OUT/.build (the app is fine)"; fi
echo "→ $APP"

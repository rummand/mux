#!/bin/zsh
# Build Mux.app, the menu bar agent, from this package.
#   ./mac/build.sh             → mac/build/Mux.app
#   ./mac/build.sh --install   → also copies it to ~/Applications and opens it
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
APP=build/Mux.app
rm -rf "$APP" build/AppIcon.iconset
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/AppIcon.iconset
cp .build/release/MuxBar "$APP/Contents/MacOS/MuxBar"
cp Info.plist "$APP/Contents/Info.plist"
# The dashboard's icon, at every size macOS asks for.
for s in 16 32 128 256 512; do
  sips -z $s $s ../web/public/icon-512.png --out build/AppIcon.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $((s * 2)) $((s * 2)) ../web/public/icon-512.png --out build/AppIcon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP" >/dev/null
echo "✓ $APP"
if [[ "${1:-}" == "--install" ]]; then
  pkill -x MuxBar 2>/dev/null || true
  mkdir -p ~/Applications && rm -rf ~/Applications/Mux.app && cp -R "$APP" ~/Applications/
  open ~/Applications/Mux.app
  echo "✓ ~/Applications/Mux.app is running: look for the M in the menu bar"
fi

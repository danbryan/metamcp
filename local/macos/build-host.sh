#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="${METAMCP_HOST_APP:-$HOME/Applications/Bryanlabs MetaMCP Host.app}"
IDENTITY="${METAMCP_CODESIGN_IDENTITY:-Developer ID Application: Bryanlabs LLC (VS4G53Q3JB)}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/Info.plist" "$APP/Contents/Resources/Info.plist.template"
cp "$ROOT/metamcp-host.c" "$APP/Contents/Resources/metamcp-host.c"
cp "$ROOT/rebuild-in-place.sh" "$APP/Contents/Resources/rebuild.sh"
chmod 755 "$APP/Contents/Resources/rebuild.sh"
clang -Wall -Wextra -Werror -O2 -arch arm64 \
  "$ROOT/metamcp-host.c" -o "$APP/Contents/MacOS/BryanlabsMetaMCPHost"
codesign --force --options runtime --timestamp \
  --identifier net.bryanlabs.metamcp-host --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

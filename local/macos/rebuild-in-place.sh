#!/usr/bin/env bash
set -euo pipefail

APP="$(cd "$(dirname "$0")/../.." && pwd)"
RESOURCES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"
IDENTITY="${METAMCP_CODESIGN_IDENTITY:-Developer ID Application: Bryanlabs LLC (VS4G53Q3JB)}"

cp "$RESOURCES/Info.plist.template" "$APP/Contents/Info.plist"
clang -Wall -Wextra -Werror -O2 -arch arm64 \
  "$RESOURCES/metamcp-host.c" -o "$MACOS/BryanlabsMetaMCPHost.next"
mv "$MACOS/BryanlabsMetaMCPHost.next" "$MACOS/BryanlabsMetaMCPHost"
codesign --force --options runtime --timestamp \
  --identifier net.bryanlabs.metamcp-host --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

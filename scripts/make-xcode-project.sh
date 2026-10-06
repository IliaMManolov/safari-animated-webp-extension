#!/bin/sh
# Generates the Xcode project (macOS and iOS app targets) that wraps the
# web extension in ./extension. Needs a Mac with Xcode installed.
# The project references ./extension in place, so edits there show up
# on the next build without running this script again.
set -e
cd "$(dirname "$0")/.."
xcrun safari-web-extension-converter extension \
  --project-location xcode \
  --app-name "WebP Player" \
  --bundle-identifier "${BUNDLE_ID:-com.imanolov.largewebpplayer}" \
  --swift \
  --no-open \
  --force
echo "Created xcode/WebP Player/WebP Player.xcodeproj"

#!/bin/sh
# Builds PearTube.app into desktop/target/release: the release binary, with
# BareKit and the worklet's native addons in Contents/Frameworks, signed ad hoc.
#
#   sh desktop/bundle.sh          build it and print its path
#   sh desktop/bundle.sh --open   and open it
#
# Needs `npm ci` at the repo root and `sh worklet/bare-kit.sh darwin` once.
set -eu
cd "$(dirname "$0")"
version=$(node -p 'require("../package.json").version')
host=darwin-$(uname -m | sed 's/x86_64/x64/')

# Panic messages name source files; write this machine's home directory as ~.
CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build --release

app=target/release/PearTube.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks"
cp target/release/PearTube "$app/Contents/MacOS/"
cp -R ../worklet/vendor/bare-kit/darwin/BareKit.framework "target/bare-addons/$host/"*.framework "$app/Contents/Frameworks/"
# The bundle loads its frameworks from Contents/Frameworks only: drop the
# build's absolute rpaths, as the binary records them.
bin="$app/Contents/MacOS/PearTube"
otool -l "$bin" | sed -n 's/^ *path \(.*\) (offset [0-9]*)$/\1/p' | grep -v '^@' | while IFS= read -r rpath; do
  install_name_tool -delete_rpath "$rpath" "$bin"
done
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>PearTube</string>
  <key>CFBundleIdentifier</key><string>com.peartube.app</string>
  <key>CFBundleName</key><string>PearTube</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>PearTube connects directly to peers on your network.</string>
</dict>
</plist>
EOF
codesign --force --sign - --timestamp=none "$app/Contents/Frameworks/"*.framework
codesign --force --sign - --timestamp=none "$app"

if [ "${1:-}" = "--open" ]; then open "$app"; fi
echo "$app"

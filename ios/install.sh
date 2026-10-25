#!/bin/sh
# Provision and install with the configured Personal Team; never collect Apple ID credentials.
set -eu
if [ $# -ne 2 ]; then
  echo "Usage: sh ios/install.sh <Personal-Team-ID> <iPhone-UDID>" >&2
  echo "Sign in to your free Apple ID in Xcode Settings → Accounts first." >&2
  exit 2
fi
team=$1
device=$2
cd "$(dirname "$0")/.."
node ios/project.mjs
# Let Xcode register this app/device and obtain its development profile using
# the account already configured in Xcode. System approvals remain interactive.
xcodebuild -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -project ios/PearTube.xcodeproj -scheme PearTube \
  -configuration Release -destination "platform=iOS,id=$device" \
  -derivedDataPath ios/build/signed-device DEVELOPMENT_TEAM="$team" build
xcrun devicectl device install app --device "$device" \
  ios/build/signed-device/Build/Products/Release-iphoneos/PearTube.app
xcrun devicectl device process launch --device "$device" com.peartube.app.dev

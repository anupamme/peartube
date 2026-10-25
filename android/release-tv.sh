#!/bin/sh
# Builds the signed arm64 Dumb TV Receiver APK (`com.peartube.receiver`) into android/build/release-apk/.
set -eu

cd "$(dirname "$0")"
props="$HOME/.gradle/gradle.properties"
for key in keystore keystorePassword keyAlias keyPassword; do
  grep -q "^peartube\.$key=" "$props" 2>/dev/null || { echo "peartube.$key is not set in $props" >&2; exit 1; }
done
if [ -x /usr/libexec/java_home ]; then JAVA_HOME=$(/usr/libexec/java_home -v 17); export JAVA_HOME; fi
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)
version=$(node -p 'require("../package.json").version')

./gradlew --console=plain :tv:assembleRelease
mkdir -p build/release-apk
out="build/release-apk/PearTubeReceiver-$version-arm64.apk"
cp tv/build/outputs/apk/release/tv-release.apk "$out"
certs=$("$tools/apksigner" verify --print-certs "$out" 2>/dev/null)
printf '%s\n' "$certs" | sed -n 's/^.*Signer.* certificate SHA-256 digest: /signer sha256: /p'
echo "$out"

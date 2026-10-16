#!/bin/sh
# Builds the signed arm64 release APK into android/build/release-apk/.
# Gradle signs it with the key named in ~/.gradle/gradle.properties:
# peartube.keystore, peartube.keystorePassword, peartube.keyAlias and
# peartube.keyPassword. Android lint needs JDK 17.
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

./gradlew --console=plain :app:assembleRelease
mkdir -p build/release-apk
out="build/release-apk/PearTube-$version-arm64.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
# An assignment, so set -e stops the script when verification fails.
certs=$("$tools/apksigner" verify --print-certs "$out" 2>/dev/null)
printf '%s\n' "$certs" | sed -n 's/^.*Signer.* certificate SHA-256 digest: /signer sha256: /p'
echo "$out"

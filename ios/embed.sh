#!/bin/sh
set -eu
prepared="$SRCROOT/build/$PLATFORM_NAME"
app="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH"
frameworks="$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH"
mkdir -p "$frameworks"
# Drop frameworks from earlier builds (e.g. an addon whose version changed) so only the prepared set ships.
for framework in "$frameworks/"*.framework; do
  [ -e "$prepared/Frameworks/${framework##*/}" ] || rm -rf "$framework"
done
cp "$prepared/worker.bundle" "$app/worker.bundle"
for framework in "$prepared/Frameworks/"*.framework; do
  name=${framework##*/}
  rm -rf "$frameworks/$name"
  ditto "$framework" "$frameworks/$name"
  if [ "${CODE_SIGNING_ALLOWED:-YES}" != NO ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --preserve-metadata=identifier "$frameworks/$name"
  fi
done

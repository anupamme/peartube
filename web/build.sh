#!/bin/sh
# Compiles peartube-media's WASM engine wet and tight into web/assets/peartube_web.wasm (+ .gz).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$ROOT/web/assets"
(cd "$ROOT/web" && cargo build --config "$ROOT/web/.cargo/config.toml" --target wasm32-unknown-unknown --release)
cp "$ROOT/web/target/wasm32-unknown-unknown/release/peartube_web.wasm" "$ROOT/web/assets/peartube_web.wasm"
gzip -9 -c "$ROOT/web/assets/peartube_web.wasm" > "$ROOT/web/assets/peartube_web.wasm.gz"
# The pins this build came from; test/ui.e2e.js fails when web/Cargo.lock has moved on without a rebuild.
shasum -a 256 "$ROOT/web/Cargo.lock" | cut -d' ' -f1 > "$ROOT/web/assets/peartube_web.lock.sha256"
ls -lh "$ROOT/web/assets/peartube_web.wasm" "$ROOT/web/assets/peartube_web.wasm.gz"

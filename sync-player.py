#!/usr/bin/env python3
"""Pins the apps' player to a peartube-media commit.

Sets the `rev` of the `player` and `codecs` git dependencies in
desktop/Cargo.toml (the Mac app), android/native/Cargo.toml, and
ios/native/Cargo.toml (the mobile player libraries), and copies
peartube-media's [patch.crates-io] block into each, which pins every OxideAV
crate (Cargo applies patches only from the top-level manifest).

    python3 sync-player.py [path to a peartube-media checkout]

The default checkout is ~/projects/peartube-media; its HEAD must be pushed.
"""
import pathlib, re, subprocess, sys

media = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "~/projects/peartube-media").expanduser()
root = pathlib.Path(__file__).resolve().parent
manifests = [root / "desktop" / "Cargo.toml", root / "android" / "native" / "Cargo.toml", root / "ios" / "native" / "Cargo.toml", root / "web" / "Cargo.toml"]

rev = subprocess.check_output(["git", "-C", media, "rev-parse", "HEAD"], text=True).strip()
pushed = subprocess.run(["git", "-C", media, "branch", "-r", "--contains", rev], capture_output=True, text=True).stdout
if not pushed.strip():
    sys.exit(f"peartube-media {rev[:9]} is not pushed")

block = re.search(r"# BEGIN pin-oxideav\n.*?# END pin-oxideav\n", (media / "Cargo.toml").read_text(), re.S)
if not block:
    sys.exit("peartube-media/Cargo.toml has no pin-oxideav block")

pattern = re.compile(r"# BEGIN pin-oxideav\n.*?# END pin-oxideav\n", re.S)
for manifest in manifests:
    text = manifest.read_text()
    text = re.sub(r'(git = "https://github.com/ayooooo123/peartube-media", rev = ")[^"]*(")', rf"\g<1>{rev}\g<2>", text)
    text = pattern.sub(lambda _: block.group(0), text) if pattern.search(text) else text.rstrip("\n") + "\n\n" + block.group(0)
    manifest.write_text(text)
print(f"player pinned to peartube-media {rev[:9]}")

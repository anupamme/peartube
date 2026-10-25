# PearTube Development Guide

PearTube is a decentralized CDN and debrid provider on the Holepunch stack. The core is deliberately small: the Holepunch modules do the heavy work, and PearTube glues them together. Keep it under 1,000 lines.

## Agent Instructions

Builds, installs, and deploy commands may be run when explicitly requested.

## Layout

|File|Purpose|
|---|---|
|`src/index.js`|`createNode`: Corestore, Autobee tracker + `apply`, Hyperblobs (`512 KiB` blocks across capped slots), `rechunkLegacyBlobs`, Hyperswarm, `search` / `put` / `append` / `publish` / `remove`, and `setLan` to swap LAN discovery without restarting the node|
|`src/blob-server.js`|Zero-patch HTTP Range blob server over stock `hypercore` sessions: `O(1)` integer-division block seeks (`Math.floor(byte / 524288)`) with zero `core.seek()` network walks, bounded `core.get()` sliding lookahead, and instant session cancellation when a player seeks|
|`src/acquire.js`|Private job queue: fetch a source, `put` it, save the announce, `append` it durably, and `repointBlob` on `512 KiB` slot migration. Stored in `jobs.json`, never in the Corestore|
|`src/http.js`|One port: the UI at `/`, `/v1` API, `/v1/blob` same-origin HTTP Range blob streaming, and `/web/*` WASM player assets|
|`src/ui.js`|The acquisitions & catalog page (one HTML string), with in-browser `peartube-media` WebAssembly playback|
|`web/`|Browser WebAssembly player (`peartube_web.wasm`, `sh web/build.sh` -> `web/assets/`, not part of the core line budget): compiles `peartube-media`'s containers, software decoders, surround downmixer, subtitle decoders, and low-latency CMAF fMP4 muxer to `wasm32-unknown-unknown` (`+simd128`) inside a Dedicated Web Worker|
|`src/lan.js`|Optional zero-wrapper LAN discovery directly over an isolated ephemeral `HyperDHT` (`port: 0`) + mDNS (`bonjour-service`), stamping each peer's advertised address (`h`) so peers dial directly rather than an mDNS reflector, rebrowsing every 10 s for missed Wi-Fi multicast answers, and falling back to dialing from the larger-key side after 3 s when a host firewall blocks incoming UDP. `bin/relay.js` passes it to `createNode` as a factory; `lanAddress` picks Wi-Fi/Ethernet IPv4 and `interfaceAdapter` pins multicast to that interface|
|`bin/relay.js`|Relay process, configured by env|
|`src/cast.js`|`peartube-cast/v1` Cast & TV Receiver stack: `_peartube-cast._tcp` mDNS discovery, 6-char TV code + `peartube://receiver/<pubkey>?token=…` Noise P2P keypair pairing over HyperDHT, byte-exact mid-stream `HTTP -> P2P` splice proxy, and autonomous P2P receiver peer adoption (public P2P or 4-hop `privateRouting` matching the cast initiator) so once a cast starts, the receiver keeps playing and seeds the video as a normal peer even when the initiator goes offline. Pairing tokens and receiver seeds stay in private files (`receiver.json`, `cast-receivers.json`), never in Corestore|
|`src/cast-ui.js`|Zero-install 10-foot Smart TV Web Receiver HTML (`/tv`, `/cast/receiver`) for LG webOS, Samsung Tizen, consoles, and kiosk browsers, with D-pad/media remote bindings and SSE/HTTP playback sync|
|`bin/receiver.js`|Portable TV Receiver daemon (`peartube-receiver` / `npm run receiver`): runs Hybrid P2P+HTTP or `--thin` (pure TCP/HTTP + mDNS, zero P2P runtime) and drives `web`, `mpv` (JSON UNIX IPC), `vlc`/`cmd:…`, or `headless` sinks|
|`android/`|Android app, which GitHub releases ship as a signed APK beside the Mac app (not part of the core line budget): Kotlin and Jetpack Compose. It runs the core itself as a peer, in a Bare worklet through bare-kit's own Java `Worklet`/`IPC` (`app/src/main/java/to/holepunch/bare/kit`, from bare-kit 78230eb; their JNI is in the QuickJS `libbare-kit.so`), speaking `worklet/worker.js`'s JSON lines (`Worker.kt`). It keeps the data paths of the Dioxus app it replaced (`files/settings.json`, `no_backup/trackers/<key>`, `files/soundfont.sf2`), so a release build signed with the same key updates it in place. The worklet suspends while the app is in the background (`PearTubeApp.kt`), which also holds the Wi-Fi multicast lock LAN discovery needs while the app is in front. Debug builds install beside the release app as `com.peartube.app.dev`, and so does a release build made with `-Ppeartube.dev` (signed with the debug key)|
|`android/native/`|`libpeartube.so`: the Rust player from [peartube-media](https://github.com/ayooooo123/peartube-media) (OxideAV, ported software decoders, MediaCodec and AAudio) behind JNI for `player/NativePlayer.kt`. Full VLC-format compatibility remains in development; require per-format playback evidence before claiming support|
|`android/app/src/main/kotlin/com/peartube/app/player/PlayerViews.kt`|Two SurfaceViews (video, subtitles above it) behind the Compose UI, in the activity's content view, under the play screen's slot; their surfaces go to `AndroidBackend` through JNI. Old views stay attached until the native side proves it has let go of their surfaces; other screens cover them. When Android takes a Surface away (the app goes to the background), `surfaceDestroyed` waits up to 1 s for the native side to let go: a MediaCodec still stopping on a Surface that is already gone fails, its cleanup is never proved, and every later Surface is held. The video view takes the picture's shape inside the slot, with black bars around it; the subtitle view covers the whole slot|
|`android/app/src/main/kotlin/com/peartube/app/ui/PlayScreen.kt`|The play screen leaves its slot clear and draws the controls over the picture: back, ±10 s, play/pause, the clock, a seek bar and fullscreen, plus audio and subtitle menus. They hide 3 s after the last touch while playing; a tap on the picture brings them back. Fullscreen hides the system bars and lays the window out edge to edge, sideways for a wide picture; turning the phone sideways enters it, and back leaves it. The picture's content description carries the clock, for TalkBack and `e2e.mjs`|
|`android/tv/`|Dedicated Dumb TV Receiver APK (`com.peartube.receiver`, `PearTubeReceiver-<version>-arm64.apk`): pure 10-foot idle QR screen + `libpeartube.so` video player over the headless P2P / 4-hop `privateRouting` peer engine—zero library, channels, search, CameraX, or settings UI, with full D-pad/media-remote playback controls (Play/Pause, ±10 s, focusable seek bar, Audio & Subtitle track pickers, stream/decoder info, and Back-to-hide / Back-to-stop) synced back to the sender (`ReceiverActivity.kt`, `ReceiverWorker.kt`, `ReceiverApp.kt`)|
|`android/worklet.mjs`|Packs `worklet/worker.js` for android-arm64 with bare-pack, links its native addons with bare-link, and gathers them with bare-kit's libraries; both `:app` and `:tv` run it, and run cargo for `android/native`|
|`android/release.sh`, `android/release-tv.sh`|Build the signed arm64 release APKs (`PearTube-<version>-arm64.apk` and `PearTubeReceiver-<version>-arm64.apk`) into `android/build/release-apk`, signed with `~/.gradle/gradle.properties`|
|`android/e2e.mjs`|On a connected phone, against a live relay: a fresh install of `com.peartube.app.dev` (the debug build, or `--apk` for a `-Ppeartube.dev` release build) joins the relay's tracker through Settings, lists it, plays the first entry (video frames from SurfaceFlinger, the clock moving, AAudio started), goes fullscreen and back (the back button where it was before), and returns to the list. With `--lan` it also checks that LAN discovery runs. It stops if a system window comes to the front, such as Android's one-time "Viewing full screen" notice: someone taps Got it on the phone, then it runs again. Writes `android/build/e2e/result.json` and screenshots|
|`desktop/`|Mac app (not part of the core line budget): GPUI through `gpui-kit` (Zed's `gpui-pre` snapshot and gpui-component's widgets). It runs the same worklet as Android through bare-kit's C API (`src/worker.rs`, the same JSON lines), and the same Rust player with peartube-media's `AppleBackend`. It keeps the Dioxus Mac app's data paths: `settings.json` and `soundfont.sf2` in `~/Library/Application Support/PearTube`, each tracker's Corestore in `~/Library/Caches/PearTube/trackers/<key>`; `PEARTUBE_STORAGE` puts both in one directory. `build.rs` packs the worklet for darwin and links BareKit|
|`desktop/src/video.rs`|The picture: a native NSView under GPUI's own view, which peartube-media's `AppleBackend` draws into: AVPlayer for H.264/HEVC with any audio the player decodes (peartube-media's native route serves them as HLS on 127.0.0.1; AAC, AC-3, E-AC-3, FLAC and ALAC are copied, the rest decoded and sent as FLAC), AVSampleBufferDisplayLayer + audio renderer for everything else, and the subtitle layer over both. While a video plays the window is transparent and the play screen paints nothing over its slot, so the picture shows through and the controls draw over it, the way GPUI puts a blur under a window|
|`desktop/src/play.rs`|The play screen: the controls over the picture (back, ±10 s, play/pause, the clock, a seek bar and fullscreen, plus audio and subtitle menus), hidden 3 s after the mouse last moved while playing. Space plays and pauses, ← and → skip 10 s, F toggles fullscreen, Esc leaves fullscreen and then the screen; a click on the picture plays or pauses, a double click toggles fullscreen. Leaving makes the window opaque again before the picture's view goes|
|`desktop/src/cast_screen.rs`, `desktop/src/receiver_main.rs`|`cast_screen.rs`: Mac sender Cast chooser and persistent remote bar in `PearTube`. `receiver_main.rs`: standalone Dumb TV Receiver binary (`PearTubeReceiver`, `com.peartube.receiver`) with only the 10-foot QR idle screen + native `VideoView` player and local playback/track controls over the headless P2P/private-P2P engine|
|`desktop/bundle.sh`|Builds `desktop/target/release/PearTube.app` (or `PearTubeReceiver.app` with `--receiver`): the release binary with BareKit and the worklet's addons in `Contents/Frameworks`, signed ad hoc; `--zip` writes `<Name>-<version>-macos-<arch>.zip` with `ditto`|
|`worklet/worker.js`|The worklet: newline-delimited JSON over `BareKit.IPC` to `createNode`. LAN discovery follows the device's address: checked on start, on resume and every 10 s, and stopped in the background. Its state goes out as `lan` in `start` and `status`, and the list shows it under the peer count. `desktop/build.rs` (Mac) and `android/worklet.mjs` (Android) pack it with bare-pack (`worklet/imports.json` maps Node builtins to `bare-*`) and link its native addons with bare-link|
|`worklet/crypto/`|The worklet's `crypto`: `createHash('sha256')` on sodium-native, the only part of `crypto` the core and LAN discovery use. `package.json` `imports` and `worklet/imports.json` map `node:crypto` and `crypto` to it, so the apps don't ship bare-crypto's 0.8 MB library|
|`worklet/bare-kit.sh`|Builds bare-kit with QuickJS (libqjs) instead of V8 for Android and macOS, from pinned sources plus `worklet/patches/`, into `worklet/vendor`, cached by its inputs: libbare-kit.so is 3.9 MB instead of 65.5 MB|
|`sync-player.py`|Pins both apps to a peartube-media commit: the `player`/`codecs` git rev and a copy of its `[patch.crates-io]` OxideAV pins in `desktop/Cargo.toml` and `android/native/Cargo.toml` (Cargo applies patches only from the top-level manifest)|
|`.github/workflows/android-app.yml`|CI: builds the Android app's arm64 debug APK on pushes that touch `android/`, the worklet or the core, and keeps it as the run's artifact|
|`test/network.test.js`|Relays on a local HyperDHT testnet, including adversarial peers|
|`test/lan.test.js`|LAN adapter in isolation: the advertised address wins, a lost mDNS answer is asked for again, discovery errors are reported, not fatal, and a peer that cannot reach us is joined from our side, with one connection either way and no dial without a shared topic. `test/mdns.js` is an in-memory mDNS for these|
|`test/desktop.e2e.js`|The Mac app's worklet, driven from Rust (`desktop/examples/smoke.rs`), joins a relay on a testnet, streams exact bytes, plays the entry through the app's player (every frame and audio sample equal to FFmpeg's decode), sees a later publish and removal without reopening, and still lists the tracker when a peer announces a malformed title. A second run finds the relay over LAN discovery alone, with no DHT reachable. Needs ffmpeg. Writes `desktop/target/e2e/result.json` and `lan-result.json`|
|`test/cast.e2e.js`|Cast & TV Receiver E2E: `--thin` portable receiver daemon, mid-stream initiator-offline HTTP->P2P splice + autonomous P2P seeding to a 3rd peer, cross-subnet HyperDHT Noise keypair casting, and 4-hop `privateRouting` autonomous private peer seeding with zero public/LAN byte leakage. Writes `desktop/target/e2e/cast-result.json`|

## Rules

- The Corestore holds only public data (tracker + blobs). Replication serves any stored core a peer can name. Secrets, source URLs and headers stay in private files.
- `apply` is the only gate on the tracker. It must stay deterministic: no clock, no randomness, no I/O. A writer may only add or remove entries under its own writer key.
- Keep Autobee `fastForward: false`. Fast-forward adopts a peer's built view without running `apply`, which lets a forging peer plant entries under other writers' keys (covered by a test).
- A tracker write counts only once it is in the local oplog; an unsynced joiner's optimistic write lives in memory until first sync.
- Connect peers with `tracker.replicate(conn)`, not `store.replicate(conn)`; only the former attaches Autobee's wakeup protocol.
- Give Autobee a namespaced store, and have a new tracker's founder append once before relying on others' optimistic writes.
- Pin `autobee` exactly; it is experimental.
- Use the P2P libraries (Hyperswarm, HyperDHT) through their public API only, unmodified from npm: no monkeypatching, private methods or patched copies. No router rules (OPNsense) either. Blind relays (`relayThrough`) are optional; nothing may depend on one.
- Autobee emits `'update'` only on an interrupt. To hear about view changes, pass `onchange` to `createNode`, which runs from Autobee's `update` handler.
- Don't add a machine API field without updating every client in the same change. MediaStorm is the proof client.
- Prefer deleting code to adding it. Old platform code is at tag `archive/v0.3.0-platform`.
- `src/index.js` also runs under Bare, in the apps' worklet: no Node-only imports there. Map `node:` builtins to `bare-*` in `package.json` `imports`, except `node:crypto`, which goes to `worklet/crypto` (SHA-256 only).
- The Android and macOS worklet runs on QuickJS: no `Intl`, and guard V8-only APIs such as `Error.captureStackTrace`. Keep `worklet/patches/libqjs-function-source.patch` until libqjs ends its CommonJS wrapper on a new line; without it the worklet dies loading bonjour-service, which `test/desktop.e2e.js` catches.
- Keep `worklet/patches/libqjs-deferred-release.patch`. QuickJS frees an object as soon as its last reference goes, but addons built for V8 release a reference and then touch memory that object owned (jstl's `js_persistent_t::reset()`). Without the patch, udx-native's DNS lookup crashes the worklet whenever HyperDHT resolves a bootstrap host by name. `test/desktop.e2e.js` names its bootstrap nodes `localhost:<port>` to catch it.
- Keep the Android app's `minSdk` at 29: the QuickJS bare-kit calls `timespec_get`, new in API 29, and the player calls NDK media functions added in 29. Both apps' version is `package.json`'s; releases bump it there.
- Keep the Android app's native libraries uncompressed in the APK (`jniLibs.useLegacyPackaging = false`). Android then loads them from the APK; compressed, it unpacks a second copy at install, which made the Dioxus app take 61 MB on the phone for an 18.7 MB APK. bare-kit loads the worklet's addons by file name, which works from the APK.
- Keep mimalloc as `libpeartube.so`'s global allocator (`android/native/src/lib.rs`). The software decoders allocate and free a lot each frame: on a Pixel 5a, 720p XviD took 23 ms a frame with Android's own allocator and 11 ms with mimalloc, and the MPEG-4 Part 2 decoder's second rebuild thread made decoding slower with Android's allocator. It uses local-dynamic TLS because the app loads the library with dlopen.
- Pin `gpui-kit` exactly: it pins its own GPUI snapshot, and GPUI's API changes between snapshots.
- Keep the Mac app's picture in its own NSView under GPUI's view (`desktop/src/video.rs`), with the window transparent only while a video plays. A layer inside GPUI's view would be drawn over by GPUI's Metal layer, and a view above it would cover the controls.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- Phone tests drive only the app. When a system window is in front (a permission prompt, Android's fullscreen notice), stop and ask the user to answer it; never tap it or send it keys.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.

## Commands

```bash
npm install
npm test
npm start
npm run receiver             # Portable TV Receiver daemon (--thin, --player web|mpv|vlc|headless, --open)

# Apps (cargo; Android SDK + NDK 29.0.14206865 and JDK 17 for Android; Xcode for the Mac)
sh worklet/bare-kit.sh      # once: bare-kit on QuickJS into worklet/vendor (cmake 4+, ninja, node 22.21+/24.9+), for Android if the NDK is found and macOS on a Mac
sh worklet/bare-kit.sh darwin   # the Mac only, with Xcode alone
npm run app                 # builds desktop/target/release/PearTube.app (desktop/bundle.sh) and opens it
sh desktop/bundle.sh --zip  # the Mac app zipped for a release: desktop/target/release/PearTube-<version>-macos-arm64.zip
sh desktop/bundle.sh --receiver --zip   # Mac Dumb TV Receiver app zipped: desktop/target/release/PearTubeReceiver-<version>-macos-arm64.zip
cargo run --manifest-path desktop/Cargo.toml   # debug build of the Mac app, run in place
npm run test:desktop        # E2E through the worklet on macOS
cargo run --manifest-path desktop/Cargo.toml --bin PearTubeReceiver   # standalone Mac/HTPC Dumb TV Receiver
npm run test:cast           # Cast & TV Receiver E2E suite (writes desktop/target/e2e/cast-result.json)
cd android && ./gradlew :app:assembleDebug :tv:assembleDebug   # phone (:app) & dumb TV receiver (:tv) debug APKs
cd android && ./gradlew -Ppeartube.dev :app:assembleRelease    # phone release build as com.peartube.app.dev
sh android/release.sh       # signed arm64 phone release APK in android/build/release-apk
sh android/release-tv.sh    # signed arm64 Dumb TV Receiver APK (com.peartube.receiver) in android/build/release-apk
node android/e2e.mjs --serial <adb serial> --relay http://<relay>:8174 [--lan] [--apk path]   # E2E on a connected phone
sh web/build.sh             # compiles peartube-media to wasm32-unknown-unknown (+simd128) into web/assets/peartube_web.wasm
python3 sync-player.py      # after pushing peartube-media: pin both apps to its HEAD
```

## Troubleshooting

No peers: check both NATs. HyperDHT aborts with `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` (reported as `HOLEPUNCH_ABORTED`) when both sides are randomized; forward a UDP port (`PEARTUBE_DHT_PORT`) or use `PEARTUBE_RELAY_THROUGH`.

Slow first connection on a local testnet: every peer is on 127.0.0.1, which HyperDHT will not holepunch, so two peers connect only once one of them passes dht-rpc's NAT check and reports itself open. That check can take minutes after a failed first try; a fresh testnet usually connects in about 25 seconds, which is why the E2E tests wait up to 60–120 seconds.

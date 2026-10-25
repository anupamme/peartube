# PearTube

PearTube lets you host videos on your own server or NAS and stream them between peers. Built with [Holepunch](https://holepunch.to).

Videos are split into small pieces so you can start watching or seek ahead before the whole file downloads. Relays, phones, desktops, and TVs fetch the pieces they need from whichever peers hold them, cache watched pieces locally, and share them with other viewers while online.

Catalogs come in two forms: **shared Trackers**, where anyone with the tracker key can add their own listings, and **personal Channels**, where only the channel owner can publish listings while subscribers still help distribute the catalog and video pieces.

## Run a relay

A relay is the PearTube service you run on a server or NAS to import and share videos.

```sh
npm install
PEARTUBE_TRACKER=<tracker key> npm start
```

Leave `PEARTUBE_TRACKER` unset to found a new tracker; the relay prints its `tracker` and `channel` keys on startup (`{"msg":"relay ready", ...}`). Open `http://<relay>:8174/` for the web UI (which plays MKV/AVI/MP4/TS streams directly in the browser via `peartube-media` compiled to WebAssembly, including DTS/AC-3/TrueHD surround audio and PGS/ASS/SRT subtitles), `http://<relay>:8174/manifest.json` in Stremio, `http://<relay>:8174/v1/playlist.m3u` in VLC/MPV/IINA/Kodi, or `http://<relay>:8174/tv` on a Smart TV browser. Run an unauthenticated relay only on a trusted network (anyone who can reach it can queue downloads unless `PEARTUBE_API_TOKEN` is set).

Prebuilt multi-arch container (`linux/amd64` and `linux/arm64`, published from `main` by CI):

```sh
docker run -d --name peartube-relay \
  -p 8174:8174 -p 8175:8175 \
  -e PEARTUBE_STREAM_HOST=<lan-or-host-ip> \
  -e PEARTUBE_TRACKER=<optional-tracker-key> \
  -v ./peartube-data:/data \
  ghcr.io/ayooooo123/peartube-relay:latest
```

Peers try to connect automatically, and relays on the same local network can discover each other (`PEARTUBE_LAN_HOST`). Some restrictive router setups still need a forwarded UDP port (`PEARTUBE_DHT_PORT`) or a relay; see [Reachability](#reachability).

Or build locally with `docker build -t peartube-relay .` and mount `/data`.

There is no browser file-upload UI yet. Media gets onto a relay either by posting a direct download URL to `POST /v1/acquire` (from `curl` or an external client) or by pointing `PEARTUBE_WATCH_DIR` at a local folder of media files:

```sh
curl -X POST http://127.0.0.1:8174/v1/acquire \
  -H 'content-type: application/json' \
  -d '{"id":"imdb:tt0111161","title":"Example","source":{"url":"https://example.com/video.mp4"}}'
```

| Variable | Default | Meaning |
|---|---|---|
| `PEARTUBE_TRACKER` | none (found new) | Tracker key to join |
| `PEARTUBE_STORAGE` | `./peartube-data` | Data directory |
| `PEARTUBE_API_HOST` | `0.0.0.0` | Interface bound by the UI and `/v1` API server |
| `PEARTUBE_API_PORT` | `8174` | UI, `/v1` API, Stremio addon, M3U, and `/tv` port |
| `PEARTUBE_STREAM_HOST` | `127.0.0.1` | Host put in stream URLs; set to a LAN or reachable host address to serve other machines |
| `PEARTUBE_STREAM_PORT` | `8175` | Port used by players to stream video |
| `PEARTUBE_DHT_PORT` | random | Fixed UDP port, only needed when manually port-forwarding behind a double-randomized NAT |
| `PEARTUBE_BOOTSTRAP` | mainnet | Default public peer-discovery network; override with comma-separated `host:port` servers |
| `PEARTUBE_PRIVATE_ROUTING` | off | **Early alpha (needs testing):** `1` routes swarm connections over four-hop private circuits; endpoint peer addresses are not announced to the tracker DHT topic |
| `PEARTUBE_PRIVATE_RELAY` | off | `1`: run an embedded private-route hop; with private routing also enabled, publicly announce this relay as a discovery anchor (its egress IP is visible to the DHT) |
| `PEARTUBE_PRIVATE_RELAY_PORT` | `PEARTUBE_DHT_PORT` | Dedicated UDP port for the embedded private-route relay |
| `PEARTUBE_RELAY_THROUGH` | none | Comma-separated blind relay keys |
| `PEARTUBE_LAN_HOST` | off | This machine's LAN IPv4; turns on mDNS discovery of relays on the local network |
| `PEARTUBE_SOURCES` | none | Comma-separated extra channel/tracker keys or `peartube://` URIs to subscribe to |
| `PEARTUBE_PUBLISH_CHANNEL` | `1` on relays | List this relay's saved videos and future imports in its own channel without duplicating the media (`0` disables) |
| `PEARTUBE_DIRECTORY` | off | `1`: publish a list of subscribed channels and trackers so other peers can discover them |
| `PEARTUBE_WATCH_DIR` | none | Optional local folder (e.g. `/data/import`) automatically imported once per file |
| `PEARTUBE_MIRROR_FEEDS` | none | Optional comma-separated JSON feed or peer `/v1/entries` URLs to import automatically |
| `PEARTUBE_PLUGINS_DIR` | `<PEARTUBE_STORAGE>/plugins` | Directory scanned on startup for custom import plugins (`*.mjs` / `*.js`; `/data/plugins` in Docker) |
| `PEARTUBE_ACQUIRE_CONCURRENCY` | `4` | Maximum concurrent HTTP acquisition downloads |
| `PEARTUBE_ALLOWED_PEERS` | none | Optional comma-separated 64-hex peer Noise public keys allowed through the swarm firewall |
| `PEARTUBE_API_TOKEN` | none | Optional Bearer token required on mutating `POST`/`DELETE` `/v1/*` routes |

### Reachability

HyperDHT cannot holepunch between two randomized NATs (it aborts the holepunch). Relays on the same network can still find each other: set `PEARTUBE_LAN_HOST` on each, and they discover one another over mDNS and connect directly over ephemeral UDP ports, with no internet path or port forward. This works across subnets when the router reflects mDNS and routes UDP between them. For relays on different networks, forward a UDP port and set `PEARTUBE_DHT_PORT`, or use a blind relay via `PEARTUBE_RELAY_THROUGH`.

Private routing is **early alpha and needs real-world WAN testing**. It requires at least four reachable, distinct relay identities, and at least one relay must set both `PEARTUBE_PRIVATE_ROUTING=1` and `PEARTUBE_PRIVATE_RELAY=1` so private-only peers can find an anchor before exchanging their expiring peer keys through the tracker. Upgrade every peer before relying on this property: older builds still announce endpoint IPs directly.

## UI and API

One port serves the acquisitions page at `/`, the `/v1` API, the Stremio v3 addon, the M3U8 playlist, and `/tv`. By default there is no auth: run an open relay on a trusted network only, because anyone who can reach it can queue a download of any URL. Setting `PEARTUBE_API_TOKEN` requires `Authorization: Bearer <token>` on `POST` and `DELETE` `/v1/*` routes while keeping `GET` routes open for players.

| Route | Does |
|---|---|
| `GET /` | Acquisitions page |
| `GET /v1/search?id=imdb:tt0944947:s01e02` | Tracker entries for an id, each with a `streamUrl` |
| `GET /v1/entries` | Every tracker entry, same shape as search |
| `POST /v1/acquire` `{id, title, source: {url, headers}}` | Fetch a source, store it, announce it |
| `GET /v1/jobs`, `GET /v1/jobs/:jobId`, `DELETE /v1/jobs/:jobId` | Acquire jobs (sources are never returned) |
| `GET /v1/status` | Tracker, writer and blob keys, stored bytes, peers and per-transport replication traffic |
| `GET /v1/sources` | Followed trackers/channels, this node's `channel` key, and catalogs discovered through peers |
| `POST /v1/sources` `{uri}` or `{key, kind, alias}`, `DELETE /v1/sources/:key` | Follow or remove a shared tracker or channel |
| `POST /v1/channel/publish`, `DELETE /v1/channel/sources/:key` | Publish an entry or a link to another catalog (`{type: "source", sourceKey, kind, title, target}`), or remove a catalog link |
| `POST /v1/open` `{uri}`, `GET /v1/resolve?uri=…` | Open a `peartube://channel/…`, `peartube://tracker/…`, `peartube://receiver/…` pairing link, or direct `peartube://watch/…` video link without subscribing first |
| `POST /v1/cache/clear` `{key?}` | Clear cached video data for one entry or all non-local streams |
| `GET /v1/events` | Server-Sent Events (`text/event-stream`) live update stream for external UIs |
| `GET /manifest.json`, `/catalog/:type/:id.json`, `/stream/:type/:id.json` | Stremio v3 addon (`tt…`, `tt…:S:E`, `imdb:…`) |
| `GET /v1/plugins`, `POST /v1/plugins/:name/run`, `POST /v1/mirror` | List or run import plugins (`http-acquire`, `channel-backfill`, `watch-dir`, `feed-mirror`, plus `/data/plugins/*.mjs` modules) |
| `GET /v1/playlist.m3u` | M3U8 playlist across followed channels and trackers (VLC, MPV, IINA, Kodi) |
| `GET /tv`, `GET /cast/receiver` | Fullscreen TV page designed for remote controls (open in a TV browser; no install needed) |
| `GET /v1/cast/status`, `POST /v1/cast/pair`, `DELETE /v1/cast/receivers/:id`, `POST /v1/cast/play`, `POST /v1/cast/attach`, `POST /v1/cast/control`, `POST /v1/cast/stop`, `POST /v1/cast/receiver/start` (`/stop`, `/rotate`) | Pair a TV, start playback, reconnect its remote control, or manage a local receiver |


### Shared Trackers and personal Channels

Both are public catalogs of videos; the difference is who can add listings:

| | Shared Tracker (`peartube://tracker/<key>`) | Personal Channel (`peartube://channel/<key>`) |
|---|---|---|
| **Who can publish** | Anyone with the tracker key | Only the owner can publish; share the channel link (`status.channel`) with subscribers, not the local publishing secret |
| **Unwanted listings** | Contributors can add their own listings, not edit someone else's, and there is no moderation yet | Subscribers follow read-only and cannot add listings |
| **When publisher is offline** | Other online peers continue serving the catalog and any video pieces they hold | Other online subscribers continue serving the catalog and any video pieces they hold |
| **Typical use** | A shared catalog across several trusted relays | Your own published video library or a directory linking to other catalogs (`PEARTUBE_DIRECTORY=1`) |

Under the hood, trackers use multi-writer [Autobee](https://github.com/holepunchto/autobee) (`fastForward: false`, so every peer verifies writer keys locally through `apply`), channels use single-writer `Hyperbee`, and media pieces live in `Hyperblobs` (up to 512 KiB per block).

- **Your own channel**: Every node creates a local channel alongside the catalogs it follows (`sources.json` / `PEARTUBE_SOURCES`; setting `sources` without `PEARTUBE_TRACKER` follows channels alone). On relays, `PEARTUBE_PUBLISH_CHANNEL=1` (default) also lists local tracker imports in the relay's channel without duplicating the stored media.
- **Directories**: Both trackers and channels can publish links to other catalogs (`discoveredSources`) so followers can find them.
- **Shared video pieces across catalogs**: Viewers opening the same shared video file through different catalogs or a direct `peartube://watch/…` link join the same peer pool (`peartube/blob/v1/<blobsKey>`) and exchange pieces directly.


### Cast & TV Receivers (`peartube-cast/v1`)

Phones (Android: `android/app/`, `com.peartube.app`; iOS development target: `ios/`, `com.peartube.app.dev`) and Macs (`desktop/` `PearTube`) stay pure sender, library, and local-player apps. Mobile apps do not have a receive-cast screen or incoming-cast playback mode. Receiver functionality is reserved for the dedicated TV clients below, which expose zero library, channel, search, or settings UI while running a headless P2P / 4-hop `privateRouting` peer engine underneath (`src/cast.js`):

1. **Android TV / Google TV / Fire TV / Pi Receiver APK (`android/tv/`, `com.peartube.receiver`)**: Standalone Leanback/launcher receiver APK (`sh android/release-tv.sh` → `PearTubeReceiver-<version>-arm64.apk`), showing only the 10-foot QR idle screen and decoding MKV/AVI/MP4/HEVC/XviD/FLAC/TrueHD/ASS/PGS natively through `libpeartube.so` with full local D-pad/media-remote controls (Play/Pause, ±10 s, focusable seek bar, Audio & Subtitle track pickers, decoder telemetry, smart Back-to-hide / Back-to-stop) synced back to the sender, plus screensaver wake-on-cast.
2. **Desktop / HTPC Receiver Binary (`PearTubeReceiver`)**: Standalone macOS/HTPC dumb-receiver binary (`cargo run --manifest-path desktop/Cargo.toml --bin PearTubeReceiver`) backed by `peartube-media`'s hardware/software decoder pipeline with full local seek, Play/Pause, ±10 s, Audio/Subtitle track menus, Fullscreen, and Stop controls.
3. **Smart TV Web Receiver (`/tv`)**: Zero-install HTML5/SSE fullscreen dumb receiver for LG webOS, Samsung Tizen, game consoles, and TV browsers—open `http://<sender-or-relay-lan-ip>:8177/tv` (or `:8174/tv` on a relay, `:8176/tv` on `peartube-receiver`) with local D-pad/pointer Play/Pause, ±10 s, seek, Mute, Fullscreen, and Stop controls.
4. **Portable Receiver Daemon (`bin/receiver.js` / `npm run receiver`)**: Runs in full Hybrid P2P+HTTP mode or `--thin` network-only mode (`--player web|mpv|vlc|headless|cmd:…`), and serves as the reference implementation for thin media platforms (tvOS Swift, Roku BrightScript, Kodi, set-top boxes):
   - **Discovery & Pairing**: Advertises `_peartube-cast._tcp` over LAN mDNS (`txt`: `v=1`, `id`, `name`, `h=<lanIp>`, `pk=<noisePubKey>`, `p2p=1|0`, `auth=code|open`) and displays a 6-character TV pairing code (`POST /cast/v1/pair {code}` → persistent bearer `token` stored privately in `cast-receivers.json`). P2P-capable receivers also listen on HyperDHT with a persistent Noise keypair (`peartube://receiver/<64-hex-pubkey>?token=…`) so paired senders can cast and control across subnets, VLANs, or NATs.
   - **Autonomous P2P & Private-Routing Peer Handoff**: Once a cast starts on a P2P-capable receiver (`p2p=1`), the receiver adopts the initiator's network mode—joining as a normal public/LAN swarm peer (`mode: "p2p"`) or automatically spinning up a 4-hop encrypted private-routing peer (`mode: "private-p2p"`, zero public DHT or cleartext LAN exposure when `privateRouting` is enabled on the initiator). Native P2P receivers stream directly from their local `BlobServer` (`32 MiB` rolling playhead prefetch window) while browser Web TVs use the LAN `/cast/v1/hybrid/` Range splice, continuing to play and seed cached blocks after the initiator disconnects (`POST /v1/cast/attach` reconnects a remote control later; `Detach` leaves the TV playing on its own).
   - **Wire Endpoints (Thin Receiver Contract)**: `GET /cast/v1/info`, `POST /cast/v1/pair`, `POST /cast/v1/command` (`load`, `play`, `pause`, `togglePlay`, `seek`, `skip`, `selectAudio`, `selectSubtitle`, `volume`, `stop`, `status`), and `GET /cast/v1/events` (`text/event-stream` pushing `{event: "state", state}`), mirrored identically as NDJSON over HyperDHT Noise `SecretStream`.

Job status: `queued` → `running` (fetching; `bytes` of `total`) → `announcing` (stored, being published to the tracker) → `done`; or `failed` / `cancelled`. A job is `done` only once its announce is on disk; after a restart, `announcing` jobs re-announce without re-fetching.

Ids look like `imdb:tt0111161` for movies and `imdb:tt0944947:s01e02` for episodes.

`status.routes.private`, `.public` and `.lan` each contain live `peers`, cumulative `rxBytes` / `txBytes` (including closed connections), and sampled `downBps` / `upBps`. The top-level byte totals equal the sums of the paths; top-level rates cover the same traffic but may differ by rounding. `public` means the public-DHT swarm, not proof of a direct IP connection: `relayThrough` can insert a blind relay. The relay UI and both apps show the split; their P2P summaries retain cumulative per-path bytes after a transfer ends.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data: the tracker and the blobs. Acquire jobs, with their source URLs and headers, live in `jobs.json` in the data directory and are never replicated.

Private-only peers put a ten-minute, periodically renewed swarm public key in the tracker so other peers can dial their private listener without a public DHT peer announcement. This key, like the tracker and blob metadata, is public; source URLs and headers remain private. Only designated discovery relays announce on the tracker DHT topic. Ordinary DHT bootstrap and lookups still use the direct overlay and can reveal an endpoint's IP and tracker interest. LAN discovery is a separate direct path. Neither this alpha protocol nor several VPN exits on one physical host protects against traffic correlation or a colluding relay operator.

Those counters measure replication connections, not bootstrap UDP, specific files, or anonymity. If LAN and private routing are both on, the same video can arrive over LAN while private metadata traffic rises. Prove a private **blob** transfer with a fresh tracker, uncached reader, LAN disabled, exact file hash, private receive bytes at least as large as the file, and zero public/LAN receive bytes; inspect the seeder's transmit counters and the DHT peer topic too. These checks cannot rule out timing correlation, a malicious bootstrap, or colluding route relays.

The container image keeps Gluetun's firewall on. With `VPN_SERVICE_PROVIDER` set, `bin/relay.js` waits for a `tun0` route before opening the API or swarm and exits if its route disappears. Do not disable Gluetun's firewall: the process check runs every two seconds and cannot replace a network-level kill switch. A stopped VPN relay must not be restarted until its tunnel and firewall are verified.

Each private relay's DHT identity comes from its local writer secret, not the public writer key returned by `/v1/status`. For rootless Podman VPN relays, keep `CAP_NET_ADMIN`, `CAP_NET_RAW`, and a separate network namespace per container, and pass `--device /dev/net/tun`; without the device, Gluetun cannot create that container's `tun0`.


## Client app

PearTube's released clients are a Kotlin app for Android in `android/` and a
GPUI app for macOS in `desktop/`. A native SwiftUI iOS development target lives
in `ios/`, embedding the same Bare worklet and Rust player; see its
[build, free Apple ID sideloading, and verification guide](ios/README.md).
The iOS target is not a published release or a claim of full device/codec
certification. The relay and its acquisitions page remain available separately.

The Mac release ships `PearTube-<version>-macos-arm64.zip` (and `PearTubeReceiver-<version>-macos-arm64.zip` for dedicated HTPC/TV displays) for Apple Silicon Macs on macOS 13 or later. Because bundles are signed ad hoc rather than notarized, macOS quarantines downloaded zips until cleared once:

```sh
xattr -dr com.apple.quarantine /Applications/PearTube.app
```

The apps connect directly to peers rather than streaming everything through one relay: they follow trackers and channels, open `peartube://` links, cast to TVs, fetch the video pieces needed for playback, and share cached pieces while online (they never run the HTTP acquirer, and cached data can be cleared in the app). They also expose the same `/v1`, SSE, Stremio, and M3U server on `127.0.0.1` (`status.apiUrl`, defaulting to `127.0.0.1:8174` with ephemeral port fallback) and enable local mDNS discovery by default on fresh installs.

Under the hood, each app runs `src/index.js` inside a Bare worklet from [bare-kit](https://github.com/holepunchto/bare-kit) and plays from the worklet's loopback blob server through the Rust player in [peartube-media](https://github.com/ayooooo123/peartube-media): platform hardware decoders (MediaCodec, VideoToolbox) where supported, software decoders otherwise, in a native view with overlay controls and fullscreen. Full VLC-format compatibility is still in development; decoder registration does not establish correct playback for every file. The desktop E2E covers H.264 video and FLAC audio, comparing decoded frames and samples with FFmpeg. The player buffers before starting and pauses its clock during source stalls.

On first launch it asks for a tracker key (a relay's `GET /v1/status` shows it), and optionally blind relay keys, a DHT bootstrap list for a private network, and whether to find relays on this network. With that on, the app finds relays on the local network that run with `PEARTUBE_LAN_HOST` over mDNS, which works where the public DHT cannot connect two randomized NATs. It uses the device's Wi-Fi or Ethernet address and follows it from network to network. A line under the peer count shows what it is doing: the address it uses, or why it has none. Android drops Wi-Fi multicast unless an app holds a multicast lock, so the app holds one while it is open. macOS asks once whether the app may accept incoming connections; allow it, or LAN peers cannot connect. Settings live in the app's data directory. Each tracker's Corestore holds only what peers can serve again, so it lives outside backups: `~/Library/Caches/PearTube` on the Mac, the no-backup files directory on Android.

On the Mac, the space bar plays and pauses, ← and → skip 10 seconds, F toggles
fullscreen and Esc leaves fullscreen, then the video. A click on the picture
plays or pauses it, and a double click toggles fullscreen.

MIDI playback needs your own SoundFont 2 (`.sf2`, up to 256 MiB). In Settings,
choose a bank with the system document picker. The app copies it into private
storage, outside the replicated Corestore; no bank is bundled or shared.
Choosing or removing a bank takes effect immediately in Settings and applies
to subsequently opened MIDI files. Cancelling or rejecting an import preserves
the previous copy. These actions are independent of the network settings' Save
button.

Text subtitles use runtime platform fonts and fonts attached to the media, not
bundled font files. Select a subtitle track below the picture, or with the CC button in fullscreen. ASS/SSA rendering
supports shaping, bidirectional text and style overrides; its libass reference
checks establish bounded pixel agreement, not byte-identical rendering.

Version 0.4.7 integrates the producer-keyed native player lifecycle and fixes
MP4 opening through the worklet's HTTP read-ahead source. Android close and
surface replacement retain the views until native retirement is confirmed;
forced activity destruction reports pending cleanup rather than claiming it
finished. The release keeps the existing `com.peartube.app` package and signing
identity so an in-place upgrade preserves settings and private media data.
Physical-device checks cover hardware H.264, paused backward seek/resume,
background/surface recreation, repeated close/reopen and EOS. These are scoped
lifecycle checks, not full codec compatibility or A/V timing certification.

Version 0.4.8 preserves surround dialogue on Android speakers by explicitly
mixing multichannel PCM to stereo, including the center channel in both outputs.
Mono and stereo stay unchanged. Channel layouts survive decoder output and
audio reopen/trim paths; bounded partial writes preserve sample timing.

Version 0.4.9 fixes an Android background-return race: delayed output
notifications no longer invalidate a decoder that has already restarted.
Native Player/AAudio/MediaCodec checks cover Surface recreation and an
intentionally delayed resume notification through EOS. The five-second
active recovery deadline is unchanged; the 0.4.8 dialogue fix is retained.

Version 0.4.10 moves first-use subtitle font discovery into cue decoding,
ahead of timed presentation. This corrects a reproduced cold-start case where
a selected SubRip cue was drawn only after expiry, then immediately cleared.
Embedded SubRip/ASS selection and a standalone Player caption smoke cover
host pixels and timing; Android overlay and actual-show confirmation remain
pending while the test phone is disconnected. The dialogue and background
resume corrections above are retained.

Version 0.4.11 fixes playback stopping for good about a minute after a seek
or the start of a long video. The player's 32 MiB read-ahead stopped refilling
once full, so a movie froze when playback reached the end of that window, and
later seeks or a return to the app could fail with "no presentable picture".
It also hid subtitles: in the tested movie the first English cue comes after
playback had already stopped. On the phone, the same movie now plays past the
old stop point with its PGS captions on screen.

Version 0.4.12 fixes audio disappearing after seeking in older DivX/MP3 AVI
videos. The AVI reader now confirms an MPEG-audio frame boundary before using
the post-seek timestamp, rather than mistaking compressed payload bytes for a
header. Physical-device checks cover the affected episode in the actual app,
plus native Player playback from local and HTTP sources. The 0.4.11 subtitle
and read-ahead corrections remain included.

Version 0.4.13 prevents sustained software-video lateness from leaving a frozen
picture while audio and captions continue: playback holds the shared clock
until video catches up, with bounded recovery. It retains the existing late
frame cutoff rather than displaying increasingly stale pictures. Missing video
decoders no longer stop otherwise playable audio. The temporary diagnostic
counter row and per-frame profiling scaffolding are removed from the release.

Android UI updates after background/resume used Tao 0.34.8 with the upstream
[lost-wake correction](https://github.com/tauri-apps/tao/commit/beb8824915150aebd3938aa46895a9bbf930c212)
backported, which kept the elapsed-time display and play/pause icon from
freezing while native playback continued. The Kotlin app that replaced the
Dioxus Android app does not use Tao, so the backport is gone.

Version 0.4.14 prepares Android software-video pixels before their presentation
deadline and reduces VC-1 chroma interpolation overhead. Decoded pixels, audio
sync, the 100 ms late-frame cutoff and bounded catch-up recovery are unchanged.
Verification includes complete-frame playback comparisons, seek/pause/retry
regressions, Android ownership tests and native Surface checks on a Pixel 5a.
This is a prerelease for playback feedback: continuous movie smoothness has not
yet been verified, and the changes do not promise zero dropped frames.

Version 0.4.15 shows each video at its own shape. The video view used to fill
the 16:9 player box, so a 2.4:1 movie came out 35% too tall and a 4:3 show a
third too wide. It now keeps the picture's shape inside the box, with black
bars, and captions stay on the picture. A seek whose data peers take longer
than five seconds to send now waits for it instead of failing with "no
presentable picture before the seek deadline": time spent waiting on the
network no longer counts against the decoder's five seconds.

Version 0.4.16 plays every frame of videos stamped in decode order. Some MP4
files with B-frames have no `ctts` box, so each frame carries its decode time
instead of its display time. Those times run backwards once the decoder puts the
frames in display order, and the player dropped about half of them as late: 12
of 24 frames a second on a Pixel 5a. The player now works out each frame's
display time from the H.264 or HEVC picture order and shows every frame. Files
with normal timestamps play as before.

Version 0.4.17 is the first release of the native Android app (Kotlin and
Jetpack Compose). It replaces the Dioxus app on Android with the same package,
signing key and data, so it updates 0.4.16 in place. The player controls sit over
the picture, there is a fullscreen mode, and the app takes about 37 MB on a Pixel
5a instead of about 65 MB. MPEG-4 video such as XviD decodes 1.43x faster: 35 to
50 frames a second for a 720p XviD episode on a Pixel 5a. A hot phone slows its
CPU, and at 1.4 GHz the old decoder fell below the 25 frames a second that
episode needs, so playback kept pausing. Going Home while the phone's hardware
decoder played a video no longer leaves a black picture and "platform video
output recovery timed out" on return. With subtitles on, going Home no longer
stalls for a second.

Version 0.4.18 roughly halves the time MPEG-4 Part 2 (XviD, DivX) decoding takes
on Android. The player library now uses mimalloc instead of Android's own
allocator. The decoder allocates and frees a lot each frame: a 720p XviD episode
took 23 ms a frame on a Pixel 5a with Android's allocator and 11 ms with mimalloc.
The player's other software decoders use mimalloc too; their speed was not
measured. The MPEG-4 Part 2 decoder also rebuilds each frame's pixels on two
threads, which made it 13% faster again. In the app, the first minute of that
episode used a quarter less CPU outside the P2P worker than with 0.4.17.

Version 0.4.19 is the same app as 0.4.18, built from `main`, which now carries
the Kotlin Android app. It is the first full release since 0.4.6; 0.4.7 to
0.4.18 were prereleases.

The Mac app is now a GPUI app (`desktop/`), replacing the Dioxus webview app.
It keeps that app's settings and stores. The Dioxus code is gone from the
repository, including the old Dioxus iOS target (a native SwiftUI iOS target now lives in `ios/`).

Version 0.4.20 brings the player fixes made since 0.4.19 and two P2P changes.
A seek in a Vorbis track, in Matroska or Ogg, lands where it should; before,
playback stood still or went silent. 24-bit PCM sound in Matroska plays instead
of noise, and MP3 sound inside MP4 plays (it was taken for AAC and stayed
silent). A seek onto an open-GOP HEVC picture (a CRA) with the software decoder
plays on instead of stopping with "reference picture is missing". LAN discovery
no longer depends on which of two peers has the smaller key: when that peer
cannot reach the other, the other one now connects after 3 s. The Holepunch
libraries are on their latest versions (hypercore 11.39, corestore 7.15,
hyperdht 6.34.1, protomux 3.13); none of the updates changes how NATs are
crossed.

Version 0.4.21 fixes the Android player's back button after fullscreen. Leaving
fullscreen from a sideways picture moved the back button down by about the
status bar's height; it now stays where it was.

Version 0.4.22 moves both apps to the latest player. On the Mac, Dolby Vision
(profiles 5, 7 and 8) plays through Apple's player, E-AC-3 Atmos is passed
on, 10-bit HDR plays on the software route, and closed captions show on the
Apple route too. On both apps: a seek into the last second of a Theora+Vorbis
video keeps its sound, Ogg Vorbis no longer plays its end padding, an HEVC
picture without a timestamp no longer takes another's, AMR sound in MP4 plays,
and a damaged video packet costs only its own picture instead of stopping the
video. The Android app's native libraries no longer
carry the build machine's temp-folder path.

Version 0.4.29 groups imported streams into larger 512 KiB pieces (`put()`), updates how 4-hop `privateRouting` relays forward streams (`UDX` splicing), and drops stale relay records so offline nodes do not stall connection setup.

Version 0.4.30 fixes mid-file seeking in large (23 GB+) files, keeps read-ahead buffering alive across concurrent HTTP Range probes, tunes buffering for high-latency multi-hop routes, and adds live P2P transfer stats plus cache clearing (`POST /v1/cache/clear`) in the apps and relay UI.

Version 0.4.31 adjusts socket buffers, startup pacing, and parallel block requests on private routes.

Build needs Rust, `npm install` at the repo root, and for `worklet/bare-kit.sh` cmake 4+, ninja and Node 22.21+ or 24.9+. Android also needs the Android SDK with NDK 29.0.14206865 and JDK 17; the Mac app needs Xcode:

```sh
sh worklet/bare-kit.sh   # once: build bare-kit on QuickJS (cached) for Android if the NDK is found and macOS on a Mac
sh worklet/bare-kit.sh darwin   # the Mac only, with Xcode alone
cd android && ./gradlew :app:assembleDebug   # debug APK (com.peartube.app.dev, installs beside the release app)
cd android && ./gradlew -Ppeartube.dev :app:assembleRelease   # the release build as com.peartube.app.dev, to try its real size and speed
sh android/release.sh  # signed arm64 release APK in android/build/release-apk
sh android/release-tv.sh # signed arm64 Dumb TV Receiver APK (com.peartube.receiver) in android/build/release-apk
node android/e2e.mjs --serial <adb serial> --relay http://<relay>:8174 [--lan] [--apk path]   # E2E on a connected phone; writes android/build/e2e
npm run app            # macOS: builds desktop/target/release/PearTube.app and opens it
sh desktop/bundle.sh --zip   # macOS: the same, zipped for a release as desktop/target/release/PearTube-<version>-macos-arm64.zip
sh desktop/bundle.sh --receiver --zip   # macOS: standalone PearTubeReceiver-<version>-macos-arm64.zip
cargo run --manifest-path desktop/Cargo.toml   # macOS: a debug build, run in place
cargo run --manifest-path desktop/Cargo.toml --bin PearTubeReceiver   # standalone Mac/HTPC Dumb TV Receiver
npm run test:desktop   # E2E on macOS: the worklet finds a relay over a testnet DHT, then over LAN discovery alone; streams exact bytes and sees later publishes and removals live
npm run receiver       # Portable TV Receiver daemon (--thin, --player web|mpv|vlc|headless)
npm run test:cast      # E2E: thin receiver daemon, Hybrid HTTP->P2P sender-death failover, and cross-subnet Noise P2P casting
node --test test/private-discovery.test.js   # private seeder-to-reader byte proof plus DHT peer-list check; prints a result.json artifact
node ios/project.mjs && sh ios/package.sh   # iOS dev target: generate Xcode project and unsigned arm64 IPA for AltStore/SideStore (see ios/README.md)
```

### Low-cost private-routing experiments

Run `node test/private-scale.mjs --readers 4 --relays 5 --bytes 8388625 --churn-ms 1500 --artifact android/build/e2e-private-scale/overlap-churn.json` for a fresh local tracker, five real private relay identities, four uncached readers and relay restarts **during** transfer. The JSON keeps discovery/first-byte/transfer times, hashes, path counters, DHT topic exposure and overlap evidence. It is a co-located loopback test, **not** an independent-WAN or loss measurement.

On a Linux box with rootless Podman and an existing PearTube image containing Node, `tc`, and the same dependencies as this checkout, run `node test/private-netem.mjs --media /path/to/fixture.mp4 --readers 1 --relays 4 --delay-ms 20 --jitter-ms 5 --loss-percent 0.1 --shared-namespace --out android/build/e2e-private-netem/run-a`. It creates disposable test containers with fresh Corestores and private relay identities in **one isolated network namespace**, and applies `tc netem` to that namespace's loopback device. The JSON records the applied qdisc, exact media hash and private-only bytes; failed checks are saved in `result.json`, then only this run's containers and network are removed. Increase `--readers` and `--relays`, then add `--churn`, to probe load separately from link impairment. This is one physical host and one shared qdisc, **not** independent egress or production VPN traffic.

To test separate network namespaces, omit `--shared-namespace`: a disposable Podman bridge carries packets and each reader shapes its own `eth0`. On the rootless Podman bridge available here, four identities appeared in the relay directory but the tracker never became announced, so that topology produced **no** throughput result. The failure artifact records the public directory, reader state and exact stage; do not confuse it with a measured stream. The shared-namespace variant gets a reproducible impairment test without touching production, but every reader shares an IP and qdisc, not an independent WAN path. Compare with an otherwise identical `--delay-ms 0 --jitter-ms 0 --loss-percent 0` control run before making claims about slow routing.

The matched single-reader NUC runs used the same uncached 13,776,925-byte video. A 10,000-packet `netem` limit prevented *unrequested* queue overflow; `tc -s qdisc show` recorded actual drops. Shaping began **after** seeding. These are individual runs, not WAN estimates or statistically stable benchmarks:

| Test-namespace `lo` netem | First byte | Exact-byte transfer | Kernel drops |
|---|---:|---:|---:|
| 0 ms, 0% loss | 88 ms | 397 ms | 0 |
| 20 ± 5 ms, 0% loss | 2,383 ms | 3,329 ms | 0 |
| 20 ± 5 ms, 0.1% loss | 1,316 ms | 5,823 ms | 133 / 127,343 packets |

Even without packet loss, compounded per-hop latency increases time to first byte and transfer time; the 20 ms runs report 283–295 ms peer RTT. The initial *default* 1,000-packet `netem` queue had instead produced 34–40-second transfers and about 3% drops under four readers despite requesting only 0.1% loss. Those runs are evidence of a **bad test queue**, not a measured VPN or routing regression. At 80 ± 15 ms and 1% loss with that small queue, one reader reached four private peers but had not seen the fixture after 120 seconds; the result **failed** and is not a throughput sample. The separate-namespace bridge failed before shaping began.

With the corrected queue, five relays, four simultaneous readers and one relay replacement during transfer, **all four** independently hashed the full video over private paths with zero public/LAN received bytes. Their first bytes took 1.6–13.5 seconds and transfers 63–69 seconds; the shared qdisc dropped 999 of 958,102 packets (about 0.1%). This is a successful churn/byte-integrity test but still a substantial per-reader slowdown on one host. The JSON also retains the reader's one-MiB arrival milestones, exposing long stalls followed by bursts. Reproduce on genuinely independent network sites before choosing hop-count or transport changes.

For the independent-network phone check, run `node test/private-wan.mjs anchor` on a reachable test host, then run three more anchors with `--tracker` set to its printed fresh key on independent egresses. Run `node test/private-wan.mjs seeder --tracker <key>` on a separate host; without `--media` it generates a one-minute MP4 using ffmpeg and publishes it through private routing. Their separate `--out` directories retain each peer's `result.json` and the fixture's hash/size; do not use production storage or a tracker already used by the library. Once the fixture appears, connect the test phone over **USB ADB**, have a person switch it to cellular or unrelated Wi-Fi, then run `node android/e2e.mjs --serial <usb-serial> --tracker <key> --private-routing --apk <current-dev-apk> --out android/build/e2e-private-wan`. That script touches only `com.peartube.app.dev` (clears its test data), never the signed production app; stop for any Android system dialog and let the person answer it. Its pass condition includes advancing video/audio plus at least 256 KiB received privately and zero bytes on public-DHT/LAN replication paths. Record the seeder's proof and the phone's `result.json` and screenshots together. A USB connection matters: Wi-Fi ADB usually drops when the person switches to cellular. Without independent reachable relays, a fresh app build, and a person-operated phone network switch, do not report this as a WAN result.

`desktop/bundle.sh`, which `npm run app` runs, puts BareKit and the worklet's
native addons in the app's `Contents/Frameworks` and signs it ad hoc. A
`cargo run` binary finds them where the build left them instead.

Gradle needs JDK 17. On macOS, `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`
selects it (`android/release.sh` does this); the Android Gradle plugin's `jlink`
stage fails with JDK 27.

The Android app's Gradle build runs `android/worklet.mjs`, which packs `worklet/worker.js` with bare-pack and links the native addons it needs (sodium, udx, rocksdb, …) with bare-link, and runs cargo for `android/native`, the player library. On the Mac, `desktop/build.rs` does the same packing. In the worklet, `crypto` is `worklet/crypto`: SHA-256 on sodium-native, all the core and LAN discovery use, so neither app ships bare-crypto's 0.8 MB library.

The player library links with 16 KiB ELF load alignment, for Android devices
with 16 KiB pages, and with the build machine's home directory written as `~`
in its panic messages.

The release APK is 29.8 MB, and it takes about that much on a phone: its
native libraries are stored uncompressed and load straight from the APK. The
Dioxus app's APK was 18.7 MB, but Android unpacked a second copy of its
libraries at install, 61 MB in all. Android also compiles the app's Kotlin code
to machine code: a stock phone does it in the background, about 5 MB for this
app, and a phone set to compile every app at install adds 7.4 MB right away. A
debug build is twice the size and slower, so try size and speed with
`-Ppeartube.dev`, which builds the release as `com.peartube.app.dev`, signed
with the debug key.

On Android, macOS, and iOS the worklet runs on QuickJS, not V8: `worklet/bare-kit.sh` builds bare-kit with [libqjs](https://github.com/holepunchto/libqjs), Holepunch's QuickJS backend for the same engine ABI, so bare and the addons are unchanged. That makes `libbare-kit.so` 3.9 MB instead of 65.5 MB, and the APK 16.7 MB smaller.

CI runs core and Cast E2E suites and publishes the multi-arch `ghcr.io/ayooooo123/peartube-relay:latest` image on pushes to `main` (`.github/workflows/ci.yml`), and builds both the arm64 phone debug APK (`PearTube-debug-arm64`) and Android TV receiver debug APK (`PearTubeReceiver-debug-arm64`) on pushes touching `android/`, `worklet/`, or `src/` (`.github/workflows/android-app.yml`). Releases carry the signed phone and TV APKs from `android/release.sh` and `android/release-tv.sh` alongside the Mac app and receiver zips from `desktop/bundle.sh --zip` and `desktop/bundle.sh --receiver --zip`. Gradle signs APKs with `peartube.keystore`, `peartube.keystorePassword`, `peartube.keyAlias` and `peartube.keyPassword` from `~/.gradle/gradle.properties`, keeping the `com.peartube.app` package, signing key, and data paths for in-place upgrades while installing debug builds side by side as `com.peartube.app.dev`.

## Current status

- Most everyday testing so far has been native playback and basic P2P streaming. Casting (`peartube-cast/v1`), Stremio, M3U playlists, folder/feed import plugins, and multi-catalog directories pass automated end-to-end tests, but have had little real-world use yet.
- There is no browser upload button, and shared trackers (`peartube://tracker/…`) have no moderation yet: anyone with a tracker key can add duplicate or unwanted listings that crowd out other results. Share `peartube://channel/…` links publicly and keep tracker keys to trusted relays for now.
- Private routing (`PEARTUBE_PRIVATE_ROUTING=1`) is early alpha and does not make you anonymous. It needs testing across separate internet connections, requires at least four reachable relay hops, adds delay, and still exposes discovery/bootstrap traffic (see [Privacy rule](#privacy-rule)).
- Common video, audio, and subtitle formats play in `peartube-media`, but compatibility is not yet as broad as VLC's.
- Platform and access limits: `ios/` is a sideload development target; the Mac app (`arm64`) is not notarized yet, so macOS requires an extra step on first open; Windows and Linux desktop apps are not built yet; `/v1` authentication is just an optional single Bearer token on `POST`/`DELETE`.

## Goals

- Let community relays, NAS boxes, and viewers share hosting load without relying on one central media host.
- Support more formats and desktop/TV platforms in `peartube-media` while keeping the native apps small (~30 MB).
- Let people curate channels and directories while viewers still share pieces of the same video across catalogs.
- Make private routing and TV playback reliable outside local test setups.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged `archive/v0.3.0-platform`. Restore anything with `git checkout archive/v0.3.0-platform -- <path>`.

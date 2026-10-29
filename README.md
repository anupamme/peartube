# PearTube

PearTube lets you host videos on your own server or NAS and stream them between peers. Built with [Holepunch](https://holepunch.to).

Videos are split into small pieces so you can start watching or seek ahead before the whole file downloads. Relays, phones, desktops, and TVs fetch the pieces they need from whichever peers hold them, cache watched pieces locally, and share them with other viewers while online.

Catalogs come in two forms: **shared Trackers**, where anyone with the tracker key can add their own listings, and **personal Channels**, where only the channel owner can publish listings while subscribers still help distribute the catalog and video pieces.

## Run a relay

A relay is the PearTube service you run on a server or NAS to import and share videos.

```sh
npm install
npm start
```

A bare `npm start` founds a new tracker and prints its `tracker` and `channel` keys (`{"msg":"relay ready", ...}`). Open `http://<relay>:8174/` and finish setup under **Settings**: the address viewers stream from, LAN discovery, the tracker to join, HiveRelays, the import folder, feeds and copy limits. Settings are saved in `settings.json` in the data directory (mode `0600`, never in the Corestore). Each one is marked **Applies now** or **After restart**, and the page lists any changes still waiting for a restart. Environment variables still work and take precedence. A setting given by one shows **Set by PEARTUBE_…** and is read-only in the UI. Precedence is env var, then `settings.json`, then the default. Only `PEARTUBE_STORAGE`, `PEARTUBE_API_HOST`, `PEARTUBE_API_PORT` and `PEARTUBE_API_TOKEN` have to be set before starting.

The founded tracker's key is saved as the **Join a tracker** setting on first start. Without it, following a channel would make that channel the relay's primary catalog on the next start, and the relay's own library would drop out of view. A data directory that already lost it gets it back after one restart; Settings asks for that restart.

Settings can point the relay at folders on its disk. A relay without `PEARTUBE_API_TOKEN` already trusts its local network (anyone there can queue downloads), so devices on private addresses (LAN, Tailscale, loopback) can change settings too; clients from public addresses get `403` until the relay has a token. Settings are only accepted from the relay's own page, never from another website through your browser.

The web UI has five tabs:

| Tab | What it covers |
|---|---|
| Library | Adding videos, plus a poster grid (All / Movies / Shows / Videos, search) where shows group their episodes by season. Plays in the browser through `peartube-media` compiled to WebAssembly (MKV/AVI/MP4/TS, DTS/AC-3/TrueHD surround, PGS/ASS/SRT subtitles) or casts to a TV |
| Channels | Your tracker and channel, and the channels you follow |
| Sharing | Peers, copies kept for other relays, HiveRelays, and the Stremio and M3U addresses |
| TV | Pairing and controlling TVs |
| Settings | Relay configuration (see above) |

Stremio takes `http://<relay>:8174/manifest.json`. VLC, MPV, IINA and Kodi take `http://<relay>:8174/v1/playlist.m3u`. A Smart TV browser opens `http://<relay>:8174/tv`. Set `PEARTUBE_API_TOKEN` on any network you don't fully trust: the UI asks for it once, then keeps it in that browser.

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

There is no browser file upload. To get media onto a relay, paste a link into **Library → Add a video or channel**:

- A direct file link (`https://…/Movie.2008.1080p.mkv`) is fetched as is.
- A video page (YouTube, Vimeo and the other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports) needs `yt-dlp` on the relay's `PATH`. The relay resolves the page again on every attempt, because those media URLs expire, and stores one progressive file with both audio and video.

Before anything is added, the relay identifies the link. It parses title, year, `S01E02`, resolution, codec and audio from the filename, or reads the page's title, uploader, length and thumbnail through yt-dlp. Names that look like a movie or an episode get suggestions from [Cinemeta](https://v3-cinemeta.strem.io) (no key; change it or turn it off under **Settings → Title lookup service**). A suggestion is preselected only when the title matches exactly and the year agrees. A title you accept is announced as `imdb:tt…` (movie) or `imdb:tt…:s01e02` (episode), with the title `Name 2008` or `Name S01E02`: the ids Stremio and MediaStorm search by. Anything else stays a plain `clip:` video under its parsed or page title.

**Import a folder**, **Follow a feed** and **Copy a channel** sit under the same box. The API does the same from `curl`:

```sh
curl -X POST http://127.0.0.1:8174/v1/acquire \
  -H 'content-type: application/json' \
  -d '{"id":"imdb:tt0111161","title":"Example","source":{"url":"https://example.com/video.mp4"}}'
```

### Install on a system (agent quickstart)

When an AI coding/ops agent (Codex CLI, Claude Code, OpenCode, etc.) installs `peartube-relay` on a host, follow these rules so peers and players can actually reach it and the daemon survives after the agent turn ends:

1. **Host & network capability check**:
   - **Real Linux/macOS host, NAS, or VPS (including self-hosted remote `codex` CLI / SSH sessions)**: Supported. If the agent runs inside a command sandbox (such as Codex's `workspace-write` + `codex-network-proxy`), request unsandboxed/escalated execution: `HyperDHT` (`udx-native`) needs raw UDP sockets (cannot traverse an `HTTP_PROXY`), and the relay must be registered under Docker, `systemd`, or `launchd` so the agent's per-command process reaper does not kill it when the turn exits.
   - **OpenAI-hosted Codex Cloud VMs (`Work in > Cloud`)**: **Cannot** host a live public or LAN `peartube-relay`—the cloud VM sits behind an HTTP/HTTPS-only egress proxy that blocks raw `HyperDHT`/`UDX` UDP (even with Tailscale attached), exposes no inbound TCP/UDP ports, and hibernates between turns. In Codex Cloud, either run loopback-only tests against `createTestnet()` (`PEARTUBE_BOOTSTRAP=127.0.0.1:<port>`), drive an external relay's HTTPS `/v1/acquire` API via a Codex Network secret, or deploy the container below onto a real VPS.
2. **Settings before starting**: an unattended install sets these as env vars. Each one locks its setting in the web UI. Anything left unset can be set later under **Settings**.
   - Detect the machine's reachable LAN, Tailscale, or public IPv4 (`HOST_IP`) and set `PEARTUBE_STREAM_HOST=$HOST_IP` (leaving the `127.0.0.1` default breaks playback on every other device). On a LAN host, also set `PEARTUBE_LAN_HOST=$HOST_IP` for zero-config mDNS discovery.
   - Generate `PEARTUBE_API_TOKEN=$(openssl rand -hex 32)` on any non-loopback network (`GET` playback/Stremio/M3U routes stay open; `POST`/`PUT`/`DELETE` `/v1/*` and `/v1/settings` require `Authorization: Bearer <token>`). Keep `PEARTUBE_STORAGE` mode `0700` and env files mode `0600`.
   - Leave `PEARTUBE_TRACKER` unset to found a new catalog, or pass the user's existing `PEARTUBE_TRACKER` / `PEARTUBE_SOURCES` (add `PEARTUBE_REPLICATE=1` to mirror and seed remote blobs).
3. **Install and detach as a persistent service**:

   **Docker / Podman (fastest on Linux servers, NAS, or VPS; `linux/amd64` + `linux/arm64`)** — use `--network host` on Linux LAN hosts so `PEARTUBE_LAN_HOST` mDNS multicast (`224.0.0.251:5353`) and ephemeral LAN UDP ports reach the local network, or `-p 8174:8174 -p 8175:8175 -p 49737:49737/udp` with `-e PEARTUBE_DHT_PORT=49737` on a WAN VPS / macOS Docker Desktop:

   ```sh
   mkdir -p /srv/peartube-data && chmod 700 /srv/peartube-data
   API_TOKEN=$(openssl rand -hex 32)
   docker run -d --name peartube-relay --restart unless-stopped \
     --network host \
     -e PEARTUBE_STREAM_HOST=<lan-or-public-ip> \
     -e PEARTUBE_LAN_HOST=<lan-ipv4-if-on-lan> \
     -e PEARTUBE_API_TOKEN="$API_TOKEN" \
     -v /srv/peartube-data:/data \
     ghcr.io/ayooooo123/peartube-relay:latest
   ```

   **Native Linux (`systemd`, no Docker — requires Node >= 22, `git`, and `libatomic1` for `rocksdb-native`)**:

   ```sh
   sudo apt-get update && sudo apt-get install -y --no-install-recommends git curl ca-certificates libatomic1
   sudo useradd --system --home-dir /var/lib/peartube --shell /usr/sbin/nologin peartube || true
   sudo install -d -m 0700 -o peartube -g peartube /var/lib/peartube
   sudo install -d -m 0755 /etc/peartube
   sudo git clone https://github.com/ayooooo123/peartube.git /opt/peartube
   sudo npm --prefix /opt/peartube ci --omit=dev
   API_TOKEN=$(openssl rand -hex 32)
   sudo tee /etc/peartube/relay.env >/dev/null <<EOF
   PEARTUBE_STORAGE=/var/lib/peartube
   PEARTUBE_STREAM_HOST=<lan-or-public-ip>
   PEARTUBE_LAN_HOST=<lan-ipv4-if-on-lan>
   PEARTUBE_API_TOKEN=$API_TOKEN
   UV_THREADPOOL_SIZE=16
   EOF
   sudo chmod 0600 /etc/peartube/relay.env
   sudo tee /etc/systemd/system/peartube-relay.service >/dev/null <<'EOF'
   [Unit]
   Description=PearTube P2P Relay
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=peartube
   Group=peartube
   WorkingDirectory=/opt/peartube
   EnvironmentFile=/etc/peartube/relay.env
   ExecStart=/opt/peartube/node_modules/.bin/bare /opt/peartube/bin/relay.js
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload && sudo systemctl enable --now peartube-relay
   ```

   **Native macOS (`launchd` LaunchAgent — requires Node >= 22 and `git`)**:

   ```sh
   mkdir -p ~/.local/share/peartube/data ~/Library/LaunchAgents && chmod 700 ~/.local/share/peartube/data
   git clone https://github.com/ayooooo123/peartube.git ~/.local/share/peartube/app
   npm --prefix ~/.local/share/peartube/app ci --omit=dev
   API_TOKEN=$(openssl rand -hex 32)
   cat > ~/Library/LaunchAgents/com.peartube.relay.plist <<EOF
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>com.peartube.relay</string>
     <key>WorkingDirectory</key><string>$HOME/.local/share/peartube/app</string>
     <key>ProgramArguments</key><array>
       <string>$HOME/.local/share/peartube/app/node_modules/.bin/bare</string>
       <string>$HOME/.local/share/peartube/app/bin/relay.js</string>
     </array>
     <key>EnvironmentVariables</key><dict>
       <key>PEARTUBE_STORAGE</key><string>$HOME/.local/share/peartube/data</string>
       <key>PEARTUBE_STREAM_HOST</key><string><lan-ipv4></string>
       <key>PEARTUBE_LAN_HOST</key><string><lan-ipv4></string>
       <key>PEARTUBE_API_TOKEN</key><string>$API_TOKEN</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>$HOME/.local/share/peartube/relay.log</string>
     <key>StandardErrorPath</key><string>$HOME/.local/share/peartube/relay.log</string>
   </dict></plist>
   EOF
   chmod 600 ~/Library/LaunchAgents/com.peartube.relay.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.peartube.relay.plist
   ```

4. **Verify and report**:
   - Poll `curl -fsS http://127.0.0.1:8174/v1/status` until `tracker` and `channel` are 64-character hex keys, and confirm `curl -fsSI http://127.0.0.1:8174/manifest.json` returns `200 OK`.
   - Return the Web UI (`http://<host>:8174/`), Smart TV page (`http://<host>:8174/tv`), Stremio addon (`http://<host>:8174/manifest.json`), M3U playlist (`http://<host>:8174/v1/playlist.m3u`), public read-only channel URI (`peartube://channel/<status.channel>`), private shared tracker key (`<status.tracker>`), and the path holding `PEARTUBE_API_TOKEN`.

Every variable except `PEARTUBE_STORAGE`, `PEARTUBE_API_HOST`, `PEARTUBE_API_PORT`, `PEARTUBE_API_TOKEN`, `PEARTUBE_SOURCES`, `PEARTUBE_PLUGINS_DIR` and the `PEARTUBE_PRIVATE_RELAY*` guard mode is also a setting in the web UI. When one is set, it overrides that setting and locks it in the UI.

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
| `PEARTUBE_PRIVATE_ROUTING` | off | `1`: routes swarm connections over two-hop encrypted guard circuits on stock HyperDHT; endpoint peer addresses and tracker keys are never announced publicly |
| `PEARTUBE_PRIVATE_RELAY` | off | `1`: run a standalone Corestore-free guard forwarder (`bin/private-relay.js` / `peartube-private-relay`); cannot be combined with tracker or content flags |
| `PEARTUBE_PRIVATE_RELAY_PORT` | `PEARTUBE_DHT_PORT` | Dedicated UDP port for the standalone private guard forwarder |
| `PEARTUBE_RELAY_THROUGH` | none | Comma-separated blind relay keys |
| `PEARTUBE_LAN_HOST` | off | This machine's LAN IPv4; turns on mDNS discovery of relays on the local network |
| `PEARTUBE_SOURCES` | none | Comma-separated extra channel/tracker keys or `peartube://` URIs to subscribe to |
| `PEARTUBE_PUBLISH_CHANNEL` | `1` on relays | List this relay's saved videos and future imports in its own channel without duplicating the media (`0` disables) |
| `PEARTUBE_DIRECTORY` | off | `1`: publish a list of subscribed channels and trackers so other peers can discover them |
| `PEARTUBE_WATCH_DIR` | none | Optional local folder (e.g. `/data/import`) automatically imported once per file |
| `PEARTUBE_MIRROR_FEEDS` | none | Optional comma-separated JSON feed or peer `/v1/entries` URLs to import automatically |
| `PEARTUBE_REPLICATE` | off | `1` (or comma-separated source/writer keys) to P2P-replicate all remote video blobs locally without duplicating catalog entries |
| `PEARTUBE_REPLICATE_FREE_GB` | `20` | Minimum free disk GiB kept in reserve on `PEARTUBE_STORAGE` when `PEARTUBE_REPLICATE` is active |
| `PEARTUBE_REPLICATE_MBPS` | `80` | Shared download cap for `PEARTUBE_REPLICATE` backfill, so a replica never takes the seeder capacity (or its own disk) that viewers need; `0` removes the cap. Backfill also stops while any connected relay reports it is serving viewers (more than 1 Mbps to non-bulk peers, held 3 s, sent over the `peartube/bulk-busy` channel) and resumes after |
| `PEARTUBE_HIVERELAYS` | none | Optional comma-separated [HiveRelay](https://github.com/bigdestiny2/P2P-Hiverelay) (`v0.24.x`/`v0.26.x`) HTTP URLs (`http://host:9100=TOKEN` or bare URLs) recruited as supplemental public-channel & blob seeders |
| `PEARTUBE_HIVERELAY_API_KEY` | none | Optional shared Bearer API key fallback for `PEARTUBE_HIVERELAYS` entries without an inline `=TOKEN` |
| `PEARTUBE_HIVERELAY_DISCOVER` | off | `1`: discover open/allowlisted HiveRelays on the `hiverelay-discovery-v1` DHT topic and broadcast publisher-signed `hiverelay.seed-request.v3` requests (`publisherPubkey` exposed on `/v1/plugins`) |
| `PEARTUBE_HIVERELAY_REPLICAS` | `3` | Target P2P HiveRelay replica count when `PEARTUBE_HIVERELAY_DISCOVER` or unauthenticated relay URLs are used |
| `PEARTUBE_HIVERELAY_UPLOAD_MBPS` | `50` | Shared upload cap for bulk peers that don't pace themselves: HiveRelays (peers that open `hiverelay-seed` without sending seed requests and don't answer `peartube/bulk-busy`), over both public and LAN connections. While over it their connections are paused. PearTube replica relays are never paused; they follow `PEARTUBE_REPLICATE_MBPS` and stand down while viewers watch. Viewer apps are never capped. `0` removes the cap |
| `PEARTUBE_PLUGINS_DIR` | `<PEARTUBE_STORAGE>/plugins` | Directory scanned on startup for custom import plugins (`*.mjs` / `*.js`; `/data/plugins` in Docker) |
| `PEARTUBE_ACQUIRE_CONCURRENCY` | `4` | Maximum concurrent HTTP acquisition downloads |
| `PEARTUBE_CINEMETA_URL` | `https://v3-cinemeta.strem.io` | Cinemeta-compatible service that suggests movie and episode matches for added links; empty turns lookups off |
| `PEARTUBE_ALLOWED_PEERS` | none | Optional comma-separated 64-hex peer Noise public keys allowed through the swarm firewall |
| `PEARTUBE_API_TOKEN` | none | Optional Bearer token required on mutating `POST`/`PUT`/`DELETE` `/v1/*` routes and on `/v1/settings` |

### Reachability

HyperDHT cannot holepunch between two randomized NATs (it aborts the holepunch). Relays on the same network can still find each other: set `PEARTUBE_LAN_HOST` on each, and they discover one another over mDNS and connect directly over ephemeral UDP ports, with no internet path or port forward. This works across subnets when the router reflects mDNS and routes UDP between them. For relays on different networks, forward a UDP port and set `PEARTUBE_DHT_PORT`, or use a blind relay via `PEARTUBE_RELAY_THROUGH`.

Private routing connects peers over **two-hop encrypted UDX-spliced guard circuits** on unmodified `hyperdht`. It requires at least two reachable, `/24`-diverse guard forwarders (`peartube-private-relay` / `node bin/private-relay.js`, or `PEARTUBE_PRIVATE_RELAY=1` alone with no tracker/content flags), which open zero Corestore or media state on disk and auto-discover over global DHT guard topics. Private endpoints auto-discover guards fresh on each boot, never announce endpoint IPs or `tracker.discoveryKey` publicly, disable LAN mDNS, and fail closed if fewer than two diverse guards are reachable.

## UI and API

One port serves the web UI at `/`, the `/v1` API, the Stremio v3 addon, the M3U8 playlist, and `/tv`. By default there is no auth: run an open relay on a trusted network only, because anyone who can reach it can queue a download of any URL. Setting `PEARTUBE_API_TOKEN` requires `Authorization: Bearer <token>` on `POST`, `PUT` and `DELETE` `/v1/*` routes and on `/v1/settings`, while keeping the other `GET` routes open for players.

| Route | Does |
|---|---|
| `GET /` | Web UI: library, channels, sharing, TV, settings |
| `GET /v1/settings`, `PUT /v1/settings` `{key: value, …}` | Relay settings with each one's `value`, `source` (`env`/`file`/`default`), `env` name and `live` flag, plus `restartNeeded`. Saved in `settings.json`. Without `PEARTUBE_API_TOKEN`, only clients on private addresses may use it; a cross-origin `Origin` is refused (`403` either way). Env-set keys answer `409`; secrets and tokens inside URLs are never returned (list URLs come back as `{ref, label}`, and `"#n"` keeps one on update) |
| `POST /v1/identify` `{url}` | What a link holds: `link` (file name, size, or page title, uploader, length and thumbnail through yt-dlp), `parsed` name parts, Cinemeta `candidates` with their `imdb:…` ids and titles, `match` (an exact title and year), and a `plain` `clip:` fallback |
| `GET /v1/poster/:tt` | Redirect to Cinemeta's poster for an identified entry |
| `GET /v1/search?id=imdb:tt0944947:s01e02` | Tracker entries for an id, each with a `streamUrl`. One result per file (`id` + `sha256`): when several writers announced the same file, the copy most likely to play wins (owned, then most cached here, then a per-video core, then the tracker founder's). Copies from writers that were reset point at data nobody stores, and only their writer could remove them |
| `GET /v1/entries` | Every tracker entry, one per file, same shape as search |
| `POST /v1/acquire` `{id, title, source: {url, headers, page}}` | Fetch a source, store it, announce it; `page: true` resolves a video page through yt-dlp on every attempt |
| `GET /v1/jobs`, `GET /v1/jobs/:jobId`, `DELETE /v1/jobs/:jobId` | Acquire jobs (sources are never returned). `DELETE` cancels a queued or running job and removes a finished, failed or cancelled one |
| `GET /v1/status` | Tracker, writer and blob keys, stored bytes, peers and per-transport replication traffic, `lan` (`{host, port}` while LAN discovery runs), `privateRouting`, `tokenRequired`, and `settingsOpen` (whether this client may use `/v1/settings`) |
| `GET /v1/sources` | Followed trackers/channels, this node's `channel` key, and catalogs discovered through peers |
| `POST /v1/sources` `{uri}` or `{key, kind, alias}`, `DELETE /v1/sources/:key` | Follow or remove a shared tracker or channel |
| `POST /v1/channel/publish`, `DELETE /v1/channel/sources/:key` | Publish an entry or a link to another catalog (`{type: "source", sourceKey, kind, title, target}`), or remove a catalog link |
| `POST /v1/open` `{uri}`, `GET /v1/resolve?uri=…` | Open a `peartube://channel/…`, `peartube://tracker/…`, `peartube://receiver/…` pairing link, or direct `peartube://watch/…` video link without subscribing first |
| `POST /v1/cache/clear` `{key?}` | Clear cached video data for one entry or all non-local streams |
| `GET /v1/events` | Server-Sent Events (`text/event-stream`) live update stream for external UIs |
| `GET /manifest.json`, `/catalog/:type/:id.json`, `/stream/:type/:id.json` | Stremio v3 addon (`tt…`, `tt…:S:E`, `imdb:…`) |
| `GET /v1/plugins`, `POST /v1/plugins/:name/run`, `POST /v1/mirror` | List or run import & seeder plugins (`http-acquire`, `channel-backfill`, `blob-rechunk`, `watch-dir`, `feed-mirror`, `p2p-replicate`, `hiverelay-seed`, plus `/data/plugins/*.mjs` modules) |
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

Phones (Android: `android/app/`, `com.peartube.app`; iOS development target: `ios/`, `com.peartube.app.dev`) and Macs (`desktop/` `PearTube`) stay pure sender, library, and local-player apps. Mobile apps do not have a receive-cast screen or incoming-cast playback mode. Receiver functionality is reserved for the dedicated TV clients below, which expose zero library, channel, search, or settings UI while running a headless P2P / 2-hop `privateRouting` peer engine underneath (`src/cast.js`):

1. **Android TV / Google TV / Fire TV / Pi Receiver APK (`android/tv/`, `com.peartube.receiver`)**: Standalone Leanback/launcher receiver APK (`sh android/release-tv.sh` → `PearTubeReceiver-<version>-arm64.apk`), showing only the 10-foot QR idle screen and decoding MKV/AVI/MP4/HEVC/XviD/FLAC/TrueHD/ASS/PGS natively through `libpeartube.so` with full local D-pad/media-remote controls (Play/Pause, ±10 s, focusable seek bar, Audio & Subtitle track pickers, decoder telemetry, smart Back-to-hide / Back-to-stop) synced back to the sender, plus screensaver wake-on-cast.
2. **Desktop / HTPC Receiver Binary (`PearTubeReceiver`)**: Standalone macOS/HTPC dumb-receiver binary (`cargo run --manifest-path desktop/Cargo.toml --bin PearTubeReceiver`) backed by `peartube-media`'s hardware/software decoder pipeline with full local seek, Play/Pause, ±10 s, Audio/Subtitle track menus, Fullscreen, and Stop controls.
3. **Smart TV Web Receiver (`/tv`)**: Zero-install HTML5/SSE fullscreen dumb receiver for LG webOS, Samsung Tizen, game consoles, and TV browsers—open `http://<sender-or-relay-lan-ip>:8177/tv` (or `:8174/tv` on a relay, `:8176/tv` on `peartube-receiver`) with local D-pad/pointer Play/Pause, ±10 s, seek, Mute, Fullscreen, and Stop controls.
4. **Portable Receiver Daemon (`bin/receiver.js` / `npm run receiver`)**: Runs in full Hybrid P2P+HTTP mode or `--thin` network-only mode (`--player web|mpv|vlc|headless|cmd:…`), and serves as the reference implementation for thin media platforms (tvOS Swift, Roku BrightScript, Kodi, set-top boxes):
   - **Discovery & Pairing**: Advertises `_peartube-cast._tcp` over LAN mDNS (`txt`: `v=1`, `id`, `name`, `h=<lanIp>`, `pk=<noisePubKey>`, `p2p=1|0`, `auth=code|open`) and displays a 6-character TV pairing code (`POST /cast/v1/pair {code}` → persistent bearer `token` stored privately in `cast-receivers.json`). P2P-capable receivers also listen on HyperDHT with a persistent Noise keypair (`peartube://receiver/<64-hex-pubkey>?token=…`) so paired senders can cast and control across subnets, VLANs, or NATs.
   - **Autonomous P2P & Private-Routing Peer Handoff**: Once a cast starts on a P2P-capable receiver (`p2p=1`), the receiver adopts the initiator's network mode—joining as a normal public/LAN swarm peer (`mode: "p2p"`) or automatically spinning up a 2-hop encrypted private-routing peer (`mode: "private-p2p"`, failing closed with zero public DHT or cleartext HTTP/LAN exposure when `privateRouting` is enabled on the initiator). Native P2P receivers stream directly from their local [`hypercore-blob-server`](https://github.com/holepunchto/hypercore-blob-server) (a linear download range from the playhead) while browser Web TVs use the LAN `/cast/v1/hybrid/` Range splice, continuing to play and seed cached blocks after the initiator disconnects (`POST /v1/cast/attach` reconnects a remote control later; `Detach` leaves the TV playing on its own).
   - **Wire Endpoints (Thin Receiver Contract)**: `GET /cast/v1/info`, `POST /cast/v1/pair`, `POST /cast/v1/command` (`load`, `play`, `pause`, `togglePlay`, `seek`, `skip`, `selectAudio`, `selectSubtitle`, `volume`, `stop`, `status`), and `GET /cast/v1/events` (`text/event-stream` pushing `{event: "state", state}`), mirrored identically as NDJSON over HyperDHT Noise `SecretStream`.

Job status: `queued` → `running` (fetching; `bytes` of `total`) → `announcing` (stored, being published to the tracker) → `done`; or `failed` / `cancelled`. A job is `done` only once its announce is on disk; after a restart, `announcing` jobs re-announce without re-fetching.

Ids look like `imdb:tt0111161` for movies and `imdb:tt0944947:s01e02` for episodes.

`status.routes.private`, `.public` and `.lan` each contain live `peers`, cumulative `rxBytes` / `txBytes` (including closed connections), and sampled `downBps` / `upBps`. The top-level byte totals equal the sums of the paths; top-level rates cover the same traffic but may differ by rounding. `public` means the public-DHT swarm, not proof of a direct IP connection: `relayThrough` can insert a blind relay. The relay UI and both apps show the split; their P2P summaries retain cumulative per-path bytes after a transfer ends.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data: the tracker and the blobs. Several things live in private files in the data directory and are never replicated: acquire jobs with their source URLs and headers in `jobs.json`, and relay settings (feed URLs, HiveRelay keys) in `settings.json`. A video page's thumbnail is shown only while you confirm the add and is never announced. An identified entry carries nothing beyond its `imdb:…` id and title.

Private-only peers exchange ten-minute, periodically renewed inner Noise public keys inside the tracker and seal route descriptors (`G_S` + expiring `routeToken`) behind `crypto_secretbox` keys derived from the tracker or peer public key. Consenting stateless guard forwarders (`bin/private-relay.js`) forward encrypted UDX packets in RAM (`relayTo`) with zero Corestore or Hypercore protocol participation, and every endpoint dials both inbound and outbound strictly through `/24`-diverse guards (`Peer_A -> G_A <-> G_B <- Peer_B`), rejecting endpoint or unadvertised direct hop-open attempts. Because guards are auto-discovered on the open DHT, `/24` diversity enforces network-prefix separation rather than proving independent operators: a monitor running its own advertised `/24` guard can act as `G_A` to reach `G_B` across one non-controlled guard (still never seeing the seeder's IP unless `G_B` also colludes or is seized), and this topology does not provide legal immunity or defeat provider flow logs or global traffic correlation.

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

Local investigations and capture references live in the private Obsidian
vault: `PearTube Client Release History`, `PearTube TV Playback Diagnostics`
and `PearTube Private Network Experiments`. This README describes the
current app and repeatable commands.

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

On TVs with adopted external storage, install upgrades onto the existing
volume (`pm install -r --force-uuid <volume-UUID> <on-device-apk>`), then
verify `/cast/v1/info` still reports the same receiver identity and
`externalStorage: true`. An ordinary `adb install -r` can move the app
back to internal storage, stranding its identity and cached blobs.

For an upcoming TV/P2P test, start device-side packet evidence **before** playback (not during someone else's run):

```sh
node android/capture-network.mjs --serial <rooted-TV-adb-serial> --receiver http://<tv-ip>:8176 --out android/build/e2e-captures/tv-run-1 --seconds 7200
# Or wrap a fresh automated run; use a different directory from android/e2e.mjs --out, which clears its own output:
node android/capture-network.mjs --serial <rooted-TV-adb-serial> --receiver http://<tv-ip>:8176 --out android/build/e2e-captures/phone-tv-run-1 -- node android/e2e.mjs --serial <phone-adb-serial> --relay http://<relay>:8174
```

The runner requires a root ADB shell and `tcpdump` **on each captured device**, and refuses to run the test if capture cannot start. A rooted Pi 4 receiver has both; a stock Pixel 9 does not, so capture its traffic from a rooted peer or a router mirror rather than pretending a host-side Wi-Fi capture sees all unicast. Each run keeps a 128-byte-snaplen `peer-N.pcap` (network and loopback packet timing without full movie payload), epoch-time `peer-N.logcat.txt`, optional second-by-second `receiver.ndjson` with P2P route byte counters and buffering, and `capture.json` with clocks, versions, SHA-256 hashes and command exit. SIGINT and normal completion stop only the capture's remote `tcpdump` PID. The packet headers, logs and receiver state can disclose addresses or pairing URLs: keep these private artifacts under `android/build/`, never attach them to a public release. Capturing packets adds some load; compare with a run without capture before attributing small cadence losses to the player.

The trace spools to `/data/local/tmp` on the rooted receiver while recording, excludes ADB's TCP/5555 feedback traffic, and is pulled to the private result directory only after capture stops. Keep the Pi connected until that final pull finishes; on failure `capture.json` retains the on-device path for recovery.

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
- Private routing (`PEARTUBE_PRIVATE_ROUTING=1`) is early alpha and does not make you anonymous. It needs testing across separate internet connections, requires at least two reachable prefix-diverse guards, adds delay, and still exposes discovery/bootstrap traffic (see [Privacy rule](#privacy-rule)).
- Common video, audio, and subtitle formats play in `peartube-media`, but compatibility is not yet as broad as VLC's.
- Platform and access limits: `ios/` is a sideload development target; the Mac app (`arm64`) is not notarized yet, so macOS requires an extra step on first open; Windows and Linux desktop apps are not built yet; `/v1` authentication is just an optional single Bearer token on `POST`/`DELETE`.

## Goals

- Let community relays, NAS boxes, and viewers share hosting load without relying on one central media host.
- Support more formats and desktop/TV platforms in `peartube-media` while keeping the native apps small (~30 MB).
- Let people curate channels and directories while viewers still share pieces of the same video across catalogs.
- Make private routing and TV playback reliable outside local test setups.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged `archive/v0.3.0-platform`. Restore anything with `git checkout archive/v0.3.0-platform -- <path>`.

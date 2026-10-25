FROM docker.io/qmcgaw/gluetun:latest AS gluetun
FROM docker.io/library/node:22-bookworm-slim
# rocksdb-native links libatomic; openvpn + iptables + gluetun-entrypoint let relay containers run their own VPN tunnel without a sidecar container.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 git ca-certificates openvpn iptables iproute2 && rm -rf /var/lib/apt/lists/* && ln -sf /usr/sbin/openvpn /usr/sbin/openvpn2.6 && usermod -l nonrootuser -g 0 node && mkdir -p /etc/openvpn /tmp/gluetun
COPY --from=gluetun /gluetun-entrypoint /gluetun-entrypoint
COPY --from=gluetun /gluetun /gluetun
WORKDIR /app
COPY package.json package-lock.json ./
COPY worklet/crypto ./worklet/crypto
RUN npm ci --omit=dev --no-audit --no-fund && BARE_BIN=$(ls /app/node_modules/bare-runtime-linux-*/bin/bare | head -n 1) && chmod +x "$BARE_BIN" && ln -sfn bare-events node_modules/events && ln -sfn bare-dgram node_modules/dgram && ln -sfn bare-os node_modules/os && ln -sfn bare-net node_modules/net && ln -sfn peartube-crypto node_modules/crypto && ln -sfn bare-buffer node_modules/buffer && ln -sfn "$BARE_BIN" /usr/local/bin/bare && rm -f /usr/sbin/openvpn2.6 && printf '#!/bin/sh\nsed -i "/^user *\$/d" /etc/openvpn/target.ovpn 2>/dev/null || true\ngrep -q "^sndbuf " /etc/openvpn/target.ovpn 2>/dev/null || printf "\\nsndbuf 4194304\\nrcvbuf 4194304\\n" >> /etc/openvpn/target.ovpn 2>/dev/null || true\nexec /usr/sbin/openvpn "$@"\n' > /usr/sbin/openvpn2.6 && chmod +x /usr/sbin/openvpn2.6
COPY patches/hyperdht-private ./node_modules/hyperdht/lib/private
COPY src ./src
COPY bin ./bin
COPY web/assets ./web/assets
ENV PEARTUBE_STORAGE=/data UV_THREADPOOL_SIZE=16
VOLUME /data
EXPOSE 8174 8175
ENV VPN_TYPE=openvpn VPN_INTERFACE=tun0 OPENVPN_PROTOCOL=udp OPENVPN_VERSION=2.6 OPENVPN_VERBOSITY=1 OPENVPN_PROCESS_USER=nonrootuser VPN_PORT_FORWARDING_LISTENING_PORTS=0 VPN_PORT_FORWARDING_PORTS_COUNT=1 VPN_PORT_FORWARDING_STATUS_FILE=/tmp/gluetun/forwarded_port PORT_FORWARD_ONLY=on SERVER_SELECTION_MODE=random OWNED_ONLY=no FIREWALL_IPTABLES_LOG_LEVEL=info LOG_LEVEL=info HEALTH_SERVER_ADDRESS=127.0.0.1:9999 HEALTH_TARGET_ADDRESSES=cloudflare.com:443,github.com:443 HEALTH_ICMP_TARGET_IPS=1.1.1.1,8.8.8.8 HEALTH_SMALL_CHECK_TYPE=icmp HEALTH_RESTART_VPN=on METRICS_TYPE=noop METRICS_PROMETHEUS_LISTENING_ADDRESS=:9090 DNS_SERVER=on DNS_UPSTREAM_RESOLVER_TYPE=DoT DNS_CACHING=on DNS_UPSTREAM_IPV6=off BLOCK_MALICIOUS=on BLOCK_ADS=off DNS_UPDATE_PERIOD=24h HTTPPROXY_LOG=off HTTPPROXY_LISTENING_ADDRESS=:8888 HTTPPROXY_STEALTH=off SHADOWSOCKS=off SHADOWSOCKS_LOG=off SHADOWSOCKS_LISTENING_ADDRESS=:8388 SHADOWSOCKS_CIPHER=chacha20-ietf-poly1305 SOCKS5_ENABLED=off SOCKS5_LISTENING_ADDRESS=:1080 HTTP_CONTROL_SERVER_LOG=on HTTP_CONTROL_SERVER_ADDRESS=:8000 HTTP_CONTROL_SERVER_AUTH_CONFIG_FILEPATH=/gluetun/auth/config.toml UPDATER_PERIOD=0 UPDATER_MIN_RATIO=0.8 UPDATER_PREFER_DIRECT_DOWNLOAD=no PUBLICIP_FILE=/tmp/gluetun/ip PUBLICIP_ENABLED=on PUBLICIP_API=ipinfo,ifconfigco,ip2location,cloudflare STORAGE_SERVERS_ENABLED=on STORAGE_SERVERS_DIRECTORY_PATH=/gluetun/servers/ PPROF_ENABLED=no PPROF_BLOCK_PROFILE_RATE=0 PPROF_MUTEX_PROFILE_RATE=0 PPROF_HTTP_SERVER_ADDRESS=:6060 VERSION_INFORMATION=on PUID=1000 PGID=1000 PMTUD_ICMP_ADDRESSES=1.1.1.1,8.8.8.8 PMTUD_TCP_ADDRESSES=1.1.1.1:443,8.8.8.8:443,1.1.1.1:53,8.8.8.8:53 IPV6_CHECK_ADDRESSES=[2001:4860:4860::8888]:53,[2606:4700:4700::1111]:53
CMD ["sh", "-c", "if [ -n \"$VPN_SERVICE_PROVIDER\" ]; then echo 3.20.0 > /etc/alpine-release && /gluetun-entrypoint & sleep 2 && rm -f /etc/alpine-release; fi; while true; do bare bin/relay.js || true; sleep 1; done"]

//! What the app joins: an optional primary tracker, subscribed channels/trackers,
//! optional blind relays, DHT bootstrap, LAN discovery (on by default on fresh installs),
//! and private routing. Kept in private settings.json, never inside Corestore.

use serde::{Deserialize, Serialize};

use crate::worker::DATA_DIR;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceSpec {
    pub key: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub alias: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Primary open tracker key, 64 hex characters. May be empty when `sources` is non-empty.
    pub tracker: String,
    /// Subscribed channels (`kind: "channel"`) and additional trackers (`kind: "tracker"`).
    pub sources: Vec<SourceSpec>,
    /// Blind relay keys, for peers behind two randomized NATs.
    pub relay_through: Vec<String>,
    /// DHT bootstrap nodes as host:port; empty means the public DHT.
    pub bootstrap: Vec<String>,
    /// Find relays and peers on the local network over mDNS.
    pub lan_discovery: bool,
    /// Route peer connections over 4-hop encrypted relay circuits.
    pub private_routing: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            tracker: String::new(),
            sources: Vec::new(),
            relay_through: Vec::new(),
            bootstrap: Vec::new(),
            lan_discovery: true,
            private_routing: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSettings {
    #[serde(default)]
    tracker: String,
    #[serde(default)]
    sources: Vec<SourceSpec>,
    #[serde(default)]
    relay_through: Vec<String>,
    #[serde(default)]
    bootstrap: Vec<String>,
    #[serde(default)]
    lan_discovery: bool,
    #[serde(default)]
    private_routing: bool,
}

impl Settings {
    pub fn has_sources(&self) -> bool {
        !self.tracker.is_empty() || !self.sources.is_empty()
    }

    pub fn load() -> Settings {
        std::fs::read(DATA_DIR.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RawSettings>(&bytes).ok())
            .map(|r| Settings {
                tracker: r.tracker,
                sources: r.sources,
                relay_through: r.relay_through,
                bootstrap: r.bootstrap,
                lan_discovery: r.lan_discovery,
                private_routing: r.private_routing,
            })
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let file = DATA_DIR.join("settings.json");
        let tmp = file.with_extension("json.tmp");
        std::fs::create_dir_all(&*DATA_DIR).map_err(|err| err.to_string())?;
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|err| err.to_string())?).map_err(|err| err.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|err| err.to_string())
    }

    pub fn format_sources(&self) -> String {
        self.sources
            .iter()
            .map(|s| {
                if s.alias.is_empty() {
                    format!("peartube://{}/{}", s.kind, s.key)
                } else {
                    format!("peartube://{}/{}?name={}", s.kind, s.key, s.alias)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn add_or_update_source(&mut self, spec: SourceSpec) {
        if spec.kind == "tracker" && self.tracker == spec.key {
            return;
        }
        if let Some(existing) = self.sources.iter_mut().find(|s| s.key == spec.key) {
            existing.kind = spec.kind;
            if !spec.alias.is_empty() {
                existing.alias = spec.alias;
            }
        } else {
            self.sources.push(spec);
        }
    }

    /// Settings from the form's fields. Accepts raw 64-hex keys and `peartube://` URIs.
    pub fn parse(tracker: &str, sources_raw: &str, relay_through: &str, bootstrap: &str, lan_discovery: bool, private_routing: bool) -> Result<Settings, String> {
        let mut primary = String::new();
        let mut sources: Vec<SourceSpec> = Vec::new();
        let tr = tracker.trim();
        if !tr.is_empty() {
            let parsed = parse_source_token(tr, "tracker")?;
            if parsed.kind == "tracker" {
                primary = parsed.key;
            } else {
                sources.push(parsed);
            }
        }
        for token in split_lines_or_commas(sources_raw) {
            let spec = parse_source_token(token, "channel")?;
            if spec.kind == "tracker" && primary.is_empty() && sources.is_empty() {
                primary = spec.key;
            } else if spec.key != primary && !sources.iter().any(|s| s.key == spec.key) {
                sources.push(spec);
            }
        }
        if primary.is_empty() && sources.is_empty() {
            return Err("Add at least one tracker key or peartube:// channel.".into());
        }
        let relay_through: Vec<String> = split(relay_through).map(str::to_lowercase).collect();
        if let Some(bad) = relay_through.iter().find(|key| !is_key(key)) {
            return Err(format!("Relay key {bad} is not 64 hex characters."));
        }
        let bootstrap: Vec<String> = split(bootstrap).map(String::from).collect();
        if let Some(bad) = bootstrap.iter().find(|node| !is_host_port(node)) {
            return Err(format!("Bootstrap node {bad} is not host:port."));
        }
        Ok(Settings { tracker: primary, sources, relay_through, bootstrap, lan_discovery, private_routing })
    }
}

pub fn parse_source_token(raw: &str, default_kind: &str) -> Result<SourceSpec, String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_lowercase();
    if is_key(&lower) {
        return Ok(SourceSpec { key: lower, kind: default_kind.into(), alias: String::new() });
    }
    if let Some((prefix, key)) = lower.split_once(':')
        && (prefix == "channel" || prefix == "tracker")
        && is_key(key)
    {
        return Ok(SourceSpec { key: key.into(), kind: prefix.into(), alias: String::new() });
    }
    let rest = trimmed
        .strip_prefix("peartube://")
        .or_else(|| trimmed.strip_prefix("PEARTUBE://"))
        .or_else(|| trimmed.strip_prefix("peartube:"))
        .ok_or_else(|| format!("Invalid key or peartube:// URI: {trimmed}"))?;
    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, q),
        None => (rest, ""),
    };
    let (verb, body) = path.split_once('/').ok_or_else(|| format!("Invalid peartube:// URI: {trimmed}"))?;
    let verb = verb.to_lowercase();
    let key = body.trim().to_lowercase();
    if !is_key(&key) {
        return Err(format!("Source key in {trimmed} is not 64 hex characters."));
    }
    let mut kind = match verb.as_str() {
        "channel" => "channel".to_string(),
        "tracker" => "tracker".to_string(),
        "add" | "source" => default_kind.to_string(),
        _ => return Err(format!("Expected peartube://channel/... or peartube://tracker/..., got {verb}")),
    };
    let mut alias = String::new();
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        if let Some((k, v)) = pair.split_once('=') {
            let val = percent_decode(v);
            if k == "kind" && (val == "channel" || val == "tracker") {
                kind = val;
            } else if k == "name" || k == "alias" {
                alias = val;
            }
        }
    }
    Ok(SourceSpec { key, kind, alias })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(val) = u8::from_str_radix(hex, 16)
        {
            out.push(val);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split(list: &str) -> impl Iterator<Item = &str> {
    list.split(|c: char| c == ',' || c.is_whitespace()).filter(|s| !s.is_empty())
}

fn split_lines_or_commas(list: &str) -> impl Iterator<Item = &str> {
    list.split(['\n', '\r', ',']).map(str::trim).filter(|s| !s.is_empty())
}

pub fn is_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_host_port(node: &str) -> bool {
    node.rsplit_once(':').is_some_and(|(host, port)| !host.is_empty() && port.parse::<u16>().is_ok_and(|p| p > 0))
}

//! The P2P worker: a Bare worklet (bare-kit) running `worklet/worker.js`, which
//! is the relay's own core. We talk to it in newline-delimited JSON over
//! bare-kit's IPC pipes; worker.js documents the messages.

use std::collections::HashMap;
use std::ffi::{CString, c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use futures_channel::{mpsc, oneshot};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::settings::Settings;

// worklet/worker.js packed by build.rs with bare-pack.
static BUNDLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/worker.bundle"));

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTraffic {
    pub peers: u64,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub down_bps: u64,
    pub up_bps: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TrafficRoutes {
    #[serde(rename = "private")]
    pub private_route: RouteTraffic,
    #[serde(rename = "public")]
    pub public_route: RouteTraffic,
    pub lan: RouteTraffic,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub key: String,
    pub kind: String,
    #[serde(default)]
    pub alias: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub writable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSource {
    pub key: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub via: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reciprocity {
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub seeded_bytes: u64,
    #[serde(default)]
    pub contributing_peers: u64,
    #[serde(default)]
    pub ratio: f64,
    #[serde(default)]
    pub inflight_max: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tracker: String,
    #[serde(default)]
    pub channel: String,
    pub writer: String,
    pub blobs: String,
    pub blob_bytes: u64,
    #[serde(default)]
    pub cached_bytes: u64,
    pub peers: u64,
    pub lan_peers: u64,
    #[serde(default)]
    pub down_bps: u64,
    #[serde(default)]
    pub up_bps: u64,
    #[serde(default)]
    pub rx_bytes: u64,
    #[serde(default)]
    pub tx_bytes: u64,
    pub routes: TrafficRoutes,
    #[serde(default)]
    pub inflight_blocks: u64,
    #[serde(default)]
    pub rtt: u64,
    #[serde(default)]
    pub retransmits: u64,
    pub lan: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub sources: Vec<SourceInfo>,
    #[serde(default)]
    pub discovered_sources: Vec<DiscoveredSource>,
    #[serde(default)]
    pub reciprocity: Reciprocity,
}

/// One tracker or channel entry, matching `/v1/search` results.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub id: String,
    pub title: String,
    pub size: u64,
    pub sha256: String,
    pub local: bool,
    #[serde(default)]
    pub cached_bytes: u64,
    pub stream_url: String,
    #[serde(default)]
    pub magnet_url: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub source_kind: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUriResult {
    pub action: String,
    #[serde(default)]
    pub source: Option<SourceInfo>,
    #[serde(default)]
    pub entry: Option<Entry>,
    #[serde(default)]
    pub receiver: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastReceiver {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub paired: bool,
    #[serde(default)]
    pub p2p: bool,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub auth: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastTrack {
    pub stream: i32,
    pub kind: String,
    #[serde(default)]
    pub codec: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastEntryMeta {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastPlaybackState {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub entry: Option<CastEntryMeta>,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub playing: bool,
    #[serde(default)]
    pub buffering: bool,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub p2p_peers: u64,
    #[serde(default)]
    pub cached_bytes: u64,
    #[serde(default)]
    pub seeding: bool,
    #[serde(default)]
    pub tracks: Vec<CastTrack>,
    #[serde(default)]
    pub audio: Option<i32>,
    #[serde(default)]
    pub subtitle: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSession {
    pub receiver_id: String,
    pub receiver_name: String,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub state: CastPlaybackState,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverInfo {
    pub device_id: String,
    pub name: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub pair_code: String,
    #[serde(default)]
    pub pairing_uri: String,
    #[serde(default)]
    pub listen_url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastStatus {
    #[serde(default)]
    pub web_receiver_url: Option<String>,
    #[serde(default)]
    pub receivers: Vec<CastReceiver>,
    #[serde(default)]
    pub session: Option<CastSession>,
    #[serde(default)]
    pub receiver_mode: Option<ReceiverInfo>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverCommand {
    #[serde(default)]
    pub seq: u64,
    pub action: String,
    #[serde(default)]
    pub entry: Option<CastEntryMeta>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub stream_url: Option<String>,
    #[serde(default)]
    pub http_stream_url: Option<String>,
    #[serde(default)]
    pub start_position_ms: u64,
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub delta_ms: Option<i64>,
    #[serde(default)]
    pub stream: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A tracker, channel, or peer set changed.
    Update,
    /// Subscribed sources changed through the loopback HTTP daemon.
    Sources(Vec<SourceInfo>),
    /// Cast receivers, remote session, or local TV receiver metadata changed.
    Cast(CastStatus),
    /// A remote sender pushed a playback command into our local TV Receiver mode.
    ReceiverCommand(ReceiverCommand),
    /// The worker hit an uncaught error.
    Fatal(String),
    /// The worklet closed its IPC; no more replies will come.
    Exited,
}
#[repr(C)]
struct UvBuf {
    base: *const c_char,
    len: usize,
}

#[repr(C)]
struct WorkletOptions {
    memory_limit: usize,
    assets: *const c_char,
}

#[repr(C)]
struct BareWorklet {
    _opaque: [u8; 0],
}

#[repr(C)]
struct BareIpc {
    _opaque: [u8; 0],
}

unsafe extern "C" {
    fn bare_worklet_alloc(result: *mut *mut BareWorklet) -> c_int;
    fn bare_worklet_init(worklet: *mut BareWorklet, options: *const WorkletOptions) -> c_int;
    fn bare_worklet_start(worklet: *mut BareWorklet, filename: *const c_char, source: *const UvBuf, argc: c_int, argv: *const *const c_char) -> c_int;
    fn bare_worklet_suspend(worklet: *mut BareWorklet, linger: c_int) -> c_int;
    fn bare_worklet_resume(worklet: *mut BareWorklet) -> c_int;
    fn bare_ipc_alloc(result: *mut *mut BareIpc) -> c_int;
    fn bare_ipc_init(ipc: *mut BareIpc, worklet: *mut BareWorklet) -> c_int;
    fn bare_ipc_get_incoming(ipc: *mut BareIpc) -> c_int;
    fn bare_ipc_get_outgoing(ipc: *mut BareIpc) -> c_int;
}

type Reply = Result<Value, String>;

/// State shared with the IPC reader thread.
#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    subscribers: Mutex<Vec<mpsc::UnboundedSender<Event>>>,
}

pub struct Worker {
    worklet: *mut BareWorklet,
    outgoing: c_int,
    write: Mutex<()>,
    next_id: AtomicU64,
    shared: Arc<Shared>,
}

// The worklet handle is only passed to bare-kit calls, which are thread safe;
// everything else is behind a Mutex or atomic.
unsafe impl Send for Worker {}
unsafe impl Sync for Worker {}

static WORKER: LazyLock<Result<Worker, String>> = LazyLock::new(|| Worker::spawn(&DATA_DIR.join("bare-assets")));

/// The process's one worklet, started on first use.
pub fn worker() -> Result<&'static Worker, String> {
    WORKER.as_ref().map_err(Clone::clone)
}

impl Worker {
    fn spawn(assets: &Path) -> Result<Worker, String> {
        std::fs::create_dir_all(assets).map_err(|err| format!("Cannot create {}: {err}", assets.display()))?;
        let assets = CString::new(assets.to_string_lossy().as_bytes()).map_err(|err| err.to_string())?;
        let source = UvBuf { base: BUNDLE.as_ptr().cast(), len: BUNDLE.len() };
        let (incoming, outgoing, worklet) = unsafe {
            // A write to a worklet that has exited must fail with EPIPE, not kill the app.
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
            let mut worklet = std::ptr::null_mut();
            check(bare_worklet_alloc(&mut worklet), "alloc")?;
            let options = WorkletOptions { memory_limit: 0, assets: assets.as_ptr() };
            check(bare_worklet_init(worklet, &options), "init")?;
            // Returns once the source, filename and assets have been copied in.
            check(bare_worklet_start(worklet, c"/worker.bundle".as_ptr(), &source, 0, std::ptr::null()), "start")?;
            let mut ipc = std::ptr::null_mut();
            check(bare_ipc_alloc(&mut ipc), "IPC alloc")?;
            check(bare_ipc_init(ipc, worklet), "IPC init")?;
            (bare_ipc_get_incoming(ipc), bare_ipc_get_outgoing(ipc), worklet)
        };
        let shared = Arc::new(Shared::default());
        let reader = shared.clone();
        std::thread::Builder::new()
            .name("peartube-ipc".into())
            .spawn(move || reader.read(incoming))
            .map_err(|err| err.to_string())?;
        Ok(Worker { worklet, outgoing, write: Mutex::new(()), next_id: AtomicU64::new(1), shared })
    }

    pub async fn start(&self, settings: &Settings) -> Result<Status, String> {
        let folder = if settings.tracker.is_empty() { "default" } else { settings.tracker.as_str() };
        let storage = STORE_DIR.join("trackers").join(folder);
        let tracker = if settings.tracker.is_empty() { Value::Null } else { json!(settings.tracker) };
        let params = json!({
            "storage": storage.to_string_lossy(),
            "tracker": tracker,
            "sources": settings.sources,
            "relayThrough": non_empty(&settings.relay_through),
            "bootstrap": non_empty(&settings.bootstrap),
            "lan": settings.lan_discovery,
            "privateRouting": settings.private_routing,
        });
        parse(self.call("start", params).await?)
    }

    pub async fn status(&self) -> Result<Status, String> {
        parse(self.call("status", json!({})).await?)
    }

    /// Every entry for `id`, or the whole subscribed catalog when `id` is None.
    pub async fn search(&self, id: Option<&str>) -> Result<Vec<Entry>, String> {
        parse(self.call("search", json!({ "id": id })).await?)
    }

    pub async fn add_source(&self, key: &str, kind: &str, alias: &str) -> Result<SourceInfo, String> {
        let res = self.call("addSource", json!({ "key": key, "kind": kind, "alias": alias })).await?;
        parse(res.get("source").cloned().unwrap_or(Value::Null))
    }

    pub async fn remove_source(&self, key: &str) -> Result<(), String> {
        self.call("removeSource", json!({ "key": key })).await.map(drop)
    }

    pub async fn open_uri(&self, uri: &str) -> Result<OpenUriResult, String> {
        let storage = STORE_DIR.join("cast").to_string_lossy().to_string();
        parse(self.call("openUri", json!({ "uri": uri, "storage": storage })).await?)
    }


    pub async fn warm(&self, key: &str) -> Result<(), String> {
        self.call("warm", json!({ "key": key })).await.map(drop)
    }
    pub async fn clear_cache(&self, key: Option<&str>) -> Result<(), String> {
        self.call("clearCache", json!({ "key": key })).await.map(drop)
    }

    fn cast_dir() -> String {
        STORE_DIR.join("cast").to_string_lossy().to_string()
    }

    pub async fn cast_status(&self) -> Result<CastStatus, String> {
        parse(self.call("castStatus", json!({ "storage": Self::cast_dir() })).await?)
    }

    pub async fn cast_pair(&self, params: Value) -> Result<CastStatus, String> {
        let mut body = params;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("storage").or_insert_with(|| json!(Self::cast_dir()));
        }
        parse(self.call("castPair", body).await?)
    }

    pub async fn cast_remove(&self, id: &str) -> Result<CastStatus, String> {
        parse(self.call("castRemove", json!({ "id": id, "storage": Self::cast_dir() })).await?)
    }

    pub async fn cast_play(&self, receiver_id: &str, key: &str, prefer_mode: &str, start_position_ms: u64) -> Result<CastStatus, String> {
        parse(
            self.call(
                "castPlay",
                json!({
                    "storage": Self::cast_dir(),
                    "receiverId": receiver_id,
                    "key": key,
                    "preferMode": prefer_mode,
                    "startPositionMs": start_position_ms,
                }),
            )
            .await?,
        )
    }

    pub async fn cast_attach(&self, receiver_id: &str) -> Result<CastStatus, String> {
        parse(self.call("castAttach", json!({ "storage": Self::cast_dir(), "receiverId": receiver_id })).await?)
    }

    pub async fn cast_control(&self, params: Value) -> Result<CastStatus, String> {
        let mut body = params;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("storage").or_insert_with(|| json!(Self::cast_dir()));
        }
        parse(self.call("castControl", body).await?)
    }

    pub async fn cast_stop(&self, stop_playback: bool) -> Result<CastStatus, String> {
        parse(self.call("castStop", json!({ "storage": Self::cast_dir(), "stopPlayback": stop_playback })).await?)
    }

    pub async fn receiver_start(&self, name: &str, open_auth: bool) -> Result<ReceiverInfo, String> {
        parse(self.call("receiverStart", json!({ "storage": Self::cast_dir(), "name": name, "openAuth": open_auth })).await?)
    }

    pub async fn receiver_stop(&self) -> Result<(), String> {
        self.call("receiverStop", json!({})).await.map(drop)
    }

    pub async fn receiver_rotate_code(&self) -> Result<ReceiverInfo, String> {
        parse(self.call("receiverRotateCode", json!({ "storage": Self::cast_dir() })).await?)
    }

    pub async fn receiver_report_state(&self, state: Value) -> Result<(), String> {
        self.call("receiverReportState", json!({ "storage": Self::cast_dir(), "state": state })).await.map(drop)
    }
    /// Events from the worker, until it exits.
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded();
        self.shared.subscribers.lock().push(tx);
        rx
    }

    /// Stop the worklet's I/O while the app is in the background.
    pub fn suspend(&self) {
        unsafe { bare_worklet_suspend(self.worklet, -1) };
    }

    pub fn resume(&self) {
        unsafe { bare_worklet_resume(self.worklet) };
    }

    async fn call(&self, method: &str, params: Value) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().insert(id, tx);
        let mut line = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params })).map_err(|err| err.to_string())?;
        line.push(b'\n');
        if let Err(err) = self.write_all(&line) {
            self.shared.pending.lock().remove(&id);
            return Err(err);
        }
        rx.await.map_err(|_| "The P2P worker stopped".to_string())?
    }

    fn write_all(&self, mut bytes: &[u8]) -> Result<(), String> {
        let _one_writer = self.write.lock();
        while !bytes.is_empty() {
            let n = unsafe { libc::write(self.outgoing, bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 {
                bytes = &bytes[n as usize..];
                continue;
            }
            let err = std::io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::EAGAIN) => wait(self.outgoing, libc::POLLOUT),
                Some(libc::EINTR) => {}
                _ => return Err(format!("Cannot reach the P2P worker: {err}")),
            }
        }
        Ok(())
    }
}

impl Shared {
    fn read(&self, fd: c_int) {
        let mut chunk = vec![0u8; 64 * 1024];
        let mut buffered = Vec::new();
        loop {
            let n = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
            if n > 0 {
                buffered.extend_from_slice(&chunk[..n as usize]);
                while let Some(end) = buffered.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buffered.drain(..=end).collect();
                    self.dispatch(&line[..end]);
                }
                continue;
            }
            if n == 0 {
                break;
            }
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EAGAIN) => wait(fd, libc::POLLIN),
                Some(libc::EINTR) => {}
                _ => break,
            }
        }
        // Dropping the senders fails every call still waiting for a reply.
        self.pending.lock().clear();
        self.broadcast(Event::Exited);
    }

    fn dispatch(&self, line: &[u8]) {
        let msg = match serde_json::from_slice::<Value>(line) {
            Ok(msg) => msg,
            Err(err) => {
                // The reply's id is unreadable too: fail every waiting call rather than hang one.
                let error = format!("Unreadable message from the P2P worker: {err}");
                for (_, reply) in self.pending.lock().drain() {
                    let _ = reply.send(Err(error.clone()));
                }
                return self.broadcast(Event::Fatal(error));
            }
        };
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            let Some(reply) = self.pending.lock().remove(&id) else { return };
            let result = match msg.get("error") {
                Some(error) => Err(error.as_str().unwrap_or("Unknown worker error").to_string()),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = reply.send(result);
        } else {
            match msg.get("event").and_then(Value::as_str) {
                Some("update") => self.broadcast(Event::Update),
                Some("sources") => {
                    if let Ok(list) = serde_json::from_value::<Vec<SourceInfo>>(msg.get("sources").cloned().unwrap_or(Value::Null)) {
                        self.broadcast(Event::Sources(list));
                    }
                    self.broadcast(Event::Update);
                }
                Some("cast") => {
                    if let Ok(st) = serde_json::from_value::<CastStatus>(msg.get("cast").cloned().unwrap_or(Value::Null)) {
                        self.broadcast(Event::Cast(st));
                    }
                }
                Some("receiverCommand") => {
                    if let Ok(cmd) = serde_json::from_value::<ReceiverCommand>(msg.get("command").cloned().unwrap_or(Value::Null)) {
                        self.broadcast(Event::ReceiverCommand(cmd));
                    }
                }
                Some("fatal") => self.broadcast(Event::Fatal(msg["error"].as_str().unwrap_or("").to_string())),
                _ => {}
            }
        }
    }

    fn broadcast(&self, event: Event) {
        self.subscribers.lock().retain(|tx| tx.unbounded_send(event.clone()).is_ok());
    }
}

fn check(code: c_int, what: &str) -> Result<(), String> {
    if code == 0 { Ok(()) } else { Err(format!("bare-kit {what} failed ({code})")) }
}

fn wait(fd: c_int, events: libc::c_short) {
    let mut poll = libc::pollfd { fd, events, revents: 0 };
    unsafe { libc::poll(&mut poll, 1, -1) };
}

fn non_empty(list: &[String]) -> Option<&[String]> {
    if list.is_empty() { None } else { Some(list) }
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|err| format!("Unexpected reply from the P2P worker: {err}"))
}

/// Where the app keeps its settings and bare-kit's unpacked assets: the same
/// place the Dioxus app used, so an upgrade keeps them. PEARTUBE_STORAGE
/// overrides this and STORE_DIR.
pub static DATA_DIR: LazyLock<PathBuf> = LazyLock::new(|| app_dir("Library/Application Support/PearTube"));

/// Where each tracker's Corestore lives. The app only reads, so its stores hold
/// nothing peers cannot serve again, and they can be large: keep them out of
/// backups (Time Machine skips Library/Caches).
static STORE_DIR: LazyLock<PathBuf> = LazyLock::new(|| app_dir("Library/Caches/PearTube"));

fn app_dir(in_home: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os("PEARTUBE_STORAGE") {
        return dir.into();
    }
    PathBuf::from(std::env::var_os("HOME").expect("HOME is set")).join(in_home)
}

use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use oxideav_core::RuntimeContext;
use player::{AppleBackend, Player, PlayerOptions, TrackKind};
use serde_json::json;

static CODECS: LazyLock<Arc<RuntimeContext>> = LazyLock::new(|| Arc::new(codecs::context()));
thread_local! { static ERROR: RefCell<String> = const { RefCell::new(String::new()) }; }

pub struct PearTubePlayer {
    backend: Arc<AppleBackend>,
    player: Option<Player>,
}

fn fail(message: impl ToString) { ERROR.with(|error| *error.borrow_mut() = message.to_string()); }
fn guarded<T>(fallback: T, body: impl FnOnce() -> Result<T, String>) -> T {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => { fail(error); fallback }
        Err(_) => { fail("The native player panicked"); fallback }
    }
}
fn main_thread() -> Result<(), String> {
    if unsafe { libc::pthread_main_np() } != 0 { Ok(()) }
    else { Err("Player bridge calls must run on the main thread".into()) }
}
unsafe fn handle<'a>(ptr: *mut PearTubePlayer) -> Result<&'a mut PearTubePlayer, String> {
    main_thread()?;
    unsafe { ptr.as_mut() }.ok_or_else(|| "No native player".into())
}
unsafe fn text(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() { return Err("Missing string".into()); }
    unsafe { CStr::from_ptr(ptr) }.to_str().map(str::to_owned).map_err(|e| e.to_string())
}
fn string(value: String) -> Result<*mut c_char, String> {
    CString::new(value).map(CString::into_raw).map_err(|e| e.to_string())
}
fn command(ptr: *mut PearTubePlayer, body: impl FnOnce(&Player)) -> i32 {
    guarded(-1, || {
        let h = unsafe { handle(ptr)? };
        let player = h.player.as_ref().ok_or("Playback has not opened")?;
        body(player);
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_create(view: *mut c_void) -> *mut PearTubePlayer {
    guarded(std::ptr::null_mut(), || {
        main_thread()?;
        if view.is_null() { return Err("A live UIView is required".into()); }
        let backend = AppleBackend::new();
        unsafe { backend.attach(view); }
        Ok(Box::into_raw(Box::new(PearTubePlayer { backend, player: None })))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_open(ptr: *mut PearTubePlayer, url: *const c_char, sf2: *const c_char) -> i32 {
    guarded(-1, || {
        let h = unsafe { handle(ptr)? };
        if h.player.is_some() { return Err("Create a new backend before changing media".into()); }
        let url = unsafe { text(url)? };
        let soundfont = if sf2.is_null() { None } else { Some(PathBuf::from(unsafe { text(sf2)? })) };
        h.player = Some(Player::open(&url, h.backend.clone(), CODECS.clone(), PlayerOptions { soundfont, ..Default::default() }, |_| {}));
        Ok(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_frame(ptr: *mut PearTubePlayer, width: f64, height: f64) -> i32 {
    guarded(-1, || {
        let h = unsafe { handle(ptr)? };
        if !width.is_finite() || !height.is_finite() || width < 0.0 || height < 0.0 { return Err("Invalid player bounds".into()); }
        h.backend.set_frame([0.0, 0.0, width, height]);
        Ok(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_play(p: *mut PearTubePlayer) -> i32 { command(p, Player::play) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_pause(p: *mut PearTubePlayer) -> i32 { command(p, Player::pause) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_seek(p: *mut PearTubePlayer, ms: i64) -> i32 { command(p, |p| p.seek(Duration::from_millis(ms.max(0) as u64))) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_select_audio(p: *mut PearTubePlayer, stream: i32) -> i32 { command(p, |p| p.select_audio(u32::try_from(stream).ok())) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_select_subtitle(p: *mut PearTubePlayer, stream: i32) -> i32 { command(p, |p| p.select_subtitle(u32::try_from(stream).ok())) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_suspend(p: *mut PearTubePlayer) -> i32 { command(p, Player::suspend) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_resume(p: *mut PearTubePlayer) -> i32 { command(p, Player::resume) }
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_state(ptr: *mut PearTubePlayer) -> *mut c_char {
    guarded(std::ptr::null_mut(), || {
        let h = unsafe { handle(ptr)? };
        let st = h.player.as_ref().ok_or("Playback has not opened")?.state();
        let tracks: Vec<_> = st.tracks.iter().map(|t| json!({
            "stream": t.stream, "kind": match t.kind { TrackKind::Audio => "audio", TrackKind::Video => "video", TrackKind::Subtitle => "subtitle" },
            "codec": t.codec, "language": t.language, "title": t.title, "default": t.default,
        })).collect();
        string(json!({
            "positionMs": st.position.as_millis() as u64, "durationMs": st.duration.map(|d| d.as_millis() as u64),
            "playing": st.playing, "buffering": st.buffering, "ended": st.ended, "error": st.error,
            "tracks": tracks, "audio": st.audio, "subtitle": st.subtitle,
            "videoWidth": st.video_size.map(|s| s.0), "videoHeight": st.video_size.map(|s| s.1),
            "videoDecoder": st.video_decoder, "droppedFrames": st.dropped_frames,
        }).to_string())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_last_error() -> *mut c_char {
    guarded(std::ptr::null_mut(), || ERROR.with(|error| string(error.borrow().clone())))
}
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_string_free(ptr: *mut c_char) {
    let _ = guarded((), || { if !ptr.is_null() { drop(unsafe { CString::from_raw(ptr) }); } Ok(()) });
}
#[unsafe(no_mangle)]
pub extern "C" fn peartube_player_destroy(ptr: *mut PearTubePlayer) {
    guarded((), || {
        if ptr.is_null() { return Ok(()); }
        main_thread()?;
        let h = unsafe { Box::from_raw(ptr) };
        // Detach while UIKit is still retained. Joining the pipelines must never
        // block main: the pipeline may itself be waiting for a main-queue job.
        let detached = catch_unwind(AssertUnwindSafe(|| h.backend.detach()));
        let owned = Box::into_raw(h) as usize;
        // Keep the allocation owned even if OS thread creation fails: leaking
        // one failed retirement is safer than joining a Player on UIKit's thread.
        std::thread::Builder::new().name("peartube-player-retire".into()).spawn(move || {
            let _ = catch_unwind(AssertUnwindSafe(|| drop(unsafe { Box::from_raw(owned as *mut PearTubePlayer) })));
        }).map_err(|error| format!("Cannot retire player off-main: {error}"))?;
        detached.map_err(|_| "The player could not detach".to_string())?;
        Ok(())
    });
}

//! Video preview backed by a bundled libVLC.
//!
//! libVLC decodes into RGBA buffers through its "vmem" callbacks; the newest frame is kept
//! in memory and the frontend pulls it through the `vlcframe` URI scheme and paints it on
//! a canvas, so frames are dropped (not queued) when the webview can't keep up.

use std::{
    ffi::{CStr, CString, c_char, c_int, c_uint, c_void},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use libloading::Library;
use serde::Serialize;

use crate::err::app_err::AppErr;

const MAX_FRAME_EDGE: u32 = 1920;
const FRAME_HEADER_LEN: usize = 12;

#[cfg(target_os = "macos")]
const LIBRARIES: [&str; 2] = ["libvlccore.dylib", "libvlc.dylib"];
#[cfg(target_os = "windows")]
const LIBRARIES: [&str; 2] = ["libvlccore.dll", "libvlc.dll"];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const LIBRARIES: [&str; 2] = ["libvlccore.so.9", "libvlc.so.5"];

type Raw = *mut c_void;
type LockCb = unsafe extern "C" fn(Raw, *mut Raw) -> Raw;
type UnlockCb = unsafe extern "C" fn(Raw, Raw, *const Raw);
type DisplayCb = unsafe extern "C" fn(Raw, Raw);
type FormatCb =
    unsafe extern "C" fn(*mut Raw, *mut c_char, *mut c_uint, *mut c_uint, *mut c_uint, *mut c_uint) -> c_uint;
type CleanupCb = unsafe extern "C" fn(Raw);

// libvlc_state_t
const STATE_PLAYING: c_int = 3;
const STATE_PAUSED: c_int = 4;
const STATE_ENDED: c_int = 6;
const STATE_ERROR: c_int = 7;
const TRACK_VIDEO: c_int = 1;

#[repr(C)]
struct MediaTrack {
    codec: u32,
    original_fourcc: u32,
    id: c_int,
    kind: c_int,
    profile: c_int,
    level: c_int,
    details: Raw,
    bitrate: c_uint,
    language: *mut c_char,
    description: *mut c_char,
}

// Leading fields of libvlc_video_track_t; only read through a pointer.
#[repr(C)]
struct VideoTrack {
    height: c_uint,
    width: c_uint,
    sar_num: c_uint,
    sar_den: c_uint,
}

struct Vlc {
    instance: Raw,
    errmsg: unsafe extern "C" fn() -> *const c_char,
    media_new_path: unsafe extern "C" fn(Raw, *const c_char) -> Raw,
    media_release: unsafe extern "C" fn(Raw),
    media_tracks_get: unsafe extern "C" fn(Raw, *mut *mut *mut MediaTrack) -> c_uint,
    media_tracks_release: unsafe extern "C" fn(*mut *mut MediaTrack, c_uint),
    player_new_from_media: unsafe extern "C" fn(Raw) -> Raw,
    player_release: unsafe extern "C" fn(Raw),
    player_play: unsafe extern "C" fn(Raw) -> c_int,
    player_set_pause: unsafe extern "C" fn(Raw, c_int),
    player_stop: unsafe extern "C" fn(Raw),
    player_get_time: unsafe extern "C" fn(Raw) -> i64,
    player_set_time: unsafe extern "C" fn(Raw, i64),
    player_get_length: unsafe extern "C" fn(Raw) -> i64,
    player_get_state: unsafe extern "C" fn(Raw) -> c_int,
    audio_set_mute: unsafe extern "C" fn(Raw, c_int),
    video_set_callbacks: unsafe extern "C" fn(Raw, LockCb, UnlockCb, DisplayCb, Raw),
    video_set_format_callbacks: unsafe extern "C" fn(Raw, FormatCb, CleanupCb),
    // Keeps the symbols above valid.
    _libraries: Vec<Library>,
}

// libVLC's API is thread-safe; the instance lives for the whole process.
unsafe impl Send for Vlc {}
unsafe impl Sync for Vlc {}

static VLC_DIR: OnceLock<PathBuf> = OnceLock::new();
static VLC: OnceLock<Result<Vlc, String>> = OnceLock::new();

/// Records where the bundled `lib/` and `plugins/` folders are and starts loading libVLC
/// in the background, since scanning its plugins takes a moment.
pub(crate) fn init(vlc_dir: PathBuf) {
    let _ = VLC_DIR.set(vlc_dir);
    std::thread::spawn(|| {
        if let Err(error) = vlc() {
            tracing::warn!("libVLC unavailable: {error}");
        }
    });
}

fn vlc() -> Result<&'static Vlc, AppErr> {
    VLC.get_or_init(|| {
        let dir = VLC_DIR.get().ok_or("libVLC location is not configured")?;
        unsafe { Vlc::load(dir) }
    })
    .as_ref()
    .map_err(|error| AppErr::new(error.clone()))
}

impl Vlc {
    unsafe fn load(dir: &Path) -> Result<Vlc, String> {
        let lib_dir = dir.join("lib");
        let plugin_dir = dir.join("plugins");
        if !plugin_dir.is_dir() {
            return Err(format!("libVLC plugins not found in {}", plugin_dir.display()));
        }
        // libvlc references libvlccore through @rpath/its bare name; loading libvlccore
        // first by absolute path lets the loader reuse it.
        let mut libraries = Vec::new();
        for name in LIBRARIES {
            let path = lib_dir.join(name);
            let library = unsafe { Library::new(&path) }
                .map_err(|error| format!("Could not load {}: {error}", path.display()))?;
            libraries.push(library);
        }
        let lib = &libraries[1];

        macro_rules! sym {
            ($name:literal) => {
                *unsafe { lib.get(concat!($name, "\0").as_bytes()) }
                    .map_err(|error| format!("libVLC is missing {}: {error}", $name))?
            };
        }

        unsafe { std::env::set_var("VLC_PLUGIN_PATH", &plugin_dir) };
        let libvlc_new: unsafe extern "C" fn(c_int, *const *const c_char) -> Raw = sym!("libvlc_new");
        let args: Vec<CString> = ["--quiet", "--no-video-title-show", "--no-osd", "--no-snapshot-preview"]
            .iter()
            .map(|arg| CString::new(*arg).unwrap())
            .collect();
        let argv: Vec<*const c_char> = args.iter().map(|arg| arg.as_ptr()).collect();
        let instance = unsafe { libvlc_new(argv.len() as c_int, argv.as_ptr()) };
        if instance.is_null() {
            return Err("libVLC failed to start".into());
        }

        Ok(Vlc {
            instance,
            errmsg: sym!("libvlc_errmsg"),
            media_new_path: sym!("libvlc_media_new_path"),
            media_release: sym!("libvlc_media_release"),
            media_tracks_get: sym!("libvlc_media_tracks_get"),
            media_tracks_release: sym!("libvlc_media_tracks_release"),
            player_new_from_media: sym!("libvlc_media_player_new_from_media"),
            player_release: sym!("libvlc_media_player_release"),
            player_play: sym!("libvlc_media_player_play"),
            player_set_pause: sym!("libvlc_media_player_set_pause"),
            player_stop: sym!("libvlc_media_player_stop"),
            player_get_time: sym!("libvlc_media_player_get_time"),
            player_set_time: sym!("libvlc_media_player_set_time"),
            player_get_length: sym!("libvlc_media_player_get_length"),
            player_get_state: sym!("libvlc_media_player_get_state"),
            audio_set_mute: sym!("libvlc_audio_set_mute"),
            video_set_callbacks: sym!("libvlc_video_set_callbacks"),
            video_set_format_callbacks: sym!("libvlc_video_set_format_callbacks"),
            _libraries: libraries,
        })
    }

    fn last_error(&self) -> String {
        let message = unsafe { (self.errmsg)() };
        if message.is_null() {
            "unknown libVLC error".into()
        } else {
            unsafe { CStr::from_ptr(message) }.to_string_lossy().into_owned()
        }
    }
}

#[derive(Default)]
struct Frame {
    seq: u32,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

/// Receives decoded pictures from libVLC's threads.
struct Sink {
    vlc: &'static Vlc,
    media: Raw,
    max_width: u32,
    max_height: u32,
    size: Mutex<(u32, u32)>,
    // Decode buffers handed to libVLC, plus the indexes not currently locked by it.
    buffers: Mutex<(Vec<Box<[u8]>>, Vec<usize>)>,
    latest: Mutex<Frame>,
    first_frame: Condvar,
}

impl Sink {
    fn buffer_len(&self) -> usize {
        let (width, height) = *self.size.lock().unwrap();
        width as usize * height as usize * 4
    }

    /// Display aspect ratio of the first video track, including non-square pixels.
    fn track_aspect(&self) -> Option<f64> {
        let vlc = self.vlc;
        let mut tracks = std::ptr::null_mut();
        let count = unsafe { (vlc.media_tracks_get)(self.media, &mut tracks) };
        let mut aspect = None;
        for index in 0..count as usize {
            let track = unsafe { &**tracks.add(index) };
            if track.kind != TRACK_VIDEO || track.details.is_null() {
                continue;
            }
            let video = unsafe { &*(track.details as *const VideoTrack) };
            if video.width > 0 && video.height > 0 {
                let sar = if video.sar_num > 0 && video.sar_den > 0 {
                    video.sar_num as f64 / video.sar_den as f64
                } else {
                    1.0
                };
                aspect = Some(video.width as f64 * sar / video.height as f64);
                break;
            }
        }
        if count > 0 {
            unsafe { (vlc.media_tracks_release)(tracks, count) };
        }
        aspect
    }
}

unsafe extern "C" fn on_format(
    opaque: *mut Raw,
    chroma: *mut c_char,
    width: *mut c_uint,
    height: *mut c_uint,
    pitches: *mut c_uint,
    lines: *mut c_uint,
) -> c_uint {
    let sink = unsafe { &*(*opaque as *const Sink) };
    let (source_width, source_height) = unsafe { (*width, *height) };
    if source_width == 0 || source_height == 0 {
        return 0;
    }
    // The size libVLC offers is padded to its decoder alignment and ignores the pixel aspect,
    // while the picture is scaled to fill whatever size we pick, so size the frame from the
    // track's real display aspect.
    let offered_aspect = source_width as f64 / source_height as f64;
    let aspect = match sink.track_aspect() {
        // Auto-rotated video arrives transposed relative to the track.
        Some(aspect) if (aspect > 1.0) != (offered_aspect > 1.0) => 1.0 / aspect,
        Some(aspect) => aspect,
        None => offered_aspect,
    };
    let fit_width = (sink.max_width as f64)
        .min(sink.max_height as f64 * aspect)
        .min(source_width as f64);
    let frame_width = (fit_width as u32).max(2) & !1;
    let frame_height = ((fit_width / aspect) as u32).max(2) & !1;
    unsafe {
        std::ptr::copy_nonoverlapping(b"RGBA".as_ptr().cast(), chroma, 4);
        *width = frame_width;
        *height = frame_height;
        *pitches = frame_width * 4;
        *lines = frame_height;
    }
    *sink.size.lock().unwrap() = (frame_width, frame_height);
    let mut buffers = sink.buffers.lock().unwrap();
    *buffers = (Vec::new(), Vec::new());
    1
}

unsafe extern "C" fn on_cleanup(_opaque: Raw) {}

unsafe extern "C" fn on_lock(opaque: Raw, planes: *mut Raw) -> Raw {
    let sink = unsafe { &*(opaque as *const Sink) };
    let len = sink.buffer_len();
    let mut guard = sink.buffers.lock().unwrap();
    let (buffers, free) = &mut *guard;
    let index = free.pop().unwrap_or_else(|| {
        buffers.push(vec![0; len].into_boxed_slice());
        buffers.len() - 1
    });
    unsafe { *planes = buffers[index].as_mut_ptr().cast() };
    // Picture ids are offset by one so the first buffer isn't a null pointer.
    (index + 1) as Raw
}

unsafe extern "C" fn on_unlock(opaque: Raw, picture: Raw, _planes: *const Raw) {
    let sink = unsafe { &*(opaque as *const Sink) };
    sink.buffers.lock().unwrap().1.push(picture as usize - 1);
}

unsafe extern "C" fn on_display(opaque: Raw, picture: Raw) {
    let sink = unsafe { &*(opaque as *const Sink) };
    let (width, height) = *sink.size.lock().unwrap();
    let buffers = sink.buffers.lock().unwrap();
    let Some(pixels) = buffers.0.get(picture as usize - 1) else { return };
    let mut latest = sink.latest.lock().unwrap();
    latest.pixels.clear();
    latest.pixels.extend_from_slice(pixels);
    latest.width = width;
    latest.height = height;
    latest.seq = latest.seq.wrapping_add(1);
    sink.first_frame.notify_all();
}

struct Session {
    id: u64,
    vlc: &'static Vlc,
    player: Raw,
    sink: *const Sink,
}

unsafe impl Send for Session {}
unsafe impl Sync for Session {}

impl Session {
    fn sink(&self) -> &Sink {
        unsafe { &*self.sink }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            // Stop waits for libVLC's threads, so no callback can touch the sink afterwards.
            (self.vlc.player_stop)(self.player);
            (self.vlc.player_release)(self.player);
            let sink = Arc::from_raw(self.sink);
            (self.vlc.media_release)(sink.media);
        }
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static CURRENT: Mutex<Option<Arc<Session>>> = Mutex::new(None);

fn session(id: u64) -> Result<Arc<Session>, AppErr> {
    CURRENT
        .lock()
        .unwrap()
        .as_ref()
        .filter(|session| session.id == id)
        .cloned()
        .ok_or_else(|| AppErr::new("This video is no longer open"))
}

/// Opens `path` and shows its first frame, paused and silent. Replaces any open video.
pub(crate) fn open(path: &str, max_width: u32, max_height: u32) -> Result<u64, AppErr> {
    close_current();
    let vlc = vlc()?;
    let c_path = CString::new(path).map_err(|_| AppErr::new("Invalid video path"))?;
    let media = unsafe { (vlc.media_new_path)(vlc.instance, c_path.as_ptr()) };
    if media.is_null() {
        return Err(AppErr::new(vlc.last_error()));
    }
    let player = unsafe { (vlc.player_new_from_media)(media) };
    if player.is_null() {
        unsafe { (vlc.media_release)(media) };
        return Err(AppErr::new(vlc.last_error()));
    }

    let sink = Arc::into_raw(Arc::new(Sink {
        vlc,
        media,
        max_width: max_width.clamp(64, MAX_FRAME_EDGE),
        max_height: max_height.clamp(64, MAX_FRAME_EDGE),
        size: Mutex::new((0, 0)),
        buffers: Mutex::new((Vec::new(), Vec::new())),
        latest: Mutex::new(Frame::default()),
        first_frame: Condvar::new(),
    }));
    let session = Arc::new(Session { id: NEXT_ID.fetch_add(1, Ordering::Relaxed), vlc, player, sink });
    unsafe {
        (vlc.video_set_callbacks)(player, on_lock, on_unlock, on_display, sink as Raw);
        (vlc.video_set_format_callbacks)(player, on_format, on_cleanup);
        (vlc.audio_set_mute)(player, 1);
        if (vlc.player_play)(player) != 0 {
            return Err(AppErr::new(vlc.last_error()));
        }
    }

    // Wait for the first frame, then hold it as the poster until the user presses play.
    let latest = session.sink().latest.lock().unwrap();
    let (latest, _) = session
        .sink()
        .first_frame
        .wait_timeout_while(latest, Duration::from_secs(5), |frame| {
            frame.seq == 0 && !matches!(unsafe { (vlc.player_get_state)(player) }, STATE_ENDED | STATE_ERROR)
        })
        .unwrap();
    drop(latest);
    unsafe {
        (vlc.player_set_pause)(player, 1);
        (vlc.audio_set_mute)(player, 0);
    }

    let id = session.id;
    let mut current = CURRENT.lock().unwrap();
    if current.as_ref().is_some_and(|newer| newer.id > id) {
        drop(current);
        return Err(AppErr::new("A newer video was opened"));
    }
    let previous = current.replace(session);
    drop(current);
    drop(previous);
    Ok(id)
}

pub(crate) fn play(id: u64) -> Result<(), AppErr> {
    let session = session(id)?;
    let vlc = session.vlc;
    unsafe {
        if (vlc.player_get_state)(session.player) == STATE_ENDED {
            (vlc.player_stop)(session.player);
            (vlc.player_play)(session.player);
        } else {
            (vlc.player_set_pause)(session.player, 0);
        }
    }
    Ok(())
}

pub(crate) fn pause(id: u64) -> Result<(), AppErr> {
    let session = session(id)?;
    unsafe { (session.vlc.player_set_pause)(session.player, 1) };
    Ok(())
}

pub(crate) fn seek(id: u64, time_ms: i64) -> Result<(), AppErr> {
    let session = session(id)?;
    let vlc = session.vlc;
    unsafe {
        // An ended player ignores seeks until it is started again.
        if (vlc.player_get_state)(session.player) == STATE_ENDED {
            (vlc.player_stop)(session.player);
            (vlc.player_play)(session.player);
        }
        (vlc.player_set_time)(session.player, time_ms.max(0));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoStatus {
    time_ms: i64,
    length_ms: i64,
    state: &'static str,
}

pub(crate) fn status(id: u64) -> Result<VideoStatus, AppErr> {
    let session = session(id)?;
    let vlc = session.vlc;
    let state = match unsafe { (vlc.player_get_state)(session.player) } {
        STATE_PLAYING => "playing",
        STATE_PAUSED => "paused",
        STATE_ENDED => "ended",
        STATE_ERROR => "error",
        _ => "loading",
    };
    Ok(VideoStatus {
        time_ms: unsafe { (vlc.player_get_time)(session.player) }.max(0),
        length_ms: unsafe { (vlc.player_get_length)(session.player) }.max(0),
        state,
    })
}

pub(crate) fn close(id: u64) {
    let mut current = CURRENT.lock().unwrap();
    if current.as_ref().is_some_and(|session| session.id == id) {
        let session = current.take();
        drop(current);
        drop(session);
    }
}

fn close_current() {
    let session = CURRENT.lock().unwrap().take();
    drop(session);
}

/// Returns the newest frame of video `id` if it is newer than `after`, prefixed with
/// little-endian `width`, `height` and `seq` (u32 each).
pub(crate) fn frame(id: u64, after: u32) -> Option<Vec<u8>> {
    let session = session(id).ok()?;
    let latest = session.sink().latest.lock().unwrap();
    if latest.seq == after || latest.pixels.is_empty() {
        return None;
    }
    let mut body = Vec::with_capacity(FRAME_HEADER_LEN + latest.pixels.len());
    for value in [latest.width, latest.height, latest.seq] {
        body.extend_from_slice(&value.to_le_bytes());
    }
    body.extend_from_slice(&latest.pixels);
    Some(body)
}

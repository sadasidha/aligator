mod err;
mod models;
mod services;

use std::path::PathBuf;

use models::{files_folder::FileFolder, settings::Settings};
use services::image_edit::{self, ImageTransform};
use services::video;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn load_current_path() -> Result<String, String> {
    Settings::load()
        .map(|settings| settings.current_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_current_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = Settings::load()?;
        settings.current_path = path;
        settings.save()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn load_file_folder(path: String) -> Result<Vec<FileFolder>, String> {
    tauri::async_runtime::spawn_blocking(move || FileFolder::load(path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_with_default_app(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| format!("Failed to open {path}: {error}"))
}

#[tauri::command]
async fn transform_image(
    path: String,
    transforms: Vec<ImageTransform>,
    destination: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        image_edit::transform_image(&path, &transforms, destination.as_deref())
    })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_text_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || services::text_preview::read_text_preview(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn video_open(path: String, max_width: u32, max_height: u32) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || video::open(&path, max_width, max_height))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn video_play(id: u64) -> Result<(), String> {
    video::play(id).map_err(|error| error.to_string())
}

#[tauri::command]
fn video_pause(id: u64) -> Result<(), String> {
    video::pause(id).map_err(|error| error.to_string())
}

#[tauri::command]
fn video_seek(id: u64, time_ms: i64) -> Result<(), String> {
    video::seek(id, time_ms).map_err(|error| error.to_string())
}

#[tauri::command]
fn video_status(id: u64) -> Result<video::VideoStatus, String> {
    video::status(id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn video_close(id: u64) {
    // Stopping waits for libVLC's threads, so keep it off the IPC thread.
    let _ = tauri::async_runtime::spawn_blocking(move || video::close(id)).await;
}

/// Serves `vlcframe://localhost/frame?id=<video>&after=<seq>`: the newest decoded frame, or
/// 204 when there is nothing newer than `after`.
fn video_frame_response(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let mut id = 0;
    let mut after = 0;
    for pair in request.uri().query().unwrap_or_default().split('&') {
        match pair.split_once('=') {
            Some(("id", value)) => id = value.parse().unwrap_or(0),
            Some(("after", value)) => after = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    let frame = video::frame(id, after);
    tauri::http::Response::builder()
        .status(if frame.is_some() { 200 } else { 204 })
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(frame.unwrap_or_default())
        .unwrap()
}

fn vlc_dir(app: &tauri::App) -> PathBuf {
    let bundled = app.path().resource_dir().map(|dir| dir.join("vlc"));
    match bundled {
        Ok(dir) if dir.join("plugins").is_dir() => dir,
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vlc"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            video::init(vlc_dir(app));
            Ok(())
        })
        .register_uri_scheme_protocol("vlcframe", |_ctx, request| video_frame_response(request))
        .invoke_handler(tauri::generate_handler![
            greet,
            load_current_path,
            save_current_path,
            load_file_folder,
            open_with_default_app,
            transform_image,
            read_text_preview,
            video_open,
            video_play,
            video_pause,
            video_seek,
            video_status,
            video_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

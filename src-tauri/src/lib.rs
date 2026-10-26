mod data;
mod documents;
mod settings;
mod state;
mod streams;

use data::DataPaths;
use documents::{
    create_document, load_recent, read_document, record_recent, remove_recent,
    remove_recent_stream as remove_stream_recent, save_document, save_recent, JsonDocument,
    RecentDocument, RecentStream,
};
use serde::Serialize;
use settings::{load_settings, save_settings, AppSettings};
use state::AppState;
use std::io;
use streams::{
    read_snapshot, record_recent as record_stream_recent, StreamManager, StreamSnapshot,
};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    settings: AppSettings,
    data_root: String,
    recents: Vec<RecentDocument>,
    streams: Vec<RecentStream>,
}

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Result<Bootstrap, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "settings state is unavailable".to_string())?
        .clone();
    let recents = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?
        .documents
        .clone();
    let streams = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?
        .streams
        .clone();
    Ok(Bootstrap {
        settings,
        data_root: state.paths.root.to_string_lossy().to_string(),
        recents,
        streams,
    })
}

#[tauri::command]
fn update_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let saved = save_settings(&state.paths.settings, &settings)?;
    *state
        .settings
        .lock()
        .map_err(|_| "settings state is unavailable".to_string())? = saved.clone();
    Ok(saved)
}

#[tauri::command]
fn list_recent_documents(state: State<'_, AppState>) -> Result<Vec<RecentDocument>, String> {
    Ok(state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?
        .documents
        .clone())
}

#[tauri::command]
fn create_json_document(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<JsonDocument, String> {
    let document = create_document(&state.paths.documents, name.as_deref())?;
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    record_recent(&mut store, &document);
    save_recent(&state.paths.recent, &store)?;
    Ok(document)
}

#[tauri::command]
fn open_json_document(state: State<'_, AppState>, path: String) -> Result<JsonDocument, String> {
    let document = read_document(&path)?;
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    record_recent(&mut store, &document);
    save_recent(&state.paths.recent, &store)?;
    Ok(document)
}

#[tauri::command]
fn save_json_document(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> Result<JsonDocument, String> {
    let document = save_document(&path, &text)?;
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    record_recent(&mut store, &document);
    save_recent(&state.paths.recent, &store)?;
    Ok(document)
}

#[tauri::command]
fn remove_recent_json_document(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<RecentDocument>, String> {
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    let remaining = remove_recent(&mut store, &path);
    save_recent(&state.paths.recent, &store)?;
    Ok(remaining)
}

#[tauri::command]
fn list_recent_streams(state: State<'_, AppState>) -> Result<Vec<RecentStream>, String> {
    Ok(state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?
        .streams
        .clone())
}

#[tauri::command]
fn open_stream(state: State<'_, AppState>, path: String) -> Result<StreamSnapshot, String> {
    let snapshot = read_snapshot(&path)?;
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    record_stream_recent(&mut store, &snapshot);
    save_recent(&state.paths.recent, &store)?;
    Ok(snapshot)
}

#[tauri::command]
fn start_stream_follow(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    state
        .streams
        .lock()
        .map_err(|_| "stream state is unavailable".to_string())?
        .start(&app, &path)
}

#[tauri::command]
fn stop_stream_follow(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state
        .streams
        .lock()
        .map_err(|_| "stream state is unavailable".to_string())?
        .stop(&path);
    Ok(())
}

#[tauri::command]
fn remove_recent_stream(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<RecentStream>, String> {
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    let remaining = remove_stream_recent(&mut store, &path);
    save_recent(&state.paths.recent, &store)?;
    Ok(remaining)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let paths = DataPaths::init()
                .map_err(|error| io::Error::other(format!("data directory: {error}")))?;
            let settings = load_settings(&paths.settings);
            if !paths.settings.exists() {
                save_settings(&paths.settings, &settings)
                    .map_err(io::Error::other)?;
            }
            let recents = load_recent(&paths.recent);
            app.manage(AppState {
                paths,
                settings: std::sync::Mutex::new(settings),
                recents: std::sync::Mutex::new(recents),
                streams: std::sync::Mutex::new(StreamManager::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            update_settings,
            list_recent_documents,
            create_json_document,
            open_json_document,
            save_json_document,
            remove_recent_json_document,
            list_recent_streams,
            open_stream,
            start_stream_follow,
            stop_stream_follow,
            remove_recent_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running JSON Buddy");
}

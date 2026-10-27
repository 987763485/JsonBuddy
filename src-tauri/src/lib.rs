mod audit;
mod conversation;
mod data;
mod documents;
mod menu;
mod mock;
mod network;
mod settings;
mod state;
mod streams;
mod yaml;

use audit::{AuditConfig, AuditEntry, AuditState};
use data::DataPaths;
use documents::{
    create_document, load_recent, read_document, record_recent, remove_recent,
    remove_recent_stream as remove_stream_recent, save_document, save_recent, JsonDocument,
    RecentDocument, RecentStream,
};
use mock::{MockProject, MockRequestLog, MockServerStatus, MockState};
use serde::Serialize;
use settings::{load_settings, save_settings, AppSettings};
use state::AppState;
use std::collections::HashMap;
use std::io;
use streams::{
    read_archive, read_snapshot_cached, record_recent as record_stream_recent, remove_archive,
    StreamArchivePage, StreamManager, StreamSnapshot,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn parse_yaml_document(text: String) -> Result<serde_json::Value, String> {
    yaml::parse_yaml_document(&text)
}

#[tauri::command]
async fn test_local_request(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    method: String,
) -> Result<network::LocalRequestResult, String> {
    if let Err(error) = network::validate_local_url(&url) {
        audit::record_and_emit(
            &app,
            &state.audit,
            AuditEntry::app(
                "network",
                "critical",
                "Network egress",
                url.clone(),
                "app-request",
                true,
                "Rule: non-local request blocked by the local network policy.",
            ),
        );
        return Err(error);
    }
    network::send_local_request(&url, &method).await
}

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
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let saved = save_settings(&state.paths.settings, &settings)?;
    state.mock.configure(saved.mock_port, saved.mock_https);
    menu::install(&app, &saved.language)
        .map_err(|error| format!("could not rebuild the application menu: {error}"))?;
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
fn save_text_file(path: String, text: String) -> Result<(), String> {
    crate::data::write_text(std::path::Path::new(&path), &text)
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
    let snapshot = read_snapshot_cached(&path, &state.paths.stream_cache)?;
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
        .start(&app, &path, &state.paths.stream_cache)
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
fn read_stream_archive(
    state: State<'_, AppState>,
    path: String,
    before_line: u64,
    limit: Option<usize>,
) -> Result<StreamArchivePage, String> {
    read_archive(
        &state.paths.stream_cache,
        &path,
        before_line,
        limit.unwrap_or(500),
    )
}

#[tauri::command]
fn remove_recent_stream(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<RecentStream>, String> {
    remove_archive(&state.paths.stream_cache, &path);
    let mut store = state
        .recents
        .lock()
        .map_err(|_| "recent files state is unavailable".to_string())?;
    let remaining = remove_stream_recent(&mut store, &path);
    save_recent(&state.paths.recent, &store)?;
    Ok(remaining)
}

#[tauri::command]
fn list_mock_projects(state: State<'_, AppState>) -> Result<Vec<MockProject>, String> {
    Ok(state.mock.projects())
}

#[tauri::command]
fn save_mock_project(
    state: State<'_, AppState>,
    project: MockProject,
) -> Result<MockProject, String> {
    state.mock.save_project(project)
}

#[tauri::command]
fn create_mock_project(
    state: State<'_, AppState>,
    name: String,
    description: String,
    slug: String,
) -> Result<MockProject, String> {
    state.mock.create_project(name, description, slug)
}

#[tauri::command]
fn delete_mock_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let name = state
        .mock
        .projects()
        .into_iter()
        .find(|project| project.id == id)
        .map(|project| project.name)
        .unwrap_or_else(|| id.clone());
    state.mock.delete_project(&id)?;
    audit::record_and_emit(
        &app,
        &state.audit,
        AuditEntry::app(
            "delete",
            "critical",
            "Project deletion",
            name,
            "mock-project",
            false,
            "Rule: mock project removed from local storage.",
        ),
    );
    Ok(())
}

#[tauri::command]
fn mock_server_status(state: State<'_, AppState>) -> Result<MockServerStatus, String> {
    Ok(state.mock.status())
}

#[tauri::command]
fn mock_request_logs(state: State<'_, AppState>) -> Result<Vec<MockRequestLog>, String> {
    Ok(state.mock.request_logs())
}

#[tauri::command]
fn audit_config(state: State<'_, AppState>) -> Result<AuditConfig, String> {
    Ok(state.audit.config())
}

#[tauri::command]
fn list_app_audit(state: State<'_, AppState>) -> Vec<AuditEntry> {
    state.audit.entries()
}

#[tauri::command]
fn update_audit_categories(
    state: State<'_, AppState>,
    categories: HashMap<String, bool>,
) -> Result<AuditConfig, String> {
    state.audit.update_categories(categories)
}

#[tauri::command]
fn acknowledge_audit(state: State<'_, AppState>, id: String) -> Result<AuditConfig, String> {
    state.audit.acknowledge(&id)
}

#[tauri::command]
fn set_mock_runtime_response(
    state: State<'_, AppState>,
    project_id: String,
    endpoint_id: String,
    response: Option<serde_json::Value>,
) -> Result<(), String> {
    state
        .mock
        .set_runtime_response(&project_id, &endpoint_id, response)
}

#[tauri::command]
fn start_mock_server(app: AppHandle, state: State<'_, AppState>) -> Result<MockServerStatus, String> {
    state.mock.start_server(app)?;
    Ok(state.mock.status())
}

#[tauri::command]
fn stop_mock_server(state: State<'_, AppState>) -> Result<MockServerStatus, String> {
    state.mock.stop_server()?;
    Ok(state.mock.status())
}

#[tauri::command]
fn set_mock_project_running(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    running: bool,
) -> Result<MockServerStatus, String> {
    state.mock.set_project_running(app, &project_id, running)
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
            menu::install(app.handle(), &settings.language).map_err(io::Error::other)?;
            let recents = load_recent(&paths.recent);
            let mock = MockState::new(&paths, settings.mock_port, settings.mock_https)
                .map_err(io::Error::other)?;
            let audit = AuditState::new(&paths.audit).map_err(io::Error::other)?;
            app.manage(AppState {
                paths,
                settings: std::sync::Mutex::new(settings),
                recents: std::sync::Mutex::new(recents),
                streams: std::sync::Mutex::new(StreamManager::default()),
                mock,
                audit,
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Err(error) = app.emit("buddy-menu", event.id().as_ref().to_string()) {
                eprintln!("could not forward menu event: {error}");
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            update_settings,
            list_recent_documents,
            create_json_document,
            open_json_document,
            save_json_document,
            save_text_file,
            parse_yaml_document,
            test_local_request,
            remove_recent_json_document,
            list_recent_streams,
            open_stream,
            start_stream_follow,
            stop_stream_follow,
            read_stream_archive,
            remove_recent_stream,
            list_mock_projects,
            save_mock_project,
            create_mock_project,
            delete_mock_project,
            mock_server_status,
            mock_request_logs,
            audit_config,
            list_app_audit,
            update_audit_categories,
            acknowledge_audit,
            start_mock_server,
            stop_mock_server,
            set_mock_project_running,
            set_mock_runtime_response
        ])
        .run(tauri::generate_context!())
        .expect("error while running JSON Buddy");
}

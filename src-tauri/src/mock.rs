use crate::audit::AuditEntry;
use crate::data::{now_iso, write_json, write_text, DataPaths};
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::net::{Ipv6Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockEndpoint {
    pub id: String,
    pub method: String,
    pub path: String,
    pub name: String,
    pub status: u16,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub response: Value,
    #[serde(default)]
    pub imported_from: Option<String>,
    /// Generation settings persisted with the endpoint. The generated payload
    /// itself is recreated at runtime and never written to project files.
    #[serde(default)]
    pub generated_info: Option<Value>,
    /// Generated data for the current session. Never written to project files.
    #[serde(skip)]
    pub runtime_response: Option<Value>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockProject {
    #[serde(default = "default_version")]
    pub version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub slug: String,
    pub endpoints: Vec<MockEndpoint>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_schema_count")]
    pub schema_count: u32,
}

fn default_version() -> u32 {
    1
}

fn default_schema_count() -> u32 {
    1
}

fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServerStatus {
    pub running: bool,
    pub port: u16,
    pub https: bool,
    pub url: String,
    #[serde(default)]
    pub uptime_seconds: u64,
    #[serde(default)]
    pub total_requests: u64,
    #[serde(default)]
    pub running_projects: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockRequestLog {
    pub project_id: String,
    pub project_name: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub duration_ms: u64,
    pub at: String,
}

pub struct MockState {
    projects: Arc<RwLock<Vec<MockProject>>>,
    logs: Arc<RwLock<Vec<MockRequestLog>>>,
    requests: Arc<AtomicU64>,
    running_projects: Arc<RwLock<HashSet<String>>>,
    server: Mutex<Option<MockServerHandle>>,
    projects_dir: PathBuf,
    certs_dir: PathBuf,
    port: AtomicU16,
    https: AtomicBool,
}

struct MockServerHandle {
    port: u16,
    https: bool,
    started: Instant,
    handle: Handle<SocketAddr>,
    ipv6_handle: Option<Handle<SocketAddr>>,
    join: Option<JoinHandle<()>>,
}

type MockEmitter = Arc<dyn Fn(MockRequestLog) + Send + Sync>;
type MockAudit = Arc<dyn Fn(AuditEntry) + Send + Sync>;

#[derive(Clone)]
struct ServerCtx {
    projects: Arc<RwLock<Vec<MockProject>>>,
    logs: Arc<RwLock<Vec<MockRequestLog>>>,
    requests: Arc<AtomicU64>,
    running_projects: Arc<RwLock<HashSet<String>>>,
    emit: MockEmitter,
    audit: MockAudit,
}

impl MockServerHandle {
    fn status(&self) -> MockServerStatus {
        MockServerStatus {
            running: true,
            port: self.port,
            https: self.https,
            url: format!(
                "{}://localhost:{}",
                if self.https { "https" } else { "http" },
                self.port
            ),
            uptime_seconds: self.started.elapsed().as_secs(),
            total_requests: 0,
            running_projects: Vec::new(),
        }
    }

    fn stop(&mut self) {
        self.handle
            .graceful_shutdown(Some(Duration::from_millis(650)));
        if let Some(handle) = self.ipv6_handle.as_ref() {
            handle.graceful_shutdown(Some(Duration::from_millis(650)));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl MockState {
    pub fn new(paths: &DataPaths, port: u16, https: bool) -> Result<Self, String> {
        let mut projects = load_projects(&paths.mock_projects)?;
        if projects.is_empty() {
            projects.push(sample_project());
            save_project_file(&paths.mock_projects, &projects[0])?;
        }
        Ok(Self {
            projects: Arc::new(RwLock::new(projects)),
            logs: Arc::new(RwLock::new(Vec::new())),
            requests: Arc::new(AtomicU64::new(0)),
            running_projects: Arc::new(RwLock::new(HashSet::new())),
            server: Mutex::new(None),
            projects_dir: paths.mock_projects.clone(),
            certs_dir: paths.mock_certs.clone(),
            port: AtomicU16::new(port),
            https: AtomicBool::new(https),
        })
    }

    pub fn configure(&self, port: u16, https: bool) {
        self.port.store(port, Ordering::SeqCst);
        self.https.store(https, Ordering::SeqCst);
    }

    pub fn projects(&self) -> Vec<MockProject> {
        self.projects
            .read()
            .map(|projects| projects.clone())
            .unwrap_or_default()
    }

    pub fn request_logs(&self) -> Vec<MockRequestLog> {
        self.logs
            .read()
            .map(|logs| logs.clone())
            .unwrap_or_default()
    }

    fn running_project_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .running_projects
            .read()
            .map(|projects| projects.iter().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    pub fn set_runtime_response(
        &self,
        project_id: &str,
        endpoint_id: &str,
        response: Option<Value>,
    ) -> Result<(), String> {
        let mut projects = self
            .projects
            .write()
            .map_err(|_| "mock projects state is unavailable".to_string())?;
        let project = projects
            .iter_mut()
            .find(|project| project.id == project_id)
            .ok_or_else(|| format!("mock project not found: {project_id}"))?;
        let endpoint = project
            .endpoints
            .iter_mut()
            .find(|endpoint| endpoint.id == endpoint_id)
            .ok_or_else(|| format!("mock endpoint not found: {endpoint_id}"))?;
        endpoint.runtime_response = response;
        Ok(())
    }

    pub fn save_project(&self, mut project: MockProject) -> Result<MockProject, String> {
        if !valid_project_id(&project.id) {
            return Err("invalid mock project id".to_string());
        }
        project.slug = sanitize_slug(&project.slug);
        if project.slug.is_empty() {
            project.slug = sanitize_slug(&project.name);
        }
        if project.slug.is_empty() {
            project.slug = "mock-api".to_string();
        }
        project.updated_at = now_iso();
        project.version = 1;
        let mut projects = self
            .projects
            .write()
            .map_err(|_| "mock projects state is unavailable".to_string())?;
        project.slug = unique_slug(&projects, &project.slug, Some(&project.id));
        if let Some(existing) = projects.iter().find(|item| item.id == project.id) {
            for endpoint in &mut project.endpoints {
                if let Some(previous) = existing
                    .endpoints
                    .iter()
                    .find(|item| item.id == endpoint.id)
                {
                    endpoint.runtime_response = previous.runtime_response.clone();
                }
            }
        }
        if let Some(existing) = projects.iter_mut().find(|item| item.id == project.id) {
            *existing = project.clone();
        } else {
            projects.push(project.clone());
        }
        save_project_file(&self.projects_dir, &project)?;
        Ok(project)
    }

    pub fn create_project(
        &self,
        name: String,
        description: String,
        slug: String,
    ) -> Result<MockProject, String> {
        let mut projects = self
            .projects
            .write()
            .map_err(|_| "mock projects state is unavailable".to_string())?;
        let base = sanitize_slug(&slug);
        let base = if base.is_empty() {
            sanitize_slug(&name)
        } else {
            base
        };
        let base = if base.is_empty() {
            "mock-api".to_string()
        } else {
            base
        };
        let project = MockProject {
            version: 1,
            id: Uuid::new_v4().to_string(),
            name: if name.trim().is_empty() {
                "Untitled Mock API".to_string()
            } else {
                name.trim().to_string()
            },
            description: description.trim().to_string(),
            slug: unique_slug(&projects, &base, None),
            endpoints: Vec::new(),
            updated_at: now_iso(),
            schema_count: 1,
        };
        projects.push(project.clone());
        save_project_file(&self.projects_dir, &project)?;
        Ok(project)
    }

    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        if !valid_project_id(id) {
            return Err("invalid mock project id".to_string());
        }
        let mut projects = self
            .projects
            .write()
            .map_err(|_| "mock projects state is unavailable".to_string())?;
        projects.retain(|project| project.id != id);
        let path = self.projects_dir.join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("could not delete {}: {error}", path.display()))?;
        }
        drop(projects);
        let mut mounted = self
            .running_projects
            .write()
            .map_err(|_| "mock running projects state is unavailable".to_string())?;
        let was_mounted = mounted.remove(id);
        let empty = mounted.is_empty();
        drop(mounted);
        if was_mounted && empty {
            self.stop_server()?;
        }
        Ok(())
    }

    pub fn status(&self) -> MockServerStatus {
        let total_requests = self.requests.load(Ordering::SeqCst);
        if let Ok(server) = self.server.lock() {
            if let Some(server) = server.as_ref() {
                let mut status = server.status();
                status.total_requests = total_requests;
                status.running_projects = self.running_project_ids();
                return status;
            }
        }
        let port = self.port.load(Ordering::SeqCst);
        let https = self.https.load(Ordering::SeqCst);
        MockServerStatus {
            running: false,
            port,
            https,
            url: format!(
                "{}://localhost:{}",
                if https { "https" } else { "http" },
                port
            ),
            uptime_seconds: 0,
            total_requests,
            running_projects: Vec::new(),
        }
    }

    pub fn set_project_running(
        &self,
        app: AppHandle,
        project_id: &str,
        running: bool,
    ) -> Result<MockServerStatus, String> {
        let exists = self
            .projects
            .read()
            .map(|projects| projects.iter().any(|project| project.id == project_id))
            .unwrap_or(false);
        if !exists {
            return Err(format!("mock project not found: {project_id}"));
        }
        let mut mounted = self
            .running_projects
            .write()
            .map_err(|_| "mock running projects state is unavailable".to_string())?;
        if running {
            mounted.insert(project_id.to_string());
            drop(mounted);
            let has_server = self
                .server
                .lock()
                .map(|server| server.is_some())
                .unwrap_or(false);
            if !has_server {
                self.start_server(app)?;
            }
        } else {
            mounted.remove(project_id);
            let empty = mounted.is_empty();
            drop(mounted);
            if empty {
                self.stop_server()?;
            }
        }
        Ok(self.status())
    }

    pub fn start_server(&self, app: AppHandle) -> Result<MockServerStatus, String> {
        let mut guard = self
            .server
            .lock()
            .map_err(|_| "mock server state is unavailable".to_string())?;
        if let Some(server) = guard.as_ref() {
            return Ok(server.status());
        }
        let port = self.port.load(Ordering::SeqCst);
        let https = self.https.load(Ordering::SeqCst);
        let (listener, ipv6_listener) = bind_mock_listeners(port)?;

        let projects = self.projects.clone();
        let logs = self.logs.clone();
        let requests = self.requests.clone();
        let running_projects = self.running_projects.clone();
        self.requests.store(0, Ordering::SeqCst);
        if let Ok(mut entries) = logs.write() {
            entries.clear();
        }
        let emitter_app = app.clone();
        let emit: MockEmitter = Arc::new(move |entry| {
            let _ = emitter_app.emit("mock-request", entry);
        });
        let audit_app = app.clone();
        let audit: MockAudit = Arc::new(move |entry| {
            if let Some(state) = audit_app.try_state::<crate::state::AppState>() {
                crate::audit::record_and_emit(&audit_app, &state.audit, entry);
            }
        });
        let certs = self.certs_dir.clone();
        let handle = Handle::<SocketAddr>::new();
        let server_handle = handle.clone();
        let ipv6_handle = ipv6_listener.as_ref().map(|_| Handle::<SocketAddr>::new());
        let server_handle6 = ipv6_handle.clone();
        let join = thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("could not create mock runtime: {error}");
                    return;
                }
            };
            runtime.block_on(async move {
                let router = Router::new()
                    .fallback(handle_request)
                    .with_state(ServerCtx {
                        projects,
                        logs,
                        requests,
                        running_projects,
                        emit,
                        audit,
                    });
                if https {
                    let config = match tls_config(&certs).await {
                        Ok(config) => config,
                        Err(error) => {
                            eprintln!("could not prepare mock TLS: {error}");
                            return;
                        }
                    };
                    let config6 = config.clone();
                    let router6 = router.clone();
                    let handle6 = server_handle6.clone();
                    tokio::join!(
                        serve_https(listener, router, server_handle, config),
                        async move {
                            if let Some(listener) = ipv6_listener {
                                if let Some(handle) = handle6 {
                                    serve_https(listener, router6, handle, config6).await;
                                }
                            }
                        }
                    );
                } else {
                    let router6 = router.clone();
                    let handle6 = server_handle6.clone();
                    tokio::join!(
                        serve_http(listener, router, server_handle),
                        async move {
                            if let Some(listener) = ipv6_listener {
                                if let Some(handle) = handle6 {
                                    serve_http(listener, router6, handle).await;
                                }
                            }
                        }
                    );
                }
            });
        });

        let server = MockServerHandle {
            port,
            https,
            started: Instant::now(),
            handle,
            ipv6_handle,
            join: Some(join),
        };
        let status = server.status();
        *guard = Some(server);
        Ok(status)
    }

    pub fn stop_server(&self) -> Result<MockServerStatus, String> {
        {
            let mut guard = self
                .server
                .lock()
                .map_err(|_| "mock server state is unavailable".to_string())?;
            if let Some(mut server) = guard.take() {
                server.stop();
            }
        }
        Ok(self.status())
    }
}

pub fn load_projects(directory: &Path) -> Result<Vec<MockProject>, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
    let mut projects = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("could not read {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        match serde_json::from_str::<MockProject>(&text) {
            Ok(project) => {
                if !valid_project_id(&project.id) {
                    eprintln!("skipping mock project with invalid id: {}", path.display());
                    continue;
                }
                if projects
                    .iter()
                    .any(|existing: &MockProject| existing.id == project.id)
                {
                    eprintln!("skipping duplicate mock project id: {}", path.display());
                    continue;
                }
                projects.push(project);
            }
            Err(error) => eprintln!("skipping mock project {}: {error}", path.display()),
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

pub fn save_project_file(directory: &Path, project: &MockProject) -> Result<(), String> {
    if !valid_project_id(&project.id) {
        return Err("invalid mock project id".to_string());
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
    write_json(&directory.join(format!("{}.json", project.id)), project)
}

fn sample_project() -> MockProject {
    MockProject {
        version: 1,
        id: "mock-movies".to_string(),
        name: "Movies API".to_string(),
        description: "Local movie catalog mock for development.".to_string(),
        slug: "movies-api".to_string(),
        updated_at: now_iso(),
        schema_count: 1,
        endpoints: vec![
            MockEndpoint {
                id: "movies-list".to_string(),
                method: "GET".to_string(),
                path: "/movies".to_string(),
                name: "List movies".to_string(),
                status: 200,
                delay_ms: 0,
                enabled: true,
                response: json!({
                    "movies": [
                        {
                            "id": "tt0944947",
                            "title": "Game of Thrones",
                            "year": 2011,
                            "rating": 9.2,
                            "genres": ["Drama", "Fantasy"]
                        },
                        {
                            "id": "tt0306414",
                            "title": "The Wire",
                            "year": 2002,
                            "rating": 9.3,
                            "genres": ["Crime", "Drama"]
                        }
                    ],
                    "meta": { "count": 2, "source": "mock" }
                }),
                imported_from: None,
                generated_info: None,
                runtime_response: None,
            },
            MockEndpoint {
                id: "movies-get".to_string(),
                method: "GET".to_string(),
                path: "/movies/:id".to_string(),
                name: "Get movie".to_string(),
                status: 200,
                delay_ms: 0,
                enabled: true,
                response: json!({
                    "id": "tt0944947",
                    "title": "Game of Thrones",
                    "year": 2011,
                    "rating": 9.2
                }),
                imported_from: None,
                generated_info: None,
                runtime_response: None,
            },
            MockEndpoint {
                id: "movies-create".to_string(),
                method: "POST".to_string(),
                path: "/movies".to_string(),
                name: "Create movie".to_string(),
                status: 201,
                delay_ms: 0,
                enabled: true,
                response: json!({
                    "id": "tt-new",
                    "title": "New movie"
                }),
                imported_from: None,
                generated_info: None,
                runtime_response: None,
            },
        ],
    }
}

fn sanitize_slug(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .trim_matches('/')
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn unique_slug(projects: &[MockProject], base: &str, exclude: Option<&str>) -> String {
    let base = if base.is_empty() { "mock-api" } else { base };
    let mut candidate = base.to_string();
    let mut index = 2;
    while projects
        .iter()
        .any(|project| project.slug == candidate && Some(project.id.as_str()) != exclude)
    {
        candidate = format!("{base}-{index}");
        index += 1;
    }
    candidate
}

fn mounted_projects(
    projects: Vec<MockProject>,
    running: &HashSet<String>,
) -> Vec<MockProject> {
    projects
        .into_iter()
        .filter(|project| running.contains(&project.id))
        .collect()
}

fn effective_response(endpoint: &MockEndpoint) -> &Value {
    endpoint
        .runtime_response
        .as_ref()
        .unwrap_or(&endpoint.response)
}

async fn handle_request(
    State(ctx): State<ServerCtx>,
    request: Request<Body>,
) -> Response {
    let started = std::time::Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();
    if method == Method::OPTIONS {
        return cors_response(StatusCode::NO_CONTENT, Body::empty());
    }
    ctx.requests.fetch_add(1, Ordering::SeqCst);
    if path_has_traversal(&path) {
        let decoded = percent_decode_path(&path).replace('\\', "/");
        (ctx.audit)(AuditEntry::app(
            "traversal",
            "critical",
            "Directory traversal",
            decoded,
            "mock-route",
            true,
            "Rule: mock route path escapes its project mount.",
        ));
        let entry = MockRequestLog {
            project_id: String::new(),
            project_name: String::new(),
            method: method.as_str().to_string(),
            path: path.clone(),
            status: StatusCode::FORBIDDEN.as_u16(),
            duration_ms: started.elapsed().as_millis() as u64,
            at: now_iso(),
        };
        if let Ok(mut logs) = ctx.logs.write() {
            logs.insert(0, entry.clone());
            logs.truncate(200);
        }
        (ctx.emit)(entry);
        let body = json!({
            "error": "Mock route path is outside the mounted project",
            "method": method.as_str(),
            "path": path
        });
        return cors_response(
            StatusCode::FORBIDDEN,
            Body::from(serde_json::to_vec(&body).unwrap_or_default()),
        );
    }
    let mounted = ctx
        .running_projects
        .read()
        .map(|projects| projects.clone())
        .unwrap_or_default();
    let projects = ctx
        .projects
        .read()
        .map(|projects| projects.clone())
        .unwrap_or_default();
    let active = mounted_projects(projects, &mounted);
    let matched = find_endpoint(&active, method.as_str(), &path, &query);
    let Some((project, endpoint)) = matched else {
        let body = json!({
            "error": "No mock endpoint matched",
            "method": method.as_str(),
            "path": path
        });
        let entry = MockRequestLog {
            project_id: String::new(),
            project_name: String::new(),
            method: method.as_str().to_string(),
            path: path.clone(),
            status: StatusCode::NOT_FOUND.as_u16(),
            duration_ms: started.elapsed().as_millis() as u64,
            at: now_iso(),
        };
        if let Ok(mut logs) = ctx.logs.write() {
            logs.insert(0, entry.clone());
            logs.truncate(200);
        }
        (ctx.emit)(entry);
        return cors_response(
            StatusCode::NOT_FOUND,
            Body::from(serde_json::to_vec(&body).unwrap_or_default()),
        );
    };

    if endpoint.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(endpoint.delay_ms.min(5000))).await;
    }
    let status = StatusCode::from_u16(endpoint.status).unwrap_or(StatusCode::OK);
    let body = if status == StatusCode::NO_CONTENT {
        Vec::new()
    } else {
        serde_json::to_vec(effective_response(&endpoint))
            .unwrap_or_else(|_| b"null".to_vec())
    };
    let entry = MockRequestLog {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        method: method.as_str().to_string(),
        path,
        status: status.as_u16(),
        duration_ms: started.elapsed().as_millis() as u64,
        at: now_iso(),
    };
    if let Ok(mut logs) = ctx.logs.write() {
        logs.insert(0, entry.clone());
        logs.truncate(200);
    }
    (ctx.emit)(entry);
    cors_response(status, Body::from(body))
}

fn find_endpoint(
    projects: &[MockProject],
    method: &str,
    path: &str,
    query: &str,
) -> Option<(MockProject, MockEndpoint)> {
    for project in projects {
        let base = format!("/{}", project.slug);
        let rest = if path == base {
            "/"
        } else if path.starts_with(&format!("{base}/")) {
            &path[base.len()..]
        } else {
            continue;
        };
        for endpoint in &project.endpoints {
            if !endpoint.enabled || endpoint.method.to_uppercase() != method.to_uppercase() {
                continue;
            }
            let (route, route_query) = endpoint
                .path
                .split_once('?')
                .unwrap_or((endpoint.path.as_str(), ""));
            if path_matches(route, rest) && query_matches(route_query, query) {
                return Some((project.clone(), endpoint.clone()));
            }
        }
    }
    None
}

fn percent_decode(input: &str, plus_as_space: bool) -> String {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' if plus_as_space => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = (bytes[index + 1] as char).to_digit(16);
                let low = (bytes[index + 2] as char).to_digit(16);
                if let (Some(high), Some(low)) = (high, low) {
                    decoded.push((high * 16 + low) as u8);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).to_string()
}

fn percent_decode_path(input: &str) -> String {
    percent_decode(input, false)
}

fn percent_decode_query(input: &str) -> String {
    percent_decode(input, true)
}

fn path_has_traversal(path: &str) -> bool {
    let decoded = percent_decode_path(path).replace('\\', "/");
    decoded.split('/').any(|segment| segment == "..")
}

fn query_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (
                percent_decode_query(key),
                percent_decode_query(value),
            )
        })
        .collect()
}

fn query_matches(pattern: &str, actual: &str) -> bool {
    if pattern.trim().is_empty() {
        return true;
    }
    let expected = query_pairs(pattern);
    if expected.is_empty() {
        return true;
    }
    let received = query_pairs(actual);
    expected.iter().all(|(key, value)| {
        received.iter().any(|(actual_key, actual_value)| {
            actual_key == key
                && (value.starts_with(':') || value == actual_value)
        })
    })
}

fn path_matches(pattern: &str, actual: &str) -> bool {
    let pattern_parts: Vec<&str> = pattern.trim_matches('/').split('/').filter(|part| !part.is_empty()).collect();
    let actual_parts: Vec<&str> = actual.trim_matches('/').split('/').filter(|part| !part.is_empty()).collect();
    if pattern_parts.len() != actual_parts.len() {
        return false;
    }
    pattern_parts
        .iter()
        .zip(actual_parts.iter())
        .all(|(expected, received)| expected.starts_with(':') || expected == received)
}

fn cors_response(status: StatusCode, body: Body) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS".parse().unwrap(),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, "*".parse().unwrap());
    if status != StatusCode::NO_CONTENT {
        headers.insert(
            header::CONTENT_TYPE,
            "application/json; charset=utf-8".parse().unwrap(),
        );
    }
    response
}

fn bind_mock_listeners(port: u16) -> Result<(TcpListener, Option<TcpListener>), String> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
        .map_err(|error| format!("could not bind mock port {port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("could not configure mock listener: {error}"))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("could not inspect mock listener: {error}"))?
        .port();
    let ipv6_listener = TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, bound_port)))
        .ok()
        .and_then(|listener| {
            listener
                .set_nonblocking(true)
                .ok()
                .map(|_| listener)
        });
    Ok((listener, ipv6_listener))
}

async fn serve_http(
    listener: TcpListener,
    router: Router,
    handle: Handle<SocketAddr>,
) {
    match axum_server::from_tcp(listener) {
        Ok(server) => {
            if let Err(error) = server
                .handle(handle)
                .serve(router.into_make_service())
                .await
            {
                eprintln!("mock server stopped: {error}");
            }
        }
        Err(error) => eprintln!("could not create mock server: {error}"),
    }
}

async fn serve_https(
    listener: TcpListener,
    router: Router,
    handle: Handle<SocketAddr>,
    config: RustlsConfig,
) {
    match axum_server::from_tcp_rustls(listener, config) {
        Ok(server) => {
            if let Err(error) = server
                .handle(handle)
                .serve(router.into_make_service())
                .await
            {
                eprintln!("mock TLS server stopped: {error}");
            }
        }
        Err(error) => eprintln!("could not create mock TLS server: {error}"),
    }
}

async fn tls_config(certs: &Path) -> Result<RustlsConfig, String> {
    fs::create_dir_all(certs)
        .map_err(|error| format!("could not create {}: {error}", certs.display()))?;
    let cert_path = certs.join("mock-cert.pem");
    let key_path = certs.join("mock-key.pem");
    if !cert_path.exists() || !key_path.exists() {
        let generated = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .map_err(|error| format!("could not generate TLS certificate: {error}"))?;
        write_text(&cert_path, &generated.cert.pem())?;
        write_text(&key_path, &generated.signing_key.serialize_pem())?;
    }
    let cert = fs::read_to_string(&cert_path)
        .map_err(|error| format!("could not read {}: {error}", cert_path.display()))?;
    let key = fs::read_to_string(&key_path)
        .map_err(|error| format!("could not read {}: {error}", key_path.display()))?;
    RustlsConfig::from_pem(cert.into_bytes(), key.into_bytes())
        .await
        .map_err(|error| format!("could not load TLS certificate: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_mock_listeners_to_loopback() {
        let (ipv4, ipv6) = bind_mock_listeners(0).expect("listeners");
        let ipv4_address = ipv4.local_addr().expect("ipv4 address");
        assert!(ipv4_address.ip().is_loopback());
        if let Some(ipv6) = ipv6 {
            let ipv6_address = ipv6.local_addr().expect("ipv6 address");
            assert!(ipv6_address.ip().is_loopback());
            assert_eq!(ipv6_address.port(), ipv4_address.port());
        }
    }

    #[test]
    fn serves_both_loopback_families() {
        use std::io::{Read, Write};
        use std::net::TcpStream;

        let (ipv4, ipv6) = bind_mock_listeners(0).expect("listeners");
        let Some(ipv6) = ipv6 else {
            return;
        };
        let port = ipv4.local_addr().expect("ipv4 address").port();
        let ipv4_handle = Handle::<SocketAddr>::new();
        let ipv6_handle = Handle::<SocketAddr>::new();
        let shutdown_v4 = ipv4_handle.clone();
        let shutdown_v6 = ipv6_handle.clone();
        let join = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let router = Router::new().route("/", axum::routing::get(|| async { "ok" }));
                tokio::join!(
                    serve_http(ipv4, router.clone(), shutdown_v4),
                    serve_http(ipv6, router, shutdown_v6)
                );
            });
        });

        for address in [
            SocketAddr::from(([127, 0, 0, 1], port)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        ] {
            let mut stream = None;
            for _ in 0..60 {
                if let Ok(connection) = TcpStream::connect(address) {
                    stream = Some(connection);
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let mut stream = stream.expect("listener should accept connections");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("timeout");
            stream
                .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .expect("write");
            let mut response = String::new();
            stream.read_to_string(&mut response).expect("read");
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.ends_with("ok"));
        }

        ipv4_handle.graceful_shutdown(Some(Duration::from_millis(50)));
        ipv6_handle.graceful_shutdown(Some(Duration::from_millis(50)));
        join.join().expect("server thread");
    }

    #[test]
    fn axum_server_accepts_a_nonblocking_listener() {
        use std::io::{Read, Write};
        use std::net::TcpStream;

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("listener");
        listener.set_nonblocking(true).expect("nonblocking");
        let address = listener.local_addr().expect("address");
        let handle = Handle::<SocketAddr>::new();
        let shutdown = handle.clone();
        let join = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let router = Router::new().route("/", axum::routing::get(|| async { "ok" }));
                if let Ok(server) = axum_server::from_tcp(listener) {
                    let _ = server
                        .handle(shutdown)
                        .serve(router.into_make_service())
                        .await;
                }
            });
        });

        let mut stream = None;
        for _ in 0..60 {
            if let Ok(connection) = TcpStream::connect(address) {
                stream = Some(connection);
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let mut stream = stream.expect("server should accept connections");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .expect("write");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.ends_with("ok"));

        handle.graceful_shutdown(Some(Duration::from_millis(50)));
        join.join().expect("server thread");
    }

    #[test]
    fn matches_path_parameters() {
        assert!(path_matches("/movies", "/movies"));
        assert!(path_matches("/movies/:id", "/movies/42"));
        assert!(!path_matches("/movies/:id", "/movies"));
        assert!(!path_matches("/movies/:id", "/shows/42"));
    }

    #[test]
    fn matches_query_parameters() {
        assert!(query_matches("", "page=2"));
        assert!(query_matches("type=movie", "type=movie&page=2"));
        assert!(query_matches("type=movie&page=2", "page=2&type=movie"));
        assert!(query_matches("type=:kind", "type=movie"));
        assert!(query_matches("name=Ada%20Lovelace", "name=Ada+Lovelace"));
        assert!(!query_matches("type=movie", "type=show"));
        assert!(!query_matches("type=movie", ""));
    }

    #[test]
    fn finds_endpoint_with_query_pattern() {
        let mut project = sample_project();
        project.endpoints[0].path = "/movies?genre=:genre".to_string();
        let (_, endpoint) = find_endpoint(
            &[project],
            "GET",
            "/movies-api/movies",
            "genre=drama&page=2",
        )
        .expect("query route");
        assert_eq!(endpoint.path, "/movies?genre=:genre");
        assert!(find_endpoint(
            &[sample_project()],
            "GET",
            "/movies-api/movies",
            ""
        )
        .is_some());
    }

    #[test]
    fn sanitizes_and_uniquifies_slugs() {
        assert_eq!(sanitize_slug(" My API / V1 "), "my-api-v1");
        let projects = vec![MockProject {
            version: 1,
            id: "a".into(),
            name: "A".into(),
            description: String::new(),
            slug: "movies".into(),
            endpoints: vec![],
            updated_at: String::new(),
            schema_count: 1,
        }];
        assert_eq!(unique_slug(&projects, "movies", None), "movies-2");
        assert_eq!(unique_slug(&projects, "movies", Some("a")), "movies");
    }

    #[test]
    fn detects_route_traversal_patterns() {
        assert!(path_has_traversal("/movies-api/../secret"));
        assert!(path_has_traversal("/movies-api/%2e%2e/secret"));
        assert!(path_has_traversal("/movies-api/movies\\..\\secret"));
        assert!(!path_has_traversal("/movies-api/movies/tt1"));
        assert!(!path_has_traversal("/movies-api/movies/..hidden"));
    }

    #[tokio::test]
    async fn blocks_and_audits_route_traversal() {
        let project = sample_project();
        let project_id = project.id.clone();
        let captured: Arc<Mutex<Vec<AuditEntry>>> = Arc::new(Mutex::new(Vec::new()));
        let captured_writer = captured.clone();
        let ctx = ServerCtx {
            projects: Arc::new(RwLock::new(vec![project])),
            logs: Arc::new(RwLock::new(Vec::new())),
            requests: Arc::new(AtomicU64::new(0)),
            running_projects: Arc::new(RwLock::new(HashSet::from([project_id]))),
            emit: Arc::new(|_| {}),
            audit: Arc::new(move |entry| {
                captured_writer.lock().expect("capture").push(entry);
            }),
        };
        let request = Request::builder()
            .method("GET")
            .uri("/movies-api/%2e%2e/secret")
            .body(Body::empty())
            .expect("request");
        let response = handle_request(axum::extract::State(ctx.clone()), request).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let audits = captured.lock().expect("audit");
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].category, "traversal");
        assert!(audits[0].blocked);
        assert!(audits[0].target.contains("../secret"));
        assert_eq!(ctx.requests.load(Ordering::SeqCst), 1);
        assert_eq!(ctx.logs.read().expect("logs")[0].status, 403);
    }

    #[test]
    fn finds_mounted_endpoint() {
        let project = sample_project();
        let (found, endpoint) =
            find_endpoint(&[project], "GET", "/movies-api/movies/tt1", "").expect("route");
        assert_eq!(found.slug, "movies-api");
        assert_eq!(endpoint.path, "/movies/:id");
    }

    #[tokio::test]
    async fn mounted_routes_use_runtime_responses() {
        let project = sample_project();
        let project_id = project.id.clone();
        let projects = Arc::new(RwLock::new(vec![project]));
        let logs = Arc::new(RwLock::new(Vec::new()));
        let requests = Arc::new(AtomicU64::new(0));
        let running = Arc::new(RwLock::new(HashSet::from([project_id.clone()])));
        let ctx = ServerCtx {
            projects: projects.clone(),
            logs: logs.clone(),
            requests: requests.clone(),
            running_projects: running.clone(),
            emit: Arc::new(|_| {}),
            audit: Arc::new(|_| {}),
        };
        let request = || {
            Request::builder()
                .method("GET")
                .uri("/movies-api/movies")
                .body(Body::empty())
                .expect("request")
        };

        let response = handle_request(axum::extract::State(ctx.clone()), request()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let text = String::from_utf8(bytes.to_vec()).expect("utf8");
        assert!(text.contains("Game of Thrones"));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(logs.read().expect("logs").len(), 1);

        projects.write().expect("projects")[0].endpoints[0].runtime_response =
            Some(json!({ "runtime": true }));
        let response = handle_request(axum::extract::State(ctx.clone()), request()).await;
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let text = String::from_utf8(bytes.to_vec()).expect("utf8");
        assert!(text.contains("\"runtime\":true"));

        running.write().expect("running").clear();
        let response = handle_request(axum::extract::State(ctx), request()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(requests.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn only_running_projects_are_mounted() {
        let project = sample_project();
        let id = project.id.clone();
        assert!(mounted_projects(vec![project.clone()], &HashSet::new()).is_empty());
        let running: HashSet<String> = [id].into_iter().collect();
        let active = mounted_projects(vec![project], &running);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "mock-movies");
    }

    #[test]
    fn runtime_response_overrides_static_response() {
        let mut endpoint = sample_project().endpoints.remove(0);
        assert_eq!(effective_response(&endpoint), &endpoint.response);
        endpoint.runtime_response = Some(json!([{ "id": "live" }]));
        assert_eq!(
            effective_response(&endpoint),
            &json!([{ "id": "live" }])
        );
        endpoint.runtime_response = None;
        assert_eq!(effective_response(&endpoint), &endpoint.response);
    }

    #[test]
    fn status_reports_total_requests() {
        use crate::data::DataPaths;

        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DataPaths::from_root(temp.path().join(".json_buddy")).expect("paths");
        let state = MockState::new(&paths, 4010, false).expect("mock state");
        state.requests.store(12, Ordering::SeqCst);
        assert_eq!(state.status().total_requests, 12);
    }

    #[test]
    fn rejects_project_ids_that_escape_the_project_directory() {
        use crate::data::DataPaths;

        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DataPaths::from_root(temp.path().join(".json_buddy")).expect("paths");
        let state = MockState::new(&paths, 4010, false).expect("mock state");
        let outside = temp.path().join("outside.json");
        fs::write(&outside, "{}").expect("outside");
        assert!(state.delete_project("../outside").is_err());
        assert!(outside.exists());

        let mut project = sample_project();
        project.id = "../outside".to_string();
        assert!(state.save_project(project).is_err());
        assert_eq!(fs::read_to_string(&outside).expect("outside"), "{}");
    }

    #[test]
    fn deleting_a_project_clears_its_mount_state() {
        use crate::data::DataPaths;

        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DataPaths::from_root(temp.path().join(".json_buddy")).expect("paths");
        let state = MockState::new(&paths, 4010, false).expect("mock state");
        let project = state.projects().remove(0);
        state
            .running_projects
            .write()
            .expect("running projects")
            .insert(project.id.clone());
        state.delete_project(&project.id).expect("delete project");
        assert!(state
            .running_projects
            .read()
            .expect("running projects")
            .is_empty());
        assert!(state.projects().is_empty());
    }

    #[test]
    fn runtime_responses_stay_out_of_project_files() {
        use crate::data::DataPaths;

        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DataPaths::from_root(temp.path().join(".json_buddy")).expect("paths");
        let state = MockState::new(&paths, 4010, false).expect("mock state");
        let mut project = state.projects().remove(0);
        let endpoint_id = project.endpoints[0].id.clone();
        state
            .set_runtime_response(
                &project.id,
                &endpoint_id,
                Some(json!([{ "id": "generated" }])),
            )
            .expect("runtime response");
        project.name = "Movies API updated".to_string();
        project.endpoints[0].imported_from = Some("movies.schema.json".to_string());
        let generated_info = json!({
            "n": 10,
            "seed": 42,
            "options": { "realistic": true, "unique": true, "vary": true, "nulls": false },
            "arrayOnly": false
        });
        project.endpoints[0].generated_info = Some(generated_info.clone());
        state.save_project(project).expect("save project");

        let live = state.projects().remove(0);
        let endpoint = live
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == endpoint_id)
            .expect("endpoint");
        assert!(endpoint.runtime_response.is_some());
        assert_eq!(endpoint.generated_info, Some(generated_info.clone()));

        let stored = load_projects(&paths.mock_projects).expect("load projects");
        let stored_endpoint = stored[0]
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == endpoint_id)
            .expect("stored endpoint");
        assert!(stored_endpoint.runtime_response.is_none());
        assert_eq!(stored_endpoint.generated_info, Some(generated_info));
        assert_eq!(
            stored_endpoint.imported_from.as_deref(),
            Some("movies.schema.json")
        );
    }

    #[test]
    fn project_round_trip() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project = sample_project();
        save_project_file(temp.path(), &project).expect("save");
        let loaded = load_projects(temp.path()).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Movies API");
        assert_eq!(loaded[0].endpoints.len(), 3);
    }
}

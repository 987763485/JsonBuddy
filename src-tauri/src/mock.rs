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
use std::fs;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServerStatus {
    pub running: bool,
    pub port: u16,
    pub https: bool,
    pub url: String,
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
    server: Mutex<Option<MockServerHandle>>,
    projects_dir: PathBuf,
    certs_dir: PathBuf,
    port: AtomicU16,
    https: AtomicBool,
}

struct MockServerHandle {
    port: u16,
    https: bool,
    handle: Handle<SocketAddr>,
    join: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct ServerCtx {
    projects: Arc<RwLock<Vec<MockProject>>>,
    logs: Arc<RwLock<Vec<MockRequestLog>>>,
    app: AppHandle,
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
        }
    }

    fn stop(&mut self) {
        self.handle
            .graceful_shutdown(Some(Duration::from_millis(650)));
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

    pub fn save_project(&self, mut project: MockProject) -> Result<MockProject, String> {
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
        Ok(())
    }

    pub fn status(&self) -> MockServerStatus {
        if let Ok(server) = self.server.lock() {
            if let Some(server) = server.as_ref() {
                return server.status();
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
        }
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
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
            .map_err(|error| format!("could not bind mock port {port}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure mock listener: {error}"))?;

        let projects = self.projects.clone();
        let logs = self.logs.clone();
        if let Ok(mut entries) = logs.write() {
            entries.clear();
        }
        let app_handle = app.clone();
        let certs = self.certs_dir.clone();
        let handle = Handle::<SocketAddr>::new();
        let server_handle = handle.clone();
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
                        app: app_handle,
                    });
                let result = if https {
                    match tls_config(&certs).await {
                        Ok(config) => match axum_server::from_tcp_rustls(listener, config) {
                            Ok(server) => {
                                server
                                    .handle(server_handle)
                                    .serve(router.into_make_service())
                                    .await
                            }
                            Err(error) => {
                                eprintln!("could not create mock TLS server: {error}");
                                return;
                            }
                        },
                        Err(error) => {
                            eprintln!("could not prepare mock TLS: {error}");
                            return;
                        }
                    }
                } else {
                    match axum_server::from_tcp(listener) {
                        Ok(server) => {
                            server
                                .handle(server_handle)
                                .serve(router.into_make_service())
                                .await
                        }
                        Err(error) => {
                            eprintln!("could not create mock server: {error}");
                            return;
                        }
                    }
                };
                if let Err(error) = result {
                    eprintln!("mock server stopped: {error}");
                }
            });
        });

        let server = MockServerHandle {
            port,
            https,
            handle,
            join: Some(join),
        };
        let status = server.status();
        *guard = Some(server);
        Ok(status)
    }

    pub fn stop_server(&self) -> Result<MockServerStatus, String> {
        let mut guard = self
            .server
            .lock()
            .map_err(|_| "mock server state is unavailable".to_string())?;
        if let Some(mut server) = guard.take() {
            server.stop();
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
            Ok(project) => projects.push(project),
            Err(error) => eprintln!("skipping mock project {}: {error}", path.display()),
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

pub fn save_project_file(directory: &Path, project: &MockProject) -> Result<(), String> {
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

async fn handle_request(
    State(ctx): State<ServerCtx>,
    request: Request<Body>,
) -> Response {
    let started = std::time::Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if method == Method::OPTIONS {
        return cors_response(StatusCode::NO_CONTENT, Body::empty());
    }
    let projects = ctx
        .projects
        .read()
        .map(|projects| projects.clone())
        .unwrap_or_default();
    let matched = find_endpoint(&projects, method.as_str(), &path);
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
        let _ = ctx.app.emit("mock-request", entry);
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
        serde_json::to_vec(&endpoint.response).unwrap_or_else(|_| b"null".to_vec())
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
    let _ = ctx.app.emit("mock-request", entry);
    cors_response(status, Body::from(body))
}

fn find_endpoint(
    projects: &[MockProject],
    method: &str,
    path: &str,
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
            if path_matches(&endpoint.path, rest) {
                return Some((project.clone(), endpoint.clone()));
            }
        }
    }
    None
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
        "GET,POST,PUT,PATCH,DELETE,OPTIONS".parse().unwrap(),
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
    fn matches_path_parameters() {
        assert!(path_matches("/movies", "/movies"));
        assert!(path_matches("/movies/:id", "/movies/42"));
        assert!(!path_matches("/movies/:id", "/movies"));
        assert!(!path_matches("/movies/:id", "/shows/42"));
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
    fn finds_mounted_endpoint() {
        let project = sample_project();
        let (found, endpoint) = find_endpoint(&[project], "GET", "/movies-api/movies/tt1").expect("route");
        assert_eq!(found.slug, "movies-api");
        assert_eq!(endpoint.path, "/movies/:id");
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

use crate::conversation::{Conversation, ToolCall};
use crate::data::write_json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const AUDIT_LIMIT: usize = 500;

pub const CATEGORIES: [&str; 6] = [
    "traversal",
    "read",
    "upload",
    "delete",
    "shell",
    "network",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub path: String,
    pub category: String,
    pub severity: String,
    pub label: String,
    pub target: String,
    pub tool: String,
    pub session_id: Option<String>,
    pub timestamp: Option<String>,
    pub blocked: bool,
    pub rule: String,
    pub line: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditConfig {
    pub categories: HashMap<String, bool>,
    #[serde(default)]
    pub acknowledged: Vec<String>,
}

impl Default for AuditConfig {
    fn default() -> Self {
        let mut categories = HashMap::new();
        for category in CATEGORIES {
            let enabled = matches!(category, "traversal" | "upload" | "delete");
            categories.insert(category.to_string(), enabled);
        }
        Self {
            categories,
            acknowledged: Vec::new(),
        }
    }
}

impl AuditConfig {
    fn normalized(mut self) -> Self {
        for category in CATEGORIES {
            self.categories.entry(category.to_string()).or_insert(false);
        }
        self.categories.retain(|key, _| CATEGORIES.contains(&key.as_str()));
        self.acknowledged.sort();
        self.acknowledged.dedup();
        if self.acknowledged.len() > 1000 {
            let start = self.acknowledged.len() - 1000;
            self.acknowledged.drain(..start);
        }
        self
    }

    pub fn enabled(&self, category: &str) -> bool {
        self.categories.get(category).copied().unwrap_or(false)
    }
}

pub struct AuditState {
    config: Mutex<AuditConfig>,
    path: PathBuf,
}

impl AuditState {
    pub fn new(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory)
            .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
        let path = directory.join("config.json");
        let config = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<AuditConfig>(&text).ok())
                .unwrap_or_default()
                .normalized()
        } else {
            let default = AuditConfig::default();
            write_config(&path, &default)?;
            default
        };
        Ok(Self {
            config: Mutex::new(config),
            path,
        })
    }

    pub fn config(&self) -> AuditConfig {
        self.config
            .lock()
            .map(|config| config.clone())
            .unwrap_or_default()
    }

    pub fn update_categories(
        &self,
        categories: HashMap<String, bool>,
    ) -> Result<AuditConfig, String> {
        let mut config = self
            .config
            .lock()
            .map_err(|_| "audit state is unavailable".to_string())?;
        let mut next = config.clone();
        next.categories = categories;
        next = next.normalized();
        write_config(&self.path, &next)?;
        *config = next.clone();
        Ok(next)
    }

    pub fn acknowledge(&self, id: &str) -> Result<AuditConfig, String> {
        let mut config = self
            .config
            .lock()
            .map_err(|_| "audit state is unavailable".to_string())?;
        if !config.acknowledged.iter().any(|entry| entry == id) {
            config.acknowledged.push(id.to_string());
            let next = config.clone().normalized();
            write_config(&self.path, &next)?;
            *config = next;
        }
        Ok(config.clone())
    }
}

fn write_config(path: &Path, config: &AuditConfig) -> Result<(), String> {
    write_json(path, config)
}

pub fn analyze(conversation: &Conversation, stream_path: &str) -> Vec<AuditEntry> {
    let mut entries = Vec::new();
    for call in &conversation.tool_calls {
        if let Some(entry) = classify(call, conversation, stream_path) {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| entry.line);
    if entries.len() > AUDIT_LIMIT {
        let start = entries.len() - AUDIT_LIMIT;
        entries.drain(..start);
    }
    entries.reverse();
    entries
}

fn classify(
    call: &ToolCall,
    conversation: &Conversation,
    stream_path: &str,
) -> Option<AuditEntry> {
    let name = call.name.to_ascii_lowercase();
    let arguments = serde_json::from_str::<Value>(&call.arguments).ok();
    let flat = call.arguments.to_ascii_lowercase();
    let command = string_value(arguments.as_ref(), &["command", "cmd", "script"]);
    let path = string_value(
        arguments.as_ref(),
        &["path", "file", "filename", "target", "source"],
    );
    let url = find_url(&call.arguments);
    let failed = call.status == "error";

    let traversal = find_traversal(arguments.as_ref());
    let (category, severity, label, target, blocked, rule) = if is_delete(&name, &command, &flat) {
        (
            "delete",
            "critical",
            "File deletion",
            command.clone().or(path.clone()).unwrap_or_else(|| summary(&call.arguments)),
            failed,
            if failed {
                "Rule: destructive file operation. The sandbox denied it.".to_string()
            } else {
                "Rule: destructive file operation outside the allowlist.".to_string()
            },
        )
    } else if let Some(escape) = traversal {
        (
            "traversal",
            "critical",
            "Directory traversal",
            escape,
            true,
            "Rule: path escapes the workspace root. The request is blocked by policy.".to_string(),
        )
    } else if is_upload(&name, &flat, url.as_deref()) {
        let remote = url
            .as_deref()
            .map(|value| format!("{} → {}", path.clone().unwrap_or_else(|| "file".to_string()), host_of(value)))
            .unwrap_or_else(|| path.clone().or(command.clone()).unwrap_or_else(|| summary(&call.arguments)));
        (
            "upload",
            "warning",
            "File upload",
            remote,
            failed,
            if failed {
                "Rule: outbound upload was denied.".to_string()
            } else {
                "Rule: outbound upload to a non-local destination.".to_string()
            },
        )
    } else if let Some(remote) = url
        .as_deref()
        .filter(|value| !is_local_url(value))
        .filter(|_| is_network(&name, &flat))
    {
        (
            "network",
            "warning",
            "Network egress",
            remote.to_string(),
            failed,
            if failed {
                "Rule: outbound request was denied.".to_string()
            } else {
                "Rule: outbound request to a non-local host.".to_string()
            },
        )
    } else if is_shell(&name, &command, &flat) {
        (
            "shell",
            "warning",
            "Shell execution",
            command.clone().or(path.clone()).unwrap_or_else(|| summary(&call.arguments)),
            failed,
            if failed {
                "Rule: shell command failed or was denied.".to_string()
            } else {
                "Rule: shell command observed and allowed by the sandbox.".to_string()
            },
        )
    } else if is_read(&name) {
        (
            "read",
            "info",
            "File read",
            path.clone().unwrap_or_else(|| summary(&call.arguments)),
            failed,
            if failed {
                "Rule: file read was denied.".to_string()
            } else {
                "Rule: file read inside the workspace.".to_string()
            },
        )
    } else {
        return None;
    };

    Some(AuditEntry {
        id: format!("{stream_path}::{}::{}", call.line, call.id),
        path: stream_path.to_string(),
        category: category.to_string(),
        severity: severity.to_string(),
        label: label.to_string(),
        target: target.trim().to_string(),
        tool: call.name.clone(),
        session_id: conversation.session_id.clone(),
        timestamp: call.timestamp.clone(),
        blocked,
        rule,
        line: call.line,
    })
}

fn string_value(root: Option<&Value>, keys: &[&str]) -> Option<String> {
    let object = root?.as_object()?;
    for key in keys {
        if let Some(Value::String(text)) = object.get(*key) {
            if !text.trim().is_empty() {
                return Some(text.trim().to_string());
            }
        }
    }
    None
}

fn find_traversal(root: Option<&Value>) -> Option<String> {
    fn walk(value: &Value, found: &mut Option<String>) {
        match value {
            Value::String(text) => {
                if found.is_none() && looks_like_traversal(text) {
                    *found = Some(text.clone());
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, found);
                }
            }
            Value::Object(object) => {
                for item in object.values() {
                    walk(item, found);
                }
            }
            _ => {}
        }
    }
    let mut found = None;
    if let Some(value) = root {
        walk(value, &mut found);
    }
    found
}

fn looks_like_traversal(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    normalized.split('/').any(|part| part == "..")
}

fn find_url(value: &str) -> Option<String> {
    for scheme in ["https://", "http://"] {
        if let Some(index) = value.find(scheme) {
            let rest = &value[index..];
            let end = rest
                .find(|character: char| {
                    matches!(
                        character,
                        '"' | '\'' | ' ' | '\n' | '\r' | '\t' | ',' | ')' | ']' | '}' | ';'
                    )
                })
                .unwrap_or(rest.len());
            return Some(rest[..end].to_string());
        }
    }
    None
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url)
        .to_string()
}

fn is_local_url(url: &str) -> bool {
    let host = host_of(url).to_ascii_lowercase();
    let host = host.split(':').next().unwrap_or(&host);
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn is_delete(name: &str, command: &Option<String>, flat: &str) -> bool {
    let command = command.as_deref().unwrap_or("").to_ascii_lowercase();
    name.contains("delete")
        || name.contains("remove")
        || name.contains("unlink")
        || name == "rm"
        || name.contains("trash")
        || command.starts_with("rm ")
        || command.contains(" rm ")
        || command.contains("rm -")
        || command.contains("rmdir ")
        || command.starts_with("del ")
        || command.contains(" unlink ")
        || flat.contains("\"recursive\":true")
}

fn is_upload(name: &str, flat: &str, url: Option<&str>) -> bool {
    name.contains("upload")
        || name.contains("send_file")
        || name.contains("sendfile")
        || (url.is_some() && (name.contains("put") || flat.contains("\"file\"")))
}

fn is_network(name: &str, flat: &str) -> bool {
    name.contains("fetch")
        || name.contains("http")
        || name.contains("request")
        || name.contains("curl")
        || name.contains("wget")
        || name.contains("browser")
        || name.contains("websearch")
        || name.contains("web_search")
        || flat.contains("http://")
        || flat.contains("https://")
}

fn is_shell(name: &str, command: &Option<String>, flat: &str) -> bool {
    name.contains("shell")
        || name.contains("bash")
        || name.contains("exec")
        || name.contains("terminal")
        || name.contains("command")
        || name == "run"
        || name.contains("process")
        || command.is_some()
        || flat.contains("\"command\"")
}

fn is_read(name: &str) -> bool {
    name.contains("read")
        || name.contains("cat")
        || name.contains("head")
        || name.contains("tail")
        || name.contains("open")
        || name.contains("list")
        || name.contains("glob")
        || name.contains("grep")
        || name.contains("search")
}

fn summary(arguments: &str) -> String {
    let flat = arguments.replace('\n', " ");
    if flat.chars().count() > 90 {
        format!("{}…", flat.chars().take(90).collect::<String>())
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, arguments: &str, status: &str, line: u64) -> ToolCall {
        ToolCall {
            id: format!("c{line}"),
            name: name.to_string(),
            arguments: arguments.to_string(),
            status: status.to_string(),
            duration_ms: None,
            output: None,
            timestamp: Some("2026-10-27T10:00:00.000Z".to_string()),
            line,
        }
    }

    #[test]
    fn classifies_tool_activity() {
        let mut conversation = Conversation::default();
        conversation.session_id = Some("s-1".to_string());
        conversation.tool_calls = vec![
            call("read_file", r#"{"path":"../.ssh/id_rsa"}"#, "error", 1),
            call("shell", r#"{"command":"rm -rf ../../data"}"#, "completed", 2),
            call(
                "upload_file",
                r#"{"path":"a.bin","url":"https://api.third-party.dev/upload"}"#,
                "completed",
                3,
            ),
            call("fetch", r#"{"url":"https://example.com/data"}"#, "completed", 4),
            call("fetch", r#"{"url":"http://localhost:4010/movies"}"#, "completed", 5),
            call("shell", r#"{"command":"pnpm test"}"#, "error", 6),
            call("read_file", r#"{"path":"src/index.ts"}"#, "completed", 7),
        ];
        let entries = analyze(&conversation, "/tmp/session.jsonl");
        assert_eq!(entries.len(), 6);
        let categories: Vec<_> = entries
            .iter()
            .map(|entry| entry.category.as_str())
            .collect();
        assert!(categories.contains(&"traversal"));
        assert!(categories.contains(&"delete"));
        assert!(categories.contains(&"upload"));
        assert!(categories.contains(&"network"));
        assert!(categories.contains(&"shell"));
        assert!(categories.contains(&"read"));
        let traversal = entries
            .iter()
            .find(|entry| entry.category == "traversal")
            .expect("traversal");
        assert!(traversal.blocked);
        assert!(traversal.target.contains("../.ssh/id_rsa"));
        let upload = entries
            .iter()
            .find(|entry| entry.category == "upload")
            .expect("upload");
        assert!(upload.target.contains("third-party.dev"));
        let network = entries
            .iter()
            .find(|entry| entry.category == "network")
            .expect("network");
        assert_eq!(network.target, "https://example.com/data");
        let shell = entries
            .iter()
            .find(|entry| entry.category == "shell")
            .expect("shell");
        assert!(shell.blocked);
        assert!(entries
            .iter()
            .all(|entry| entry.path == "/tmp/session.jsonl"));
    }

    #[test]
    fn config_defaults_and_round_trip() {
        let temp = tempfile::tempdir().expect("tempdir");
        let state = AuditState::new(temp.path()).expect("state");
        let config = state.config();
        assert!(config.enabled("traversal"));
        assert!(config.enabled("delete"));
        assert!(!config.enabled("read"));
        assert!(!config.enabled("shell"));

        let mut categories = HashMap::new();
        categories.insert("read".to_string(), true);
        categories.insert("unknown".to_string(), true);
        let updated = state.update_categories(categories).expect("update");
        assert!(updated.enabled("read"));
        assert!(!updated.enabled("traversal"));
        assert!(!updated.categories.contains_key("unknown"));
        state.acknowledge("event-1").expect("ack");

        let reloaded = AuditState::new(temp.path()).expect("reload");
        let config = reloaded.config();
        assert!(config.enabled("read"));
        assert!(config.acknowledged.contains(&"event-1".to_string()));
    }
}

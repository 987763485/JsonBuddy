use crate::data::{now_iso, read_json, write_json, write_text};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_DOCUMENT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub lines: usize,
    pub opened_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentStore {
    pub documents: Vec<RecentDocument>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonDocument {
    pub path: String,
    pub name: String,
    pub text: String,
    pub size: u64,
    pub lines: usize,
}

pub fn load_recent(path: &Path) -> RecentStore {
    read_json::<RecentStore>(path)
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub fn save_recent(path: &Path, store: &RecentStore) -> Result<(), String> {
    write_json(path, store)
}

pub fn read_document(path: &str) -> Result<JsonDocument, String> {
    let file_path = PathBuf::from(path);
    if !file_path.is_file() {
        return Err(format!("file does not exist: {path}"));
    }
    let metadata = fs::metadata(&file_path)
        .map_err(|err| format!("could not read {}: {err}", file_path.display()))?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("file is larger than the 50 MB editor limit".to_string());
    }
    let text = fs::read_to_string(&file_path)
        .map_err(|err| format!("could not read {} as UTF-8: {err}", file_path.display()))?;
    Ok(document_from_text(&file_path, text))
}

pub fn create_document(documents_dir: &Path, requested_name: Option<&str>) -> Result<JsonDocument, String> {
    fs::create_dir_all(documents_dir)
        .map_err(|err| format!("could not create {}: {err}", documents_dir.display()))?;
    let stem = sanitize_stem(requested_name.unwrap_or("untitled"));
    let mut candidate = documents_dir.join(format!("{stem}.json"));
    let mut suffix = 2;
    while candidate.exists() {
        candidate = documents_dir.join(format!("{stem}-{suffix}.json"));
        suffix += 1;
    }
    write_text(&candidate, "{}\n")?;
    read_document(candidate.to_string_lossy().as_ref())
}

pub fn save_document(path: &str, text: &str) -> Result<JsonDocument, String> {
    if text.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("document is larger than the 50 MB editor limit".to_string());
    }
    let file_path = PathBuf::from(path);
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            return Err(format!("directory does not exist: {}", parent.display()));
        }
    }
    fs::write(&file_path, text)
        .map_err(|err| format!("could not save {}: {err}", file_path.display()))?;
    Ok(document_from_text(&file_path, text.to_string()))
}

pub fn record_recent(store: &mut RecentStore, document: &JsonDocument) {
    store.documents.retain(|entry| entry.path != document.path);
    store.documents.insert(
        0,
        RecentDocument {
            path: document.path.clone(),
            name: document.name.clone(),
            size: document.size,
            lines: document.lines,
            opened_at: now_iso(),
        },
    );
    store.documents.truncate(50);
}

pub fn remove_recent(store: &mut RecentStore, path: &str) -> Vec<RecentDocument> {
    store.documents.retain(|entry| entry.path != path);
    store.documents.clone()
}

fn document_from_text(path: &Path, text: String) -> JsonDocument {
    let size = text.len() as u64;
    let lines = text.lines().count().max(1);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled.json")
        .to_string();
    JsonDocument {
        path: path.to_string_lossy().to_string(),
        name,
        text,
        size,
        lines,
    }
}

fn sanitize_stem(input: &str) -> String {
    let file_name = Path::new(input)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled");
    let without_extension = file_name
        .strip_suffix(".json")
        .or_else(|| file_name.strip_suffix(".JSON"))
        .unwrap_or(file_name);
    let mut result = String::new();
    for character in without_extension.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
            result.push(character);
        } else if character.is_whitespace() {
            result.push('-');
        }
    }
    let trimmed = result.trim_matches(['-', '_', '.']).to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_document_uses_unique_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        let directory = temp.path().join("documents");
        let first = create_document(&directory, Some("my file.json")).expect("first");
        let second = create_document(&directory, Some("my file.json")).expect("second");
        assert_eq!(first.name, "my-file.json");
        assert_eq!(second.name, "my-file-2.json");
        assert_eq!(first.text, "{}\n");
    }

    #[test]
    fn recent_store_orders_and_removes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let directory = temp.path().join("documents");
        let first = create_document(&directory, Some("first")).expect("first");
        let second = create_document(&directory, Some("second")).expect("second");
        let mut store = RecentStore::default();
        record_recent(&mut store, &first);
        record_recent(&mut store, &second);
        assert_eq!(store.documents[0].name, "second.json");
        let remaining = remove_recent(&mut store, &first.path);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].name, "second.json");
    }

    #[test]
    fn invalid_names_fall_back_to_untitled() {
        assert_eq!(sanitize_stem("../../"), "untitled");
        assert_eq!(sanitize_stem("???"), "untitled");
        assert_eq!(sanitize_stem("hello world"), "hello-world");
    }
}

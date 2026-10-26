use chrono::{SecondsFormat, Utc};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct DataPaths {
    pub root: PathBuf,
    pub settings: PathBuf,
    pub recent: PathBuf,
    pub documents: PathBuf,
    pub mock_projects: PathBuf,
    pub mock_certs: PathBuf,
    pub mock_logs: PathBuf,
    pub audit: PathBuf,
    pub stream_cache: PathBuf,
}

impl DataPaths {
    pub fn init() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or_else(|| "could not resolve the home directory".to_string())?;
        Self::from_root(home.join(".json_studio"))
    }

    pub fn from_root(root: PathBuf) -> Result<Self, String> {
        let paths = Self {
            settings: root.join("settings.json"),
            recent: root.join("recent.json"),
            documents: root.join("documents"),
            mock_projects: root.join("mock").join("projects"),
            mock_certs: root.join("mock").join("certs"),
            mock_logs: root.join("mock").join("logs"),
            audit: root.join("audit"),
            stream_cache: root.join("cache").join("streams"),
            root,
        };

        for directory in [
            &paths.documents,
            &paths.mock_projects,
            &paths.mock_certs,
            &paths.mock_logs,
            &paths.audit,
            &paths.stream_cache,
        ] {
            fs::create_dir_all(directory)
                .map_err(|err| format!("could not create {}: {err}", directory.display()))?;
            secure_directory(directory)?;
        }
        secure_directory(&paths.root)?;
        Ok(paths)
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            return Err(format!("directory does not exist: {}", parent.display()));
        }
    }
    fs::write(path, text).map_err(|err| format!("could not write {}: {err}", path.display()))?;
    secure_file(path)?;
    Ok(())
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|err| format!("could not serialize {}: {err}", path.display()))?;
    write_text(path, &(text + "\n"))
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)
        .map_err(|err| format!("could not read {}: {err}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|err| format!("could not parse {}: {err}", path.display()))
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|err| format!("could not secure {}: {err}", path.display()))
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|err| format!("could not secure {}: {err}", path.display()))
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_root_has_expected_layout() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join(".json_studio");
        let paths = DataPaths::from_root(root.clone()).expect("data root");
        assert!(paths.documents.is_dir());
        assert!(paths.mock_projects.is_dir());
        assert!(paths.mock_certs.is_dir());
        assert!(paths.audit.is_dir());
        assert!(paths.stream_cache.is_dir());
        assert_eq!(paths.root, root);
    }
}

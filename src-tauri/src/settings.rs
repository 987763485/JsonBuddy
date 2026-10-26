use crate::data::{read_json, write_json};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub language: String,
    pub theme: String,
    pub mock_port: u16,
    pub mock_https: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "en".to_string(),
            theme: "light".to_string(),
            mock_port: 4010,
            mock_https: false,
        }
    }
}

impl AppSettings {
    pub fn normalized(mut self) -> Self {
        if !matches!(self.language.as_str(), "en" | "zh") {
            self.language = "en".to_string();
        }
        if !matches!(self.theme.as_str(), "light" | "dark" | "system") {
            self.theme = "light".to_string();
        }
        if !(1024..=65535).contains(&self.mock_port) {
            self.mock_port = 4010;
        }
        self
    }
}

pub fn load_settings(path: &Path) -> AppSettings {
    read_json::<AppSettings>(path)
        .ok()
        .flatten()
        .unwrap_or_default()
        .normalized()
}

pub fn save_settings(path: &Path, settings: &AppSettings) -> Result<AppSettings, String> {
    let settings = settings.clone().normalized();
    write_json(path, &settings)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_settings_fall_back_to_defaults() {
        let settings = AppSettings {
            language: "fr".into(),
            theme: "neon".into(),
            mock_port: 80,
            mock_https: true,
        }
        .normalized();
        assert_eq!(settings.language, "en");
        assert_eq!(settings.theme, "light");
        assert_eq!(settings.mock_port, 4010);
        assert!(settings.mock_https);
    }

    #[test]
    fn settings_round_trip() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("settings.json");
        let saved = save_settings(
            &path,
            &AppSettings {
                language: "zh".into(),
                theme: "dark".into(),
                mock_port: 5050,
                mock_https: true,
            },
        )
        .expect("save");
        let loaded = load_settings(&path);
        assert_eq!(saved.language, loaded.language);
        assert_eq!(saved.theme, loaded.theme);
        assert_eq!(saved.mock_port, 5050);
        assert!(loaded.mock_https);
    }
}

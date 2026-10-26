use crate::data::DataPaths;
use crate::documents::RecentStore;
use crate::settings::AppSettings;
use crate::streams::StreamManager;
use std::sync::Mutex;

pub struct AppState {
    pub paths: DataPaths,
    pub settings: Mutex<AppSettings>,
    pub recents: Mutex<RecentStore>,
    pub streams: Mutex<StreamManager>,
}

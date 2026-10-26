use crate::documents::{RecentStream, RecentStore};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use zstd::zstd_safe;

const MAX_INITIAL_EVENTS: usize = 2000;
const MAX_STREAM_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub line: u64,
    pub raw: String,
    pub ts: Option<String>,
    pub level: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSnapshot {
    pub path: String,
    pub name: String,
    pub format: String,
    pub size: u64,
    pub decoded_size: u64,
    pub lines: u64,
    pub events: Vec<StreamEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamLivePayload {
    pub path: String,
    pub events: Vec<StreamEvent>,
    pub total_lines: u64,
    pub decoded_size: u64,
    pub reset: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamErrorPayload {
    pub path: String,
    pub message: String,
}

#[derive(Default)]
pub struct StreamManager {
    sessions: HashMap<String, StreamSession>,
}

struct StreamSession {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl StreamManager {
    pub fn stop(&mut self, path: &str) {
        if let Some(mut session) = self.sessions.remove(path) {
            session.stop.store(true, Ordering::SeqCst);
            if let Some(join) = session.join.take() {
                let _ = join.join();
            }
        }
    }

    pub fn start(&mut self, app: &AppHandle, path: &str) -> Result<(), String> {
        let target = fs::canonicalize(path)
            .map_err(|err| format!("could not resolve stream path: {err}"))?;
        let key = target.to_string_lossy().to_string();
        self.stop(&key);

        let format = stream_format(&target)
            .ok_or_else(|| "only .jsonl, .jsonl.zstd and .jsonl.zst streams are supported".to_string())?;
        let snapshot = read_snapshot(&key)?;
        let metadata = fs::metadata(&target)
            .map_err(|err| format!("could not read {}: {err}", target.display()))?;
        let parent = target
            .parent()
            .ok_or_else(|| "stream has no parent directory".to_string())?
            .to_path_buf();

        let (sender, receiver) =
            mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let _ = sender.send(event);
        })
        .map_err(|err| format!("could not start the stream watcher: {err}"))?;
        watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|err| format!("could not watch {}: {err}", parent.display()))?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_app = app.clone();
        let thread_target = target.clone();
        let thread_key = key.clone();
        let initial_offset = metadata.len();
        let mut offset = initial_offset;
        let mut line_no = snapshot.lines;
        let mut decoded_size = snapshot.decoded_size;
        let mut compressed_pending: Vec<u8> = Vec::new();
        let mut decoded_pending: Vec<u8> = Vec::new();

        let join = thread::spawn(move || {
            let _watcher = watcher;
            while !thread_stop.load(Ordering::SeqCst) {
                match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(Ok(event)) => {
                        let relevant = event.paths.iter().any(|candidate| {
                            candidate == &thread_target
                                || fs::canonicalize(candidate)
                                    .map(|path| path == thread_target)
                                    .unwrap_or(false)
                        });
                        if !relevant {
                            continue;
                        }
                        let result = process_change(
                            &thread_app,
                            &thread_target,
                            &thread_key,
                            format,
                            &mut offset,
                            &mut line_no,
                            &mut decoded_size,
                            &mut compressed_pending,
                            &mut decoded_pending,
                        );
                        if let Err(message) = result {
                            let _ = thread_app.emit(
                                "stream-error",
                                StreamErrorPayload {
                                    path: thread_key.clone(),
                                    message,
                                },
                            );
                        }
                    }
                    Ok(Err(error)) => {
                        let _ = thread_app.emit(
                            "stream-error",
                            StreamErrorPayload {
                                path: thread_key.clone(),
                                message: format!("stream watcher error: {error}"),
                            },
                        );
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        self.sessions.insert(
            key,
            StreamSession {
                stop,
                join: Some(join),
            },
        );
        Ok(())
    }
}

pub fn stream_format(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if name.ends_with(".jsonl.zstd") || name.ends_with(".jsonl.zst") {
        Some("zstd")
    } else if name.ends_with(".jsonl") {
        Some("jsonl")
    } else {
        None
    }
}

pub fn read_snapshot(path: &str) -> Result<StreamSnapshot, String> {
    let file_path = PathBuf::from(path);
    let canonical = fs::canonicalize(&file_path)
        .map_err(|err| format!("could not resolve {path}: {err}"))?;
    let format = stream_format(&canonical)
        .ok_or_else(|| "only .jsonl, .jsonl.zstd and .jsonl.zst streams are supported".to_string())?;
    let metadata = fs::metadata(&canonical)
        .map_err(|err| format!("could not read {}: {err}", canonical.display()))?;
    if metadata.len() > MAX_STREAM_BYTES {
        return Err("stream file is larger than the 256 MB viewer limit".to_string());
    }
    let bytes = fs::read(&canonical)
        .map_err(|err| format!("could not read {}: {err}", canonical.display()))?;
    let decoded = if format == "zstd" {
        zstd::stream::decode_all(&bytes[..])
            .map_err(|err| format!("could not decode zstd stream: {err}"))?
    } else {
        bytes
    };
    let decoded_size = decoded.len() as u64;
    let text = String::from_utf8_lossy(&decoded);
    let total_lines = text.lines().count() as u64;
    let mut all_events = Vec::new();
    let mut line_no = 0u64;
    for line in text.lines() {
        line_no += 1;
        if line.trim().is_empty() {
            continue;
        }
        all_events.push(parse_event(line_no, line));
    }
    let events = if all_events.len() > MAX_INITIAL_EVENTS {
        all_events.split_off(all_events.len() - MAX_INITIAL_EVENTS)
    } else {
        all_events
    };
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("stream.jsonl")
        .to_string();
    Ok(StreamSnapshot {
        path: canonical.to_string_lossy().to_string(),
        name,
        format: format.to_string(),
        size: metadata.len(),
        decoded_size,
        lines: total_lines,
        events,
    })
}

pub fn recent_from_snapshot(snapshot: &StreamSnapshot) -> RecentStream {
    RecentStream {
        path: snapshot.path.clone(),
        name: snapshot.name.clone(),
        format: snapshot.format.clone(),
        size: snapshot.size,
        decoded_size: snapshot.decoded_size,
        lines: snapshot.lines,
        opened_at: crate::data::now_iso(),
    }
}

pub fn record_recent(store: &mut RecentStore, snapshot: &StreamSnapshot) {
    crate::documents::record_recent_stream(store, &recent_from_snapshot(snapshot));
}

fn process_change(
    app: &AppHandle,
    target: &Path,
    key: &str,
    format: &str,
    offset: &mut u64,
    line_no: &mut u64,
    decoded_size: &mut u64,
    compressed_pending: &mut Vec<u8>,
    decoded_pending: &mut Vec<u8>,
) -> Result<(), String> {
    let metadata = match fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(err) => return Err(format!("could not stat {}: {err}", target.display())),
    };
    if metadata.len() < *offset {
        let snapshot = read_snapshot(key)?;
        let _ = app.emit(
            "stream-live",
            StreamLivePayload {
                path: key.to_string(),
                events: snapshot.events,
                total_lines: snapshot.lines,
                decoded_size: snapshot.decoded_size,
                reset: true,
            },
        );
        *offset = metadata.len();
        *line_no = snapshot.lines;
        *decoded_size = snapshot.decoded_size;
        compressed_pending.clear();
        decoded_pending.clear();
        return Ok(());
    }
    if metadata.len() == *offset {
        return Ok(());
    }

    let mut file = File::open(target)
        .map_err(|err| format!("could not open {}: {err}", target.display()))?;
    file.seek(SeekFrom::Start(*offset))
        .map_err(|err| format!("could not seek {}: {err}", target.display()))?;
    let mut appended = Vec::new();
    file.read_to_end(&mut appended)
        .map_err(|err| format!("could not read {}: {err}", target.display()))?;
    *offset = metadata.len();

    let events = consume_append(
        format,
        &appended,
        line_no,
        decoded_size,
        compressed_pending,
        decoded_pending,
    )?;

    if !events.is_empty() {
        let _ = app.emit(
            "stream-live",
            StreamLivePayload {
                path: key.to_string(),
                events,
                total_lines: *line_no,
                decoded_size: *decoded_size,
                reset: false,
            },
        );
    }
    Ok(())
}

fn consume_append(
    format: &str,
    appended: &[u8],
    line_no: &mut u64,
    decoded_size: &mut u64,
    compressed_pending: &mut Vec<u8>,
    decoded_pending: &mut Vec<u8>,
) -> Result<Vec<StreamEvent>, String> {
    let mut events = Vec::new();
    if format == "jsonl" {
        compressed_pending.extend_from_slice(appended);
        consume_lines(compressed_pending, line_no, &mut events);
        return Ok(events);
    }

    compressed_pending.extend_from_slice(appended);
    loop {
        let frame_size = match zstd_safe::find_frame_compressed_size(compressed_pending) {
            Ok(size) if size > 0 && size <= compressed_pending.len() => size,
            _ => break,
        };
        let frame: Vec<u8> = compressed_pending.drain(..frame_size).collect();
        let decoded = zstd::stream::decode_all(&frame[..])
            .map_err(|err| format!("could not decode an appended zstd frame: {err}"))?;
        *decoded_size += decoded.len() as u64;
        decoded_pending.extend_from_slice(&decoded);
        consume_lines(decoded_pending, line_no, &mut events);
    }
    Ok(events)
}

fn consume_lines(pending: &mut Vec<u8>, line_no: &mut u64, events: &mut Vec<StreamEvent>) {
    while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
        let mut line = String::from_utf8_lossy(&pending[..position]).to_string();
        pending.drain(..=position);
        if line.ends_with('\r') {
            line.pop();
        }
        *line_no += 1;
        if !line.trim().is_empty() {
            events.push(parse_event(*line_no, &line));
        }
    }
}

fn parse_event(line_no: u64, raw: &str) -> StreamEvent {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok();
    let object = value.as_ref().and_then(|value| value.as_object());
    let text_field = |names: &[&str]| {
        object.and_then(|object| {
            names.iter().find_map(|name| {
                object.get(*name).and_then(|value| match value {
                    serde_json::Value::String(text) => Some(text.clone()),
                    serde_json::Value::Number(number) => Some(number.to_string()),
                    _ => None,
                })
            })
        })
    };
    StreamEvent {
        line: line_no,
        raw: raw.to_string(),
        ts: text_field(&["ts", "timestamp", "time"]),
        level: text_field(&["level", "severity"]).map(|value| value.to_uppercase()),
        name: text_field(&["event", "type", "name"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_stream_formats() {
        assert_eq!(stream_format(Path::new("a.jsonl")), Some("jsonl"));
        assert_eq!(stream_format(Path::new("a.jsonl.zstd")), Some("zstd"));
        assert_eq!(stream_format(Path::new("a.jsonl.zst")), Some("zstd"));
        assert_eq!(stream_format(Path::new("a.json")), None);
    }

    #[test]
    fn parses_stream_events() {
        let event = parse_event(3, r#"{"ts":"2026-10-26T10:00:00Z","level":"warn","event":"rate_limit"}"#);
        assert_eq!(event.line, 3);
        assert_eq!(event.level.as_deref(), Some("WARN"));
        assert_eq!(event.name.as_deref(), Some("rate_limit"));
    }

    #[test]
    fn reads_example_streams_when_available() {
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../example");
        let jsonl = example.join("233aab46-2fbe-469e-955a-95d2567995f9.jsonl");
        if jsonl.is_file() {
            let snapshot = read_snapshot(jsonl.to_string_lossy().as_ref()).expect("example jsonl");
            assert!(snapshot.lines > 1000);
            assert!(!snapshot.events.is_empty());
        }
        let zstd_file = example.join("session.v4.jsonl.zstd");
        if zstd_file.is_file() {
            let snapshot = read_snapshot(zstd_file.to_string_lossy().as_ref()).expect("example zstd");
            assert!(snapshot.lines > 10);
            assert_eq!(snapshot.format, "zstd");
        }
    }

    #[test]
    fn decodes_appended_zstd_frames_incrementally() {
        let first = zstd::stream::encode_all(&b"{\"level\":\"info\",\"event\":\"one\"}\n"[..], 3)
            .expect("first frame");
        let second = zstd::stream::encode_all(&b"{\"level\":\"warn\",\"event\":\"two\"}\n"[..], 3)
            .expect("second frame");
        let mut line_no = 0;
        let mut decoded_size = 0;
        let mut compressed_pending = Vec::new();
        let mut decoded_pending = Vec::new();

        let events = consume_append(
            "zstd",
            &first,
            &mut line_no,
            &mut decoded_size,
            &mut compressed_pending,
            &mut decoded_pending,
        )
        .expect("first append");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name.as_deref(), Some("one"));

        let split = second.len() / 2;
        let first_part = consume_append(
            "zstd",
            &second[..split],
            &mut line_no,
            &mut decoded_size,
            &mut compressed_pending,
            &mut decoded_pending,
        )
        .expect("partial append");
        assert!(first_part.is_empty());
        let events = consume_append(
            "zstd",
            &second[split..],
            &mut line_no,
            &mut decoded_size,
            &mut compressed_pending,
            &mut decoded_pending,
        )
        .expect("second append");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name.as_deref(), Some("two"));
        assert_eq!(line_no, 2);
    }

    #[test]
    fn reads_plain_and_zstd_snapshots() {
        let temp = tempfile::tempdir().expect("tempdir");
        let plain = temp.path().join("events.jsonl");
        fs::write(&plain, "{\"level\":\"info\",\"event\":\"start\"}\n{\"level\":\"error\",\"event\":\"stop\"}\n")
            .expect("plain");
        let snapshot = read_snapshot(plain.to_string_lossy().as_ref()).expect("plain snapshot");
        assert_eq!(snapshot.lines, 2);
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[1].name.as_deref(), Some("stop"));

        let compressed = temp.path().join("events.jsonl.zstd");
        let data = b"{\"level\":\"info\",\"event\":\"zstd\"}\n";
        let encoded = zstd::stream::encode_all(&data[..], 3).expect("encode");
        fs::write(&compressed, encoded).expect("zstd");
        let snapshot = read_snapshot(compressed.to_string_lossy().as_ref()).expect("zstd snapshot");
        assert_eq!(snapshot.lines, 1);
        assert_eq!(snapshot.events[0].name.as_deref(), Some("zstd"));
        assert_eq!(snapshot.format, "zstd");
    }
}

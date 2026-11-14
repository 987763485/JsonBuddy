use crate::audit::{analyze, AuditEntry};
use crate::conversation::{normalize_events, Conversation};
use crate::documents::{RecentStream, RecentStore};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use zstd::zstd_safe;

const MAX_BUFFER_EVENTS: usize = 10_000;
const MAX_BUFFER_BYTES: usize = 50 * 1024 * 1024;
const MAX_STREAM_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TAIL_PLAIN_BYTES: u64 = 64 * 1024 * 1024;
const TAIL_ZSTD_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TAIL_DECODED_BYTES: usize = 128 * 1024 * 1024;
const ZSTD_FRAME_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub line: u64,
    pub raw: String,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamArchivePage {
    pub events: Vec<StreamEvent>,
    pub has_more: bool,
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
    pub conversation: Conversation,
    pub audit: Vec<AuditEntry>,
    pub tail: bool,
    #[serde(skip)]
    pub follow_offset: u64,
    #[serde(skip)]
    pub pending: Vec<u8>,
}

struct TailRead {
    events: Vec<StreamEvent>,
    decoded_size: u64,
    lines: u64,
    follow_offset: u64,
    pending: Vec<u8>,
}

struct ParsedLines {
    events: Vec<StreamEvent>,
    lines: u64,
    complete_bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamLivePayload {
    pub path: String,
    pub events: Vec<StreamEvent>,
    pub conversation: Conversation,
    pub audit: Vec<AuditEntry>,
    pub total_lines: u64,
    pub decoded_size: u64,
    pub reset: bool,
    pub tail: bool,
    pub silent: bool,
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

    pub fn start(
        &mut self,
        app: &AppHandle,
        path: &str,
        cache_dir: &Path,
    ) -> Result<(), String> {
        let target = fs::canonicalize(path)
            .map_err(|err| format!("could not resolve stream path: {err}"))?;
        let key = target.to_string_lossy().to_string();
        self.stop(&key);

        let format = stream_format(&target)
            .ok_or_else(|| "only .jsonl, .jsonl.zstd and .jsonl.zst streams are supported".to_string())?;
        let snapshot = read_snapshot_cached(&key, cache_dir)?;
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
        let thread_cache_dir = cache_dir.to_path_buf();
        let mut offset = snapshot.follow_offset;
        let mut line_no = snapshot.lines;
        let mut decoded_size = snapshot.decoded_size;
        let mut compressed_pending: Vec<u8> = Vec::new();
        let mut decoded_pending: Vec<u8> = snapshot.pending.clone();
        let mut event_buffer = snapshot.events.clone();
        let _ = app.emit(
            "stream-live",
            StreamLivePayload {
                path: key.clone(),
                events: snapshot.events.clone(),
                conversation: snapshot.conversation.clone(),
                audit: snapshot.audit.clone(),
                total_lines: snapshot.lines,
                decoded_size: snapshot.decoded_size,
                reset: true,
                tail: snapshot.tail,
                silent: true,
            },
        );
        let mut tail_mode = snapshot.tail;

        let join = thread::spawn(move || {
            let _watcher = watcher;
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
                &mut event_buffer,
                &mut tail_mode,
                &thread_cache_dir,
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
                            &mut event_buffer,
                            &mut tail_mode,
                            &thread_cache_dir,
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

#[cfg(test)]
fn read_snapshot(path: &str) -> Result<StreamSnapshot, String> {
    read_snapshot_impl(path, None)
}

pub fn read_snapshot_cached(path: &str, cache_dir: &Path) -> Result<StreamSnapshot, String> {
    read_snapshot_impl(path, Some(cache_dir))
}

fn read_snapshot_impl(
    path: &str,
    cache_dir: Option<&Path>,
) -> Result<StreamSnapshot, String> {
    let file_path = PathBuf::from(path);
    let canonical = fs::canonicalize(&file_path)
        .map_err(|err| format!("could not resolve {path}: {err}"))?;
    let format = stream_format(&canonical)
        .ok_or_else(|| "only .jsonl, .jsonl.zstd and .jsonl.zst streams are supported".to_string())?;
    let metadata = fs::metadata(&canonical)
        .map_err(|err| format!("could not read {}: {err}", canonical.display()))?;
    let size = metadata.len();
    if size > MAX_STREAM_BYTES {
        return Err("stream file is larger than the 2 GB viewer limit".to_string());
    }
    let tail_window = if format == "zstd" {
        TAIL_ZSTD_BYTES
    } else {
        TAIL_PLAIN_BYTES
    };
    let (mut events, decoded_size, total_lines, tail, follow_offset, pending) =
        if size > tail_window {
            let tail = if format == "zstd" {
                read_zstd_tail(&canonical, size, tail_window)?
            } else {
                read_plain_tail(&canonical, size, tail_window)?
            };
            (
                tail.events,
                tail.decoded_size,
                tail.lines,
                true,
                tail.follow_offset,
                tail.pending,
            )
        } else {
            let file = File::open(&canonical)
                .map_err(|err| format!("could not read {}: {err}", canonical.display()))?;
            let mut bytes = Vec::with_capacity(size as usize);
            let mut reader = file.take(size);
            reader
                .read_to_end(&mut bytes)
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
            (
                all_events,
                decoded_size,
                total_lines,
                false,
                size,
                Vec::new(),
            )
        };
    if let Some(cache_dir) = cache_dir {
        let archive = archive_path(cache_dir, &canonical);
        let dropped = trim_event_buffer_collect(&mut events);
        if let Err(error) = write_archive(&archive, &dropped, true) {
            eprintln!("could not write stream archive: {error}");
        }
    } else {
        trim_event_buffer(&mut events);
    }
    let conversation = normalize_events(&events);
    let path_string = canonical.to_string_lossy().to_string();
    let audit = analyze(&conversation, &path_string);
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("stream.jsonl")
        .to_string();
    Ok(StreamSnapshot {
        path: path_string,
        name,
        format: format.to_string(),
        size,
        decoded_size,
        lines: total_lines,
        events,
        conversation,
        audit,
        tail,
        follow_offset,
        pending,
    })
}

fn read_plain_tail(path: &Path, size: u64, window: u64) -> Result<TailRead, String> {
    let start = size.saturating_sub(window);
    let probe_start = start.saturating_sub(1);
    let prefix = if start > 0 { 1usize } else { 0 };
    let mut file = File::open(path)
        .map_err(|err| format!("could not read {}: {err}", path.display()))?;
    file.seek(SeekFrom::Start(probe_start))
        .map_err(|err| format!("could not seek {}: {err}", path.display()))?;
    let mut bytes = Vec::with_capacity(window as usize + prefix);
    file.read_to_end(&mut bytes)
        .map_err(|err| format!("could not read {}: {err}", path.display()))?;
    let at_line_boundary = start == 0 || bytes.first() == Some(&b'\n');
    let offset = if at_line_boundary {
        prefix
    } else {
        match bytes[prefix..].iter().position(|byte| *byte == b'\n') {
            Some(position) => prefix + position + 1,
            None => {
                return Ok(TailRead {
                    events: Vec::new(),
                    decoded_size: (bytes.len() - prefix) as u64,
                    lines: 0,
                    follow_offset: start,
                    pending: Vec::new(),
                });
            }
        }
    };
    let parsed = parse_complete_lines(&bytes[offset..], 1, false);
    Ok(TailRead {
        events: parsed.events,
        decoded_size: (bytes.len() - offset) as u64,
        lines: parsed.lines,
        follow_offset: probe_start + offset as u64 + parsed.complete_bytes as u64,
        pending: Vec::new(),
    })
}

fn parse_complete_lines(bytes: &[u8], start_line: u64, skip_first: bool) -> ParsedLines {
    let mut events = Vec::new();
    let mut line_no = start_line.saturating_sub(1);
    let mut cursor = 0usize;
    let mut complete_bytes = 0usize;
    let mut first = true;
    while let Some(position) = bytes[cursor..].iter().position(|byte| *byte == b'\n') {
        let end = cursor + position;
        let line_bytes = &bytes[cursor..end];
        cursor = end + 1;
        complete_bytes = cursor;
        if first {
            first = false;
            if skip_first {
                continue;
            }
        }
        let mut line = String::from_utf8_lossy(line_bytes).to_string();
        if line.ends_with('\r') {
            line.pop();
        }
        line_no += 1;
        if !line.trim().is_empty() {
            events.push(parse_event(line_no, &line));
        }
    }
    ParsedLines {
        events,
        lines: line_no.saturating_sub(start_line.saturating_sub(1)),
        complete_bytes,
    }
}

fn read_zstd_tail(path: &Path, size: u64, window: u64) -> Result<TailRead, String> {
    let start = size.saturating_sub(window);
    let mut file = File::open(path)
        .map_err(|err| format!("could not read {}: {err}", path.display()))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|err| format!("could not seek {}: {err}", path.display()))?;
    let mut bytes = Vec::with_capacity(window as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| format!("could not read {}: {err}", path.display()))?;
    let mut last_error = None;
    for offset in zstd_frame_offsets(&bytes) {
        let (decoded, consumed) = match decode_zstd_tail_frames(&bytes[offset..]) {
            Ok(result) => result,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        if decoded.is_empty() {
            continue;
        }
        let parsed = parse_complete_lines(&decoded, 1, start > 0 || offset > 0);
        let pending = decoded[parsed.complete_bytes..].to_vec();
        return Ok(TailRead {
            events: parsed.events,
            decoded_size: decoded.len() as u64,
            lines: parsed.lines,
            follow_offset: start + offset as u64 + consumed as u64,
            pending,
        });
    }
    Err(match last_error {
        Some(error) => format!("could not decode the zstd stream tail: {error}"),
        None => format!(
            "could not find a complete zstd frame in the last {} MB of this stream",
            window / (1024 * 1024)
        ),
    })
}

fn zstd_frame_offsets(bytes: &[u8]) -> Vec<usize> {
    let mut offsets = Vec::new();
    if bytes.len() < ZSTD_FRAME_MAGIC.len() {
        return offsets;
    }
    for index in 0..=bytes.len() - ZSTD_FRAME_MAGIC.len() {
        if bytes[index..index + ZSTD_FRAME_MAGIC.len()] == ZSTD_FRAME_MAGIC {
            offsets.push(index);
            if offsets.len() >= 1024 {
                break;
            }
        }
    }
    offsets
}

fn decode_zstd_tail_frames(bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let mut cursor = 0usize;
    let mut decoded = Vec::new();
    let mut frames = 0usize;
    while cursor < bytes.len() {
        let frame_size = match zstd_safe::find_frame_compressed_size(&bytes[cursor..]) {
            Ok(size) if size > 0 && cursor + size <= bytes.len() => size,
            _ => break,
        };
        let frame = &bytes[cursor..cursor + frame_size];
        let frame_decoded = zstd::stream::decode_all(frame)
            .map_err(|err| format!("could not decode an appended zstd frame: {err}"))?;
        if decoded.len() + frame_decoded.len() > MAX_TAIL_DECODED_BYTES {
            return Err(format!(
                "the zstd tail decodes to more than {} MB",
                MAX_TAIL_DECODED_BYTES / (1024 * 1024)
            ));
        }
        decoded.extend_from_slice(&frame_decoded);
        cursor += frame_size;
        frames += 1;
    }
    if frames == 0 {
        return Err("no complete zstd frame was found".to_string());
    }
    Ok((decoded, cursor))
}

fn trim_event_buffer(events: &mut Vec<StreamEvent>) {
    if events.len() > MAX_BUFFER_EVENTS {
        let start = events.len() - MAX_BUFFER_EVENTS;
        events.drain(..start);
    }
    let mut bytes: usize = events.iter().map(|event| event.raw.len()).sum();
    while bytes > MAX_BUFFER_BYTES && !events.is_empty() {
        bytes = bytes.saturating_sub(events.remove(0).raw.len());
    }
}

fn trim_event_buffer_collect(events: &mut Vec<StreamEvent>) -> Vec<StreamEvent> {
    let mut dropped = Vec::new();
    if events.len() > MAX_BUFFER_EVENTS {
        let start = events.len() - MAX_BUFFER_EVENTS;
        dropped.extend(events.drain(..start));
    }
    let mut bytes: usize = events.iter().map(|event| event.raw.len()).sum();
    while bytes > MAX_BUFFER_BYTES && !events.is_empty() {
        let event = events.remove(0);
        bytes = bytes.saturating_sub(event.raw.len());
        dropped.push(event);
    }
    dropped
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub fn archive_path(cache_dir: &Path, canonical: &Path) -> PathBuf {
    let key = canonical.to_string_lossy();
    cache_dir.join(format!("stream-{:016x}.jsonl", fnv1a(key.as_bytes())))
}

fn write_archive(
    path: &Path,
    events: &[StreamEvent],
    reset: bool,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true);
    if reset {
        options.truncate(true);
    } else {
        options.append(true);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("could not secure {}: {error}", path.display()))?;
    }
    for event in events {
        let line = serde_json::to_string(event)
            .map_err(|error| format!("could not encode archived event: {error}"))?;
        writeln!(file, "{line}")
            .map_err(|error| format!("could not append {}: {error}", path.display()))?;
    }
    Ok(())
}

pub fn read_archive(
    cache_dir: &Path,
    path: &str,
    before_line: u64,
    limit: usize,
) -> Result<StreamArchivePage, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("could not resolve {path}: {error}"))?;
    let archive = archive_path(cache_dir, &canonical);
    if !archive.is_file() {
        return Ok(StreamArchivePage {
            events: Vec::new(),
            has_more: false,
        });
    }
    let limit = limit.clamp(1, 2000);
    let file = File::open(&archive)
        .map_err(|error| format!("could not read {}: {error}", archive.display()))?;
    let reader = BufReader::new(file);
    let mut events: VecDeque<StreamEvent> = VecDeque::new();
    let mut has_more = false;
    for line in reader.lines() {
        let line = line.map_err(|error| format!("could not read stream archive: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event = match serde_json::from_str::<StreamEvent>(&line) {
            Ok(event) => event,
            Err(_) => continue,
        };
        if event.line >= before_line {
            continue;
        }
        if events.len() == limit {
            events.pop_front();
            has_more = true;
        }
        events.push_back(event);
    }
    Ok(StreamArchivePage {
        events: events.into_iter().collect(),
        has_more,
    })
}

pub fn remove_archive(cache_dir: &Path, path: &str) {
    let Ok(canonical) = fs::canonicalize(path) else {
        return;
    };
    let archive = archive_path(cache_dir, &canonical);
    let _ = fs::remove_file(archive);
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
        tail: snapshot.tail,
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
    event_buffer: &mut Vec<StreamEvent>,
    tail_mode: &mut bool,
    cache_dir: &Path,
) -> Result<(), String> {
    let metadata = match fs::metadata(target) {
        Ok(metadata) => metadata,
        Err(err) => return Err(format!("could not stat {}: {err}", target.display())),
    };
    if metadata.len() < *offset {
        let snapshot = read_snapshot_cached(key, cache_dir)?;
        *event_buffer = snapshot.events.clone();
        *tail_mode = snapshot.tail;
        let _ = app.emit(
            "stream-live",
            StreamLivePayload {
                path: key.to_string(),
                events: snapshot.events,
                conversation: snapshot.conversation,
                audit: snapshot.audit,
                total_lines: snapshot.lines,
                decoded_size: snapshot.decoded_size,
                reset: true,
                tail: *tail_mode,
                silent: false,
            },
        );
        *offset = snapshot.follow_offset;
        *line_no = snapshot.lines;
        *decoded_size = snapshot.decoded_size;
        compressed_pending.clear();
        decoded_pending.clear();
        decoded_pending.extend_from_slice(&snapshot.pending);
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
        event_buffer.extend(events.iter().cloned());
        let archive = archive_path(cache_dir, target);
        let dropped = trim_event_buffer_collect(event_buffer);
        if let Err(error) = write_archive(&archive, &dropped, false) {
            eprintln!("could not append stream archive: {error}");
        }
        let conversation = normalize_events(event_buffer);
        let audit = analyze(&conversation, key);
        let _ = app.emit(
            "stream-live",
            StreamLivePayload {
                path: key.to_string(),
                events,
                conversation,
                audit,
                total_lines: *line_no,
                decoded_size: *decoded_size,
                reset: false,
                tail: *tail_mode,
                silent: false,
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
    fn reads_only_the_tail_of_plain_streams() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("tail.jsonl");
        let last = "{\"event\":\"three\"}\n{\"event\":\"four\"}\n";
        let content = format!("{{\"event\":\"one\"}}\n{{\"event\":\"two\"}}\n{last}");
        fs::write(&path, &content).expect("tail stream");
        let size = fs::metadata(&path).expect("metadata").len();
        let tail = read_plain_tail(&path, size, last.len() as u64 + 5).expect("plain tail");
        assert_eq!(tail.lines, 2);
        assert_eq!(tail.events.len(), 2);
        assert_eq!(tail.events[0].name.as_deref(), Some("three"));
        assert_eq!(tail.events[1].name.as_deref(), Some("four"));
        assert_eq!(tail.events[0].line, 1);
        assert_eq!(tail.follow_offset, size);
    }

    #[test]
    fn keeps_the_first_line_when_the_tail_starts_at_a_line_boundary() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("boundary.jsonl");
        let last = "{\"event\":\"three\"}\n";
        let content = format!("{{\"event\":\"one\"}}\n{{\"event\":\"two\"}}\n{last}");
        fs::write(&path, &content).expect("boundary stream");
        let size = fs::metadata(&path).expect("metadata").len();
        let tail = read_plain_tail(&path, size, last.len() as u64).expect("plain tail");
        assert_eq!(tail.lines, 1);
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].name.as_deref(), Some("three"));
    }

    #[test]
    fn keeps_the_partial_last_line_for_following() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("partial.jsonl");
        let partial = "{\"event\":\"two\"}";
        let content = format!("{{\"event\":\"one\"}}\n{partial}");
        fs::write(&path, &content).expect("partial stream");
        let size = fs::metadata(&path).expect("metadata").len();
        let tail = read_plain_tail(&path, size, 1024).expect("plain tail");
        assert_eq!(tail.lines, 1);
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].name.as_deref(), Some("one"));
        assert_eq!(
            tail.follow_offset,
            content.len() as u64 - partial.len() as u64
        );
    }

    #[test]
    fn reads_a_zstd_tail_from_a_frame_boundary() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("tail.jsonl.zstd");
        let frames = [
            b"{\"event\":\"one\"}\n{\"event\":\"two\"}\n".as_slice(),
            b"{\"event\":\"three\"}\n{\"event\":\"four\"}\n".as_slice(),
            b"{\"event\":\"five\"}\n{\"event\":\"six\"}\n".as_slice(),
        ];
        let encoded: Vec<Vec<u8>> = frames
            .iter()
            .map(|frame| zstd::stream::encode_all(*frame, 3).expect("encode frame"))
            .collect();
        let mut bytes = Vec::new();
        for frame in &encoded {
            bytes.extend_from_slice(frame);
        }
        fs::write(&path, &bytes).expect("zstd tail stream");
        let size = bytes.len() as u64;
        let last_frame = encoded.last().expect("last frame").len() as u64;
        let tail = read_zstd_tail(&path, size, last_frame + encoded[1].len() as u64)
            .expect("zstd tail");
        assert_eq!(tail.lines, 3);
        assert_eq!(tail.events.len(), 3);
        assert_eq!(tail.events[0].name.as_deref(), Some("four"));
        assert_eq!(tail.events[2].name.as_deref(), Some("six"));
        assert_eq!(tail.follow_offset, size);
    }

    #[test]
    fn carries_a_partial_zstd_line_into_follow() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("partial.jsonl.zstd");
        let first = zstd::stream::encode_all(
            b"{\"event\":\"one\"}\n{\"event\":\"two\"".as_slice(),
            3,
        )
        .expect("first frame");
        let second = zstd::stream::encode_all(b",\"level\":\"info\"}\n".as_slice(), 3)
            .expect("second frame");
        fs::write(&path, &first).expect("partial zstd stream");
        let size = first.len() as u64;
        let tail = read_zstd_tail(&path, size, size).expect("zstd tail");
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].name.as_deref(), Some("one"));
        assert_eq!(tail.pending, b"{\"event\":\"two\"");

        let mut line_no = tail.lines;
        let mut decoded_size = tail.decoded_size;
        let mut compressed_pending = Vec::new();
        let mut decoded_pending = tail.pending.clone();
        let events = consume_append(
            "zstd",
            &second,
            &mut line_no,
            &mut decoded_size,
            &mut compressed_pending,
            &mut decoded_pending,
        )
        .expect("follow append");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].line, tail.lines + 1);
        let value: serde_json::Value =
            serde_json::from_str(&events[0].raw).expect("complete line");
        assert_eq!(value["event"], "two");
        assert_eq!(value["level"], "info");
    }

    #[test]
    fn rejects_streams_larger_than_the_viewer_limit() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("huge.jsonl");
        let file = File::create(&path).expect("create");
        file.set_len(MAX_STREAM_BYTES + 1).expect("sparse file");
        let error = read_snapshot(path.to_string_lossy().as_ref()).expect_err("too large");
        assert!(error.contains("2 GB"));
    }

    #[test]
    fn reads_example_streams_when_available() {
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../example");
        let jsonl = example.join("233aab46-2fbe-469e-955a-95d2567995f9.jsonl");
        if jsonl.is_file() {
            let snapshot = read_snapshot(jsonl.to_string_lossy().as_ref()).expect("example jsonl");
            assert!(snapshot.lines > 1000);
            assert!(!snapshot.events.is_empty());
            assert!(snapshot.conversation.stats.user_messages > 0);
            assert!(snapshot.conversation.stats.tool_calls > 0);
            assert!(!snapshot.conversation.messages.is_empty());
            assert!(!snapshot.audit.is_empty());
            assert!(snapshot.audit.iter().all(|entry| entry.path == snapshot.path));
            assert!(snapshot.audit.len() <= crate::audit::AUDIT_LIMIT);
        }
        let zstd_file = example.join("session.v4.jsonl.zstd");
        if zstd_file.is_file() {
            let snapshot = read_snapshot(zstd_file.to_string_lossy().as_ref()).expect("example zstd");
            assert!(snapshot.lines > 10);
            assert_eq!(snapshot.format, "zstd");
            assert!(!snapshot.conversation.messages.is_empty());
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
    fn archives_events_beyond_buffer_limit() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("large.jsonl");
        let cache_dir = temp.path().join("cache");
        let mut text = String::new();
        for index in 1..=MAX_BUFFER_EVENTS + 5 {
            text.push_str(&format!(
                "{{\"level\":\"info\",\"event\":\"event-{index}\"}}\n"
            ));
        }
        fs::write(&path, text).expect("large stream");
        let snapshot =
            read_snapshot_cached(path.to_string_lossy().as_ref(), &cache_dir).expect("snapshot");
        assert_eq!(snapshot.events.len(), MAX_BUFFER_EVENTS);
        assert_eq!(snapshot.events[0].line, 6);

        let page = read_archive(
            &cache_dir,
            path.to_string_lossy().as_ref(),
            6,
            500,
        )
        .expect("archive page");
        assert_eq!(page.events.len(), 5);
        assert_eq!(page.events[0].line, 1);
        assert_eq!(page.events[4].line, 5);
        assert!(!page.has_more);

        let page = read_archive(
            &cache_dir,
            path.to_string_lossy().as_ref(),
            6,
            1,
        )
        .expect("bounded archive page");
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].line, 5);
        assert!(page.has_more);

        fs::write(
            &path,
            "{\"level\":\"info\",\"event\":\"short\"}\n",
        )
        .expect("truncated stream");
        read_snapshot_cached(path.to_string_lossy().as_ref(), &cache_dir).expect("reset snapshot");
        let page = read_archive(
            &cache_dir,
            path.to_string_lossy().as_ref(),
            2,
            500,
        )
        .expect("reset archive");
        assert!(page.events.is_empty());
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

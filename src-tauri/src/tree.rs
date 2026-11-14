use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

const MAX_NODES: usize = 200_000;
const MAX_ROWS: usize = 4_000;
const PREVIEW_LIMIT: usize = 120;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeRow {
    pub key: String,
    pub path: String,
    pub depth: usize,
    pub index: bool,
    pub kind: String,
    pub preview: String,
    pub expandable: bool,
    pub expanded: bool,
    pub count: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSnapshot {
    pub status: String,
    pub rows: Vec<TreeRow>,
    pub nodes: usize,
    pub depth: usize,
    pub truncated: bool,
}

struct TreeCache {
    revision: u64,
    initialized: bool,
    status: &'static str,
    value: Option<Value>,
}

static CACHE: Mutex<TreeCache> = Mutex::new(TreeCache {
    revision: 0,
    initialized: false,
    status: "empty",
    value: None,
});

fn with_cache<T>(
    text: Option<String>,
    revision: u64,
    build: impl FnOnce(&TreeCache) -> T,
) -> Result<T, String> {
    let mut cache = CACHE
        .lock()
        .map_err(|_| "tree cache is unavailable".to_string())?;
    if !cache.initialized || cache.revision != revision {
        if cache.initialized && revision < cache.revision {
            return Err("tree data belongs to a superseded revision".to_string());
        }
        let Some(text) = text else {
            return Err("tree data was not supplied for this revision".to_string());
        };
        if text.trim().is_empty() {
            cache.status = "empty";
            cache.value = None;
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(value) => {
                    cache.status = "ok";
                    cache.value = Some(value);
                }
                Err(_) => {
                    cache.status = "invalid";
                    cache.value = None;
                }
            }
        }
        cache.revision = revision;
        cache.initialized = true;
    }
    Ok(build(&cache))
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn count_of(value: &Value) -> Option<usize> {
    match value {
        Value::Array(items) => Some(items.len()),
        Value::Object(map) => Some(map.len()),
        _ => None,
    }
}

fn expandable(value: &Value) -> bool {
    match value {
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        _ => false,
    }
}

fn preview(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => {
            let text = if value.chars().count() > PREVIEW_LIMIT {
                let mut clipped: String = value.chars().take(PREVIEW_LIMIT).collect();
                clipped.push('…');
                clipped
            } else {
                value.clone()
            };
            serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string())
        }
        Value::Array(items) => format!("[{} items]", items.len()),
        Value::Object(map) => format!("{{{} keys}}", map.len()),
    }
}

fn is_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    characters
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '$')
}

fn path_for(parent: &str, key: &str, index: bool) -> String {
    if index {
        return format!("{parent}[{key}]");
    }
    if is_identifier(key) {
        return format!("{parent}.{key}");
    }
    format!(
        "{parent}[{}]",
        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string())
    )
}

fn walk_stats(value: &Value, level: usize, nodes: &mut usize, max_depth: &mut usize) {
    if *nodes >= MAX_NODES {
        return;
    }
    *nodes += 1;
    *max_depth = (*max_depth).max(level);
    match value {
        Value::Array(items) => {
            for item in items {
                walk_stats(item, level + 1, nodes, max_depth);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                walk_stats(item, level + 1, nodes, max_depth);
            }
        }
        _ => {}
    }
}

fn collect_matches(
    value: &Value,
    key: &str,
    path: &str,
    query: &str,
    level: usize,
    nodes: &mut usize,
    max_depth: &mut usize,
    matches: &mut HashMap<String, bool>,
) -> bool {
    if *nodes >= MAX_NODES {
        return false;
    }
    *nodes += 1;
    *max_depth = (*max_depth).max(level);
    let self_match = key.to_lowercase().contains(query)
        || path.to_lowercase().contains(query)
        || preview(value).to_lowercase().contains(query);
    let mut any_child = false;
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let child_key = index.to_string();
                let child_path = path_for(path, &child_key, true);
                if collect_matches(
                    item,
                    &child_key,
                    &child_path,
                    query,
                    level + 1,
                    nodes,
                    max_depth,
                    matches,
                ) {
                    any_child = true;
                }
            }
        }
        Value::Object(map) => {
            for (child_key, item) in map {
                let child_path = path_for(path, child_key, false);
                if collect_matches(
                    item,
                    child_key,
                    &child_path,
                    query,
                    level + 1,
                    nodes,
                    max_depth,
                    matches,
                ) {
                    any_child = true;
                }
            }
        }
        _ => {}
    }
    let matched = self_match || any_child;
    matches.insert(path.to_string(), matched);
    matched
}

struct RowCollector<'a> {
    expanded: &'a HashSet<String>,
    query: Option<&'a str>,
    matches: Option<&'a HashMap<String, bool>>,
    rows: Vec<TreeRow>,
    truncated: bool,
}

impl<'a> RowCollector<'a> {
    fn emit(&mut self, key: &str, value: &Value, path: &str, depth: usize, index: bool) {
        if let Some(matches) = self.matches {
            if !matches.get(path).copied().unwrap_or(false) {
                return;
            }
        }
        if self.rows.len() >= MAX_ROWS {
            self.truncated = true;
            return;
        }
        let can_expand = expandable(value);
        let is_expanded = can_expand && (self.query.is_some() || self.expanded.contains(path));
        self.rows.push(TreeRow {
            key: key.to_string(),
            path: path.to_string(),
            depth,
            index,
            kind: kind_of(value).to_string(),
            preview: preview(value),
            expandable: can_expand,
            expanded: is_expanded,
            count: count_of(value),
        });
        if !is_expanded {
            return;
        }
        match value {
            Value::Array(items) => {
                for (child_index, item) in items.iter().enumerate() {
                    if self.rows.len() >= MAX_ROWS {
                        self.truncated = true;
                        return;
                    }
                    let child_key = child_index.to_string();
                    let child_path = path_for(path, &child_key, true);
                    self.emit(&child_key, item, &child_path, depth + 1, true);
                }
            }
            Value::Object(map) => {
                for (child_key, item) in map {
                    if self.rows.len() >= MAX_ROWS {
                        self.truncated = true;
                        return;
                    }
                    let child_path = path_for(path, child_key, false);
                    self.emit(child_key, item, &child_path, depth + 1, false);
                }
            }
            _ => {}
        }
    }
}

fn build_snapshot(value: &Value, expanded: &[String], query: &str) -> TreeSnapshot {
    let expanded: HashSet<String> = expanded.iter().cloned().collect();
    let query = query.trim().to_lowercase();
    let query = if query.is_empty() {
        None
    } else {
        Some(query.as_str())
    };
    let mut nodes = 0;
    let mut depth = 0;
    let matches;
    match query {
        Some(query) => {
            let mut found = HashMap::new();
            collect_matches(
                value, "$", "$", query, 0, &mut nodes, &mut depth, &mut found,
            );
            matches = Some(found);
        }
        None => {
            walk_stats(value, 0, &mut nodes, &mut depth);
            matches = None;
        }
    }
    let mut collector = RowCollector {
        expanded: &expanded,
        query,
        matches: matches.as_ref(),
        rows: Vec::new(),
        truncated: false,
    };
    collector.emit("$", value, "$", 0, false);
    TreeSnapshot {
        status: "ok".to_string(),
        rows: collector.rows,
        nodes,
        depth,
        truncated: collector.truncated,
    }
}

pub fn snapshot(
    text: Option<String>,
    revision: u64,
    expanded: Vec<String>,
    query: String,
) -> Result<TreeSnapshot, String> {
    with_cache(text, revision, |cache| {
        if cache.status != "ok" {
            return TreeSnapshot {
                status: cache.status.to_string(),
                rows: Vec::new(),
                nodes: 0,
                depth: 0,
                truncated: false,
            };
        }
        match cache.value.as_ref() {
            Some(value) => build_snapshot(value, &expanded, &query),
            None => TreeSnapshot {
                status: "empty".to_string(),
                rows: Vec::new(),
                nodes: 0,
                depth: 0,
                truncated: false,
            },
        }
    })
}

fn collect_paths(value: &Value, path: &str, limit: usize, output: &mut Vec<String>) {
    if output.len() >= limit || !expandable(value) {
        return;
    }
    output.push(path.to_string());
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if output.len() >= limit {
                    return;
                }
                collect_paths(
                    item,
                    &path_for(path, &index.to_string(), true),
                    limit,
                    output,
                );
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                if output.len() >= limit {
                    return;
                }
                collect_paths(item, &path_for(path, key, false), limit, output);
            }
        }
        _ => {}
    }
}

pub fn expandable_paths(
    text: Option<String>,
    revision: u64,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    with_cache(text, revision, |cache| {
        if cache.status != "ok" {
            return Vec::new();
        }
        let Some(value) = cache.value.as_ref() else {
            return Vec::new();
        };
        let limit = limit.unwrap_or(MAX_ROWS).min(MAX_ROWS);
        let mut output = Vec::new();
        collect_paths(value, "$", limit, &mut output);
        output
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_rows_and_stats() {
        let value = json!({
            "name": "demo",
            "items": [1, {"ok": true}]
        });
        let snapshot = build_snapshot(
            &value,
            &[
                "$".to_string(),
                "$.items".to_string(),
                "$.items[1]".to_string(),
            ],
            "",
        );
        assert_eq!(snapshot.status, "ok");
        assert!(snapshot.nodes >= 6);
        assert_eq!(snapshot.depth, 3);
        assert_eq!(snapshot.rows[0].path, "$");
        assert!(snapshot.rows.iter().any(|row| row.path == "$.items[1].ok"));
        assert!(!snapshot.truncated);
    }

    #[test]
    fn filters_with_ancestors() {
        let value = json!({"outer": {"inner": [{"needle": true}]}});
        let snapshot = build_snapshot(&value, &[], "needle");
        let paths: Vec<_> = snapshot.rows.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(paths[0], "$");
        assert!(paths.contains(&"$.outer"));
        assert!(paths.contains(&"$.outer.inner[0]"));
        assert!(paths.contains(&"$.outer.inner[0].needle"));
    }

    #[test]
    fn formats_paths_like_the_editor() {
        assert_eq!(path_for("$", "valid_name", false), "$.valid_name");
        assert_eq!(path_for("$", "a-b", false), "$[\"a-b\"]");
        assert_eq!(path_for("$", "0", false), "$[\"0\"]");
        assert_eq!(path_for("$", "12", true), "$[12]");
    }

    #[test]
    fn handles_scalar_roots_and_truncated_previews() {
        let snapshot = build_snapshot(&json!(true), &[], "");
        assert_eq!(snapshot.rows.len(), 1);
        assert_eq!(snapshot.rows[0].kind, "boolean");
        assert_eq!(snapshot.rows[0].preview, "true");
        let long = "a".repeat(PREVIEW_LIMIT + 10);
        let text = preview(&Value::String(long));
        assert!(text.ends_with("…\""));
        assert_eq!(text.chars().count(), PREVIEW_LIMIT + 3);
    }

    #[test]
    fn caps_rows_and_expandable_paths() {
        let value = Value::Array((0..5_000).map(|index| json!(index)).collect());
        let snapshot = build_snapshot(&value, &["$".to_string()], "");
        assert_eq!(snapshot.rows.len(), MAX_ROWS);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.rows[1].path, "$[0]");
        let nested = json!({"a": {"b": {"c": {"d": [1]}}}});
        let mut paths = Vec::new();
        collect_paths(&nested, "$", 2, &mut paths);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[1], "$.a");
    }

    #[test]
    fn snapshot_cache_handles_empty_invalid_valid_and_stale_revisions() {
        let base = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let empty = snapshot(
            Some("  ".to_string()),
            base,
            vec!["$".to_string()],
            String::new(),
        )
        .expect("empty snapshot");
        assert_eq!(empty.status, "empty");
        let invalid = snapshot(Some("{".to_string()), base + 1, vec![], String::new())
            .expect("invalid snapshot");
        assert_eq!(invalid.status, "invalid");
        let valid = snapshot(
            Some(r#"{"a":[1]}"#.to_string()),
            base + 2,
            vec!["$".to_string()],
            String::new(),
        )
        .expect("valid snapshot");
        assert_eq!(valid.status, "ok");
        assert_eq!(valid.rows.len(), 2);
        assert_eq!(valid.rows[1].path, "$.a");
        assert!(snapshot(None, base + 1, vec![], String::new()).is_err());
        let paths = expandable_paths(None, base + 2, Some(10)).expect("cached paths");
        assert_eq!(paths, vec!["$", "$.a"]);
    }

    #[test]
    fn collects_expandable_paths() {
        let value = json!({"a": {"b": [1]}, "c": []});
        let mut paths = Vec::new();
        collect_paths(&value, "$", 50, &mut paths);
        assert_eq!(paths, vec!["$", "$.a", "$.a.b"]);
    }
}

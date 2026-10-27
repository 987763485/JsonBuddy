use crate::streams::StreamEvent;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Semantic conversation model derived from harness JSONL events.
///
/// Rust owns event-type parsing and chunk/tool assembly; the UI only lays out
/// these stable objects.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub system_prompt: Option<String>,
    pub models: Vec<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub tool_calls: Vec<ToolCall>,
    pub turns: Vec<TurnInfo>,
    pub switches: Vec<ModelSwitch>,
    pub stats: ConversationStats,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub text: String,
    pub reasoning: Option<String>,
    pub tool_calls: Vec<String>,
    pub streaming: bool,
    pub line: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub status: String,
    pub duration_ms: Option<u64>,
    pub output: Option<String>,
    pub line: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInfo {
    pub index: u32,
    pub model: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub messages: u32,
    pub streaming: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSwitch {
    pub from: String,
    pub to: String,
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStats {
    pub messages: u32,
    pub user_messages: u32,
    pub assistant_messages: u32,
    pub tool_calls: u32,
    pub turns: u32,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventKind {
    Session,
    Title,
    System,
    UserMessage,
    AssistantMessage,
    AssistantChunk,
    AssistantAttempt,
    Reasoning,
    ToolCall,
    ToolResult,
    ModelSwitch,
    TurnStart,
    TurnEnd,
    Step,
    Other,
}

pub fn normalize_events(events: &[StreamEvent]) -> Conversation {
    let mut builder = Builder::default();
    for event in events {
        builder.consume(event);
    }
    builder.finish()
}

#[derive(Default)]
struct Builder {
    conversation: Conversation,
    current_assistant: Option<usize>,
    current_turn: Option<usize>,
    current_model: Option<String>,
    call_times: HashMap<String, i64>,
    last_timestamp: Option<String>,
    last_timestamp_ms: Option<i64>,
    seen_models: HashSet<String>,
}

impl Builder {
    fn consume(&mut self, event: &StreamEvent) {
        let Ok(value) = serde_json::from_str::<Value>(&event.raw) else {
            return;
        };
        let Some(object) = value.as_object() else {
            return;
        };

        if let Some(session_id) = text_field(
            object,
            &["sessionId", "session_id", "session"],
        ) {
            if self.conversation.session_id.is_none() {
                self.conversation.session_id = Some(session_id);
            }
        }
        if let Some(model) = model_of(object) {
            if self.current_model.is_none() {
                self.current_model = Some(model.clone());
            }
            if self.seen_models.insert(model.clone()) {
                self.conversation.models.push(model.clone());
            }
        }
        let timestamp = timestamp_of(object);
        if let Some(iso) = timestamp.as_ref() {
            self.last_timestamp = Some(iso.clone());
        }
        if let Some(ms) = timestamp_ms_of(object) {
            self.last_timestamp_ms = Some(ms);
        }
        self.collect_tokens(object);

        let kind = classify(object);
        match kind {
            EventKind::Session => {
                if let Some(meta) = object.get("meta").and_then(Value::as_object) {
                    if self.conversation.session_id.is_none() {
                        self.conversation.session_id =
                            text_field(meta, &["sessionId", "session_id"]);
                    }
                }
                self.conversation.started_at =
                    self.conversation.started_at.clone().or(timestamp);
            }
            EventKind::Title => {
                if let Some(title) = text_field(object, &["aiTitle", "title", "name"]) {
                    self.conversation.title = Some(title);
                }
            }
            EventKind::System => {
                let text = text_of_field(object, &["content", "text", "system"]);
                if !text.is_empty() {
                    self.conversation.system_prompt =
                        Some(match self.conversation.system_prompt.take() {
                            Some(existing) => format!("{existing}\n\n{text}"),
                            None => text,
                        });
                }
            }
            EventKind::UserMessage => {
                self.finish_assistant();
                let text = sanitize_user_text(&text_of_field(
                    object,
                    &["text", "content", "message"],
                ));
                if text.is_empty() {
                    return;
                }
                self.start_turn(timestamp.clone());
                let id = text_field(object, &["id", "messageId", "message_id"])
                    .unwrap_or_else(|| format!("user-{}", event.line));
                let message = ChatMessage {
                    id,
                    role: "user".to_string(),
                    model: None,
                    timestamp: timestamp.clone(),
                    text,
                    reasoning: None,
                    tool_calls: Vec::new(),
                    streaming: false,
                    line: event.line,
                };
                self.conversation.messages.push(message);
                self.bump_turn_messages();
                self.current_assistant = None;
            }
            EventKind::AssistantMessage => {
                let text = text_of_field(object, &["text", "content", "message", "delta"]);
                let index = self.ensure_assistant(timestamp.clone(), event.line);
                if !text.is_empty() {
                    let message = &mut self.conversation.messages[index];
                    if !message.text.is_empty() {
                        message.text.push_str("\n\n");
                    }
                    message.text.push_str(text.trim());
                }
                if let Some(model) = model_of(object) {
                    self.conversation.messages[index].model = Some(model);
                }
                self.conversation.messages[index].streaming =
                    object.get("streaming").and_then(Value::as_bool) == Some(true);
            }
            EventKind::AssistantChunk => {
                let delta = raw_text_field(object, &["delta", "text", "content", "chunk"]);
                if delta.is_empty() {
                    return;
                }
                let index = self.ensure_assistant(timestamp.clone(), event.line);
                self.conversation.messages[index].text.push_str(&delta);
                self.conversation.messages[index].streaming = true;
            }
            EventKind::AssistantAttempt => {
                self.finish_assistant();
                if let Some(model) = model_of(object) {
                    self.record_model(&model);
                    self.current_model = Some(model);
                }
            }
            EventKind::Reasoning => {
                let text = text_of_field(
                    object,
                    &["text", "reasoning", "rawContent", "content", "delta"],
                );
                if text.is_empty() {
                    return;
                }
                let index = self.ensure_assistant(timestamp.clone(), event.line);
                let message = &mut self.conversation.messages[index];
                message.reasoning = Some(match message.reasoning.take() {
                    Some(existing) => format!("{existing}\n\n{}", text.trim()),
                    None => text.trim().to_string(),
                });
            }
            EventKind::ToolCall => self.consume_tool_call(object, event.line, timestamp),
            EventKind::ToolResult => self.consume_tool_result(object, event.line, timestamp),
            EventKind::ModelSwitch => {
                let from = text_field(object, &["from", "previous", "old"])
                    .or_else(|| self.current_model.clone())
                    .unwrap_or_else(|| "Unknown".to_string());
                let to = text_field(object, &["to", "next", "new", "model"])
                    .unwrap_or_else(|| "Unknown".to_string());
                if from != to {
                    self.conversation.switches.push(ModelSwitch {
                        from,
                        to: to.clone(),
                        timestamp: timestamp.clone(),
                    });
                    self.record_model(&to);
                    self.current_model = Some(to);
                }
            }
            EventKind::TurnStart => {
                self.finish_assistant();
                if let Some(model) = model_of(object) {
                    self.record_model(&model);
                    self.current_model = Some(model);
                }
                self.start_turn(timestamp.clone());
            }
            EventKind::TurnEnd => {
                self.finish_assistant();
                if let Some(index) = self.current_turn {
                    let turn = &mut self.conversation.turns[index];
                    turn.ended_at = timestamp;
                    turn.streaming = false;
                }
            }
            EventKind::Step | EventKind::Other => {}
        }
    }

    fn ensure_assistant(&mut self, timestamp: Option<String>, line: u64) -> usize {
        if let Some(index) = self.current_assistant {
            if index < self.conversation.messages.len() {
                return index;
            }
        }
        if self.current_turn.is_none() {
            self.start_turn(timestamp.clone());
        }
        let index = self.conversation.messages.len();
        let message = ChatMessage {
            id: format!("assistant-{line}"),
            role: "assistant".to_string(),
            model: self.current_model.clone(),
            timestamp,
            text: String::new(),
            reasoning: None,
            tool_calls: Vec::new(),
            streaming: false,
            line,
        };
        self.conversation.messages.push(message);
        self.bump_turn_messages();
        self.current_assistant = Some(index);
        index
    }

    fn finish_assistant(&mut self) {
        if let Some(index) = self.current_assistant.take() {
            if let Some(message) = self.conversation.messages.get_mut(index) {
                message.streaming = false;
            }
        }
    }

    fn start_turn(&mut self, timestamp: Option<String>) {
        if let Some(index) = self.current_turn {
            if let Some(turn) = self.conversation.turns.get_mut(index) {
                turn.ended_at = Some(
                    self.last_timestamp
                        .clone()
                        .or_else(|| timestamp.clone())
                        .unwrap_or_default(),
                );
                turn.streaming = false;
            }
        }
        let index = self.conversation.turns.len();
        self.conversation.turns.push(TurnInfo {
            index: (index + 1) as u32,
            model: self.current_model.clone(),
            started_at: timestamp.or_else(|| self.last_timestamp.clone()),
            ended_at: None,
            messages: 0,
            streaming: true,
        });
        self.current_turn = Some(index);
    }

    fn bump_turn_messages(&mut self) {
        if let Some(index) = self.current_turn {
            if let Some(turn) = self.conversation.turns.get_mut(index) {
                turn.messages += 1;
            }
        }
    }

    fn record_model(&mut self, model: &str) {
        if self.seen_models.insert(model.to_string()) {
            self.conversation.models.push(model.to_string());
        }
    }

    fn consume_tool_call(
        &mut self,
        object: &serde_json::Map<String, Value>,
        line: u64,
        timestamp: Option<String>,
    ) {
        let function = object.get("function").and_then(Value::as_object);
        let name = text_field(object, &["name", "tool", "toolName", "tool_name"])
            .or_else(|| {
                function.and_then(|value| text_field(value, &["name", "tool"]))
            })
            .unwrap_or_else(|| "tool".to_string());
        let id = text_field(
            object,
            &["callId", "call_id", "tool_call_id", "toolCallId", "id"],
        )
        .unwrap_or_else(|| format!("call-{line}"));
        let arguments = object
            .get("arguments")
            .or_else(|| object.get("args"))
            .or_else(|| object.get("input"))
            .or_else(|| function.and_then(|value| value.get("arguments")))
            .map(arguments_text)
            .unwrap_or_default();
        if let Some(ms) = timestamp_ms_of(object) {
            self.call_times.insert(id.clone(), ms);
        }
        let assistant = self.ensure_assistant(timestamp, line);
        if !self
            .conversation
            .tool_calls
            .iter()
            .any(|call| call.id == id)
        {
            self.conversation.tool_calls.push(ToolCall {
                id: id.clone(),
                name,
                arguments,
                status: "pending".to_string(),
                duration_ms: None,
                output: None,
                line,
            });
        }
        let message = &mut self.conversation.messages[assistant];
        if !message.tool_calls.contains(&id) {
            message.tool_calls.push(id);
        }
    }

    fn consume_tool_result(
        &mut self,
        object: &serde_json::Map<String, Value>,
        line: u64,
        timestamp: Option<String>,
    ) {
        let name = text_field(object, &["name", "tool", "toolName", "tool_name"])
            .unwrap_or_else(|| "tool".to_string());
        let id = text_field(
            object,
            &["callId", "call_id", "tool_call_id", "toolCallId", "id"],
        )
        .unwrap_or_else(|| format!("call-{line}"));
        let status = result_status(object);
        let output = object
            .get("output")
            .or_else(|| object.get("result"))
            .or_else(|| object.get("content"))
            .or_else(|| object.get("error"))
            .map(text_of)
            .filter(|text| !text.is_empty());
        let duration = object
            .get("duration_ms")
            .or_else(|| object.get("durationMs"))
            .and_then(Value::as_u64)
            .or_else(|| {
                let start = self.call_times.get(&id)?;
                let end = timestamp_ms_of(object)?;
                if end >= *start {
                    Some((end - *start) as u64)
                } else {
                    None
                }
            });
        let assistant = self.ensure_assistant(timestamp, line);
        if let Some(call) = self
            .conversation
            .tool_calls
            .iter_mut()
            .find(|call| call.id == id)
        {
            call.status = status;
            call.duration_ms = duration.or(call.duration_ms);
            if output.is_some() {
                call.output = output;
            }
        } else {
            self.conversation.tool_calls.push(ToolCall {
                id: id.clone(),
                name,
                arguments: String::new(),
                status,
                duration_ms: duration,
                output,
                line,
            });
        }
        let message = &mut self.conversation.messages[assistant];
        if !message.tool_calls.contains(&id) {
            message.tool_calls.push(id);
        }
    }

    fn collect_tokens(&mut self, object: &serde_json::Map<String, Value>) {
        let prompt = number_field(
            object,
            &["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"],
        )
        .or_else(|| {
            object
                .get("usage")
                .and_then(Value::as_object)
                .and_then(|usage| {
                    number_field(
                        usage,
                        &["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"],
                    )
                })
        });
        let completion = number_field(
            object,
            &[
                "completion_tokens",
                "completionTokens",
                "output_tokens",
                "outputTokens",
            ],
        )
        .or_else(|| {
            object
                .get("usage")
                .and_then(Value::as_object)
                .and_then(|usage| {
                    number_field(
                        usage,
                        &[
                            "completion_tokens",
                            "completionTokens",
                            "output_tokens",
                            "outputTokens",
                        ],
                    )
                })
        });
        if let Some(value) = prompt {
            self.conversation.stats.prompt_tokens =
                self.conversation.stats.prompt_tokens.max(value);
        }
        if let Some(value) = completion {
            self.conversation.stats.completion_tokens =
                self.conversation.stats.completion_tokens.max(value);
        }
    }

    fn finish(mut self) -> Conversation {
        self.finish_assistant();
        if let Some(index) = self.current_turn {
            if let Some(turn) = self.conversation.turns.get_mut(index) {
                turn.streaming = false;
                if turn.ended_at.is_none() {
                    turn.ended_at = self.last_timestamp.clone();
                }
            }
        }
        self.conversation.ended_at = self.last_timestamp.clone();
        if self.conversation.started_at.is_none() {
            self.conversation.started_at = self
                .conversation
                .messages
                .first()
                .and_then(|message| message.timestamp.clone());
        }
        let mut stats = ConversationStats::default();
        stats.messages = self.conversation.messages.len() as u32;
        stats.user_messages = self
            .conversation
            .messages
            .iter()
            .filter(|message| message.role == "user")
            .count() as u32;
        stats.assistant_messages = self
            .conversation
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .count() as u32;
        stats.tool_calls = self.conversation.tool_calls.len() as u32;
        stats.turns = self.conversation.turns.len() as u32;
        stats.prompt_tokens = self.conversation.stats.prompt_tokens;
        stats.completion_tokens = self.conversation.stats.completion_tokens;
        self.conversation.stats = stats;
        self.conversation
    }
}

fn classify(object: &serde_json::Map<String, Value>) -> EventKind {
    let kind = object
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| object.get("type").and_then(Value::as_str))
        .or_else(|| object.get("name").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase()
        .replace(['_', '.', ':', '-', ' '], "/");
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if kind.contains("session") && (kind.contains("meta") || kind.contains("start")) {
        return EventKind::Session;
    }
    if kind.contains("title") {
        return EventKind::Title;
    }
    if kind.contains("reasoning")
        || kind.contains("thinking")
        || kind.contains("thought")
    {
        return EventKind::Reasoning;
    }
    if (kind.contains("function") && kind.contains("call") && kind.contains("result"))
        || (kind.contains("tool") && kind.contains("result"))
    {
        return EventKind::ToolResult;
    }
    if (kind.contains("function") && kind.contains("call"))
        || (kind.contains("tool") && (kind.contains("start") || kind.contains("call")))
    {
        return EventKind::ToolCall;
    }
    if kind.contains("chunk") || kind.contains("delta") {
        return EventKind::AssistantChunk;
    }
    if kind.contains("attempt") {
        return EventKind::AssistantAttempt;
    }
    if kind.contains("switch") || kind.contains("model/change") {
        return EventKind::ModelSwitch;
    }
    if kind.contains("turn") && kind.contains("start") {
        return EventKind::TurnStart;
    }
    if kind.contains("turn") && (kind.contains("end") || kind.contains("stop")) {
        return EventKind::TurnEnd;
    }
    if kind.contains("step") {
        return EventKind::Step;
    }
    if kind.contains("assistant") && (kind.contains("message") || kind.contains("response")) {
        return EventKind::AssistantMessage;
    }
    if kind.contains("user") && (kind.contains("message") || kind.contains("prompt")) {
        return EventKind::UserMessage;
    }
    if kind == "message" || kind.ends_with("/message") {
        return match role.as_str() {
            "user" => EventKind::UserMessage,
            "assistant" => EventKind::AssistantMessage,
            "system" => EventKind::System,
            _ => EventKind::Other,
        };
    }
    EventKind::Other
}

fn text_field(object: &serde_json::Map<String, Value>, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(value) = object.get(*name) {
            let text = text_of(value);
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn text_of_field(
    object: &serde_json::Map<String, Value>,
    names: &[&str],
) -> String {
    text_field(object, names).unwrap_or_default()
}

fn raw_text_field(
    object: &serde_json::Map<String, Value>,
    names: &[&str],
) -> String {
    for name in names {
        if let Some(value) = object.get(*name) {
            let text = raw_text_of(value);
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn raw_text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(raw_text_of).collect(),
        Value::Object(object) => {
            for key in ["delta", "chunk", "text", "content", "message"] {
                if let Some(value) = object.get(key) {
                    let text = raw_text_of(value);
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                let text = text_of(item);
                if !text.is_empty() {
                    parts.push(text);
                }
            }
            parts.join("\n")
        }
        Value::Object(object) => {
            for key in [
                "text",
                "reasoning",
                "delta",
                "chunk",
                "content",
                "message",
                "output",
                "result",
            ] {
                if let Some(value) = object.get(key) {
                    let text = text_of(value);
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn arguments_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        _ => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}

fn model_of(object: &serde_json::Map<String, Value>) -> Option<String> {
    text_field(
        object,
        &[
            "model",
            "model_id",
            "modelId",
            "requestModelId",
            "model_name",
            "modelName",
        ],
    )
    .or_else(|| {
        object
            .get("providerData")
            .and_then(Value::as_object)
            .and_then(|provider| {
                text_field(
                    provider,
                    &[
                        "model",
                        "modelId",
                        "requestModelId",
                        "modelName",
                    ],
                )
            })
    })
}

fn timestamp_of(object: &serde_json::Map<String, Value>) -> Option<String> {
    let raw = object
        .get("timestamp")
        .or_else(|| object.get("ts"))
        .or_else(|| object.get("time"))?;
    if let Some(number) = raw.as_i64() {
        return iso_from_number(number);
    }
    let text = raw.as_str()?;
    if let Ok(number) = text.parse::<i64>() {
        return iso_from_number(number);
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn timestamp_ms_of(object: &serde_json::Map<String, Value>) -> Option<i64> {
    let raw = object
        .get("timestamp")
        .or_else(|| object.get("ts"))
        .or_else(|| object.get("time"))?;
    if let Some(number) = raw.as_i64() {
        return normalize_ms(number);
    }
    let text = raw.as_str()?;
    if let Ok(number) = text.parse::<i64>() {
        return normalize_ms(number);
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn normalize_ms(number: i64) -> Option<i64> {
    if number >= 1_000_000_000_000 {
        Some(number)
    } else if number >= 1_000_000_000 {
        Some(number * 1000)
    } else {
        None
    }
}

fn iso_from_number(number: i64) -> Option<String> {
    let ms = normalize_ms(number)?;
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn number_field(object: &serde_json::Map<String, Value>, names: &[&str]) -> Option<u64> {
    for name in names {
        if let Some(value) = object.get(*name) {
            if let Some(number) = value.as_u64() {
                return Some(number);
            }
            if let Some(number) = value.as_f64() {
                if number >= 0.0 {
                    return Some(number as u64);
                }
            }
        }
    }
    None
}

fn result_status(object: &serde_json::Map<String, Value>) -> String {
    if let Some(ok) = object.get("ok").and_then(Value::as_bool) {
        return if ok { "completed" } else { "error" }.to_string();
    }
    if let Some(error) = object.get("error") {
        let failed = match error {
            Value::Bool(value) => *value,
            Value::Null => false,
            Value::String(text) => !text.is_empty(),
            _ => true,
        };
        if failed {
            return "error".to_string();
        }
    }
    if let Some(success) = object.get("success").and_then(Value::as_bool) {
        return if success { "completed" } else { "error" }.to_string();
    }
    match object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "error" | "failed" | "failure" | "denied" => "error".to_string(),
        "pending" | "running" | "started" => "pending".to_string(),
        _ => "completed".to_string(),
    }
}

fn sanitize_user_text(text: &str) -> String {
    let mut output = text.to_string();
    for tag in [
        "system-reminder",
        "user_info",
        "identity_context",
        "project_context",
        "product_identity",
        "environment_context",
        "available_tools",
    ] {
        output = strip_tag_block(&output, tag);
    }
    output.trim().to_string()
}

fn strip_tag_block(text: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        output.push_str(&rest[..start]);
        let after_open = &rest[start..];
        if let Some(end) = after_open.find(&close) {
            rest = &after_open[end + close.len()..];
        } else {
            rest = "";
            break;
        }
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(line: u64, value: Value) -> StreamEvent {
        StreamEvent {
            line,
            raw: value.to_string(),
            ts: None,
            level: None,
            name: None,
        }
    }

    #[test]
    fn normalizes_codebuddy_events() {
        let events = vec![
            event(1, json!({"type":"session-meta","sessionId":"s-1","timestamp":1792910781885i64})),
            event(2, json!({"type":"ai-title","aiTitle":"Fix the handler","timestamp":1792910782000i64})),
            event(3, json!({
                "type":"message","role":"user","id":"u1","timestamp":1792910783000i64,
                "content":[{"type":"input_text","text":"<system-reminder data-role=\"user-context\">ctx</system-reminder>Please fix <code>src/index.ts</code>."}]
            })),
            event(4, json!({
                "type":"reasoning","timestamp":1792910784000i64,
                "providerData":{"model":"deepseek-r1"},
                "rawContent":[{"type":"reasoning_text","text":"Read the file first."}]
            })),
            event(5, json!({
                "type":"function_call","timestamp":1792910785000i64,"callId":"c1",
                "name":"read_file","arguments":{"path":"src/index.ts"}
            })),
            event(6, json!({
                "type":"function_call_result","timestamp":1792910785480i64,"callId":"c1",
                "name":"read_file","status":"completed","output":{"type":"text","text":"214 lines"}
            })),
            event(7, json!({
                "type":"message","role":"assistant","id":"a1","timestamp":1792910786000i64,
                "providerData":{"model":"deepseek-r1"},
                "content":[{"type":"output_text","text":"Done. The response shape is unchanged."}]
            })),
        ];
        let conversation = normalize_events(&events);
        assert_eq!(conversation.session_id.as_deref(), Some("s-1"));
        assert_eq!(conversation.title.as_deref(), Some("Fix the handler"));
        assert_eq!(conversation.models, vec!["deepseek-r1"]);
        assert_eq!(conversation.stats.user_messages, 1);
        assert_eq!(conversation.stats.assistant_messages, 1);
        assert_eq!(conversation.stats.tool_calls, 1);
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(
            conversation.messages[0].text,
            "Please fix <code>src/index.ts</code>."
        );
        let assistant = conversation
            .messages
            .iter()
            .find(|message| message.role == "assistant")
            .expect("assistant message");
        assert_eq!(assistant.text, "Done. The response shape is unchanged.");
        assert_eq!(assistant.reasoning.as_deref(), Some("Read the file first."));
        assert_eq!(assistant.tool_calls, vec!["c1"]);
        let call = &conversation.tool_calls[0];
        assert_eq!(call.name, "read_file");
        assert_eq!(call.status, "completed");
        assert_eq!(call.duration_ms, Some(480));
        assert_eq!(call.output.as_deref(), Some("214 lines"));
        assert!(call.arguments.contains("src/index.ts"));
    }

    #[test]
    fn normalizes_harness_chunks_and_tools() {
        let events = vec![
            event(1, json!({"event":"session/start","sessionId":"s-2","timestamp":1792910781885i64})),
            event(2, json!({"event":"user/message","text":"Summarize this log.","timestamp":1792910782000i64})),
            event(3, json!({"event":"assistant/attempt","model":"deepseek-v3","timestamp":1792910782100i64})),
            event(4, json!({"event":"assistant/chunk","delta":"I will ","timestamp":1792910782200i64})),
            event(5, json!({"event":"assistant/chunk","delta":"read it.","timestamp":1792910782300i64})),
            event(6, json!({"event":"tool/start","tool":"read_file","call_id":"c9","arguments":{"path":"a.jsonl"},"timestamp":1792910782400i64})),
            event(7, json!({"event":"tool/result","call_id":"c9","ok":false,"error":"denied","timestamp":1792910782500i64})),
            event(8, json!({"event":"turn/end","timestamp":1792910782600i64})),
        ];
        let conversation = normalize_events(&events);
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(conversation.messages[1].text, "I will read it.");
        assert!(!conversation.messages[1].streaming);
        assert_eq!(conversation.stats.turns, 1);
        assert_eq!(conversation.tool_calls[0].status, "error");
        assert_eq!(conversation.tool_calls[0].duration_ms, Some(100));
        assert_eq!(conversation.tool_calls[0].output.as_deref(), Some("denied"));
    }

    #[test]
    fn records_model_switches() {
        let events = vec![
            event(1, json!({"event":"user/message","text":"Start","timestamp":1792910782000i64})),
            event(2, json!({"event":"assistant/message","model":"DeepSeek R1","text":"A","timestamp":1792910782100i64})),
            event(3, json!({"event":"model/switch","from":"DeepSeek R1","to":"DeepSeek V3","timestamp":1792910782200i64})),
            event(4, json!({"event":"assistant/message","model":"DeepSeek V3","text":"B","timestamp":1792910782300i64})),
        ];
        let conversation = normalize_events(&events);
        assert_eq!(conversation.switches.len(), 1);
        assert_eq!(conversation.switches[0].to, "DeepSeek V3");
        assert_eq!(
            conversation.models,
            vec!["DeepSeek R1", "DeepSeek V3"]
        );
        assert!(conversation.messages[1].text.contains('A'));
        assert!(conversation.messages[1].text.contains('B'));
    }

    #[test]
    fn strips_system_reminder_context() {
        assert_eq!(
            sanitize_user_text(
                "<system-reminder>ignore me</system-reminder>  real prompt  "
            ),
            "real prompt"
        );
    }
}
